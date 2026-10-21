/**
 * 注册 / 登录页（架构文档 §3.3 #20，认证契约见 §5.2）。
 *
 * - 邮箱 + 密码（服务端 PBKDF2-SHA256 加盐哈希，§0）；
 * - Tab 切换登录 / 注册，密码规则提示（8–72 字符，含字母与数字）；
 * - 错误按 §5.1 错误码中文化；静态加密安全说明（§0 服务端信封加密）。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ApiError } from '../api'
import { useAuthStore } from '../store/auth'

/** 密码规则（§5.2）：8–72 字符，需同时包含字母与数字 */
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*[0-9])[\s\S]{8,72}$/
/** 邮箱格式（宽松但实用的校验，最终以服务端为准） */
const EMAIL_RULE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 表单模式：登录 / 注册 */
type Mode = 'login' | 'register'

/** 错误码 → 中文可读信息（§5.1 错误码表） */
function friendlyErrorMessage(err: ApiError): string {
  switch (err.code) {
    case 'EMAIL_TAKEN':
      return '该邮箱已被注册，请直接登录'
    case 'INVALID_CREDENTIALS':
      return '邮箱或密码不正确'
    case 'RATE_LIMITED':
      return '操作过于频繁，请一分钟后再试'
    case 'VALIDATION_ERROR':
      return err.message || '请检查输入内容'
    case 'UNAUTHORIZED':
      return '登录状态已失效，请重新登录'
    default:
      return err.message || '服务繁忙，请稍后重试'
  }
}

/** 品牌标识：渡劫（雷霆）紫方形标 */
function LogoMark({ className = 'h-8 w-8' }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#7c6cf0" />
      <path d="M18 4 9 17h5.5L13 28 23 13h-6l1-9z" fill="#ffffff" />
    </svg>
  )
}

function CheckIcon({ className = 'h-3.5 w-3.5' }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}

function LockIcon({ className = 'h-3.5 w-3.5' }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6.5 10.5V8a5.5 5.5 0 0 1 11 0v2.5" />
      <rect x="4.5" y="10.5" width="15" height="10" rx="1.5" />
    </svg>
  )
}

function EyeIcon({ className = 'h-4 w-4' }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon({ className = 'h-4 w-4' }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 4l16 16" />
      <path d="M9.5 5.9A9.9 9.9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 4" />
      <path d="M6.6 7.6A17 17 0 0 0 2.5 12S6 18.5 12 18.5c1 0 1.9-.2 2.7-.5" />
      <path d="M10 10a3 3 0 0 0 4.2 4.2" />
    </svg>
  )
}

function AlertIcon({ className = 'h-3.5 w-3.5' }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3.5 21.5 20h-19L12 3.5z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.5h.01" />
    </svg>
  )
}

/** 类名拼接小工具（避免引入 clsx 依赖） */
function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** 注册 / 登录页（§6.1 /login） */
export default function LoginPage(): ReactNode {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const bootstrap = useAuthStore((s) => s.bootstrap)
  const login = useAuthStore((s) => s.login)
  const register = useAuthStore((s) => s.register)

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<{ email?: string; password?: string }>({})

  // 守卫跳转来源（RequireAuth 写入 location.state.from）
  const from = (location.state as { from?: string } | null)?.from
  const redirectTo = from !== undefined && from.startsWith('/') ? from : '/dashboard'

  // 恢复会话；已登录用户直接进入工作台
  useEffect(() => {
    if (!user) {
      void bootstrap()
    }
  }, [user, bootstrap])
  useEffect(() => {
    if (user) {
      navigate(redirectTo, { replace: true })
    }
  }, [user, navigate, redirectTo])

  /** 切换登录 / 注册时清空错误态 */
  function switchMode(next: Mode): void {
    setMode(next)
    setError(null)
    setFieldError({})
  }

  /** 前端预校验（与服务端规则一致，减少无效请求） */
  function validate(): boolean {
    const next: { email?: string; password?: string } = {}
    if (!EMAIL_RULE.test(email.trim())) {
      next.email = '请输入有效的邮箱地址'
    }
    if (!PASSWORD_RULE.test(password)) {
      next.password = '密码需为 8–72 个字符，且同时包含字母与数字'
    }
    setFieldError(next)
    return Object.keys(next).length === 0
  }

  /** 提交：登录或注册（注册成功即登录，响应 Set-Cookie） */
  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    if (!validate()) {
      return
    }
    setSubmitting(true)
    try {
      if (mode === 'login') {
        await login(email.trim(), password)
      } else {
        await register(email.trim(), password, displayName.trim() || undefined)
      }
      navigate(redirectTo, { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? friendlyErrorMessage(err) : '发生未知错误，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-bg p-4 lg:p-8">
      {/* 背景光晕（渡劫紫） */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[30rem] w-[52rem] -translate-x-1/2 rounded-full bg-accent/15 blur-[120px]" />
      </div>

      <div className="relative grid w-full max-w-5xl gap-8 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        {/* 品牌面板（大屏展示价值与安全说明） */}
        <section className="hidden lg:block">
          <Link to="/" className="inline-flex items-center gap-2.5">
            <LogoMark className="h-9 w-9" />
            <span className="text-lg font-semibold tracking-wide">渡劫code</span>
          </Link>
          <h1 className="mt-8 text-3xl font-bold leading-snug tracking-wide">
            在浏览器里，
            <br />
            完成一次编程渡劫
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-dim">
            对话式编程、Monaco 编辑器、虚拟 Shell 与远程执行后端融为一体。打开网页即用，无需安装任何环境。
          </p>
          <ul className="mt-8 space-y-3">
            {[
              '对话式编程：模型中立，自带 API Key',
              '云端工作区：文件树 + 编辑器 + 终端',
              '双模终端：虚拟 Shell / 自有服务器',
              '安全可控：危险命令审批 + 审计日志',
            ].map((text) => (
              <li key={text} className="flex items-center gap-2.5 text-sm text-text">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
                  <CheckIcon className="h-3 w-3" />
                </span>
                {text}
              </li>
            ))}
          </ul>
          <div className="card mt-8 bg-panel/70 p-4">
            <p className="flex items-center gap-2 text-xs font-medium text-text">
              <LockIcon className="text-accent" />
              静态加密说明
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-dim">
              密码经 PBKDF2-SHA256（10 万次迭代 + 每用户随机盐）哈希后存储；API Key 与 agent token
              以 AES-256-GCM 信封加密静态存储；登录会话存于 HttpOnly Cookie，可服务端随时吊销。
            </p>
          </div>
        </section>

        {/* 表单卡片 */}
        <section className="card w-full bg-elev/80 p-6 shadow-panel sm:p-8">
          <Link to="/" className="mb-6 inline-flex items-center gap-2 lg:hidden">
            <LogoMark className="h-7 w-7" />
            <span className="text-[15px] font-semibold tracking-wide">渡劫code</span>
          </Link>

          {/* 登录 / 注册 Tab */}
          <div className="flex rounded-lg border border-border bg-bg p-1" role="tablist">
            {(
              [
                ['login', '登录'],
                ['register', '注册'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                onClick={() => switchMode(key)}
                className={cx(
                  'flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors',
                  mode === key ? 'bg-accent text-white' : 'text-dim hover:text-text',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <form className="mt-6" onSubmit={(e) => void onSubmit(e)} noValidate>
            {/* 昵称（仅注册） */}
            {mode === 'register' && (
              <div className="mb-4">
                <label className="label" htmlFor="displayName">
                  昵称（选填）
                </label>
                <input
                  id="displayName"
                  className="field"
                  type="text"
                  autoComplete="nickname"
                  maxLength={40}
                  placeholder="怎么称呼你？"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
            )}

            {/* 邮箱 */}
            <div className="mb-4">
              <label className="label" htmlFor="email">
                邮箱
              </label>
              <input
                id="email"
                className="field"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {fieldError.email && (
                <p className="mt-1.5 text-[11px] text-err">{fieldError.email}</p>
              )}
            </div>

            {/* 密码 */}
            <div className="mb-1.5">
              <label className="label" htmlFor="password">
                密码
              </label>
              <div className="relative">
                <input
                  id="password"
                  className="field pr-11"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-2 text-dim transition-colors hover:text-text"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              {fieldError.password ? (
                <p className="mt-1.5 text-[11px] text-err">{fieldError.password}</p>
              ) : (
                <p className="mt-1.5 text-[11px] text-dim">8–72 个字符，需同时包含字母与数字</p>
              )}
            </div>

            {/* 错误提示 */}
            {error && (
              <p
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-lg border border-err/40 bg-err/10 px-3 py-2.5 text-xs leading-relaxed text-err"
              >
                <AlertIcon className="mt-px shrink-0" />
                {error}
              </p>
            )}

            {/* 提交 */}
            <button type="submit" className="btn btn-primary btn-lg mt-6 w-full" disabled={submitting}>
              {submitting && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              )}
              {mode === 'login' ? '登录' : '创建账号'}
            </button>
          </form>

          {/* 模式切换 */}
          <p className="mt-4 text-center text-xs text-dim">
            {mode === 'login' ? '还没有账号？' : '已有账号？'}
            <button
              type="button"
              className="ml-1 text-accent transition-opacity hover:opacity-80 hover:underline"
              onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
            >
              {mode === 'login' ? '免费注册' : '直接登录'}
            </button>
          </p>

          {/* 安全说明（小屏：折叠为「安全特性 ▾」details，避免常驻大段文字撑破布局） */}
          <details className="security-details mt-6 rounded-lg border border-border bg-bg px-3 py-2.5 text-[11px] leading-relaxed text-dim lg:hidden">
            <summary className="flex items-center gap-2 font-medium text-text">
              <LockIcon className="shrink-0 text-accent" />
              安全特性
              <span className="details-arrow ml-auto shrink-0 text-dim transition-transform">▾</span>
            </summary>
            <p className="mt-2">
              静态加密：API Key 与 agent token 以 AES-256-GCM 信封加密存储；密码经 PBKDF2 10
              万次迭代哈希；会话存于 HttpOnly Cookie。
            </p>
          </details>

          <div className="mt-6 text-center">
            <Link to="/" className="text-[11px] text-dim transition-colors hover:text-text">
              ← 返回官网
            </Link>
          </div>
        </section>
      </div>
    </div>
  )
}
