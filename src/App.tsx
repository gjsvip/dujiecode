/**
 * 渡劫code 路由表（架构文档 §6.1 / §6.2）。
 *
 * - /                    LandingPage（官网，无守卫）
 * - /login               LoginPage（注册/登录，无守卫）
 * - /dashboard           DashboardPage（守卫）
 * - /w/:workspaceId      WorkspacePage（守卫，懒加载）
 * - /settings/providers | /settings/backends | /settings/general
 *                        SettingsPage（守卫，懒加载，initialTab 区分页签）
 * - *                    重定向 /（404 回退）
 *
 * WorkspacePage / SettingsPage 与 Monaco、xterm 一并懒加载，
 * 保证官网首屏 Lighthouse ≥ 90（§6.1）。
 */
import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuthStore } from './store/auth'
import Layout from './components/Layout'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'

// 懒加载：重依赖页面仅在工作区 / 设置路由按需拉取（§6.1）
const WorkspacePage = lazy(() => import('./pages/WorkspacePage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

/** 懒加载占位：品牌加载态 */
function PageFallback(): ReactNode {
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
        <p className="text-sm text-dim">正在加载…</p>
      </div>
    </div>
  )
}

/**
 * 路由守卫（§6.1）：
 * 未登录访问受保护路由时重定向至 /login，并记录来源地址供登录后回跳；
 * 会话恢复中显示加载态，避免刷新页面时闪跳登录页。
 */
function RequireAuth({ children }: { children: ReactNode }): ReactNode {
  const user = useAuthStore((s) => s.user)
  const loading = useAuthStore((s) => s.loading)
  const bootstrap = useAuthStore((s) => s.bootstrap)
  const location = useLocation()

  useEffect(() => {
    // 首次进入且尚无会话结论时恢复会话（GET /api/auth/me）
    if (!user && !loading) {
      void bootstrap()
    }
  }, [user, loading, bootstrap])

  if (loading) {
    return <PageFallback />
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}

/** 应用根组件：路由表 + 守卫 + 应用外壳（§6.1 / §6.2） */
export default function App(): ReactNode {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      {/* 应用外壳：守卫 + Layout，子路由经 <Outlet /> 渲染 */}
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route
          path="/w/:workspaceId"
          element={
            <Suspense fallback={<PageFallback />}>
              <WorkspacePage />
            </Suspense>
          }
        />
        <Route
          path="/settings/providers"
          element={
            <Suspense fallback={<PageFallback />}>
              <SettingsPage initialTab="providers" />
            </Suspense>
          }
        />
        <Route
          path="/settings/backends"
          element={
            <Suspense fallback={<PageFallback />}>
              <SettingsPage initialTab="backends" />
            </Suspense>
          }
        />
        <Route
          path="/settings/general"
          element={
            <Suspense fallback={<PageFallback />}>
              <SettingsPage initialTab="general" />
            </Suspense>
          }
        />
      </Route>
      {/* 404 回退官网（§6.1） */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
