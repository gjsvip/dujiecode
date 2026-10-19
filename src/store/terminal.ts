/**
 * 终端状态 Store（架构文档 §3.3 #18 / §6.3 terminal 行）。
 *
 * 状态：sessions / activeSessionId / sockets / backends；
 * action：openSession / closeSession / write / resize / kill / spawnShell /
 *         execVfs / loadBackends。
 *
 * 双模式（§6.3）：
 * - 虚拟 Shell：不走 WebSocket，经 POST /api/workspaces/:id/exec（SSE
 *   output/exit/error 流）执行，输出由 TerminalPanel 写入 xterm；
 * - 远程后端：TerminalSocket（WSS /api/terminal/connect?backendId=），
 *   JSON 行协议 + base64（§5.4），断线指数退避自动重连，重连成功后
 *   自动重发 spawn（同会话 ID）。
 *
 * Layout 持久化的当前后端从 localStorage['dujiecode.backend'] 读取
 * （与 Layout.tsx 共用同一键，避免循环依赖）。
 */
import { create } from 'zustand'
import { api, ApiError, streamSSE, TerminalSocket } from '../api'
import type { ExecBackend } from '@shared/types'

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

/** 终端会话 Tab（§6.3：{id,label,kind,backendId} + 连接态扩展） */
export interface TerminalSession {
  id: string
  label: string
  kind: 'vfs' | 'ssh'
  /** 'vfs' 或 exec_backends.id */
  backendId: string
  /** SSH：WebSocket 已连接（断线重连中为 false） */
  connected: boolean
  /** 是否已发起 spawn（重连成功后自动重发） */
  spawned: boolean
  /** 最近一次 PTY 尺寸（重连重发 spawn 时复用） */
  cols: number
  rows: number
  /** 代理 hello 自述（版本 / 主机名 / 平台） */
  hello: { version: string; hostname: string; platform: string } | null
  /** 断线 / shell 退出提示 */
  error: string | null
}

/** xterm 输出写入器注册表（模块级 Map，避免函数入 state） */
const writers = new Map<string, (bytes: Uint8Array) => void>()

/**
 * 注册 / 注销某会话的 xterm 写入器。
 * TerminalPanel 挂载 xterm 时注册，SSE/WS 数据经此写入终端。
 */
export function attachTerminalWriter(
  sessionId: string,
  writer: (bytes: Uint8Array) => void,
): () => void {
  writers.set(sessionId, writer)
  return () => {
    writers.delete(sessionId)
  }
}

/** 读取 Layout 持久化的默认执行后端（localStorage['dujiecode.backend']） */
export function readPersistedBackend(): string {
  try {
    return globalThis.localStorage.getItem('dujiecode.backend') ?? 'vfs'
  } catch {
    return 'vfs'
  }
}

/** 会话 ID 自增序列（模块级） */
let sessionSeq = 0

function nextSessionId(): string {
  sessionSeq += 1
  return `term_${Date.now().toString(36)}_${sessionSeq}`
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/** 终端 Store 状态与动作（§6.3） */
export interface TerminalState {
  /** 终端会话 Tab 列表 */
  sessions: TerminalSession[]
  /** 当前激活会话 ID */
  activeSessionId: string | null
  /** backendId → TerminalSocket（§6.3 sockets:Map；按会话 ID 索引） */
  sockets: Map<string, TerminalSocket>
  /** 执行后端列表（GET /api/backends，供后端选择与在线状态展示） */
  backends: ExecBackend[]
  backendsLoading: boolean

  /** GET /api/backends */
  loadBackends: () => Promise<void>
  /** 打开新会话 Tab；返回会话 ID。ssh 时立即建立 WSS 连接 */
  openSession: (kind: 'vfs' | 'ssh', backendId?: string) => string
  /** 关闭会话 Tab（ssh：先 kill 远程 shell 再关闭 socket） */
  closeSession: (id: string) => void
  /** 激活会话 Tab */
  setActiveSession: (id: string) => void
  /** 向会话写入 stdin（仅 ssh；UTF-8 → base64 data 帧） */
  write: (id: string, text: string) => void
  /** 调整 PTY 窗口大小（仅 ssh） */
  resize: (id: string, cols: number, rows: number) => void
  /** 终止远程 shell（仅 ssh；杀进程组由代理执行） */
  kill: (id: string) => void
  /** xterm 挂载后发起 spawn（重连成功时由 onOpen 自动重发） */
  spawnShell: (id: string, cols: number, rows: number) => void
  /** 虚拟 Shell：POST /api/workspaces/:id/exec（SSE output/exit/error） */
  execVfs: (
    workspaceId: string,
    command: string,
    handlers: {
      onOutput: (text: string, clear: boolean) => void
      onExit: (code: number) => void
      onError: (message: string) => void
    },
  ) => Promise<void>
}

/** 局部更新会话字段（模块级助手，供 socket 回调使用） */
function patchSession(id: string, patch: Partial<TerminalSession>): void {
  const sessions = useTerminalStore
    .getState()
    .sessions.map((s) => (s.id === id ? { ...s, ...patch } : s))
  useTerminalStore.setState({ sessions })
}

/** 终端 Store（§6.3：TerminalStore --> ApiClient） */
export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  sockets: new Map<string, TerminalSocket>(),
  backends: [],
  backendsLoading: false,

  loadBackends: async () => {
    set({ backendsLoading: true })
    try {
      const res = await api.get<{ backends: ExecBackend[] }>('/api/backends')
      set({ backends: res.backends, backendsLoading: false })
    } catch {
      // 后端列表拉取失败时保留内置虚拟 Shell 可用
      set({ backendsLoading: false })
    }
  },

  openSession: (kind: 'vfs' | 'ssh', backendId?: string) => {
    const id = nextSessionId()

    if (kind === 'vfs') {
      const session: TerminalSession = {
        id,
        label: '虚拟 Shell',
        kind: 'vfs',
        backendId: 'vfs',
        connected: true,
        spawned: false,
        cols: 80,
        rows: 24,
        hello: null,
        error: null,
      }
      set({ sessions: [...get().sessions, session], activeSessionId: id })
      return id
    }

    // 远程后端：缺省使用 Layout 持久化的当前后端
    const target = backendId ?? readPersistedBackend()
    const backend = get().backends.find((b) => b.id === target)
    const session: TerminalSession = {
      id,
      label: backend?.name ?? target,
      kind: 'ssh',
      backendId: target,
      connected: false,
      spawned: false,
      cols: 80,
      rows: 24,
      hello: null,
      error: null,
    }

    const socket = new TerminalSocket(target, {
      onOpen: () => {
        patchSession(id, { connected: true, error: null })
        // 重连成功：自动重发 spawn（同会话 ID，代理侧 shell 保留或重建）
        const current = get().sessions.find((s) => s.id === id)
        if (current?.spawned === true) {
          get().sockets.get(id)?.spawn(id, current.cols, current.rows)
        }
      },
      onData: (dataId, bytes) => {
        writers.get(dataId)?.(bytes)
      },
      onExit: (dataId, code) => {
        patchSession(dataId, { error: `shell 已退出（退出码 ${code}）` })
      },
      onError: (message) => {
        patchSession(id, { error: message })
      },
      onHello: (info) => {
        patchSession(id, { hello: info })
      },
      onClose: () => {
        patchSession(id, { connected: false })
      },
    })

    const sockets = new Map(get().sockets)
    sockets.set(id, socket)
    set({ sessions: [...get().sessions, session], activeSessionId: id, sockets })
    socket.connect()
    return id
  },

  closeSession: (id: string) => {
    const socket = get().sockets.get(id)
    if (socket !== undefined) {
      socket.kill(id) // 尽力终止远程 shell
      socket.close() // 主动关闭，不再重连
    }
    const sockets = new Map(get().sockets)
    sockets.delete(id)
    writers.delete(id)
    const sessions = get().sessions.filter((s) => s.id !== id)
    const activeSessionId =
      get().activeSessionId === id ? (sessions[sessions.length - 1]?.id ?? null) : get().activeSessionId
    set({ sessions, sockets, activeSessionId })
  },

  setActiveSession: (id: string) => {
    set({ activeSessionId: id })
  },

  write: (id: string, text: string) => {
    get().sockets.get(id)?.write(id, text)
  },

  resize: (id: string, cols: number, rows: number) => {
    patchSession(id, { cols, rows })
    get().sockets.get(id)?.resize(id, cols, rows)
  },

  kill: (id: string) => {
    get().sockets.get(id)?.kill(id)
  },

  spawnShell: (id: string, cols: number, rows: number) => {
    patchSession(id, { spawned: true, cols, rows })
    get().sockets.get(id)?.spawn(id, cols, rows)
  },

  execVfs: async (workspaceId, command, handlers) => {
    try {
      await streamSSE<{ text?: string; clear?: boolean; code?: number; message?: string }>(
        `/api/workspaces/${workspaceId}/exec`,
        { command, backend: 'vfs' },
        (frame) => {
          if (frame.event === 'output') {
            handlers.onOutput(frame.data.text ?? '', frame.data.clear === true)
          } else if (frame.event === 'exit') {
            handlers.onExit(frame.data.code ?? 0)
          } else if (frame.event === 'error') {
            handlers.onError(frame.data.message ?? '命令执行失败')
          }
        },
      )
    } catch (err) {
      // 非 2xx（如 403 DANGEROUS_COMMAND）经 ApiError 归一化后提示
      handlers.onError(err instanceof ApiError ? err.message : '命令执行失败')
    }
  },
}))
