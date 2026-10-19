/**
 * 渡劫code 前端 API 客户端（架构文档 §3.3 #14，契约见 §5）。
 *
 * 职责：
 * 1. JSON fetch 封装：请求/响应均为 camelCase JSON，错误归一化为 ApiError（§5.1）；
 * 2. SSE 流式读取器：按 `event:` / `data:` 行解析，支持 keep-alive 注释行（§5.3）；
 * 3. TerminalSocket：WSS 封装（onData / onExit / onError / onClose），
 *    JSON 行协议 + base64 编解码，断线指数退避重连（§5.4 / §8.3）。
 *
 * 所有 HTTP 请求均 `credentials: 'include'`（HttpOnly Cookie `dj_session`）。
 */
import type { AgentWsMessage } from '@shared/types'

/** 服务端错误响应体（§5.1）：字段可能缺失，归一化时逐一兜底 */
interface ApiErrorBody {
  code?: unknown
  message?: unknown
  details?: unknown
}

/** HTTP 状态码 → 默认错误码（§5.1 错误码表；响应体带 code 时以响应体为准） */
function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR'
    case 401:
      return 'UNAUTHORIZED'
    case 403:
      return 'FORBIDDEN'
    case 404:
      return 'NOT_FOUND'
    case 409:
      return 'NAME_TAKEN'
    case 429:
      return 'RATE_LIMITED'
    case 502:
      return 'UPSTREAM_ERROR'
    default:
      return 'INTERNAL'
  }
}

/** 网络层失败提示（脱敏，不暴露底层原因） */
const NETWORK_ERROR_MESSAGE = '网络连接失败，请检查网络后重试'

/**
 * API 基址（§12-D2 国内外分流）：
 * - 默认空串 = 同源相对路径（Worker / CF Pages 同源部署时）；
 * - 静态镜像站（GitHub Pages / Gitee Pages）构建时经 `VITE_API_BASE`
 *   指向 Worker 绝对地址，使镜像站页面可跨源调用后端。
 */
const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

/** 拼接 API 基址与相对路径（去重斜杠） */
function apiUrl(path: string): string {
  return path.startsWith('/') ? `${API_BASE}${path}` : `${API_BASE}/${path}`
}

/**
 * 归一化 API 错误（§5.1）。
 * 与共享类型 `ApiError`（shared/types.ts）结构一致：{code, message, details?}。
 */
export class ApiError extends Error {
  /** 机器可读错误码，如 EMAIL_TAKEN / RATE_LIMITED */
  readonly code: string
  /** 附加详情（可选） */
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = details
  }
}

/** 将非 2xx 响应归一化为 ApiError；响应体非法时按状态码兜底 */
async function toApiError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null
  try {
    body = (await res.json()) as ApiErrorBody
  } catch {
    body = null
  }
  const code = typeof body?.code === 'string' ? body.code : statusToCode(res.status)
  const message =
    typeof body?.message === 'string' && body.message
      ? body.message
      : `请求失败（HTTP ${res.status}）`
  return new ApiError(code, message, body?.details)
}

/** 单次 JSON 请求参数 */
interface RequestOptions {
  method?: string
  json?: unknown
  signal?: AbortSignal
}

/**
 * 通用 JSON 请求：自动序列化请求体、归一化错误、解析响应。
 * 204 响应返回 undefined；调用方按需断言类型。
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', json, signal } = options
  const headers = new Headers({ Accept: 'application/json' })
  let body: string | undefined
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(json)
  }
  let res: Response
  try {
    res = await fetch(apiUrl(path), { method, headers, body, credentials: 'include', signal })
  } catch {
    throw new ApiError('INTERNAL', NETWORK_ERROR_MESSAGE)
  }
  if (!res.ok) {
    throw await toApiError(res)
  }
  if (res.status === 204) {
    return undefined as T
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/**
 * JSON API 门面（§5.2 端点总表）。
 * 全部请求携带 HttpOnly Cookie；错误统一抛 ApiError。
 */
export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> =>
    request<T>(path, { signal }),
  post: <T>(path: string, json?: unknown, signal?: AbortSignal): Promise<T> =>
    request<T>(path, { method: 'POST', json, signal }),
  put: <T>(path: string, json?: unknown): Promise<T> =>
    request<T>(path, { method: 'PUT', json }),
  patch: <T>(path: string, json?: unknown): Promise<T> =>
    request<T>(path, { method: 'PATCH', json }),
  del: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
}

/** SSE 数据帧：事件名 + 解析后的 data JSON（§5.3 / §11） */
export interface SSEFrame<T = unknown> {
  /** `event:` 行内容；缺省为 `message` */
  event: string
  /** `data:` 行拼接后 JSON.parse 的结果 */
  data: T
}

/**
 * SSE 流式读取器（§5.3）。
 *
 * - 适用于 `POST /api/conversations/:id/messages`（Agent 事件流）与
 *   `POST /api/workspaces/:id/exec`（手动终端 output/exit/error 流）；
 * - 按行解析：`event:` / `data:` / 空行派发；`:` 开头为 keep-alive 注释行，忽略；
 * - 泛型 T 由调用方指定（如 Agent 流可传 `SSEEvent['data']`）；
 * - 断线时抛 ApiError（网络层）或由 onEvent 消费方自行处理半途流。
 */
export async function streamSSE<T = unknown>(
  path: string,
  json: unknown,
  onEvent: (frame: SSEFrame<T>) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(json ?? {}),
      credentials: 'include',
      signal,
    })
  } catch {
    throw new ApiError('INTERNAL', NETWORK_ERROR_MESSAGE)
  }
  if (!res.ok) {
    throw await toApiError(res)
  }
  if (!res.body) {
    throw new ApiError('INTERNAL', '响应不含数据流')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  let dataLines: string[] = []

  /** 空行到达时派发一帧；无 data 行则仅重置事件名 */
  const dispatch = (): void => {
    const name = eventName || 'message'
    const raw = dataLines.join('\n')
    eventName = 'message'
    dataLines = []
    if (!raw) {
      return
    }
    let data: T
    try {
      data = JSON.parse(raw) as T
    } catch {
      return // 跳过无法解析的数据帧（如异常文本），不中断流
    }
    onEvent({ event: name, data })
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (line === '') {
          dispatch()
        } else if (line.startsWith(':')) {
          // keep-alive 注释行（§5.3：每 15 秒），忽略
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
        idx = buffer.indexOf('\n')
      }
    }
    dispatch() // 流结束：补发未以空行闭合的最后一帧
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ */
/* TerminalSocket：浏览器 ⇄ DO TerminalRoom 的 WSS 封装（§5.4 / §8.3）  */
/* ------------------------------------------------------------------ */

/** 字节数组 → base64（分块拼接，避免展开运算符触发调用栈上限） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** base64 → 字节数组 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** TerminalSocket 事件处理器（协议帧 → 前端回调，§5.4） */
export interface TerminalSocketHandlers {
  /** 连接建立（含重连成功） */
  onOpen?: () => void
  /** `data` 帧：stdout/stderr 字节流（已 base64 解码） */
  onData?: (id: string, bytes: Uint8Array) => void
  /** `exit` 帧：会话退出码 */
  onExit?: (id: string, code: number) => void
  /** `error` 帧：代理侧错误通知 */
  onError?: (message: string, id?: string) => void
  /** `hello` 帧：代理自述（版本 / 主机名 / 平台） */
  onHello?: (info: { version: string; hostname: string; platform: string }) => void
  /** 连接最终关闭（用户主动关闭或重连耗尽） */
  onClose?: (info: { code: number; reason: string }) => void
}

/** 断线重连退避序列（§8.3：1s → 2s → … → 30s 封顶） */
const RECONNECT_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000]

/**
 * 终端 WebSocket 客户端（§5.4 JSON 行协议）。
 *
 * - URL：`/api/terminal/connect?backendId=`（Cookie JWT 鉴权，同源自动携带）；
 * - 收发均为「一帧一个 JSON 对象 + \n」，二进制字段 base64 编解码；
 * - 收到 `ping` 自动回 `pong`；异常断线按指数退避自动重连同一房间；
 * - 重连成功后 DO 房间不变，已 spawn 的 shell 进程在服务器侧保留（§8.2）。
 */
export class TerminalSocket {
  private readonly backendId: string
  private readonly handlers: TerminalSocketHandlers
  private ws: WebSocket | null = null
  /** 用户主动关闭后不再重连 */
  private closedByUser = false
  /** 已连续重连次数（用于退避取阶） */
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(backendId: string, handlers: TerminalSocketHandlers) {
    this.backendId = backendId
    this.handlers = handlers
  }

  /** 建立（或重建）WebSocket 连接 */
  connect(): void {
    this.closedByUser = false
    this.openWs()
  }

  /** 当前是否处于 OPEN 状态 */
  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /** 主动关闭连接（不再重连） */
  close(code = 1000, reason = 'client close'): void {
    this.closedByUser = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.ws
    this.ws = null
    if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(code, reason)
    } else {
      // 连接已断开：补发 onClose，保证调用方 semantics 一致
      this.handlers.onClose?.({ code, reason })
    }
  }

  /** 发送一帧协议消息（JSON + 换行） */
  sendMessage(msg: AgentWsMessage): void {
    if (this.isOpen && this.ws !== null) {
      this.ws.send(`${JSON.stringify(msg)}\n`)
    }
  }

  /** 向会话写入 stdin（UTF-8 → base64 data 帧） */
  write(id: string, text: string): void {
    this.sendMessage({ type: 'data', id, data: bytesToBase64(new TextEncoder().encode(text)) })
  }

  /** 启动交互式 shell（PTY，默认 /bin/bash） */
  spawn(id: string, cols: number, rows: number, cmd?: string): void {
    this.sendMessage({ type: 'spawn', id, cols, rows, cmd })
  }

  /** 调整 PTY 窗口大小 */
  resize(id: string, cols: number, rows: number): void {
    this.sendMessage({ type: 'resize', id, cols, rows })
  }

  /** 终止会话（代理侧杀进程组） */
  kill(id: string): void {
    this.sendMessage({ type: 'kill', id })
  }

  /** 一次性命令执行（非交互；输出经 data 帧，结束经 exit 帧） */
  exec(id: string, command: string, timeoutSec?: number): void {
    this.sendMessage({ type: 'exec', id, command, timeoutSec })
  }

  /** 实际建立连接（内部）：配置了 API_BASE 时直连 Worker；否则按页面协议派生同源 wss:// */
  private openWs(): void {
    const target = `${API_BASE}/api/terminal/connect?backendId=${encodeURIComponent(this.backendId)}`
    const wsUrl = API_BASE
      ? target.replace(/^http/, 'ws')
      : `${globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${globalThis.location.host}${target}`
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    ws.onopen = (): void => {
      this.reconnectAttempt = 0
      this.handlers.onOpen?.()
    }
    ws.onmessage = (ev: MessageEvent): void => {
      if (typeof ev.data === 'string') {
        this.handleMessage(ev.data)
      }
    }
    ws.onerror = (): void => {
      // 错误细节不暴露给前端；统一由 onclose 走重连 / onClose 语义
    }
    ws.onclose = (ev: CloseEvent): void => {
      this.ws = null
      if (this.closedByUser) {
        this.handlers.onClose?.({ code: ev.code, reason: ev.reason })
        return
      }
      this.scheduleReconnect()
    }
  }

  /** 指数退避重连（同一房间 URL，§8.3） */
  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ]
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closedByUser) {
        this.openWs()
      }
    }, delay)
  }

  /** 解析一行（或一批）JSON 行协议帧并分发 */
  private handleMessage(raw: string): void {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      let msg: AgentWsMessage
      try {
        msg = JSON.parse(trimmed) as AgentWsMessage
      } catch {
        continue
      }
      this.dispatch(msg)
    }
  }

  /** 按帧类型分发到处理器；ping 自动回 pong */
  private dispatch(msg: AgentWsMessage): void {
    switch (msg.type) {
      case 'hello':
        this.handlers.onHello?.({
          version: msg.version,
          hostname: msg.hostname,
          platform: msg.platform,
        })
        break
      case 'data':
        this.handlers.onData?.(msg.id, base64ToBytes(msg.data))
        break
      case 'exit':
        this.handlers.onExit?.(msg.id, msg.code)
        break
      case 'error':
        this.handlers.onError?.(msg.message, msg.id)
        break
      case 'ping':
        this.sendMessage({ type: 'pong' })
        break
      case 'pong':
        break
      default:
        break
    }
  }
}
