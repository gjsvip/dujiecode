/**
 * 执行后端与终端路由（架构文档 §5.2「执行后端与终端」端点表 / §8.2 房间模型）。
 *
 * - 后端 CRUD 与 agent token 管理：token 以 SHA-256 哈希存储（§12-D2），
 *   明文仅在创建响应返回一次；
 * - WS 升级路由：`/api/terminal/connect`（浏览器，JWT 鉴权 + 归属校验后转 DO）、
 *   `/api/agent/connect`（Python 代理，token 校验在 DO 内完成）均转交
 *   `TERMINAL_ROOM.idFromName(backendId)` 房间；
 * - execOnBackend：Worker → DO 内部 `/exec` 中继（AI run_command 与手动终端共用）。
 */
import { Hono } from 'hono'
import type { ExecBackend, AgentTokenView } from '@shared/types'
import { ID_PREFIX } from '@shared/constants'
import { dbAll, dbFirst, dbRun, httpError, isUniqueConstraintError, newId, nowIso, sha256Hex } from '../lib/core'
import type { AppEnv, Env } from '../types'

/* ------------------------------------------------------------------ */
/* 行模型与视图转换                                                     */
/* ------------------------------------------------------------------ */

/** exec_backends 表原始行 */
interface BackendRow {
  id: string
  user_id: string
  name: string
  host: string
  status: 'online' | 'offline'
  last_seen_at: string | null
  enabled: number
  created_at: string
  updated_at: string
}

/** agent_tokens 表原始行 */
interface AgentTokenRow {
  id: string
  backend_id: string
  name: string
  token_hash: string
  last_used_at: string | null
  revoked: number
  created_at: string
}

function toExecBackend(row: BackendRow): ExecBackend {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    enabled: row.enabled === 1,
  }
}

function toAgentTokenView(row: AgentTokenRow): AgentTokenView {
  return {
    id: row.id,
    name: row.name,
    lastUsedAt: row.last_used_at,
    revoked: row.revoked === 1,
    createdAt: row.created_at,
  }
}

/* ------------------------------------------------------------------ */
/* 助手                                                                 */
/* ------------------------------------------------------------------ */

/** agent token 明文生成：`djt_` + 32 位 base62（创建时仅返回一次） */
function generateAgentToken(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let suffix = ''
  for (const byte of bytes) {
    suffix += alphabet[byte % alphabet.length]
  }
  return `djt_${suffix}`
}

/** 加载后端并校验归属：不存在 → 404；不属于当前用户 → 403（§12-D10） */
async function requireBackend(
  env: Env,
  userId: string,
  backendId: string,
): Promise<BackendRow> {
  if (backendId === '') {
    throw httpError('VALIDATION_ERROR', '缺少后端 ID', 400)
  }
  const row = await dbFirst<BackendRow>(env.DB, 'SELECT * FROM exec_backends WHERE id = ?', [backendId])
  if (!row) {
    throw httpError('NOT_FOUND', '执行后端不存在', 404)
  }
  if (row.user_id !== userId) {
    throw httpError('FORBIDDEN', '无权访问该执行后端', 403)
  }
  return row
}

/* ------------------------------------------------------------------ */
/* DO 中继：远程命令执行（AI run_command / 手动终端共用）                */
/* ------------------------------------------------------------------ */

/**
 * 经 DO TerminalRoom 中继执行远程命令：stub.fetch('/exec') → 向代理发 exec 帧 →
 * 汇总 data / exit → JSON 返回（超时 120s，§8.2）。
 */
export async function execOnBackend(
  env: Env,
  backendId: string,
  command: string,
  timeoutSec = 120,
): Promise<{ ok: boolean; output: string; exitCode: number }> {
  const stub = env.TERMINAL_ROOM.get(env.TERMINAL_ROOM.idFromName(backendId))
  try {
    const response = await stub.fetch('https://terminal-room.internal/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, timeoutSec }),
    })
    if (!response.ok) {
      let message = `远程执行失败（HTTP ${response.status}）`
      try {
        const body = (await response.json()) as { message?: unknown }
        if (typeof body.message === 'string' && body.message !== '') {
          message = body.message
        }
      } catch {
        // 响应体非 JSON：保留默认消息
      }
      return { ok: false, output: message, exitCode: -1 }
    }
    const data = (await response.json()) as { output?: unknown; exitCode?: unknown }
    return {
      ok: true,
      output: typeof data.output === 'string' ? data.output : '',
      exitCode: typeof data.exitCode === 'number' ? data.exitCode : 0,
    }
  } catch (err) {
    return {
      ok: false,
      output: `远程执行失败：${err instanceof Error ? err.message : '未知错误'}`,
      exitCode: -1,
    }
  }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

const backendRoutes = new Hono<AppEnv>()

/** GET /api/backends —— 200 {backends:[{id,name,host,status,lastSeenAt,enabled}]} */
backendRoutes.get('/backends', async (c) => {
  const rows = await dbAll<BackendRow>(
    c.env.DB,
    'SELECT * FROM exec_backends WHERE user_id = ? ORDER BY created_at DESC',
    [c.get('userId')],
  )
  return c.json({ backends: rows.map(toExecBackend) }, 200)
})

/** POST /api/backends —— 201 {backend, agentToken}（明文 token 仅此次返回） */
backendRoutes.post('/backends', async (c) => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    throw httpError('VALIDATION_ERROR', '请求体不是合法的 JSON', 400)
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '') {
    throw httpError('VALIDATION_ERROR', '后端名称不能为空', 400)
  }
  const host = typeof body.host === 'string' ? body.host.trim().slice(0, 200) : ''

  const now = nowIso()
  const backendId = newId(ID_PREFIX.backend)
  const token = generateAgentToken()
  const tokenHash = await sha256Hex(token)
  try {
    await dbRun(
      c.env.DB,
      'INSERT INTO exec_backends (id, user_id, name, host, status, last_seen_at, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [backendId, c.get('userId'), name.slice(0, 80), host, 'offline', null, 1, now, now],
    )
    await dbRun(
      c.env.DB,
      'INSERT INTO agent_tokens (id, backend_id, name, token_hash, last_used_at, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(ID_PREFIX.agentToken), backendId, 'default', tokenHash, null, 0, now],
    )
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw httpError('NAME_TAKEN', '同名执行后端已存在', 409)
    }
    throw err
  }
  const row = await dbFirst<BackendRow>(c.env.DB, 'SELECT * FROM exec_backends WHERE id = ?', [backendId])
  if (!row) {
    throw httpError('INTERNAL', '执行后端创建后读取失败', 500)
  }
  return c.json({ backend: toExecBackend(row), agentToken: token }, 201)
})

/** DELETE /api/backends/:id —— 204（agent_tokens 随外键级联删除） */
backendRoutes.delete('/backends/:id', async (c) => {
  await requireBackend(c.env, c.get('userId'), c.req.param('id'))
  await dbRun(c.env.DB, 'DELETE FROM exec_backends WHERE id = ?', [c.req.param('id')])
  return c.body(null, 204)
})

/** POST /api/backends/:id/tokens —— 201 {agentToken}（轮换：新建后可吊销旧 token） */
backendRoutes.post('/backends/:id/tokens', async (c) => {
  await requireBackend(c.env, c.get('userId'), c.req.param('id'))
  let body: Record<string, unknown> = {}
  try {
    body = await c.req.json()
  } catch {
    // 允许空体：token 名缺省为 default
  }
  const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 80) : 'default'
  const token = generateAgentToken()
  const tokenHash = await sha256Hex(token)
  await dbRun(
    c.env.DB,
    'INSERT INTO agent_tokens (id, backend_id, name, token_hash, last_used_at, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId(ID_PREFIX.agentToken), c.req.param('id'), name, tokenHash, null, 0, nowIso()],
  )
  return c.json({ agentToken: token }, 201)
})

/** GET /api/backends/:id/tokens —— 200 {tokens:[{id,name,lastUsedAt,revoked,createdAt}]} */
backendRoutes.get('/backends/:id/tokens', async (c) => {
  await requireBackend(c.env, c.get('userId'), c.req.param('id'))
  const rows = await dbAll<AgentTokenRow>(
    c.env.DB,
    'SELECT * FROM agent_tokens WHERE backend_id = ? ORDER BY created_at DESC',
    [c.req.param('id')],
  )
  return c.json({ tokens: rows.map(toAgentTokenView) }, 200)
})

/** DELETE /api/backends/:id/tokens/:tokenId —— 204（revoked=1；下次重连失效） */
backendRoutes.delete('/backends/:id/tokens/:tokenId', async (c) => {
  await requireBackend(c.env, c.get('userId'), c.req.param('id'))
  const tokenId = c.req.param('tokenId')
  const row = await dbFirst<AgentTokenRow>(
    c.env.DB,
    'SELECT * FROM agent_tokens WHERE id = ? AND backend_id = ?',
    [tokenId, c.req.param('id')],
  )
  if (!row) {
    throw httpError('NOT_FOUND', 'token 不存在', 404)
  }
  if (row.revoked !== 1) {
    await dbRun(c.env.DB, 'UPDATE agent_tokens SET revoked = 1 WHERE id = ?', [tokenId])
    // 同步清理 KV 缓存，使吊销立即对重连接生效
    await c.env.KV.delete(`backend-token:${row.token_hash}`)
  }
  return c.body(null, 204)
})

/**
 * GET /api/terminal/connect?backendId=（WS）—— 101 升级至 DO。
 * 浏览器侧：JWT 由入口中间件校验，此处追加后端归属校验后原样转发 Upgrade 请求。
 */
backendRoutes.get('/terminal/connect', async (c) => {
  const backendId = c.req.query('backendId') ?? ''
  await requireBackend(c.env, c.get('userId'), backendId)
  const stub = c.env.TERMINAL_ROOM.get(c.env.TERMINAL_ROOM.idFromName(backendId))
  // 原样转发（含 Upgrade 头与查询参数），由 DO 完成 WebSocket 接受
  return stub.fetch(c.req.raw)
})

/**
 * GET /api/agent/connect?backendId=&token=（WS）—— 101 升级至 DO。
 * 代理侧：token 哈希校验在 DO 内完成（KV 缓存 → D1 agent_tokens），此处仅做参数校验后转发。
 */
backendRoutes.get('/agent/connect', async (c) => {
  const backendId = c.req.query('backendId') ?? ''
  const token = c.req.query('token') ?? ''
  if (backendId === '' || token === '') {
    throw httpError('VALIDATION_ERROR', '缺少 backendId 或 token 参数', 400)
  }
  const stub = c.env.TERMINAL_ROOM.get(c.env.TERMINAL_ROOM.idFromName(backendId))
  return stub.fetch(c.req.raw)
})

export default backendRoutes
