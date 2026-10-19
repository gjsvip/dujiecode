/**
 * Agent 循环引擎（架构文档 §3.4 #38 / §7.3 循环状态机 / §7.4 中止与审批）。
 *
 * 流程：流式消费适配器 → 收集 tool_call → 审批介入（危险规则 / 覆盖写）→
 * 执行工具回传 → 进入下一轮，最多 MAX_AGENT_ROUNDS（25）轮；
 * 中止检测：KV `abort:{conversationId}`（§4.3）+ 客户端断开信号（req.signal）；
 * 审批等待：每 1000ms 轮询 D1 approvals 行，不自动超时放行；
 * 总是允许：alwaysAllow 时把命令模式串写入 KV `approval-allow:{conversationId}`（TTL 1h）。
 *
 * SSE 产出（§5.3）：meta / token / tool_call / approval_request /
 * approval_resolved / tool_result / usage / done / error。
 */
import type { ConversationStatus, MessageRole, ProviderProtocol, ToolCall } from '@shared/types'
import { MAX_AGENT_ROUNDS, SSE_EVENTS, TOOL_OUTPUT_MAX_CHARS } from '@shared/constants'
import { dbAll, dbFirst, dbRun, httpError, isHttpError, newId, nowIso } from '../lib/core'
import type { Env } from '../types'
import { createAdapter, type ChatMessage } from '../llm/adapters'
import { resolvePathNode } from '../routes/workspaces'
import { VfsPathError } from '../vfs/shell'
import {
  TOOL_DEFINITIONS,
  executeTool,
  matchDanger,
  writeAuditLog,
  type ToolContext,
  type ToolResult,
} from './tools'

/* ------------------------------------------------------------------ */
/* SSE 助手（对话事件流，§5.3）                                          */
/* ------------------------------------------------------------------ */

/** 组装单条 SSE 帧（data 为单行 JSON，JSON.stringify 不会产出裸换行） */
export function formatSseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** SSE keep-alive 注释行（每 15s 发送，§5.3） */
export const SSE_KEEPALIVE_COMMENT = ': keep-alive\n\n'

/** SSE 响应头（§5.3） */
export function sseResponseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  }
}

/**
 * 读取 [vars] 运行期配置（wrangler.toml；Env 绑定类型未声明这些变量，
 * 经宽松转换读取，缺省时回落 fallback）。
 */
export function readEnvVar(env: Env, key: string, fallback: string): string {
  const bag = env as unknown as Record<string, unknown>
  const value = bag[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** SSE 事件发送器（由路由层实现：enqueue 到 ReadableStream） */
type SseSender = (event: string, data: unknown) => void

/* ------------------------------------------------------------------ */
/* 循环参数                                                             */
/* ------------------------------------------------------------------ */

/** Agent 循环入参（路由层解密密钥后传入；密钥仅在内存中传递，绝不落日志） */
export interface AgentLoopParams {
  env: Env
  conversationId: string
  workspaceId: string
  userId: string
  /** 流开始即下发的 assistant 消息 ID（meta / done 事件使用） */
  messageId: string
  providerId: string
  model: string
  /** 已解密的供应商密钥（内存态） */
  apiKey: string
  protocol: ProviderProtocol
  baseUrl: string
  /** 工作区默认执行后端 */
  defaultBackend: string
  /** 客户端断开信号（c.req.raw.signal） */
  signal?: AbortSignal
}

/* ------------------------------------------------------------------ */
/* 内部助手                                                             */
/* ------------------------------------------------------------------ */

/** messages 表原始行 */
interface MessageRow {
  id: string
  conversation_id: string
  role: MessageRole
  content: string
  tool_calls: string | null
  tool_call_id: string | null
  name: string | null
  tokens_in: number
  tokens_out: number
  created_at: string
}

/** 待插入消息（id 由调用方指定，保证 meta 下发的 messageId 与落库一致） */
interface MessageInsert {
  id: string
  role: MessageRole
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
  tokensIn?: number
  tokensOut?: number
}

/** 安全 JSON 解析（失败返回 null） */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 毫秒睡眠 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 加载会话历史并转为适配器消息（按创建时间正序） */
async function loadHistory(env: Env, conversationId: string): Promise<ChatMessage[]> {
  const rows = await dbAll<MessageRow>(
    env.DB,
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
    [conversationId],
  )
  return rows.map((row) => {
    const message: ChatMessage = { role: row.role, content: row.content }
    if (row.tool_calls) {
      const parsed = safeJsonParse(row.tool_calls)
      if (Array.isArray(parsed)) {
        message.toolCalls = parsed as ToolCall[]
      }
    }
    if (row.tool_call_id) {
      message.toolCallId = row.tool_call_id
    }
    if (row.name) {
      message.name = row.name
    }
    return message
  })
}

/** 插入一条消息（ID 由调用方指定） */
async function insertMessage(env: Env, conversationId: string, row: MessageInsert): Promise<string> {
  await dbRun(
    env.DB,
    'INSERT INTO messages (id, conversation_id, role, content, tool_calls, tool_call_id, name, tokens_in, tokens_out, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      row.id,
      conversationId,
      row.role,
      row.content,
      row.toolCalls && row.toolCalls.length > 0 ? JSON.stringify(row.toolCalls) : null,
      row.toolCallId ?? null,
      row.name ?? null,
      row.tokensIn ?? 0,
      row.tokensOut ?? 0,
      nowIso(),
    ],
  )
  return row.id
}

/** 更新会话状态（§7.3 状态机落库） */
async function setConversationStatus(env: Env, conversationId: string, status: ConversationStatus): Promise<void> {
  await dbRun(env.DB, 'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), conversationId])
}

/** 中止检测：客户端断开或 KV abort 标志（TTL 300s） */
async function isAborted(env: Env, conversationId: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return true
  }
  const flag = await env.KV.get(`abort:${conversationId}`)
  return flag !== null
}

/** 审批结果 */
interface ApprovalDecision {
  decision: 'approved' | 'rejected'
  aborted: boolean
}

/**
 * 轮询等待审批决策：每 1000ms 查 D1 approvals 行（§12-D3）。
 * 不自动超时放行；客户端断开 / KV 中止标志立即返回 aborted。
 */
async function awaitApproval(
  env: Env,
  conversationId: string,
  approvalId: string,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  while (true) {
    if (await isAborted(env, conversationId, signal)) {
      return { decision: 'approved', aborted: true }
    }
    const row = await dbFirst<{ status: string }>(env.DB, 'SELECT status FROM approvals WHERE id = ?', [approvalId])
    if (row?.status === 'approved') {
      return { decision: 'approved', aborted: false }
    }
    if (row?.status === 'rejected') {
      return { decision: 'rejected', aborted: false }
    }
    await sleep(1000)
  }
}

/** 查询会话放行名单（KV `approval-allow:{conversationId}`，TTL 1h） */
async function loadAllowList(env: Env, conversationId: string): Promise<string[]> {
  const raw = await env.KV.get(`approval-allow:${conversationId}`)
  if (raw === null) {
    return []
  }
  const parsed = safeJsonParse(raw)
  return Array.isArray(parsed) ? (parsed as string[]) : []
}

/* ------------------------------------------------------------------ */
/* 主循环                                                               */
/* ------------------------------------------------------------------ */

/**
 * 运行 Agent 循环（§7.3）。
 * 所有进展经 send 以 SSE 事件下发；正常/异常终态均落库 conversations.status。
 */
export async function runAgentLoop(params: AgentLoopParams, send: SseSender): Promise<void> {
  const {
    env,
    conversationId,
    workspaceId,
    userId,
    messageId,
    model,
    apiKey,
    protocol,
    baseUrl,
    defaultBackend,
    signal,
  } = params

  const maxRounds = (() => {
    const parsed = Number.parseInt(readEnvVar(env, 'MAX_AGENT_ROUNDS', String(MAX_AGENT_ROUNDS)), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_AGENT_ROUNDS
  })()

  const toolContext: ToolContext = { env, workspaceId, userId, defaultBackend }
  const messages = await loadHistory(env, conversationId)
  // 累计用量：tokensIn 取上下文峰值（max），tokensOut 逐轮累加
  let totalIn = 0
  let totalOut = 0

  send(SSE_EVENTS.META, { conversationId, messageId })
  await setConversationStatus(env, conversationId, 'streaming')

  /** 统一错误收尾：下发 error 事件并落库 */
  const failWith = async (code: string, message: string): Promise<void> => {
    send(SSE_EVENTS.ERROR, { code, message })
    await setConversationStatus(env, conversationId, 'error')
  }

  let aborted = false

  for (let round = 1; round <= maxRounds; round++) {
    if (await isAborted(env, conversationId, signal)) {
      aborted = true
      break
    }

    /* ------------------------- 单轮：流式消费 ------------------------- */
    const roundToolCalls: ToolCall[] = []
    let assistantText = ''
    let roundIn = 0
    let roundOut = 0
    let finishReason = 'stop'
    let streamError: { code: string; message: string } | null = null

    const adapter = createAdapter({ protocol, baseUrl, apiKey })
    try {
      for await (const event of adapter.streamChat({
        model,
        messages,
        tools: TOOL_DEFINITIONS,
        signal,
      })) {
        if (await isAborted(env, conversationId, signal)) {
          aborted = true
          break
        }
        switch (event.type) {
          case 'token':
            assistantText += event.text
            send(SSE_EVENTS.TOKEN, { text: event.text })
            break
          case 'tool_call':
            roundToolCalls.push({ id: event.id, name: event.name, arguments: event.arguments })
            break
          case 'usage':
            roundIn = Math.max(roundIn, event.tokensIn)
            roundOut += event.tokensOut
            totalIn = Math.max(totalIn, event.tokensIn)
            totalOut += event.tokensOut
            send(SSE_EVENTS.USAGE, { tokensIn: totalIn, tokensOut: totalOut })
            break
          case 'done':
            finishReason = event.finishReason
            break
          case 'error':
            streamError = { code: event.code, message: event.message }
            break
          default:
            break
        }
        if (streamError) {
          break
        }
      }
    } catch (err) {
      if (await isAborted(env, conversationId, signal)) {
        aborted = true
      } else {
        streamError = { code: 'INTERNAL', message: err instanceof Error ? err.message : '流式响应处理失败' }
      }
    }

    if (aborted) {
      break
    }
    if (streamError) {
      await failWith(streamError.code, streamError.message)
      return
    }

    /* --------------------- 持久化 assistant 消息 --------------------- */
    // 首轮 assistant 消息使用 meta 下发的 messageId，前端可据此定位 / 补偿渲染
    const assistantMessageId = round === 1 ? messageId : newId('msg_')
    await insertMessage(env, conversationId, {
      id: assistantMessageId,
      role: 'assistant',
      content: assistantText,
      toolCalls: roundToolCalls,
      tokensIn: roundIn,
      tokensOut: roundOut,
    })
    messages.push({ role: 'assistant', content: assistantText, toolCalls: roundToolCalls })

    /* --------------------- 无工具调用：正常收尾 --------------------- */
    if (roundToolCalls.length === 0) {
      send(SSE_EVENTS.DONE, { messageId, finishReason: finishReason || 'stop', rounds: round })
      await setConversationStatus(env, conversationId, 'done')
      return
    }

    /* ------------------------- 逐个执行工具 ------------------------- */
    for (const call of roundToolCalls) {
      if (await isAborted(env, conversationId, signal)) {
        aborted = true
        break
      }
      send(SSE_EVENTS.TOOL_CALL, { id: call.id, name: call.name, arguments: call.arguments })

      const gate = await evaluateApprovalGate(env, send, {
        conversationId,
        workspaceId,
        userId,
        defaultBackend,
        signal,
        call,
      })

      if (gate.aborted) {
        aborted = true
        break
      }

      let result: ToolResult
      if (gate.blocked) {
        // 审批拒绝 / 远程后端不在线：结果直接回传模型，不执行工具
        result = { ok: false, output: gate.message }
      } else {
        result = await executeToolWithRetry(call, toolContext)
        await auditToolExecution(env, {
          userId,
          workspaceId,
          defaultBackend,
          call,
          ok: result.ok,
        })
      }

      // 回传模型前按上限截断（§5.3 tool_result.truncated）
      const truncated = result.output.length > TOOL_OUTPUT_MAX_CHARS
      const output = truncated
        ? `${result.output.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n…（输出超过 ${TOOL_OUTPUT_MAX_CHARS} 字符，已截断）`
        : result.output
      send(SSE_EVENTS.TOOL_RESULT, { id: call.id, name: call.name, ok: result.ok, output, truncated })
      await insertMessage(env, conversationId, {
        id: newId('msg_'),
        role: 'tool',
        content: output,
        toolCallId: call.id,
        name: call.name,
      })
      messages.push({ role: 'tool', content: output, toolCallId: call.id, name: call.name })
    }

    if (aborted) {
      break
    }
    send(SSE_EVENTS.USAGE, { tokensIn: totalIn, tokensOut: totalOut })
  }

  /* ----------------------------- 终态处理 ----------------------------- */
  if (aborted) {
    send(SSE_EVENTS.ERROR, { code: 'ABORTED', message: '已被用户中止' })
    await setConversationStatus(env, conversationId, 'aborted')
    await env.KV.delete(`abort:${conversationId}`)
    return
  }
  await failWith('MAX_ROUNDS', `已达到最大工具轮次（${maxRounds}），会话结束`)
}

/* ------------------------------------------------------------------ */
/* 审批门（§7.1 审批触发规则 / §7.4）                                    */
/* ------------------------------------------------------------------ */

/** 审批门判定结果 */
interface ApprovalGate {
  /** 已中止（调用方应中断循环） */
  aborted: boolean
  /** 不执行工具（拒绝或后端不在线），message 为回传模型的原因 */
  blocked: boolean
  message: string
}

interface GateContext {
  conversationId: string
  workspaceId: string
  userId: string
  defaultBackend: string
  signal?: AbortSignal
  call: ToolCall
}

/**
 * 执行前审批门：
 * ① run_command 且远程后端不在线 → 直接 error，不进审批（§7.1③）；
 * ② run_command 命中 DANGER_RULES 且不在放行名单 → 建 approvals 行并发请求，轮询等待；
 * ③ write_file 目标已存在（覆盖）→ 同上（§12-D5）。
 */
async function evaluateApprovalGate(
  env: Env,
  send: SseSender,
  ctx: GateContext,
): Promise<ApprovalGate> {
  const args = safeParseObject(ctx.call.arguments)
  let needsApproval = false
  let reason = ''
  let commandText = ''

  if (ctx.call.name === 'run_command') {
    const command = typeof args.command === 'string' ? args.command : ''
    const backend =
      typeof args.backend === 'string' && args.backend !== '' ? args.backend : ctx.defaultBackend || 'vfs'
    commandText = command

    // ① 远程后端在线预检（不在线直接 error，不进审批）
    if (backend !== 'vfs') {
      const row = await dbFirst<{ id: string; status: string; enabled: number }>(
        env.DB,
        'SELECT id, status, enabled FROM exec_backends WHERE id = ? AND user_id = ?',
        [backend, ctx.userId],
      )
      if (!row || row.enabled !== 1 || row.status !== 'online') {
        return { aborted: false, blocked: true, message: `执行后端不在线或不可用：${backend}` }
      }
    }

    // ② 危险规则 + 会话放行名单
    const rule = matchDanger(command)
    if (rule) {
      const allowList = await loadAllowList(env, ctx.conversationId)
      if (!allowList.includes(rule.pattern)) {
        needsApproval = true
        reason = `命中危险规则「${rule.label}」`
      }
    }
  }

  if (ctx.call.name === 'write_file') {
    const path = typeof args.path === 'string' ? args.path : ''
    commandText = path
    if (await vfsPathExists(env, ctx.workspaceId, path)) {
      needsApproval = true
      reason = '目标文件已存在，覆盖需确认'
    }
  }

  if (!needsApproval) {
    return { aborted: false, blocked: false, message: '' }
  }

  // 建审批行 + 下发请求 + 轮询等待（不自动放行）
  const approvalId = newId('apr_')
  await dbRun(
    env.DB,
    'INSERT INTO approvals (id, conversation_id, user_id, tool_name, arguments, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [approvalId, ctx.conversationId, ctx.userId, ctx.call.name, ctx.call.arguments, reason, 'pending', nowIso()],
  )
  await setConversationStatus(env, ctx.conversationId, 'awaiting_approval')
  send(SSE_EVENTS.APPROVAL_REQUEST, {
    approvalId,
    toolName: ctx.call.name,
    command: commandText,
    reason,
  })

  const outcome = await awaitApproval(env, ctx.conversationId, approvalId, ctx.signal)
  if (outcome.aborted) {
    return { aborted: true, blocked: true, message: '已被用户中止' }
  }
  send(SSE_EVENTS.APPROVAL_RESOLVED, { approvalId, decision: outcome.decision })
  await setConversationStatus(env, ctx.conversationId, 'streaming')

  await writeAuditLog(env, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    action: 'approval',
    target: ctx.call.name,
    backend: 'vfs',
    risk: 'dangerous',
    result: outcome.decision === 'approved' ? 'success' : 'rejected',
    detail: reason,
  })

  if (outcome.decision === 'rejected') {
    return { aborted: false, blocked: true, message: '用户已拒绝执行该操作' }
  }
  return { aborted: false, blocked: false, message: '' }
}

/** 工具执行审计（file_write / exec_command，按 §4.1 action 词表） */
async function auditToolExecution(
  env: Env,
  input: {
    userId: string
    workspaceId: string
    defaultBackend: string
    call: ToolCall
    ok: boolean
  },
): Promise<void> {
  const args = safeParseObject(input.call.arguments)
  if (input.call.name === 'write_file' || input.call.name === 'edit_file') {
    await writeAuditLog(env, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      action: 'file_write',
      target: typeof args.path === 'string' ? args.path : '',
      backend: 'vfs',
      risk: 'normal',
      result: input.ok ? 'success' : 'failure',
    })
    return
  }
  if (input.call.name === 'run_command') {
    const command = typeof args.command === 'string' ? args.command : ''
    const backend =
      typeof args.backend === 'string' && args.backend !== '' ? args.backend : input.defaultBackend || 'vfs'
    const rule = matchDanger(command)
    await writeAuditLog(env, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      action: 'exec_command',
      target: command,
      backend,
      risk: rule ? 'dangerous' : 'normal',
      result: input.ok ? 'success' : 'failure',
    })
  }
}

/** 工具执行（异常重试 1 次，§7.3 ToolExec --> Error） */
async function executeToolWithRetry(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  try {
    return await executeTool(call, ctx)
  } catch {
    try {
      return await executeTool(call, ctx)
    } catch (err) {
      return { ok: false, output: `工具执行失败：${err instanceof Error ? err.message : '未知错误'}` }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 参数提取小助手                                                       */
/* ------------------------------------------------------------------ */

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 退化为空对象
  }
  return {}
}

/** 判断 VFS 路径是否已存在（供 write_file 覆盖审批判定；非法路径按不存在处理） */
async function vfsPathExists(env: Env, workspaceId: string, path: string): Promise<boolean> {
  if (path === '') {
    return false
  }
  try {
    const node = await resolvePathNode(env, workspaceId, path)
    return node !== null
  } catch (err) {
    // 路径越界等非法输入按「不存在」处理，交由工具执行层报错
    if (isHttpError(err) && err.code === 'VALIDATION_ERROR') {
      return false
    }
    // VfsPathError 为普通 Error 子类，上面的 isHttpError 守卫识别不到，
    // 若不拦截会逃逸审批门导致 SSE 流以 INTERNAL 错误终止
    if (err instanceof VfsPathError) {
      return false
    }
    throw err
  }
}
