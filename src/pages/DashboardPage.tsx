/**
 * 工作台（架构文档 §3.3 #21）：
 * 工作区卡片列表（GET /api/workspaces）、新建工作区对话框（POST）、
 * 最近会话入口（跨工作区聚合 GET /api/workspaces/:id/conversations）、
 * 空状态引导。数据契约见 §5.2。
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api'
import type { Conversation, Workspace, WorkspaceSummary } from '@shared/types'

/** 跨工作区聚合的最近会话条目 */
interface RecentConversation {
  conversation: Conversation
  workspaceId: string
  workspaceName: string
}

/** 工作台展示的最近会话条数上限 */
const RECENT_LIMIT = 5
/** 聚合最近会话时最多并发探测的工作区数（无全局会话端点，按工作区逐个拉取） */
const RECENT_SCAN_LIMIT = 8

/** ISO 时间 → 中文相对时间 */
function formatRelative(iso: string): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) {
    return '—'
  }
  const minutes = Math.floor((Date.now() - time) / 60_000)
  if (minutes < 1) {
    return '刚刚'
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours} 小时前`
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return `${days} 天前`
  }
  return new Date(iso).toLocaleDateString('zh-CN')
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

const PlusIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M12 5v14 M5 12h14" className={className} />
)
const FolderIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon
    path="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10z"
    className={className}
  />
)
const ChatIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon
    path="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 4v-13.5A1.5 1.5 0 0 1 4 5.5z"
    className={className}
  />
)

/** 空状态插画（纯 SVG） */
function EmptyIllustration(): ReactNode {
  return (
    <svg viewBox="0 0 120 90" className="h-24 w-36" aria-hidden="true">
      <rect x="14" y="16" width="62" height="58" rx="8" fill="none" stroke="#232a3d" strokeWidth="2" />
      <path d="M26 32h38M26 42h38M26 52h22" stroke="#232a3d" strokeWidth="2" strokeLinecap="round" />
      <path d="M86 20l5 12h-10l5-12z" fill="#7c6cf0" />
      <circle cx="92" cy="52" r="11" fill="none" stroke="#7c6cf0" strokeWidth="2" opacity="0.45" />
      <path d="M92 46v6l4 3" stroke="#7c6cf0" strokeWidth="2" strokeLinecap="round" opacity="0.45" />
    </svg>
  )
}

/** 轻提示（创建成功 / 失败） */
function Toast({ kind, text }: { kind: 'ok' | 'err'; text: string }): ReactNode {
  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
      <div className="card flex items-center gap-2.5 bg-elev px-4 py-2.5 text-sm shadow-panel">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${kind === 'ok' ? 'bg-ok' : 'bg-err'}`} />
        <span className="text-text">{text}</span>
      </div>
    </div>
  )
}

/** 新建工作区对话框（POST /api/workspaces，§5.2） */
function NewWorkspaceDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (workspace: WorkspaceSummary) => void
}): ReactNode {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ESC 关闭
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('请输入工作区名称')
      return
    }
    if (trimmed.length > 60) {
      setError('工作区名称不能超过 60 个字符')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await api.post<{ workspace: Workspace }>('/api/workspaces', {
        name: trimmed,
        description: description.trim() || undefined,
      })
      onCreated({
        id: res.workspace.id,
        name: res.workspace.name,
        fileCount: 0,
        updatedAt: res.workspace.updatedAt,
      })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NAME_TAKEN') {
        setError('同名工作区已存在，请换一个名称')
      } else {
        setError(err instanceof ApiError ? err.message : '创建失败，请稍后重试')
      }
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <form
        className="card w-full max-w-md bg-elev p-6 shadow-panel"
        onSubmit={(event) => void onSubmit(event)}
      >
        <h2 className="text-base font-semibold">新建工作区</h2>
        <p className="mt-1 text-xs text-dim">工作区名称在你的账号下唯一。</p>

        <div className="mt-5">
          <label className="label" htmlFor="ws-name">
            名称
          </label>
          <input
            id="ws-name"
            className="field"
            type="text"
            autoFocus
            maxLength={60}
            placeholder="例如：api-server"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="mt-4">
          <label className="label" htmlFor="ws-desc">
            描述（选填）
          </label>
          <textarea
            id="ws-desc"
            className="field min-h-[72px] resize-none"
            maxLength={200}
            placeholder="这个工作区用来做什么？"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-xs text-err">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </form>
    </div>
  )
}

/** 工作台页（§6.1 /dashboard，RequireAuth 守卫内） */
export default function DashboardPage(): ReactNode {
  const navigate = useNavigate()
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [recent, setRecent] = useState<RecentConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  /** 展示轻提示（2.6s 后自动消失） */
  const showToast = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text })
    setTimeout(() => setToast(null), 2600)
  }, [])

  /** 加载工作区列表 + 聚合最近会话 */
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ workspaces: WorkspaceSummary[] }>('/api/workspaces')
      setWorkspaces(res.workspaces)
      // 最近会话：无全局端点，按工作区并发拉取后聚合（§5.2）
      const scanned = res.workspaces.slice(0, RECENT_SCAN_LIMIT)
      const groups = await Promise.all(
        scanned.map(async (ws) => {
          try {
            const r = await api.get<{ conversations: Conversation[] }>(
              `/api/workspaces/${ws.id}/conversations`,
            )
            return r.conversations.map((conversation) => ({
              conversation,
              workspaceId: ws.id,
              workspaceName: ws.name,
            }))
          } catch {
            return [] as RecentConversation[]
          }
        }),
      )
      const merged = groups
        .flat()
        .sort((a, b) => b.conversation.updatedAt.localeCompare(a.conversation.updatedAt))
        .slice(0, RECENT_LIMIT)
      setRecent(merged)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 创建成功：插入卡片列表头部并提示 */
  function onCreated(workspace: WorkspaceSummary): void {
    setWorkspaces((prev) => [workspace, ...prev])
    setDialogOpen(false)
    showToast('ok', `工作区「${workspace.name}」已创建`)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
        {/* 页头 */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-wide">我的工作区</h1>
            <p className="mt-1 text-sm text-dim">
              所有工作区与文件均归属你的账号，资源隔离存储。
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
            <PlusIcon className="h-4 w-4" />
            新建工作区
          </button>
        </div>

        {/* 统计 */}
        {!loading && !error && (
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="chip">工作区 {workspaces.length} 个</span>
            {recent.length > 0 && <span className="chip">最近会话 {recent.length} 条</span>}
          </div>
        )}

        {/* 错误态 */}
        {error && (
          <div className="card mt-6 flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-sm text-err">{error}</p>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}

        {/* 加载骨架 */}
        {loading && (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="card h-28 animate-pulse bg-panel/60" />
            ))}
          </div>
        )}

        {/* 空状态引导 */}
        {!loading && !error && workspaces.length === 0 && (
          <div className="card mt-6 flex flex-col items-center gap-4 px-6 py-16 text-center">
            <EmptyIllustration />
            <h2 className="text-lg font-semibold">开启第一次渡劫</h2>
            <p className="max-w-md text-sm leading-relaxed text-dim">
              工作区是你的云端开发空间：文件树、Monaco 编辑器、AI 对话与终端都在其中。创建后即可对话式编程。
            </p>
            <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
              <PlusIcon className="h-4 w-4" />
              创建工作区
            </button>
          </div>
        )}

        {/* 工作区卡片 */}
        {!loading && !error && workspaces.length > 0 && (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                onClick={() => navigate(`/w/${ws.id}`)}
                className="card group block p-4 text-left transition-all hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-panel"
              >
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
                    <FolderIcon className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text transition-colors group-hover:text-accent">
                      {ws.name}
                    </p>
                    <p className="mt-1 text-xs text-dim">
                      {ws.fileCount} 个文件 · 更新于 {formatRelative(ws.updatedAt)}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* 最近会话入口（点击进入所属工作区，会话列表在文件树侧栏展示） */}
        {!loading && !error && recent.length > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-semibold text-dim">最近会话</h2>
            <div className="card mt-3 divide-y divide-border">
              {recent.map(({ conversation, workspaceId, workspaceName }) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => navigate(`/w/${workspaceId}`)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-elev/60"
                >
                  <ChatIcon className="h-4 w-4 shrink-0 text-dim" />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">
                    {conversation.title || '未命名会话'}
                  </span>
                  <span className="hidden shrink-0 text-xs text-dim sm:inline">{workspaceName}</span>
                  <span className="shrink-0 text-xs text-dim">
                    {formatRelative(conversation.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      {dialogOpen && (
        <NewWorkspaceDialog onClose={() => setDialogOpen(false)} onCreated={onCreated} />
      )}
      {toast && <Toast kind={toast.kind} text={toast.text} />}
    </div>
  )
}
