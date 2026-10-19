/**
 * Monaco 多标签编辑区（架构文档 §3.3 #26）：
 * Tab 栏（dirty 标记 / 关闭）、语言按扩展名识别、Ctrl+S 保存写 VFS
 * （PUT /api/workspaces/:id/files/content，§5.2）。
 *
 * 每个 Tab 对应一个 Monaco model（path 即 model 路径），切换 Tab 保留
 * 各自的光标 / 撤销栈；dirty Tab 关闭前弹确认（保存并关闭 / 不保存 / 取消）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import Editor from '@monaco-editor/react'
import { useWorkspaceStore, type EditorTab } from '../store/workspace'

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

const CloseIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M6 6l12 12 M18 6L6 18" className={className} />
)

/** Monaco 编辑器选项（深色 IDE 观感，§6.4） */
const EDITOR_OPTIONS = {
  fontSize: 13,
  fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace',
  fontLigatures: true,
  minimap: { enabled: true, scale: 0.75 },
  scrollBeyondLastLine: false,
  renderWhitespace: 'selection' as const,
  tabSize: 2,
  automaticLayout: true,
  smoothScrolling: true,
  cursorBlinking: 'smooth' as const,
  padding: { top: 8 },
  wordWrap: 'on' as const,
}

/** 空状态（无打开 Tab） */
function EmptyState(): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <svg viewBox="0 0 120 90" className="h-24 w-36" aria-hidden="true">
        <rect x="14" y="16" width="62" height="58" rx="8" fill="none" stroke="#232a3d" strokeWidth="2" />
        <path d="M26 32h38M26 42h38M26 52h22" stroke="#232a3d" strokeWidth="2" strokeLinecap="round" />
        <path d="M86 20l5 12h-10l5-12z" fill="#7c6cf0" opacity="0.6" />
      </svg>
      <p className="text-sm text-dim">从左侧文件树选择文件开始编辑</p>
      <p className="text-xs text-dim/70">Ctrl+S 保存到云端工作区（VFS）</p>
    </div>
  )
}

/** Monaco 多标签编辑区（§3.3 #26） */
export default function EditorPane(): ReactNode {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeTab = useWorkspaceStore((s) => s.activeTab)
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab)
  const closeTab = useWorkspaceStore((s) => s.closeTab)
  const updateTabContent = useWorkspaceStore((s) => s.updateTabContent)
  const saveFile = useWorkspaceStore((s) => s.saveFile)
  const [confirmClose, setConfirmClose] = useState<EditorTab | null>(null)

  const active = tabs.find((tab) => tab.path === activeTab) ?? null

  // Ctrl+S / Cmd+S：保存当前激活 Tab（编辑器失焦时同样生效）
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        const current = useWorkspaceStore.getState().activeTab
        if (current !== null) {
          void useWorkspaceStore.getState().saveFile(current)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* Tab 栏 */}
      {tabs.length > 0 && (
        <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-panel/60">
          <div className="flex flex-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div
                key={tab.path}
                className={cx(
                  'group flex shrink-0 items-center gap-1.5 border-r border-border px-3 text-xs transition-colors',
                  tab.path === activeTab
                    ? 'border-b-2 border-b-accent bg-bg text-text'
                    : 'text-dim hover:bg-elev/50',
                )}
              >
                <button
                  type="button"
                  className="max-w-[10rem] truncate"
                  title={tab.path}
                  onClick={() => setActiveTab(tab.path)}
                >
                  {tab.name}
                </button>
                {tab.dirty && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
                    title="有未保存的更改"
                  />
                )}
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-dim opacity-0 transition-opacity hover:bg-border/60 hover:text-text group-hover:opacity-100"
                  aria-label={`关闭 ${tab.name}`}
                  onClick={() => {
                    if (tab.dirty) {
                      setConfirmClose(tab)
                    } else {
                      closeTab(tab.path)
                    }
                  }}
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 编辑器主体 */}
      <div className="min-h-0 flex-1">
        {active === null && <EmptyState />}
        {active?.loading === true && (
          <div className="flex h-full items-center justify-center text-sm text-dim">
            正在加载 {active.name}…
          </div>
        )}
        {active?.error != null && active.error !== '' && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-sm text-err">{active.error}</p>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => void useWorkspaceStore.getState().openFile(active.path)}
            >
              重试
            </button>
          </div>
        )}
        {active !== null && !active.loading && (active.error ?? '') === '' && (
          <Editor
            path={active.path}
            language={active.language}
            value={active.content}
            theme="vs-dark"
            onChange={(value) => updateTabContent(active.path, value ?? '')}
            options={EDITOR_OPTIONS}
            loading={
              <div className="flex h-full items-center justify-center text-sm text-dim">
                编辑器加载中…
              </div>
            }
          />
        )}
      </div>

      {/* dirty 关闭确认 */}
      {confirmClose !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setConfirmClose(null)
            }
          }}
        >
          <div className="card w-full max-w-sm bg-elev p-5 shadow-panel">
            <h3 className="text-sm font-semibold">「{confirmClose.name}」有未保存的更改</h3>
            <p className="mt-2 text-xs text-dim">关闭前是否保存到云端工作区？</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmClose(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => {
                  closeTab(confirmClose.path)
                  setConfirmClose(null)
                }}
              >
                不保存
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  void (async () => {
                    try {
                      await saveFile(confirmClose.path)
                    } catch {
                      // 保存失败时保留 Tab（toast 已提示）
                      return
                    }
                    closeTab(confirmClose.path)
                    setConfirmClose(null)
                  })()
                }}
              >
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
