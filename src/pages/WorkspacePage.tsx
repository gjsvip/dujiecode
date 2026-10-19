/**
 * 工作区页（架构文档 §3.3 #22 / §6.1 /w/:workspaceId）：
 * 顶栏（工作区名、执行后端切换、审批铃铛、设置入口）+
 * 左侧（FileTree + 会话列表）+ 中央 EditorPane + 右侧 ChatPanel +
 * 底部 TerminalPanel；加载 / 错误 / 空状态完备。
 *
 * 执行后端切换持久化到 localStorage['dujiecode.backend']（与 Layout 及
 * terminal store 共用同一键，§6.3）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ChatPanel from '../components/ChatPanel'
import EditorPane from '../components/EditorPane'
import FileTree from '../components/FileTree'
import TerminalPanel from '../components/TerminalPanel'
import { useChatStore } from '../store/chat'
import {
  readPersistedBackend,
  useTerminalStore,
} from '../store/terminal'
import { useWorkspaceStore } from '../store/workspace'

/** 后端持久化键（与 Layout.tsx / terminal store 约定一致） */
const BACKEND_STORAGE_KEY = 'dujiecode.backend'

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

const BellIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon
    path="M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5z M10.5 19a2 2 0 0 0 3 0"
    className={className}
  />
)
const GearIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon
    path="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z"
    className={className}
  />
)
const ChatIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon
    path="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 4v-13.5A1.5 1.5 0 0 1 4 5.5z"
    className={className}
  />
)

/** 加载骨架 */
function PageLoading(): ReactNode {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
        <p className="text-sm text-dim">正在加载工作区…</p>
      </div>
    </div>
  )
}

/** 错误态 */
function PageError({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="card flex max-w-md flex-col items-center gap-4 px-8 py-10 text-center">
        <p className="text-sm text-err">{message}</p>
        <div className="flex gap-2">
          <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
            重试
          </button>
          <Link to="/dashboard" className="btn btn-ghost btn-sm">
            返回工作台
          </Link>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 主组件                                                               */
/* ------------------------------------------------------------------ */

/** 工作区页（§3.3 #22） */
export default function WorkspacePage(): ReactNode {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const navigate = useNavigate()

  // workspace store
  const loadWorkspace = useWorkspaceStore((s) => s.loadWorkspace)
  const current = useWorkspaceStore((s) => s.current)
  const loading = useWorkspaceStore((s) => s.loading)
  const error = useWorkspaceStore((s) => s.error)
  const pendingApprovalCount = useWorkspaceStore((s) => s.pendingApprovalCount)
  const requestApprovalFocus = useWorkspaceStore((s) => s.requestApprovalFocus)

  // chat store（会话列表）
  const loadConversations = useChatStore((s) => s.loadConversations)
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const selectConversation = useChatStore((s) => s.selectConversation)

  // terminal store（后端列表）
  const loadBackends = useTerminalStore((s) => s.loadBackends)
  const backends = useTerminalStore((s) => s.backends)

  // 执行后端切换（持久化，与 Layout 共用）
  const [backend, setBackend] = useState<string>(() => readPersistedBackend())
  useEffect(() => {
    try {
      globalThis.localStorage.setItem(BACKEND_STORAGE_KEY, backend)
    } catch {
      // 隐私模式等写入失败场景忽略
    }
  }, [backend])

  /** 加载工作区 + 会话 + 后端 */
  const load = useCallback(() => {
    if (workspaceId === undefined) {
      return
    }
    void loadWorkspace(workspaceId)
    void loadConversations(workspaceId)
    void loadBackends()
  }, [workspaceId, loadWorkspace, loadConversations, loadBackends])

  useEffect(() => {
    load()
  }, [load])

  // 加载 / 错误 / 空状态
  if (workspaceId === undefined || workspaceId === '') {
    return <PageError message="缺少工作区 ID" onRetry={() => navigate('/dashboard')} />
  }
  if (loading && current === null) {
    return <PageLoading />
  }
  if (error !== null && current === null) {
    return <PageError message={error} onRetry={load} />
  }

  const backendName =
    backend === 'vfs'
      ? '虚拟 Shell'
      : (backends.find((b) => b.id === backend)?.name ?? backend)

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：工作区名 / 执行后端切换 / 审批铃铛 / 设置入口 */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-panel/60 px-3">
        <button
          type="button"
          className="btn btn-ghost btn-sm shrink-0"
          onClick={() => navigate('/dashboard')}
        >
          ← 工作台
        </button>
        <span className="min-w-0 truncate text-sm font-semibold text-text">
          {current?.name ?? ''}
        </span>
        <span className="chip hidden shrink-0 sm:inline-flex">
          默认后端：{current?.defaultBackend === 'vfs' ? '虚拟 Shell' : current?.defaultBackend ?? '—'}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* 执行后端切换（新终端默认后端） */}
          <select
            className="field h-7 w-36 px-1.5 text-[11px] sm:w-44"
            value={backend}
            title="执行后端（新终端默认）"
            onChange={(event) => setBackend(event.target.value)}
          >
            <option value="vfs">虚拟 Shell（内置）</option>
            {backends.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.status === 'online' ? ' · 在线' : ' · 离线'}
              </option>
            ))}
          </select>

          {/* 审批铃铛（点击聚焦待审批卡片） */}
          <button
            type="button"
            className="btn btn-ghost btn-sm relative px-1.5"
            title={
              pendingApprovalCount > 0
                ? `${pendingApprovalCount} 个待处理审批`
                : '暂无待处理审批'
            }
            onClick={requestApprovalFocus}
          >
            <BellIcon className="h-[18px] w-[18px]" />
            {pendingApprovalCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-err px-1 text-[10px] font-semibold leading-none text-white">
                {pendingApprovalCount > 99 ? '99+' : pendingApprovalCount}
              </span>
            )}
          </button>

          {/* 设置入口 */}
          <Link
            to="/settings/general"
            className="btn btn-ghost btn-sm px-1.5"
            title="设置"
          >
            <GearIcon className="h-[18px] w-[18px]" />
          </Link>
        </div>
      </header>

      {/* 三区布局 */}
      <div className="flex min-h-0 flex-1">
        {/* 左侧：文件树 + 会话列表 */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-panel/40 xl:w-64">
          <div className="flex h-8 shrink-0 items-center border-b border-border px-3">
            <span className="text-[11px] font-medium text-dim">文件</span>
          </div>
          <div className="h-[45%] min-h-0 shrink-0 overflow-hidden border-b border-border">
            <FileTree workspaceId={workspaceId} />
          </div>

          <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="text-[11px] font-medium text-dim">会话</span>
            <button
              type="button"
              className="text-[11px] text-dim transition-colors hover:text-accent"
              onClick={() => void selectConversation(null)}
            >
              ＋ 新会话
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                className={cx(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                  conversation.id === activeConversationId
                    ? 'bg-accent/10 text-accent'
                    : 'text-dim hover:bg-elev/50 hover:text-text',
                )}
                onClick={() => void selectConversation(conversation.id)}
              >
                <ChatIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {conversation.title || '未命名会话'}
                </span>
              </button>
            ))}
            {conversations.length === 0 && (
              <p className="px-3 py-4 text-[11px] leading-relaxed text-dim">
                暂无会话，在右侧开始第一次对话
              </p>
            )}
          </div>
        </aside>

        {/* 中央：Monaco 编辑区 */}
        <main className="min-w-0 flex-1">
          <EditorPane />
        </main>

        {/* 右侧：AI 对话面板 */}
        <aside className="flex w-[21rem] shrink-0 flex-col border-l border-border bg-panel/30 2xl:w-[24rem]">
          <ChatPanel workspaceId={workspaceId} />
        </aside>
      </div>

      {/* 底部：终端面板 */}
      <TerminalPanel workspaceId={workspaceId} />
    </div>
  )
}
