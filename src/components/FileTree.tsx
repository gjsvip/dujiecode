/**
 * 文件树（架构文档 §3.3 #25）：
 * 懒展开（GET /api/workspaces/:id/files?path=）、新建 / 重命名 / 删除菜单、
 * 点击文件打开编辑器 Tab、文件类型图标（扩展名徽标）。
 *
 * 懒展开策略：仅根目录在挂载时加载；目录首次展开时按 path 拉取 children，
 * 变更后定向刷新受影响的父目录，保留其余展开状态。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { ApiError, api } from '../api'
import { useWorkspaceStore } from '../store/workspace'
import type { FileNode, FileType } from '@shared/types'

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

const ChevronIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M9 5.5l6.5 6.5L9 18.5" className={className} />
)
const FolderIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon
    path="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10z"
    className={className}
  />
)

/** 扩展名 → 徽标配色（VS Code 风格近似） */
const EXT_BADGE: Record<string, string> = {
  ts: 'bg-blue-500/25 text-blue-300',
  tsx: 'bg-blue-500/25 text-blue-300',
  js: 'bg-yellow-500/25 text-yellow-300',
  jsx: 'bg-yellow-500/25 text-yellow-300',
  json: 'bg-amber-500/25 text-amber-300',
  py: 'bg-emerald-500/25 text-emerald-300',
  md: 'bg-slate-400/25 text-slate-300',
  html: 'bg-orange-500/25 text-orange-300',
  css: 'bg-sky-500/25 text-sky-300',
  scss: 'bg-pink-500/25 text-pink-300',
  yml: 'bg-purple-500/25 text-purple-300',
  yaml: 'bg-purple-500/25 text-purple-300',
  sh: 'bg-green-500/25 text-green-300',
  sql: 'bg-cyan-500/25 text-cyan-300',
  go: 'bg-cyan-500/25 text-cyan-300',
  rs: 'bg-orange-600/25 text-orange-300',
  java: 'bg-red-500/25 text-red-300',
  toml: 'bg-gray-500/25 text-gray-300',
  ini: 'bg-gray-500/25 text-gray-300',
  txt: 'bg-gray-500/25 text-gray-300',
  log: 'bg-gray-500/25 text-gray-300',
}

/** 文件类型图标：扩展名徽标（未知扩展名回落圆点） */
function FileIcon({ name }: { name: string }): ReactNode {
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  const label = ext === '' ? '·' : ext.slice(0, 4)
  const color = EXT_BADGE[ext] ?? 'bg-border text-dim'
  return (
    <span
      className={cx(
        'grid h-4 w-4 shrink-0 place-items-center rounded text-[8px] font-bold uppercase',
        color,
      )}
      title={ext === '' ? '文件' : `.${ext}`}
    >
      {label}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* 组件                                                                 */
/* ------------------------------------------------------------------ */

/** 右键 / 「⋯」菜单锚点 */
interface MenuAnchor {
  path: string
  type: FileType
  x: number
  y: number
}

/** 文件树（§3.3 #25） */
export default function FileTree({ workspaceId }: { workspaceId: string }): ReactNode {
  const createNode = useWorkspaceStore((s) => s.createNode)
  const renameNode = useWorkspaceStore((s) => s.renameNode)
  const deleteNode = useWorkspaceStore((s) => s.deleteNode)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const pushToast = useWorkspaceStore((s) => s.pushToast)
  const tree = useWorkspaceStore((s) => s.tree)

  // 懒展开状态：path → children（根目录 path 为 ''）
  const [childrenMap, setChildrenMap] = useState<Map<string, FileNode[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [rootLoaded, setRootLoaded] = useState(false)

  // 交互态：菜单 / 内联新建 / 内联重命名 / 删除确认
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [inlineCreate, setInlineCreate] = useState<{ parent: string; type: FileType } | null>(null)
  const [createValue, setCreateValue] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  /** 拉取目录 children 并写入 childrenMap */
  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      const res = await api.get<{ node: FileNode; children?: FileNode[] }>(
        `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`,
      )
      setChildrenMap((prev) => new Map(prev).set(path, res.children ?? []))
    },
    [workspaceId],
  )

  /** 挂载 / 切换工作区：重置并加载根目录 */
  useEffect(() => {
    let cancelled = false
    setChildrenMap(new Map())
    setExpanded(new Set())
    setRootLoaded(false)
    setMenu(null)
    setInlineCreate(null)
    setRenaming(null)
    void (async () => {
      try {
        await loadDir('')
        if (!cancelled) {
          setRootLoaded(true)
        }
      } catch (err) {
        if (!cancelled) {
          pushToast('err', err instanceof ApiError ? err.message : '文件树加载失败')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadDir, pushToast])

  /** 展开 / 折叠目录（首次展开时懒加载） */
  const toggleExpand = useCallback(
    async (path: string): Promise<void> => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next
      })
      if (!childrenMap.has(path)) {
        setLoadingDirs((prev) => new Set(prev).add(path))
        try {
          await loadDir(path)
        } catch (err) {
          pushToast('err', err instanceof ApiError ? err.message : '目录加载失败')
        } finally {
          setLoadingDirs((prev) => {
            const next = new Set(prev)
            next.delete(path)
            return next
          })
        }
      }
    },
    [childrenMap, loadDir, pushToast],
  )

  /** 定向刷新目录（变更后保留展开状态） */
  const refreshDir = useCallback(
    async (path: string): Promise<void> => {
      try {
        await loadDir(path)
      } catch {
        // 刷新失败不打断交互（toast 已由 mutation 抛出）
      }
    },
    [loadDir],
  )

  /** 打开右键 / 「⋯」菜单（坐标做视口边界收敛） */
  const openMenu = useCallback((event: ReactMouseEvent, path: string, type: FileType): void => {
    event.preventDefault()
    event.stopPropagation()
    const x = Math.min(event.clientX, window.innerWidth - 160)
    const y = Math.min(event.clientY, window.innerHeight - 180)
    setMenu({ path, type, x, y })
  }, [])

  /** 提交内联新建 */
  const submitCreate = useCallback(async (): Promise<void> => {
    if (inlineCreate === null) {
      return
    }
    const value = createValue.trim()
    const parent = inlineCreate.parent
    const path = parent === '' ? value : `${parent}/${value}`
    setInlineCreate(null)
    setCreateValue('')
    if (value === '' || value.includes('/')) {
      if (value.includes('/')) {
        pushToast('err', '名称不能包含 /')
      }
      return
    }
    try {
      await createNode(path, inlineCreate.type)
      await refreshDir(parent)
      setExpanded((prev) => new Set(prev).add(parent))
    } catch {
      // toast 已由 store 提示；保留输入态由调用方决定（此处已清空）
    }
  }, [inlineCreate, createValue, createNode, refreshDir, pushToast])

  /** 提交内联重命名 */
  const submitRename = useCallback(async (): Promise<void> => {
    if (renaming === null) {
      return
    }
    const value = renameValue.trim()
    const oldParent = renaming.includes('/') ? renaming.slice(0, renaming.lastIndexOf('/')) : ''
    const newPath = oldParent === '' ? value : `${oldParent}/${value}`
    setRenaming(null)
    setRenameValue('')
    if (value === '' || value.includes('/') || newPath === renaming) {
      return
    }
    try {
      await renameNode(renaming, newPath)
      await refreshDir(oldParent)
    } catch {
      // toast 已提示
    }
  }, [renaming, renameValue, renameNode, refreshDir])

  /** 提交删除（含目录递归） */
  const submitDelete = useCallback(
    async (path: string): Promise<void> => {
      setConfirmDelete(null)
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      try {
        await deleteNode(path)
        await refreshDir(parent)
        // 清理被删目录的展开态与缓存
        setExpanded((prev) => {
          const next = new Set(prev)
          for (const p of next) {
            if (p === path || p.startsWith(`${path}/`)) {
              next.delete(p)
            }
          }
          return next
        })
        setChildrenMap((prev) => {
          const next = new Map(prev)
          for (const key of [...next.keys()]) {
            if (key === path || key.startsWith(`${path}/`)) {
              next.delete(key)
            }
          }
          return next
        })
      } catch {
        // toast 已提示
      }
    },
    [deleteNode, refreshDir],
  )

  /** 递归渲染节点行 */
  const renderRows = (nodes: FileNode[], parentPath: string, depth: number): ReactNode =>
    nodes.map((node) => {
      const path = parentPath === '' ? node.name : `${parentPath}/${node.name}`
      const isDir = node.type === 'dir'
      const isOpen = expanded.has(path)
      const isLoading = loadingDirs.has(path)
      return (
        <div key={path}>
          <div
            className={cx(
              'group flex cursor-pointer items-center gap-1 rounded-md py-[3px] pr-1 text-xs text-text hover:bg-elev/60',
            )}
            style={{ paddingLeft: `${depth * 12 + 6}px` }}
            onClick={() => {
              if (isDir) {
                void toggleExpand(path)
              } else {
                void openFile(path)
              }
            }}
            onContextMenu={(event) => openMenu(event, path, node.type)}
          >
            {isDir ? (
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-dim hover:text-text"
                aria-label={isOpen ? '折叠目录' : '展开目录'}
                onClick={(event) => {
                  event.stopPropagation()
                  void toggleExpand(path)
                }}
              >
                <ChevronIcon className={cx('h-3 w-3 transition-transform', isOpen && 'rotate-90')} />
              </button>
            ) : (
              <span className="w-4 shrink-0" />
            )}
            {isDir ? (
              <FolderIcon className="h-3.5 w-3.5 shrink-0 text-accent/80" />
            ) : (
              <FileIcon name={node.name} />
            )}
            {renaming === path ? (
              <input
                autoFocus
                className="field h-6 min-w-0 flex-1 px-1 py-0 text-xs"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => void submitRename()}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') {
                    void submitRename()
                  } else if (event.key === 'Escape') {
                    setRenaming(null)
                  }
                }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate" title={path}>
                {node.name}
              </span>
            )}
            <button
              type="button"
              className="shrink-0 rounded px-1 text-dim opacity-0 transition-opacity hover:bg-border/60 hover:text-text group-hover:opacity-100"
              aria-label="更多操作"
              onClick={(event) => openMenu(event, path, node.type)}
            >
              ⋯
            </button>
          </div>
          {isDir && isOpen && (
            <div>
              {isLoading && (
                <p
                  className="py-1 text-[11px] text-dim"
                  style={{ paddingLeft: `${(depth + 1) * 12 + 22}px` }}
                >
                  加载中…
                </p>
              )}
              {!isLoading && renderRows(childrenMap.get(path) ?? [], path, depth + 1)}
              {inlineCreate?.parent === path && (
                <div
                  className="flex items-center gap-1.5 py-[3px] pr-1"
                  style={{ paddingLeft: `${(depth + 1) * 12 + 22}px` }}
                >
                  {inlineCreate.type === 'dir' ? (
                    <FolderIcon className="h-3.5 w-3.5 shrink-0 text-accent/80" />
                  ) : (
                    <FileIcon name={createValue || 'x.txt'} />
                  )}
                  <input
                    autoFocus
                    className="field h-6 min-w-0 flex-1 px-1 py-0 text-xs"
                    placeholder={inlineCreate.type === 'dir' ? '文件夹名称' : '文件名称'}
                    value={createValue}
                    onChange={(event) => setCreateValue(event.target.value)}
                    onBlur={() => void submitCreate()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void submitCreate()
                      } else if (event.key === 'Escape') {
                        setInlineCreate(null)
                        setCreateValue('')
                      }
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )
    })

  const rootChildren = childrenMap.get('') ?? []

  return (
    <div className="relative flex h-full flex-col overflow-auto py-1">
      {/* 工作区根 */}
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-text">
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="min-w-0 truncate">{tree?.name ?? '工作区'}</span>
      </div>

      {/* 根目录子节点 */}
      {!rootLoaded && <p className="px-3 py-2 text-[11px] text-dim">加载中…</p>}
      {rootLoaded && rootChildren.length === 0 && inlineCreate?.parent !== '' && (
        <p className="px-3 py-2 text-[11px] text-dim">暂无文件，右键或「⋯」新建</p>
      )}
      {rootLoaded && renderRows(rootChildren, '', 0)}

      {/* 根目录内联新建 */}
      {inlineCreate?.parent === '' && (
        <div className="flex items-center gap-1.5 px-2 py-[3px]" style={{ paddingLeft: '22px' }}>
          {inlineCreate.type === 'dir' ? (
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-accent/80" />
          ) : (
            <FileIcon name={createValue || 'x.txt'} />
          )}
          <input
            autoFocus
            className="field h-6 min-w-0 flex-1 px-1 py-0 text-xs"
            placeholder={inlineCreate.type === 'dir' ? '文件夹名称' : '文件名称'}
            value={createValue}
            onChange={(event) => setCreateValue(event.target.value)}
            onBlur={() => void submitCreate()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void submitCreate()
              } else if (event.key === 'Escape') {
                setInlineCreate(null)
                setCreateValue('')
              }
            }}
          />
        </div>
      )}

      {/* 上下文菜单 */}
      {menu !== null && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu(null)
            }}
          />
          <div
            className="fixed z-50 w-36 rounded-lg border border-border bg-elev p-1 shadow-panel"
            style={{ left: menu.x, top: menu.y }}
          >
            {menu.type === 'dir' && (
              <>
                <button
                  type="button"
                  className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs text-text hover:bg-panel"
                  onClick={() => {
                    setInlineCreate({ parent: menu.path, type: 'file' })
                    setCreateValue('')
                    setExpanded((prev) => new Set(prev).add(menu.path))
                    setMenu(null)
                  }}
                >
                  新建文件
                </button>
                <button
                  type="button"
                  className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs text-text hover:bg-panel"
                  onClick={() => {
                    setInlineCreate({ parent: menu.path, type: 'dir' })
                    setCreateValue('')
                    setExpanded((prev) => new Set(prev).add(menu.path))
                    setMenu(null)
                  }}
                >
                  新建文件夹
                </button>
                <div className="my-1 border-t border-border" />
              </>
            )}
            <button
              type="button"
              className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs text-text hover:bg-panel"
              onClick={() => {
                setRenaming(menu.path)
                setRenameValue(menu.path.split('/').pop() ?? menu.path)
                setMenu(null)
              }}
            >
              重命名
            </button>
            <button
              type="button"
              className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs text-err hover:bg-err/10"
              onClick={() => {
                setConfirmDelete(menu.path)
                setMenu(null)
              }}
            >
              删除
            </button>
          </div>
        </>
      )}

      {/* 删除确认 */}
      {confirmDelete !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setConfirmDelete(null)
            }
          }}
        >
          <div className="card w-full max-w-sm bg-elev p-5 shadow-panel">
            <h3 className="text-sm font-semibold">确认删除</h3>
            <p className="mt-2 text-xs leading-relaxed text-dim">
              「{confirmDelete}」将被永久删除
              {confirmDelete !== null && childrenMap.has(confirmDelete) ? '（目录递归删除，不可恢复）' : ''}
              。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmDelete(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => void submitDelete(confirmDelete)}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
