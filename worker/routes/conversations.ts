/**
 * 会话与 Agent 路由（架构文档 §5.2「会话与 Agent」端点表 / §5.3 SSE 事件契约）。
 *
 * - 会话 CRUD 与消息历史（GET /api/conversations/:id）；
 * - POST /api/conversations/:id/messages：SSE Agent 流入口（接 agent/loop.ts），
 *   响应头 text/event-stream，每 15s keep-alive 注释行；
 * - POST abort（KV `abort:{id}`）、POST approvals/:id（含 alwaysAllow 放行名单）、
 *   GET approvals、GET /api/audit-logs。
 *
 * 本路由挂载于 `/api` 前缀（含 /workspaces/:id/conversations 与 /audit-logs）。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type {
  Approval,
  AuditLog,
  Conversation,
  Message,
  ToolCall,
} from '@shared/types'
import { ID_PREFIX } from '@shared/constants'
import {
  dbAll,
  dbFirst,
  dbRun,
  decryptSecret,
  httpError,
  newId,
  nowIso,
} from '../lib/core'
import type { AppEnv } from '../types'
import {
  formatSseFrame,
  runAgentLoop,
  sseResponseHeaders,
  readEnvVar,
  SSE_KEEPALIVE_COMMENT,
} from '../agent/loop'
import { matchDanger } from '../agent/tools'
import { readJsonObject, requiredString, requireWorkspace, type ProviderRow, type WorkspaceRow } from './workspaces'

/* ------------------------------------------------------------------ */
/* 行模型与视图转换                                                     */
/* ------------------------------------------------------------------ */

/** conversations 表原始行 */
interface ConversationRow {
  id: string
  workspace_id: string
  user_id: string
  title: string
  provider_id: string | null
  model: string
  status: Conversation['status']
  created_at: string
  updated_at: string
}

/** messages 表原始行 */
interface MessageRow {
  id: string
  conversation_id: string
  role: Message['role']
  content: string
  tool_calls: string | null
  tool_call_id: string | null
  name: string | null
  tokens_in: number
  tokens_out: number
  created_at: string
}

/** approvals 表原始行 */
interface ApprovalRow {
  id: string
  conversation_id: string
  user_id: string
  tool_name: string
  arguments: string
  reason: string
  status: Approval['status']
  decided_at: string | null
  created_at: string
}

/** audit_logs 表原始行 */
interface AuditLogRow {
  id: string
  user_id: string
  workspace_id: string | null
  action: string
  target: string
  backend: string
  risk: AuditLog['risk']
  result: AuditLog['result']
  detail: string
  created_at: string
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    providerId: row.provider_id,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMessage(row: MessageRow): Message {
  const message: Message = {
    id: row.id,
    role: row.role,
    content: row.content,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at,
  }
  if (row.tool_calls) {
    try {
      const parsed: unknown = JSON.parse(row.tool_calls)
      if (Array.isArray(parsed)) {
        message.toolCalls = parsed as ToolCall[]
      }
    } catch {
      // tool_calls 损坏时忽略，不影响消息主体
    }
  }
  if (row.tool_call_id) {
    message.toolCallId = row.tool_call_id
  }
  if (row.name) {
    message.name = row.name
  }
  return message
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    toolName: row.tool_name,
    arguments: row.arguments,
    reason: row.reason,
    status: row.status,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  }
}

function toAuditLog(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    action: row.action,
    target: row.target,
    backend: row.backend,
    risk: row.risk,
    result: row.result,
    detail: row.detail,
    createdAt: row.created_at,
  }
}

/** 安全 JSON 解析（失败返回 null） */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 归属校验                                                             */
/* ------------------------------------------------------------------ */

/** 加载会话并校验归属：不存在 → 404；不属于当前用户 → 403（§12-D10） */
async function requireConversation(c: Context<AppEnv>, conversationId: string): Promise<ConversationRow> {
  if (conversationId === '') {
    throw httpError('VALIDATION_ERROR', '缺少会话 ID', 400)
  }
  const row = await dbFirst<ConversationRow>(c.env.DB, 'SELECT * FROM conversations WHERE id = ?', [conversationId])
  if (!row) {
    throw httpError('NOT_FOUND', '会话不存在', 404)
  }
  if (row.user_id !== c.get('userId')) {
    throw httpError('FORBIDDEN', '无权访问该会话', 403)
  }
  return row
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

const conversationRoutes = new Hono<AppEnv>()

/** GET /api/workspaces/:id/conversations —— 200 {conversations:[...]} */
conversationRoutes.get('/workspaces/:id/conversations', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const rows = await dbAll<ConversationRow>(
    c.env.DB,
    'SELECT * FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC',
    [ws.id],
  )
  return c.json({ conversations: rows.map(toConversation) }, 200)
})

/** POST /api/workspaces/:id/conversations —— 201 {conversation} */
conversationRoutes.post('/workspaces/:id/conversations', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const body = await readJsonObject(c)
  const providerId = requiredString(body, 'providerId', '供应商 ID')
  const model = requiredString(body, 'model', '模型')
  const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim().slice(0, 100) : '新会话'

  // 供应商归属校验
  const provider = await dbFirst<Pick<ProviderRow, 'id'>>(
    c.env.DB,
    'SELECT id FROM providers WHERE id = ? AND user_id = ?',
    [providerId, c.get('userId')],
  )
  if (!provider) {
    throw httpError('NOT_FOUND', '供应商不存在', 404)
  }

  const now = nowIso()
  const row: ConversationRow = {
    id: newId(ID_PREFIX.conversation),
    workspace_id: ws.id,
    user_id: c.get('userId'),
    title,
    provider_id: providerId,
    model,
    status: 'idle',
    created_at: now,
    updated_at: now,
  }
  await dbRun(
    c.env.DB,
    'INSERT INTO conversations (id, workspace_id, user_id, title, provider_id, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      row.id,
      row.workspace_id,
      row.user_id,
      row.title,
      row.provider_id,
      row.model,
      row.status,
      row.created_at,
      row.updated_at,
    ],
  )
  return c.json({ conversation: toConversation(row) }, 201)
})

/** GET /api/conversations/:id —— 200 {conversation, messages:[Message]} */
conversationRoutes.get('/conversations/:id', async (c) => {
  const conv = await requireConversation(c, c.req.param('id'))
  const rows = await dbAll<MessageRow>(
    c.env.DB,
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
    [conv.id],
  )
  return c.json({ conversation: toConversation(conv), messages: rows.map(toMessage) }, 200)
})

/** DELETE /api/conversations/:id —— 204（显式级联删除消息与审批） */
conversationRoutes.delete('/conversations/:id', async (c) => {
  const conv = await requireConversation(c, c.req.param('id'))
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(conv.id),
    c.env.DB.prepare('DELETE FROM approvals WHERE conversation_id = ?').bind(conv.id),
    c.env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(conv.id),
  ])
  return c.body(null, 204)
})

/**
 * POST /api/conversations/:id/messages —— SSE Agent 流（§5.3）。
 * body：{content, providerId?, model?}；providerId / model 缺省沿用会话配置。
 */
conversationRoutes.post('/conversations/:id/messages', async (c) => {
  const conv = await requireConversation(c, c.req.param('id'))
  const body = await readJsonObject(c)
  const content = requiredString(body, 'content', '消息内容')
  const providerId =
    typeof body.providerId === 'string' && body.providerId.trim() !== '' ? body.providerId.trim() : conv.provider_id ?? ''
  const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : conv.model
  if (providerId === '') {
    throw httpError('VALIDATION_ERROR', '未指定供应商：请在请求体中传 providerId', 400)
  }
  if (model.trim() === '') {
    throw httpError('VALIDATION_ERROR', '未指定模型：请在请求体中传 model', 400)
  }

  const provider = await dbFirst<ProviderRow>(
    c.env.DB,
    'SELECT * FROM providers WHERE id = ? AND user_id = ?',
    [providerId, c.get('userId')],
  )
  if (!provider) {
    throw httpError('NOT_FOUND', '供应商不存在', 404)
  }
  if (provider.enabled !== 1) {
    throw httpError('VALIDATION_ERROR', '供应商已停用', 400)
  }
  const apiKey = await decryptSecret(provider.api_key_enc, c.env.ENCRYPTION_KEY)

  const workspace = await dbFirst<Pick<WorkspaceRow, 'default_backend'>>(
    c.env.DB,
    'SELECT default_backend FROM workspaces WHERE id = ?',
    [conv.workspace_id],
  )

  // 落库 user 消息 + 同步会话的 provider / model 配置
  const now = nowIso()
  await dbRun(
    c.env.DB,
    'INSERT INTO messages (id, conversation_id, role, content, tool_calls, tool_call_id, name, tokens_in, tokens_out, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [newId(ID_PREFIX.message), conv.id, 'user', content, null, null, null, 0, 0, now],
  )
  await dbRun(c.env.DB, 'UPDATE conversations SET provider_id = ?, model = ?, updated_at = ? WHERE id = ?', [
    providerId,
    model,
    now,
    conv.id,
  ])

  const messageId = newId(ID_PREFIX.message)
  const keepAliveMs = (() => {
    const parsed = Number.parseInt(readEnvVar(c.env, 'SSE_KEEPALIVE_SEC', '15'), 10)
    return (Number.isFinite(parsed) && parsed > 0 ? parsed : 15) * 1000
  })()

  const encoder = new TextEncoder()
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        try {
          controller.enqueue(encoder.encode(formatSseFrame(event, data)))
        } catch {
          // 客户端已断开：enqueue 失败时静默忽略
        }
      }
      // 每 15s 发送 keep-alive 注释行保活（审批挂起期间尤其重要）
      keepAliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(SSE_KEEPALIVE_COMMENT))
        } catch {
          // 客户端已断开：忽略
        }
      }, keepAliveMs)

      try {
        await runAgentLoop(
          {
            env: c.env,
            conversationId: conv.id,
            workspaceId: conv.workspace_id,
            userId: c.get('userId'),
            messageId,
            providerId,
            model,
            apiKey,
            protocol: provider.protocol as 'openai' | 'anthropic' | 'gemini' | 'custom',
            baseUrl: provider.base_url,
            defaultBackend: workspace?.default_backend ?? 'vfs',
            signal: c.req.raw.signal,
          },
          send,
        )
      } catch (err) {
        if ((err as { code?: unknown })?.code === 'UNAUTHORIZED') {
          send('error', { code: 'UNAUTHORIZED', message: '会话已失效，请重新登录' })
        } else {
          console.error(
            JSON.stringify({
              level: 'error',
              module: 'conversations',
              msg: 'Agent 循环异常终止',
              detail: err instanceof Error ? err.message : String(err),
            }),
          )
          send('error', { code: 'INTERNAL', message: '服务内部错误' })
        }
      } finally {
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer)
        }
        try {
          controller.close()
        } catch {
          // 已取消：忽略
        }
      }
    },
    cancel() {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer)
      }
    },
  })

  return new Response(stream, { headers: sseResponseHeaders() })
})

/** POST /api/conversations/:id/abort —— 204（写 KV `abort:{id}`，TTL 300s） */
conversationRoutes.post('/conversations/:id/abort', async (c) => {
  const conv = await requireConversation(c, c.req.param('id'))
  await c.env.KV.put(`abort:${conv.id}`, '1', { expirationTtl: 300 })
  // 无活跃循环时也立即落库终态；有活跃循环时由其自行覆盖为最终状态
  await dbRun(c.env.DB, 'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?', [
    'aborted',
    nowIso(),
    conv.id,
  ])
  return c.body(null, 204)
})

/**
 * POST /api/conversations/:id/approvals/:approvalId —— 200 {approval}。
 * body：{decision:'approve'|'reject', alwaysAllow?}；
 * alwaysAllow 且同意时，将命令模式串写入 KV `approval-allow:{conversationId}`（TTL 1h）。
 */
conversationRoutes.post('/conversations/:id/approvals/:approvalId', async (c) => {
  const conv = await requireConversation(c, c.req.param('id'))
  const approvalId = c.req.param('approvalId')
  const body = await readJsonObject(c)
  const decision = body.decision
  if (decision !== 'approve' && decision !== 'reject') {
    throw httpError('VALIDATION_ERROR', "decision 必须为 'approve' 或 'reject'", 400)
  }
  const alwaysAllow = body.alwaysAllow === true

  const approval = await dbFirst<ApprovalRow>(
    c.env.DB,
    'SELECT * FROM approvals WHERE id = ? AND conversation_id = ?',
    [approvalId, conv.id],
  )
  if (!approval) {
    throw httpError('NOT_FOUND', '审批不存在', 404)
  }
  if (approval.user_id !== c.get('userId')) {
    throw httpError('FORBIDDEN', '无权操作该审批', 403)
  }

  // 幂等：已决策的审批直接返回当前状态
  if (approval.status !== 'pending') {
    return c.json({ approval: toApproval(approval) }, 200)
  }

  const now = nowIso()
  await dbRun(c.env.DB, 'UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?', [
    decision === 'approve' ? 'approved' : 'rejected',
    now,
    approval.id,
  ])

  // 总是允许：写入会话放行名单（TTL 1h，§4.3 / §7.4）
  if (decision === 'approve' && alwaysAllow && approval.tool_name === 'run_command') {
    const args = safeJsonParse(approval.arguments)
    const command =
      typeof args === 'object' && args !== null && typeof (args as { command?: unknown }).command === 'string'
        ? (args as { command: string }).command
        : ''
    // 优先存储命中的危险规则模式串；未命中时退化为命令原文
    const rule = matchDanger(command)
    const pattern = rule ? rule.pattern : command
    if (pattern !== '') {
      const key = `approval-allow:${conv.id}`
      const existing = await c.env.KV.get(key)
      const list = (() => {
        const parsed = existing === null ? null : safeJsonParse(existing)
        return Array.isArray(parsed) ? (parsed as string[]) : []
      })()
      if (!list.includes(pattern)) {
        list.push(pattern)
      }
      await c.env.KV.put(key, JSON.stringify(list), { expirationTtl: 3600 })
    }
  }

  const updated = await dbFirst<ApprovalRow>(c.env.DB, 'SELECT * FROM approvals WHERE id = ?', [approval.id])
  if (!updated) {
    throw httpError('NOT_FOUND', '审批不存在', 404)
  }
  return c.json({ approval: toApproval(updated) }, 200)
})

/** GET /api/conversations/:id/approvals —— 200 {approvals:[...]} */
conversationRoutes.get('/conversations/:id/approvals', async (c) => {
  const conv = await requireConversation(c, c.req.param('id'))
  const rows = await dbAll<ApprovalRow>(
    c.env.DB,
    'SELECT * FROM approvals WHERE conversation_id = ? ORDER BY created_at DESC',
    [conv.id],
  )
  return c.json({ approvals: rows.map(toApproval) }, 200)
})

/** GET /api/audit-logs?limit=&offset= —— 200 {logs:[AuditLog], total} */
conversationRoutes.get('/audit-logs', async (c) => {
  const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10)
  const rawOffset = Number.parseInt(c.req.query('offset') ?? '', 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0

  const rows = await dbAll<AuditLogRow>(
    c.env.DB,
    'SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [c.get('userId'), limit, offset],
  )
  const totalRow = await dbFirst<{ total: number }>(
    c.env.DB,
    'SELECT COUNT(*) AS total FROM audit_logs WHERE user_id = ?',
    [c.get('userId')],
  )
  return c.json({ logs: rows.map(toAuditLog), total: totalRow?.total ?? 0 }, 200)
})

export default conversationRoutes
