/**
 * 底部可折叠终端（架构文档 §3.3 #28 / §6.2）：
 * Tab（虚拟 Shell / 各远程后端）、xterm.js + addon-fit 挂载、后端选择、
 * 断线提示；虚拟 Shell 模式输出经 SSE（POST /exec）写入 xterm。
 *
 * 双模式（§6.3）：
 * - 虚拟 Shell：本地回显 + 行缓冲，Enter 执行命令（store.execVfs），
 *   output/exit SSE 事件写入 xterm，退出码非零时红色标注；
 * - 远程后端：TerminalSocket（WSS），xterm onData → data 帧，
 *   data 帧 → xterm 渲染，onResize → resize 帧，挂载即 spawn。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  attachTerminalWriter,
  useTerminalStore,
  type TerminalSession,
} from '../store/terminal'

/* ------------------------------------------------------------------ */
/* 小部件                                                               */
/* ------------------------------------------------------------------ */

/** 类名拼接小工具 */
function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** 线性图标 */
function Icon({ path, className = 'h-4 w-4' }: { path: string; className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}

const ChevronDownIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M6 9.5l6 6 6-6" className={className} />
)
const PlusIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M12 5v14 M5 12h14" className={className} />
)

/** 菜单项类名 */
const MENU_ITEM_CLS =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-text transition-colors hover:bg-panel'

/** 面板展开时的高度（px） */
const PANEL_HEIGHT = 300

/* ------------------------------------------------------------------ */
/* 单会话终端视图                                                        */
/* ------------------------------------------------------------------ */

/** 单个会话的 xterm 视图（vfs / ssh 双模式） */
function TerminalView({
  session,
  workspaceId,
}: {
  session: TerminalSession
  workspaceId: string
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  /** vfs 行输入缓冲 */
  const inputRef = useRef('')
  /** vfs 命令执行中（避免并发执行交错输出） */
  const busyRef = useRef(false)
  /** 已发送的 PTY 尺寸（避免 fit 抖动导致 resize 帧风暴） */
  const lastSizeRef = useRef({ cols: 0, rows: 0 })

  const write = useTerminalStore((s) => s.write)
  const resizeStore = useTerminalStore((s) => s.resize)
  const spawnShell = useTerminalStore((s) => s.spawnShell)
  const execVfs = useTerminalStore((s) => s.execVfs)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) {
      return
    }

    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace',
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#0b0e14',
        foreground: '#d7dce8',
        cursor: '#7c6cf0',
        selectionBackground: '#7c6cf055',
        black: '#0b0e14',
        red: '#f85149',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#7c6cf0',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#d7dce8',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    try {
      fit.fit()
    } catch {
      // 容器尚未完成布局时忽略，ResizeObserver 会补偿
    }

    // 注册输出写入器（SSE / WS 数据经此写入终端）
    const detach = attachTerminalWriter(session.id, (bytes) => {
      term.write(bytes)
    })

    /** vfs 提示符 */
    const prompt = (): void => {
      term.write('vfs:~$ ')
    }

    /** vfs：执行一条命令（输出经 SSE 写回 xterm） */
    const runVfsCommand = (command: string): void => {
      busyRef.current = true
      void execVfs(workspaceId, command, {
        onOutput: (text, clear) => {
          if (clear) {
            term.clear()
          } else if (text !== '') {
            term.write(text)
          }
        },
        onExit: (code) => {
          busyRef.current = false
          if (code !== 0) {
            term.write(`\r\n\x1b[31m[退出码 ${code}]\x1b[0m`)
          }
          prompt()
        },
        onError: (message) => {
          busyRef.current = false
          term.write(`\r\n\x1b[31m${message}\x1b[0m`)
          prompt()
        },
      })
    }

    // 键盘输入分发
    term.onData((data) => {
      if (session.kind === 'ssh') {
        write(session.id, data)
        return
      }
      // 虚拟 Shell：本地回显 + 行缓冲 + 命令执行
      for (const ch of data) {
        if (ch === '\r') {
          term.write('\r\n')
          const command = inputRef.current
          inputRef.current = ''
          if (command.trim() === '') {
            prompt()
          } else if (busyRef.current) {
            term.write('\x1b[33m上一条命令执行中，请稍候…\x1b[0m\r\n')
            prompt()
          } else {
            runVfsCommand(command)
          }
        } else if (ch === '\x7f') {
          if (inputRef.current !== '') {
            inputRef.current = inputRef.current.slice(0, -1)
            term.write('\b \b')
          }
        } else if (ch === '\x03') {
          term.write('^C\r\n')
          inputRef.current = ''
          prompt()
        } else if (ch === '\x0c') {
          term.clear()
          prompt()
        } else if (ch >= ' ') {
          inputRef.current += ch
          term.write(ch)
        }
      }
    })

    // PTY 尺寸变化 → resize 帧（仅 ssh）
    term.onResize(({ cols, rows }) => {
      if (session.kind !== 'ssh') {
        return
      }
      if (lastSizeRef.current.cols === cols && lastSizeRef.current.rows === rows) {
        return
      }
      lastSizeRef.current = { cols, rows }
      resizeStore(session.id, cols, rows)
    })

    if (session.kind === 'ssh') {
      // 挂载即发起 spawn（重连时由 store onOpen 自动重发）
      spawnShell(session.id, term.cols, term.rows)
    } else {
      prompt()
    }

    // 容器尺寸变化 → 重新适配（含从 display:none 恢复显示）
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // 忽略瞬时 0 尺寸
      }
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      detach()
      term.dispose()
    }
    // store actions 为稳定引用；session.kind 不变，仅挂载时执行一次
  }, [session.id, session.kind, workspaceId, write, resizeStore, spawnShell, execVfs])

  return (
    <div className="relative h-full">
      <div ref={hostRef} className="h-full w-full px-2 py-1" />
      {/* 断线提示 */}
      {session.kind === 'ssh' && !session.connected && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full border border-err/40 bg-err/10 px-3 py-1 text-[11px] text-err backdrop-blur-sm">
          连接中断，正在重连…
        </div>
      )}
      {/* shell 退出 / 错误提示 */}
      {session.error !== null && (
        <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-warn/40 bg-warn/10 px-3 py-1 text-[11px] text-warn backdrop-blur-sm">
          {session.error}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 主组件                                                               */
/* ------------------------------------------------------------------ */

/** 底部可折叠终端面板（§3.3 #28） */
export default function TerminalPanel({ workspaceId }: { workspaceId: string }): ReactNode {
  const sessions = useTerminalStore((s) => s.sessions)
  const activeSessionId = useTerminalStore((s) => s.activeSessionId)
  const openSession = useTerminalStore((s) => s.openSession)
  const closeSession = useTerminalStore((s) => s.closeSession)
  const setActiveSession = useTerminalStore((s) => s.setActiveSession)
  const backends = useTerminalStore((s) => s.backends)
  const loadBackends = useTerminalStore((s) => s.loadBackends)

  const [collapsed, setCollapsed] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadBackends()
  }, [loadBackends])

  // 点击菜单外关闭
  useEffect(() => {
    if (!menuOpen) {
      return
    }
    function onPointerDown(event: PointerEvent): void {
      const node = menuRef.current
      if (node !== null && !node.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])

  return (
    <section
      className="shrink-0 border-t border-border bg-panel/50"
      style={{ height: collapsed ? 36 : PANEL_HEIGHT }}
    >
      {/* Tab 栏 */}
      <div className="flex h-9 items-center gap-1 border-b border-border px-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm shrink-0 px-1.5"
          title={collapsed ? '展开终端' : '折叠终端'}
          onClick={() => setCollapsed((prev) => !prev)}
        >
          <ChevronDownIcon
            className={cx('h-3.5 w-3.5 transition-transform', !collapsed && 'rotate-180')}
          />
        </button>
        <span className="shrink-0 text-[11px] font-medium text-dim">终端</span>
        <div className="mx-1 h-4 w-px shrink-0 bg-border" />

        {/* 会话 Tab */}
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cx(
                'group flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors',
                session.id === activeSessionId
                  ? 'bg-elev text-text'
                  : 'text-dim hover:bg-elev/50',
              )}
            >
              <button
                type="button"
                className="max-w-[9rem] truncate"
                title={`${session.label}（${session.kind === 'vfs' ? '虚拟 Shell' : session.backendId}）`}
                onClick={() => setActiveSession(session.id)}
              >
                {session.label}
              </button>
              {session.kind === 'ssh' && (
                <span
                  className={cx(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    session.connected ? 'bg-ok' : 'bg-err',
                  )}
                  title={session.connected ? '已连接' : '连接中断，重连中'}
                />
              )}
              <button
                type="button"
                className="shrink-0 rounded px-0.5 text-dim opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
                aria-label={`关闭 ${session.label}`}
                onClick={() => closeSession(session.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* 新建会话菜单（后端选择） */}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            className="btn btn-ghost btn-sm px-1.5"
            title="新建终端会话"
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute bottom-full left-0 z-50 mb-1 w-60 rounded-lg border border-border bg-elev p-1.5 shadow-panel">
              <button
                type="button"
                className={MENU_ITEM_CLS}
                onClick={() => {
                  openSession('vfs')
                  setMenuOpen(false)
                  setCollapsed(false)
                }}
              >
                虚拟 Shell（内置）
              </button>
              <div className="my-1 border-t border-border" />
              <p className="px-2.5 py-1 text-[11px] text-dim">远程执行后端</p>
              {backends.length === 0 && (
                <p className="px-2.5 py-1.5 text-[11px] text-dim">
                  暂无后端，请到「设置 → 执行后端」添加
                </p>
              )}
              {backends.map((backend) => (
                <button
                  key={backend.id}
                  type="button"
                  className={MENU_ITEM_CLS}
                  onClick={() => {
                    openSession('ssh', backend.id)
                    setMenuOpen(false)
                    setCollapsed(false)
                  }}
                >
                  <span
                    className={cx(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      backend.status === 'online' ? 'bg-ok' : 'bg-dim',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{backend.name}</span>
                  <span className="shrink-0 text-[10px] text-dim">
                    {backend.status === 'online' ? '在线' : '离线'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 终端主体（全部会话保持挂载，仅切换显隐以保留滚动缓冲） */}
      {!collapsed && (
        <div className="relative" style={{ height: PANEL_HEIGHT - 36 }}>
          {sessions.length === 0 && (
            <div className="flex h-full items-center justify-center text-xs text-dim">
              点击「＋」打开虚拟 Shell 或远程后端终端
            </div>
          )}
          {sessions.map((session) => (
            <div
              key={session.id}
              className="absolute inset-0"
              style={{ display: session.id === activeSessionId ? 'block' : 'none' }}
            >
              <TerminalView session={session} workspaceId={workspaceId} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
