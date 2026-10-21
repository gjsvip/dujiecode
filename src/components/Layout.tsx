/**
 * 应用外壳（架构文档 §3.3 #24 / §6.2）：
 * 顶栏 = Logo「渡劫code」+ 后端切换下拉 + 审批铃铛（pending 计数徽标）
 *        + 设置图标 + 用户菜单（登出）；内容区经 <Outlet /> 渲染子路由。
 * 守卫内的页面（/dashboard、/w/:id、/settings/*）共用本外壳。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuthStore } from '../store/auth'
import { useWorkspaceStore } from '../store/workspace'
import type { ExecBackend } from '@shared/types'

/** 后端切换选择的持久化键（与 terminal store 约定读取同一键，避免循环依赖） */
const BACKEND_STORAGE_KEY = 'dujiecode.backend'

/** 后端选项视图（虚拟 Shell 内置项 + 远程后端） */
interface BackendOption {
  id: string
  name: string
  online: boolean
}

/** 类名拼接小工具 */
function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** 品牌标识：渡劫（雷霆）紫方形标 */
export function LogoMark({ className = 'h-7 w-7' }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#7c6cf0" />
      <path d="M18 4 9 17h5.5L13 28 23 13h-6l1-9z" fill="#ffffff" />
    </svg>
  )
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

const TerminalIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon
    path="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13z M8 9.5l2.5 2.5L8 14.5 M12.5 14.5H16"
    className={className}
  />
)
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
const ChevronDownIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M6 9.5l6 6 6-6" className={className} />
)
const MenuIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M4 6.5h16 M4 12h16 M4 17.5h16" className={className} />
)
const CloseIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M6 6l12 12 M18 6L6 18" className={className} />
)
const CheckIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M5 12.5l4.5 4.5L19 7.5" className={className} />
)
const LogoutIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M15 4.5H7.5A1.5 1.5 0 0 0 6 6v12a1.5 1.5 0 0 0 1.5 1.5H15 M12 8l4 4-4 4 M16 12H9" className={className} />
)
const DocIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M6.5 3.5h7L18 8v12.5h-11.5V3.5z M13.5 3.5V8H18 M9.5 12.5h5 M9.5 16h5" className={className} />
)
const ExternalIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M14 4.5h5.5V10 M19.5 4.5 10 14 M18 14v5.5H4.5V6H10" className={className} />
)

/** 点击容器外关闭的通用钩子（下拉菜单用） */
function useClickOutside(onOutside: () => void): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const node = ref.current
      if (node !== null && !node.contains(event.target as Node)) {
        onOutside()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [onOutside])
  return ref
}

/** 应用外壳（§6.2） */
export default function Layout(): ReactNode {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  // 审批铃铛计数与当前工作区来自 workspace store（§6.3）
  const pendingApprovalCount = useWorkspaceStore((s) => s.pendingApprovalCount)
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentId)

  const [backends, setBackends] = useState<BackendOption[]>([])
  const [currentBackend, setCurrentBackend] = useState<string>(() => {
    try {
      return globalThis.localStorage.getItem(BACKEND_STORAGE_KEY) ?? 'vfs'
    } catch {
      return 'vfs'
    }
  })
  const [backendMenuOpen, setBackendMenuOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  /** 移动端汉堡抽屉（≤768px 主导航入口） */
  const [drawerOpen, setDrawerOpen] = useState(false)

  // 拉取执行后端列表（展示在线状态；失败时仅保留内置虚拟 Shell）
  useEffect(() => {
    let cancelled = false
    api
      .get<{ backends: ExecBackend[] }>('/api/backends')
      .then((res) => {
        if (!cancelled) {
          setBackends(
            res.backends.map((b) => ({ id: b.id, name: b.name, online: b.status === 'online' })),
          )
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // 选择持久化：terminal store 打开新会话时读取同一键
  useEffect(() => {
    try {
      globalThis.localStorage.setItem(BACKEND_STORAGE_KEY, currentBackend)
    } catch {
      // 隐私模式等写入失败场景忽略
    }
  }, [currentBackend])

  // 路由变化时自动收起抽屉（避免抽屉残留遮挡内容）
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  // 抽屉展开时锁定 body 滚动，并按 ESC 关闭
  useEffect(() => {
    if (!drawerOpen) {
      return undefined
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDrawerOpen(false)
      }
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    globalThis.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      globalThis.removeEventListener('keydown', onKeyDown)
    }
  }, [drawerOpen])

  const closeBackendMenu = useCallback(() => setBackendMenuOpen(false), [])
  const closeUserMenu = useCallback(() => setUserMenuOpen(false), [])
  const backendRef = useClickOutside(closeBackendMenu)
  const userRef = useClickOutside(closeUserMenu)

  /** 登出：清空会话后回登录页 */
  const onLogout = useCallback(async () => {
    setUserMenuOpen(false)
    setDrawerOpen(false)
    await logout()
    navigate('/login', { replace: true })
  }, [logout, navigate])

  /** 审批铃铛：待审批项在 ChatPanel 内联展示，跳转到最近工作区（或工作台） */
  const onBellClick = useCallback(() => {
    navigate(currentWorkspaceId ? `/w/${currentWorkspaceId}` : '/dashboard')
  }, [navigate, currentWorkspaceId])

  const options: BackendOption[] = [
    { id: 'vfs', name: '虚拟 Shell（内置）', online: true },
    ...backends,
  ]
  const current = options.find((option) => option.id === currentBackend) ?? options[0]
  const currentLabel = current.id === 'vfs' ? '虚拟 Shell' : current.name
  const initial = (user?.displayName || user?.email || '?').trim().charAt(0).toUpperCase()

  /** 抽屉导航项（移动端主导航；active 按当前路径高亮） */
  const drawerLinks: { to: string; label: string }[] = [
    { to: '/dashboard', label: '工作台' },
    { to: '/settings/general', label: '设置 · 通用' },
    { to: '/settings/providers', label: '设置 · 供应商' },
    { to: '/settings/backends', label: '设置 · 执行后端' },
  ]

  return (
    <div className="flex h-screen flex-col bg-bg">
      {/* 顶栏 */}
      <header className="z-40 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-panel/90 px-3 backdrop-blur-md sm:px-4">
        <Link to="/dashboard" className="flex items-center gap-2 rounded-md py-1 pr-2">
          <LogoMark className="h-7 w-7" />
          <span className="text-[15px] font-semibold tracking-wide">渡劫code</span>
        </Link>

        {/* 移动端汉堡按钮（≤768px 显示，展开主导航抽屉） */}
        <button
          type="button"
          className="btn btn-ghost btn-sm touch-target md:hidden"
          aria-label="打开导航菜单"
          aria-expanded={drawerOpen}
          onClick={() => {
            setDrawerOpen(true)
            setBackendMenuOpen(false)
            setUserMenuOpen(false)
          }}
        >
          <MenuIcon className="h-5 w-5" />
        </button>

        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          {/* 后端切换下拉 */}
          <div className="relative" ref={backendRef}>
            <button
              type="button"
              aria-expanded={backendMenuOpen}
              className="btn btn-ghost btn-sm gap-1.5"
              onClick={() => {
                setBackendMenuOpen((open) => !open)
                setUserMenuOpen(false)
              }}
            >
              <TerminalIcon className="h-4 w-4" />
              <span className="hidden max-w-[9rem] truncate sm:inline">{currentLabel}</span>
              <span
                className={cx(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  current.online ? 'bg-ok' : 'bg-dim',
                )}
              />
              <ChevronDownIcon
                className={cx('h-3.5 w-3.5 transition-transform', backendMenuOpen && 'rotate-180')}
              />
            </button>
            {backendMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-64 origin-top-right rounded-lg border border-border bg-elev p-1.5 shadow-panel">
                <p className="px-2.5 py-1.5 text-[11px] font-medium text-dim">
                  执行后端（新终端默认）
                </p>
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setCurrentBackend(option.id)
                      setBackendMenuOpen(false)
                    }}
                    className={cx(
                      'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors',
                      option.id === current.id
                        ? 'bg-accent/15 text-accent'
                        : 'text-text hover:bg-panel',
                    )}
                  >
                    <span
                      className={cx(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        option.online ? 'bg-ok' : 'bg-dim',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                    {option.id === current.id && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                ))}
                <div className="mt-1 border-t border-border px-2.5 pb-1 pt-2">
                  <Link
                    to="/settings/backends"
                    className="text-[11px] text-dim transition-colors hover:text-accent"
                    onClick={() => setBackendMenuOpen(false)}
                  >
                    在「设置 → 执行后端」中添加服务器
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* 审批铃铛（pending 计数徽标） */}
          <button
            type="button"
            title={
              pendingApprovalCount > 0
                ? `${pendingApprovalCount} 个待处理审批`
                : '暂无待处理审批'
            }
            className="btn btn-ghost btn-sm relative"
            onClick={onBellClick}
          >
            <BellIcon className="h-[18px] w-[18px]" />
            {pendingApprovalCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-err px-1 text-[10px] font-semibold leading-none text-white">
                {pendingApprovalCount > 99 ? '99+' : pendingApprovalCount}
              </span>
            )}
          </button>

          {/* 设置入口 */}
          <Link to="/settings/general" className="btn btn-ghost btn-sm" title="设置">
            <GearIcon className="h-[18px] w-[18px]" />
          </Link>

          {/* 用户菜单 */}
          <div className="relative" ref={userRef}>
            <button
              type="button"
              aria-expanded={userMenuOpen}
              className="btn btn-ghost btn-sm gap-1.5"
              onClick={() => {
                setUserMenuOpen((open) => !open)
                setBackendMenuOpen(false)
              }}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/20 text-[11px] font-semibold text-accent">
                {initial}
              </span>
              <span className="hidden max-w-[8rem] truncate md:inline">
                {user?.displayName || user?.email?.split('@')[0] || '未登录'}
              </span>
              <ChevronDownIcon
                className={cx('h-3.5 w-3.5 transition-transform', userMenuOpen && 'rotate-180')}
              />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-60 origin-top-right rounded-lg border border-border bg-elev p-1.5 shadow-panel">
                <div className="border-b border-border px-2.5 py-2.5">
                  <p className="truncate text-xs font-medium text-text">
                    {user?.displayName || '未命名用户'}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-dim">{user?.email ?? ''}</p>
                </div>
                <Link
                  to="/settings/general"
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-xs text-text transition-colors hover:bg-panel"
                  onClick={() => setUserMenuOpen(false)}
                >
                  <DocIcon className="h-3.5 w-3.5 text-dim" />
                  设置与审计
                </Link>
                <Link
                  to="/"
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-xs text-text transition-colors hover:bg-panel"
                  onClick={() => setUserMenuOpen(false)}
                >
                  <ExternalIcon className="h-3.5 w-3.5 text-dim" />
                  返回官网
                </Link>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-err transition-colors hover:bg-err/10"
                  onClick={() => void onLogout()}
                >
                  <LogoutIcon className="h-3.5 w-3.5" />
                  退出登录
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* 移动端导航抽屉（≤768px）：半透明遮罩 + 左侧滑出面板 */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <nav
            className="absolute left-0 top-0 flex h-full w-[17rem] max-w-[82vw] flex-col border-r border-border bg-panel shadow-panel"
            aria-label="主导航"
          >
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
              <LogoMark className="h-7 w-7" />
              <span className="text-[15px] font-semibold tracking-wide">渡劫code</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm touch-target ml-auto"
                aria-label="关闭导航菜单"
                onClick={() => setDrawerOpen(false)}
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto py-2">
              {drawerLinks.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className={cx('drawer-link', location.pathname.startsWith(link.to) && 'active')}
                  onClick={() => setDrawerOpen(false)}
                >
                  {link.label}
                </Link>
              ))}
            </div>

            <div className="shrink-0 border-t border-border p-3">
              <button
                type="button"
                className="btn btn-outline touch-target w-full justify-center"
                onClick={() => void onLogout()}
              >
                <LogoutIcon className="h-4 w-4" />
                退出登录
              </button>
            </div>
          </nav>
        </div>
      )}

      {/* 内容区：子路由经 Outlet 渲染；工作区页自行管理内部滚动与布局 */}
      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
