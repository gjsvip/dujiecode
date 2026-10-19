/**
 * Durable Object TerminalRoom（架构文档 §3.4 #42 / §8.2 连接与房间模型）。
 *
 * 房间 = backendId（一个后端一个房间，天然单点串行）：
 * - 持有 agent WebSocket（用户服务器的 Python 代理主动外连）+ 多浏览器 WebSocket；
 * - 消息中继：hello / exec / spawn / data / resize / kill / exit / error /
 *   ping / pong（JSON 行协议 §5.4，二进制字段一律 base64）；
 * - agent 在线状态落 D1 exec_backends（连接 / 断开时更新）；
 * - 内部 fetch `/exec`：供 Worker 中继执行（等 data 汇总 + exit，超时 120s）。
 *
 * 鉴权：代理连接验 sha256(token)（先查 KV `backend-token:` 缓存，未命中查 D1
 * agent_tokens 且 revoked=0）；浏览器连接的 JWT 鉴权与归属校验由 Worker 路由
 * （routes/backends.ts）在转发前完成，DO 侧信任同源 Worker 的校验结果。
 */
import { DurableObject } from 'cloudflare:workers'
import type { AgentWsMessage } from '@shared/types'
import { dbFirst, dbRun, newId, nowIso, sha256Hex } from '../worker/lib/core'
import type { Env } from '../worker/types'

/** 内部 /exec 中继等待器（Worker → DO → 代理 → 汇总返回） */
interface ExecWaiter {
  /** base64 data 帧解码后的文本分片 */
  chunks: string[]
  resolve: (result: { output: string; exitCode: number; timedOut: boolean }) => void
  settled: boolean
  timer: ReturnType<typeof setTimeout>
}

/** DO 内部 /exec 超时（秒，§8.2：超时 120s） */
const EXEC_TIMEOUT_SEC = 120

/** 统一 JSON 错误响应 */
function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 判断是否为 WebSocket 升级请求 */
function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get('Upgrade') ?? '').toLowerCase() === 'websocket'
}

/** base64 → UTF-8 文本（§5.4：二进制字段一律 base64） */
function base64ToUtf8(base64: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

/** 安全发送（连接已关闭时静默失败） */
function safeSend(ws: WebSocket | null | undefined, frame: string): void {
  if (!ws) {
    return
  }
  try {
    ws.send(frame)
  } catch {
    // 连接已关闭：忽略
  }
}

export class TerminalRoom extends DurableObject<Env> {
  /** 服务器代理连接（每房间至多一个） */
  private agent: WebSocket | null = null
  /** 当前代理连接对应的后端 ID */
  private agentBackendId: string | null = null
  /** 浏览器连接集合（多标签共享同一房间） */
  private readonly browsers = new Map<string, WebSocket>()
  /** 会话 ID（spawn / exec）→ 发起方浏览器 sessionId（数据帧按此回路由） */
  private readonly sessionOwners = new Map<string, string>()
  /** 内部 /exec 中继等待器 */
  private readonly execWaiters = new Map<string, ExecWaiter>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  /* ------------------------------------------------------------------ */
  /* fetch 路由                                                          */
  /* ------------------------------------------------------------------ */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // 内部执行接口（Worker stub.fetch，非 WebSocket）
    if (request.method === 'POST' && url.pathname === '/exec') {
      return this.handleInternalExec(request)
    }
    // 服务器代理连接（token 鉴权在 DO 内完成）
    if (url.pathname === '/api/agent/connect') {
      return this.handleAgentConnect(request, url)
    }
    // 浏览器连接（JWT + 归属校验由 Worker 路由完成）
    if (url.pathname === '/api/terminal/connect') {
      return this.handleBrowserConnect(request)
    }
    return jsonError('NOT_FOUND', '未知的 DO 路由', 404)
  }

  /* ------------------------------------------------------------------ */
  /* 代理（agent）连接                                                   */
  /* ------------------------------------------------------------------ */

  private async handleAgentConnect(request: Request, url: URL): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return jsonError('VALIDATION_ERROR', '需要 WebSocket 升级', 426)
    }
    const token = url.searchParams.get('token') ?? ''
    const backendId = url.searchParams.get('backendId') ?? ''
    if (token === '' || backendId === '') {
      return jsonError('VALIDATION_ERROR', '缺少 backendId 或 token 参数', 400)
    }

    const auth = await this.authenticateAgent(token, backendId)
    if (!auth.ok) {
      // token 存在但已吊销时可归属用户：记录失败审计（§4.1 agent_auth_fail）
      if (auth.userId) {
        await this.writeConnectAudit(auth.userId, backendId, 'agent_auth_fail', 'failure')
      }
      return jsonError('UNAUTHORIZED', 'agent token 无效或已吊销', 401)
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()

    // 替换旧代理连接（重连场景：旧连接先关闭）
    if (this.agent) {
      try {
        this.agent.close(1000, 'replaced by new agent connection')
      } catch {
        // 旧连接可能已断开：忽略
      }
    }
    this.agent = server
    this.agentBackendId = backendId

    server.addEventListener('message', (event: Event) => {
      void this.onAgentMessage(event)
    })
    server.addEventListener('close', () => {
      void this.onAgentClose()
    })
    server.addEventListener('error', () => {
      void this.onAgentClose()
    })

    await this.markBackendStatus(backendId, 'online')
    if (auth.userId) {
      await this.writeConnectAudit(auth.userId, backendId, 'backend_connect', 'success')
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * 代理 token 鉴权：先查 KV `backend-token:{sha256Hex}` 缓存（TTL 300s），
   * 未命中查 D1 agent_tokens 且 revoked = 0；命中后回写缓存并刷新 last_used_at。
   */
  private async authenticateAgent(
    token: string,
    backendId: string,
  ): Promise<{ ok: boolean; userId?: string }> {
    const tokenHash = await sha256Hex(token)
    const cached = await this.env.KV.get(`backend-token:${tokenHash}`)
    if (cached !== null) {
      return cached === backendId ? { ok: true } : { ok: false }
    }
    const row = await dbFirst<{ id: string; backend_id: string; revoked: number; user_id: string }>(
      this.env.DB,
      'SELECT t.id, t.backend_id, t.revoked, b.user_id FROM agent_tokens t JOIN exec_backends b ON b.id = t.backend_id WHERE t.token_hash = ?',
      [tokenHash],
    )
    if (!row || row.revoked !== 0 || row.backend_id !== backendId) {
      return { ok: false, userId: row?.user_id }
    }
    await this.env.KV.put(`backend-token:${tokenHash}`, backendId, { expirationTtl: 300 })
    await dbRun(this.env.DB, 'UPDATE agent_tokens SET last_used_at = ? WHERE id = ?', [nowIso(), row.id])
    return { ok: true, userId: row.user_id }
  }

  /* ------------------------------------------------------------------ */
  /* 浏览器连接                                                          */
  /* ------------------------------------------------------------------ */

  private async handleBrowserConnect(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return jsonError('VALIDATION_ERROR', '需要 WebSocket 升级', 426)
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()

    const sessionId = newId('ses_')
    this.browsers.set(sessionId, server)
    server.addEventListener('message', (event: Event) => {
      void this.onBrowserMessage(sessionId, event)
    })
    server.addEventListener('close', () => {
      this.onBrowserClose(sessionId)
    })
    server.addEventListener('error', () => {
      this.onBrowserClose(sessionId)
    })
    return new Response(null, { status: 101, webSocket: client })
  }

  /* ------------------------------------------------------------------ */
  /* 内部 /exec 中引（Worker → DO → 代理）                                */
  /* ------------------------------------------------------------------ */

  private async handleInternalExec(request: Request): Promise<Response> {
    let body: { command?: unknown; timeoutSec?: unknown }
    try {
      body = (await request.json()) as { command?: unknown; timeoutSec?: unknown }
    } catch {
      return jsonError('VALIDATION_ERROR', '请求体不是合法的 JSON', 400)
    }
    const command = typeof body.command === 'string' ? body.command : ''
    if (command === '') {
      return jsonError('VALIDATION_ERROR', '缺少 command 参数', 400)
    }
    if (!this.agent) {
      return jsonError('UPSTREAM_ERROR', '执行后端不在线', 502)
    }
    const timeoutSec =
      typeof body.timeoutSec === 'number' && body.timeoutSec > 0
        ? Math.min(Math.floor(body.timeoutSec), EXEC_TIMEOUT_SEC)
        : EXEC_TIMEOUT_SEC

    const id = newId('exec_')
    const result = await new Promise<{ output: string; exitCode: number; timedOut: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        const waiter = this.execWaiters.get(id)
        if (waiter && !waiter.settled) {
          waiter.settled = true
          this.execWaiters.delete(id)
          // 尽力通知代理终止该命令
          safeSend(this.agent, JSON.stringify({ type: 'kill', id } satisfies AgentWsMessage))
          resolve({ output: waiter.chunks.join(''), exitCode: -1, timedOut: true })
        }
      }, timeoutSec * 1000)
      this.execWaiters.set(id, { chunks: [], resolve, settled: false, timer })
      safeSend(
        this.agent,
        JSON.stringify({ type: 'exec', id, command, timeoutSec } satisfies AgentWsMessage),
      )
    })

    if (result.timedOut) {
      return jsonError('UPSTREAM_ERROR', `远程执行超时（${timeoutSec} 秒）`, 504)
    }
    return Response.json({ output: result.output, exitCode: result.exitCode })
  }

  /* ------------------------------------------------------------------ */
  /* 代理消息处理                                                        */
  /* ------------------------------------------------------------------ */

  private async onAgentMessage(event: Event): Promise<void> {
    const messageEvent = event as MessageEvent
    const raw = typeof messageEvent.data === 'string' ? messageEvent.data : ''
    if (raw === '') {
      return
    }
    let message: AgentWsMessage
    try {
      message = JSON.parse(raw) as AgentWsMessage
    } catch {
      return
    }

    switch (message.type) {
      case 'hello':
        // 连接首帧：广播给全部浏览器（展示代理版本 / 主机信息）
        this.broadcastToBrowsers(raw)
        break
      case 'ping':
        safeSend(this.agent, JSON.stringify({ type: 'pong' } satisfies AgentWsMessage))
        break
      case 'data': {
        const waiter = this.execWaiters.get(message.id)
        if (waiter && !waiter.settled) {
          waiter.chunks.push(base64ToUtf8(message.data))
          break
        }
        this.routeToSession(message.id, raw)
        break
      }
      case 'exit': {
        const waiter = this.execWaiters.get(message.id)
        if (waiter && !waiter.settled) {
          waiter.settled = true
          clearTimeout(waiter.timer)
          this.execWaiters.delete(message.id)
          waiter.resolve({ output: waiter.chunks.join(''), exitCode: message.code, timedOut: false })
          break
        }
        this.sessionOwners.delete(message.id)
        this.routeToSession(message.id, raw)
        break
      }
      case 'error': {
        const waiter = message.id !== undefined ? this.execWaiters.get(message.id) : undefined
        if (waiter && !waiter.settled) {
          waiter.settled = true
          clearTimeout(waiter.timer)
          this.execWaiters.delete(message.id as string)
          const suffix = message.message !== '' ? `\n${message.message}` : ''
          waiter.resolve({ output: waiter.chunks.join('') + suffix, exitCode: 1, timedOut: false })
          break
        }
        this.routeToSession(message.id ?? '', raw)
        break
      }
      case 'pong':
        break
      default:
        break
    }
  }

  private async onAgentClose(): Promise<void> {
    const backendId = this.agentBackendId
    this.agent = null
    this.agentBackendId = null

    // 未完成的内层 exec 全部以 -1 收尾，避免 Worker 侧永久挂起
    for (const [id, waiter] of this.execWaiters) {
      if (!waiter.settled) {
        waiter.settled = true
        clearTimeout(waiter.timer)
        waiter.resolve({ output: waiter.chunks.join(''), exitCode: -1, timedOut: false })
      }
      this.execWaiters.delete(id)
    }

    if (backendId) {
      await this.markBackendStatus(backendId, 'offline')
    }
    this.broadcastToBrowsers(JSON.stringify({ type: 'error', message: '执行代理连接已断开' } satisfies AgentWsMessage))
  }

  /* ------------------------------------------------------------------ */
  /* 浏览器消息处理                                                      */
  /* ------------------------------------------------------------------ */

  private async onBrowserMessage(sessionId: string, event: Event): Promise<void> {
    const messageEvent = event as MessageEvent
    const raw = typeof messageEvent.data === 'string' ? messageEvent.data : ''
    if (raw === '') {
      return
    }
    let message: AgentWsMessage
    try {
      message = JSON.parse(raw) as AgentWsMessage
    } catch {
      return
    }

    switch (message.type) {
      case 'ping':
        safeSend(this.browsers.get(sessionId), JSON.stringify({ type: 'pong' } satisfies AgentWsMessage))
        break
      case 'exec':
      case 'spawn': {
        if (!this.agent) {
          safeSend(
            this.browsers.get(sessionId),
            JSON.stringify({ type: 'error', id: message.id, message: '执行后端不在线' } satisfies AgentWsMessage),
          )
          break
        }
        // 登记会话归属：后续 data / exit 帧按此回路由到发起浏览器
        this.sessionOwners.set(message.id, sessionId)
        safeSend(this.agent, raw)
        break
      }
      case 'data':
      case 'resize':
      case 'kill':
        safeSend(this.agent, raw)
        break
      default:
        break
    }
  }

  private onBrowserClose(sessionId: string): void {
    this.browsers.delete(sessionId)
    // 清理该浏览器发起的会话归属
    for (const [id, owner] of this.sessionOwners) {
      if (owner === sessionId) {
        this.sessionOwners.delete(id)
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 中继与状态落库                                                      */
  /* ------------------------------------------------------------------ */

  /** 按会话 ID 回路由到发起浏览器；未登记时广播 */
  private routeToSession(sessionKey: string, frame: string): void {
    if (sessionKey !== '') {
      const owner = this.sessionOwners.get(sessionKey)
      if (owner) {
        safeSend(this.browsers.get(owner), frame)
        return
      }
    }
    this.broadcastToBrowsers(frame)
  }

  /** 广播给全部浏览器 */
  private broadcastToBrowsers(frame: string): void {
    for (const ws of this.browsers.values()) {
      safeSend(ws, frame)
    }
  }

  /** 更新 exec_backends 在线状态（§8.2：代理连接 / 断开时更新） */
  private async markBackendStatus(backendId: string, status: 'online' | 'offline'): Promise<void> {
    const now = nowIso()
    await dbRun(
      this.env.DB,
      'UPDATE exec_backends SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?',
      [status, now, now, backendId],
    )
  }

  /** 连接审计（backend_connect / agent_auth_fail） */
  private async writeConnectAudit(
    userId: string,
    backendId: string,
    action: string,
    result: 'success' | 'failure',
  ): Promise<void> {
    try {
      await dbRun(
        this.env.DB,
        'INSERT INTO audit_logs (id, user_id, workspace_id, action, target, backend, risk, result, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [newId('aud_'), userId, null, action, backendId, backendId, 'normal', result, '', nowIso()],
      )
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', module: 'terminal-room', msg: '审计写入失败', detail: String(err) }))
    }
  }
}
