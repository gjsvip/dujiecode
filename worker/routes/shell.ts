/**
 * 手动命令执行分发（架构文档 §3.4 #37 / §12-D4）。
 *
 * 路由注册于 `/api/workspaces` 前缀下（与 workspaceRoutes 同挂载点，互不冲突）：
 *   POST /api/workspaces/:id/exec —— 契约 §5.2「手动终端执行」，SSE 输出流。
 *
 * 分发规则：
 * - backend=vfs → 虚拟 Shell（vfs/shell.ts）执行，按 32KB 分片输出；
 * - 其他 backend → DO TerminalRoom `/exec` 中继（远程执行后端），汇总后一次性输出；
 * - 危险命令手动执行直接拒绝（403 DANGEROUS_COMMAND）并写审计（§12-D4）；
 * - term 限流 120 次 / 分 / 工作区（§4.3 KV 滑动窗口）。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { RATE_LIMITS } from '@shared/constants'
import { dbFirst, httpError } from '../lib/core'
import type { AppEnv } from '../types'
import { VirtualShell } from '../vfs/shell'
import { matchDanger, writeAuditLog } from '../agent/tools'
import { execOnBackend } from './backends'
import { readJsonObject, requiredString, requireWorkspace } from './workspaces'

/* ------------------------------------------------------------------ */
/* SSE 助手（终端事件集合：output / exit / error，与 §5.3 对话事件不同）   */
/* ------------------------------------------------------------------ */

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** SSE 响应头（§5.3 通用约定） */
const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  'x-accel-buffering': 'no',
}

/** 单次 output 事件的最大字符数（约 32KB 分片，避免超长输出单帧过大） */
const OUTPUT_CHUNK_CHARS = 32 * 1024

/** term 限流 KV 计数 TTL（秒）：120s 覆盖前后两个分钟桶，保证窗口滑动 */
const TERM_RATE_TTL_SEC = 120

/**
 * term 限流：120 次 / 分 / 工作区（KV `ratelimit:term:{workspaceId}:{minuteBucket}`，§4.3）。
 * 超限返回带 Retry-After 的 429 响应；未超限计数 +1。
 */
async function checkTermRateLimit(c: Context<AppEnv>, workspaceId: string): Promise<Response | undefined> {
  const bucket = Math.floor(Date.now() / (RATE_LIMITS.term.windowSec * 1000))
  const key = `ratelimit:term:${workspaceId}:${bucket}`
  const raw = await c.env.KV.get(key)
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10)
  const used = Number.isFinite(parsed) ? parsed : 0
  if (used >= RATE_LIMITS.term.limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil(((bucket + 1) * RATE_LIMITS.term.windowSec * 1000 - Date.now()) / 1000),
    )
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ code: 'RATE_LIMITED', message: '终端命令执行过于频繁，请稍后再试' }, 429)
  }
  await c.env.KV.put(key, String(used + 1), { expirationTtl: TERM_RATE_TTL_SEC })
  return undefined
}

/* ------------------------------------------------------------------ */
/* 执行分发                                                             */
/* ------------------------------------------------------------------ */

/**
 * 手动命令执行分发（危险校验 → 限流 → vfs / DO → 审计 → SSE 组装）。
 * 供 POST /api/workspaces/:id/exec 复用。
 */
export async function streamCommandExec(
  c: Context<AppEnv>,
  params: { workspaceId: string; command: string; backend: string; userId: string },
): Promise<Response> {
  const { workspaceId, command, backend, userId } = params

  // ① 限流（先于一切执行）
  const limited = await checkTermRateLimit(c, workspaceId)
  if (limited) {
    return limited
  }

  // ② 危险命令手动执行直接拒绝（§12-D4），并写审计
  const rule = matchDanger(command)
  if (rule) {
    await writeAuditLog(c.env, {
      userId,
      workspaceId,
      action: 'exec_command',
      target: command,
      backend,
      risk: 'dangerous',
      result: 'rejected',
      detail: rule.label,
    })
    throw httpError(
      'DANGEROUS_COMMAND',
      `命令命中危险规则「${rule.label}」，手动执行已被拒绝；如需执行请通过 AI 对话审批流程`,
      403,
    )
  }

  // ③ 远程后端归属 + 在线校验（vfs 无需校验）
  if (backend !== 'vfs') {
    const row = await dbFirst<{ id: string; status: string; enabled: number }>(
      c.env.DB,
      'SELECT id, status, enabled FROM exec_backends WHERE id = ? AND user_id = ?',
      [backend, userId],
    )
    if (!row) {
      throw httpError('NOT_FOUND', '执行后端不存在', 404)
    }
    if (row.enabled !== 1) {
      throw httpError('VALIDATION_ERROR', '执行后端已停用', 400)
    }
    if (row.status !== 'online') {
      throw httpError('UPSTREAM_ERROR', '执行后端不在线', 502)
    }
  }

  // ④ 执行：vfs 虚拟 Shell / 远程 DO 中继
  let output = ''
  let exitCode = 0
  let clear = false
  if (backend === 'vfs') {
    const shell = new VirtualShell(c.env)
    const result = await shell.execute(command, workspaceId)
    output = result.output
    exitCode = result.exitCode
    clear = result.clear === true
  } else {
    const relay = await execOnBackend(c.env, backend, command)
    output = relay.output
    exitCode = relay.ok ? relay.exitCode : -1
    if (output === '') {
      output = relay.ok ? '' : '远程执行失败'
    }
  }

  // ⑤ 审计（成功 / 失败均记录）
  await writeAuditLog(c.env, {
    userId,
    workspaceId,
    action: 'exec_command',
    target: command,
    backend,
    risk: 'normal',
    result: exitCode === 0 ? 'success' : 'failure',
  })

  // ⑥ SSE 组装：output（分片，可含 clear 标记）+ exit
  const frames: string[] = []
  if (clear) {
    frames.push(sseFrame('output', { text: '', clear: true }))
  } else if (output === '') {
    frames.push(sseFrame('output', { text: '' }))
  } else {
    for (let i = 0; i < output.length; i += OUTPUT_CHUNK_CHARS) {
      frames.push(sseFrame('output', { text: output.slice(i, i + OUTPUT_CHUNK_CHARS) }))
    }
  }
  frames.push(sseFrame('exit', { code: exitCode }))
  return new Response(frames.join(''), { headers: SSE_HEADERS })
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

const shellRoutes = new Hono<AppEnv>()

/**
 * POST /api/workspaces/:id/exec —— 手动终端执行（SSE：output / exit / error）。
 * body：{command, backend?}；backend 缺省用工作区 defaultBackend。
 */
shellRoutes.post('/:id/exec', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const body = await readJsonObject(c)
  const command = requiredString(body, 'command', '命令')
  const rawBackend = body.backend
  const backend =
    typeof rawBackend === 'string' && rawBackend.trim() !== '' ? rawBackend.trim() : ws.default_backend
  return streamCommandExec(c, { workspaceId: ws.id, command, backend, userId: c.get('userId') })
})

export default shellRoutes
