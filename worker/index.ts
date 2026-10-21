/**
 * Worker 入口（架构文档 §5.1 请求生命周期 / §12 路由挂载总表）。
 *
 * 职责：
 * - `/api/*` 请求交 Hono 应用（auth / providers / workspaces / shell /
 *   conversations / backends 全部路由）；
 * - 其余请求（静态资源 / SPA 前端路由）交 `env.ASSETS`
 *   （wrangler.toml 已配 not_found_handling = single-page-application）；
 * - 内联中间件链（按注册顺序执行）：
 *   1. requestId —— 生成 / 透传 X-Request-Id，响应头回写，结构化访问日志；
 *   2. CORS —— 白名单 = APP_ORIGIN + 本地开发源，OPTIONS 预检直接 204；
 *   3. JWT 鉴权 + api 限流 —— Cookie `dj_session` 验签 + KV 会话吊销校验，
 *      通过后按用户维度做 60 次 / 分滑动窗口限流；
 * - 统一错误归一化：HttpError 按原状态码输出 `{code, message, details?}`，
 *   未预期异常一律 500 INTERNAL（细节只进日志，不泄露给客户端）。
 */
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { RATE_LIMITS } from '@shared/constants'
import { httpError, isHttpError, newId, verifyJwt } from './lib/core'
import type { SessionRecord } from './lib/core'
import type { AppEnv, Env } from './types'
import { readEnvVar } from './agent/loop'
import authRoutes from './routes/auth'
import providerRoutes from './routes/providers'
import workspaceRoutes from './routes/workspaces'
import shellRoutes from './routes/shell'
import conversationRoutes from './routes/conversations'
import backendRoutes from './routes/backends'
import blogRoutes from './routes/blog'
import adminRoutes from './routes/admin'
import { runWeeklyBackup } from './lib/backup'
/* Durable Object 必须从 Worker 入口导出，wrangler 据此识别绑定类（部署集成要求） */
export { TerminalRoom } from '../do/terminal-room'

/* ------------------------------------------------------------------ */
/* 镜像信息（§12-D2）：/api/region 供落地页展示国内/海外推荐入口           */
/* （不做服务端跳转，所有访客统一由本 Worker 直接服务）                     */
/* ------------------------------------------------------------------ */

/** 主域（345 CF 账号自定义域名，官网唯一主入口） */
const MAIN_DOMAIN = 'https://dujiecone.520691.xyz'
/** 国内镜像地址（GitHub Pages，国内可达且免实名认证；可切换为 Gitee Pages） */
const DEFAULT_CN_MIRROR = 'https://gjsvip.github.io/'
/** Gitee Pages 预期地址（账户完成实名认证并在仓库「服务 → Gitee Pages」启用后生效） */
const GITEE_PAGES_MIRROR = 'https://dujie_nb_admin.gitee.io/dujiecode'
/** CF Pages 官网镜像（静态版，海外可达） */
const CF_PAGES_MIRROR = 'https://dujiecode-9ka.pages.dev'
/** 个人官网（520691.xyz 域名体系） */
const HOMEPAGE_URL = 'https://www.520691.xyz'
/** 博客（520691.xyz 域名体系） */
const BLOG_URL = 'https://blog.520691.xyz'

/* ------------------------------------------------------------------ */
/* Hono 应用与统一 JSON 错误响应助手                                     */
/* ------------------------------------------------------------------ */

const app = new Hono<AppEnv>()

/**
 * 构造统一错误响应（§5.1 信封：`{code, message, details?}`）。
 * 直接构造 Response 而非 c.json，以便 onError 中以运行时状态码渲染。
 */
function jsonError(code: string, message: string, status: number, details?: unknown): Response {
  const body = details === undefined ? { code, message } : { code, message, details }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/* ------------------------------------------------------------------ */
/* 中间件 1：requestId（透传 / 生成 + 访问日志）                         */
/* ------------------------------------------------------------------ */

/**
 * requestId → 原始 Request 的映射。
 * 用 WeakMap 而非上下文变量持有，确保 onError（可能拿到未完整执行的上下文）
 * 与 SSE 流式响应场景下都能取到同一 ID；WeakMap 键弱引用，无内存泄漏风险。
 */
const requestIdByRequest = new WeakMap<Request, string>()

/** 单条访问日志（结构化 JSON，wrangler tail 可直接检索） */
function logAccess(c: Context<AppEnv>, requestId: string, startedAt: number): void {
  console.log(
    JSON.stringify({
      level: 'info',
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
    }),
  )
}

const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // 优先透传客户端 / 上游传入的 X-Request-Id（截断防滥用），否则本地生成
  const inbound = c.req.header('X-Request-Id')
  const requestId =
    inbound !== undefined && inbound.trim() !== '' ? inbound.trim().slice(0, 64) : newId('req_')
  requestIdByRequest.set(c.req.raw, requestId)
  // T04：注入上下文变量，业务日志（turnstile/notify/backup 等 scope）可带 requestId 关联
  c.set('requestId', requestId)
  c.header('X-Request-Id', requestId)

  const startedAt = Date.now()
  await next()
  // SSE 长连接在响应头返回时即可记录，不等待流式 body 结束
  logAccess(c, requestId, startedAt)
}

/* ------------------------------------------------------------------ */
/* 中间件 2：CORS（白名单 = APP_ORIGIN + 本地开发源）                     */
/* ------------------------------------------------------------------ */

/** 预检缓存 24h（秒） */
const CORS_MAX_AGE_SEC = 86400
/** 允许的请求方法（与 §5.2 端点表一致） */
const CORS_ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'
/** 允许的请求头（Content-Type + 备用 Authorization + requestId 透传 + T04 管理令牌） */
const CORS_ALLOWED_HEADERS = 'Content-Type, Authorization, X-Request-Id, X-Admin-Token'

/**
 * 判断 Origin 是否命中白名单：
 * - APP_ORIGIN 环境变量（生产前端源，精确匹配）；
 * - CORS_ORIGINS 环境变量（逗号分隔的多镜像源：GitHub Pages / CF Pages / Gitee Pages）；
 * - 本地开发源 http(s)://localhost | 127.0.0.1 任意端口（Vite dev / wrangler dev）。
 */
function isOriginAllowed(origin: string, env: Env): boolean {
  const appOrigin = readEnvVar(env, 'APP_ORIGIN', '')
  if (appOrigin !== '' && origin === appOrigin) {
    return true
  }
  const extraOrigins = readEnvVar(env, 'CORS_ORIGINS', '')
  if (extraOrigins !== '') {
    const list = extraOrigins
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
    if (list.includes(origin)) {
      return true
    }
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

const corsMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin')
  // 无 Origin（同源 GET / WS 升级 / 服务端调用）或不在白名单：不回写 CORS 头，
  // 由浏览器同源策略自行拦截（服务端不主动报错，避免泄露白名单判定逻辑）。
  if (origin === undefined || !isOriginAllowed(origin, c.env)) {
    await next()
    return
  }
  c.header('Access-Control-Allow-Origin', origin)
  c.header('Access-Control-Allow-Credentials', 'true')
  c.header('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS)
  c.header('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
  c.header('Access-Control-Expose-Headers', 'X-Request-Id')
  c.header('Access-Control-Max-Age', String(CORS_MAX_AGE_SEC))
  c.header('Vary', 'Origin')
  if (c.req.method === 'OPTIONS') {
    // 预检请求直接放行（不带任何业务处理）
    return c.body(null, 204)
  }
  await next()
}

/* ------------------------------------------------------------------ */
/* 中间件 3：JWT 鉴权 + api 限流（60 次 / 分 / 用户）                     */
/* ------------------------------------------------------------------ */

/** 会话 Cookie 名（HttpOnly；与 routes/auth.ts 的签发逻辑一致） */
const SESSION_COOKIE = 'dj_session'

/**
 * 免鉴权端点（§5.1）：
 * - POST /api/auth/register、POST /api/auth/login —— 登录前入口；
 * - GET /api/agent/connect —— 本地执行后端 agent 的 WS 升级，
 *   凭 agent token 在 DO 内鉴权（backends.ts 转发时前置校验归属）；
 * - OPTIONS —— CORS 预检，无业务语义。
 */
const AUTH_EXEMPTIONS: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/auth/register' },
  { method: 'POST', path: '/api/auth/login' },
  { method: 'GET', path: '/api/agent/connect' },
  // 地域与镜像信息（§12-D2 国内外分流）：落地页免登录获取访客国家与推荐入口
  { method: 'GET', path: '/api/region' },
  // 博客互动（公开数据：评论/点赞/浏览量/说说，三端静态站共用，防刷靠限流与指纹）
  { method: 'GET', path: '/api/blog/comments' },
  { method: 'POST', path: '/api/blog/comments' },
  { method: 'POST', path: '/api/blog/like' },
  { method: 'POST', path: '/api/blog/view' },
  { method: 'GET', path: '/api/blog/stats' },
  { method: 'GET', path: '/api/blog/says' },
  // T04 前端灰度开关唯一数据源（公开，无业务敏感信息）
  { method: 'GET', path: '/api/blog/config' },
]

/** api 限流 KV 计数 TTL（秒）：120s 覆盖前后两个分钟桶，保证窗口滑动 */
const API_RATE_TTL_SEC = 120

/** 去除末尾斜杠后精确匹配免鉴权表（容忍 `/api/auth/login/` 写法）；
 * HEAD 归一为 GET（Hono GET 路由依 HTTP 规范自动兼容 HEAD，豁免判断需同步） */
function isAuthExempt(c: Context<AppEnv>): boolean {
  if (c.req.method === 'OPTIONS') {
    return true
  }
  const method = c.req.method === 'HEAD' ? 'GET' : c.req.method
  const path = c.req.path.replace(/\/+$/, '') || '/'
  return AUTH_EXEMPTIONS.some((rule) => rule.method === method && rule.path === path)
}

/**
 * api 限流：60 次 / 分 / 用户（KV `ratelimit:api:{userId}:{minuteBucket}`，§4.3）。
 * 超限返回带 Retry-After 的 429；未超限计数 +1。
 */
async function checkApiRateLimit(c: Context<AppEnv>, userId: string): Promise<Response | undefined> {
  const bucket = Math.floor(Date.now() / (RATE_LIMITS.api.windowSec * 1000))
  const key = `ratelimit:api:${userId}:${bucket}`
  const raw = await c.env.KV.get(key)
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10)
  const used = Number.isFinite(parsed) ? parsed : 0
  if (used >= RATE_LIMITS.api.limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil(((bucket + 1) * RATE_LIMITS.api.windowSec * 1000 - Date.now()) / 1000),
    )
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' }, 429)
  }
  await c.env.KV.put(key, String(used + 1), { expirationTtl: API_RATE_TTL_SEC })
  return undefined
}

/**
 * 鉴权中间件：验签 Cookie JWT → 校验 KV 会话（服务端吊销）→ 注入上下文变量
 * → api 限流。验签失败抛 401 UNAUTHORIZED（由 onError 归一化为 JSON）。
 */
const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // 入口只把 /api/* 交给 Hono，此处防御性再判一次；非 API 路径直接放行
  if (!c.req.path.startsWith('/api/') || isAuthExempt(c)) {
    await next()
    return
  }

  // T04 管理 API 自带 X-Admin-Token 鉴权（routes/admin.ts 的 adminAuth），不占用用户会话。
  // isAuthExempt 是 method+path 精确匹配（管理路径带 :id 动态段，通配不可行），
  // 故用前缀放行 + 路由级中间件承接，语义等价且不漏放（设计 §2.1）。
  if (c.req.path.startsWith('/api/blog/admin/')) {
    await next()
    return
  }

  const token = getCookie(c, SESSION_COOKIE)
  if (token === undefined) {
    throw httpError('UNAUTHORIZED', '未登录或会话已失效', 401)
  }
  // verifyJwt 校验三段结构 / alg=HS256 / 签名 / exp，失败抛 401
  const payload = await verifyJwt(token, c.env.JWT_SECRET)

  // 服务端会话校验：KV session:{jti} 必须存在（登出 / 吊销即删），
  // 且记录主体与令牌 sub 一致（防 JWT_SECRET 轮换后旧令牌复用）
  const raw = await c.env.KV.get(`session:${payload.jti}`)
  if (raw === null) {
    throw httpError('UNAUTHORIZED', '会话已失效，请重新登录', 401)
  }
  let record: SessionRecord | null = null
  try {
    record = JSON.parse(raw) as SessionRecord
  } catch {
    record = null
  }
  if (record === null || record.userId !== payload.sub) {
    throw httpError('UNAUTHORIZED', '会话已失效，请重新登录', 401)
  }

  c.set('userId', payload.sub)
  c.set('email', payload.email)
  c.set('jti', payload.jti)

  const limited = await checkApiRateLimit(c, payload.sub)
  if (limited !== undefined) {
    return limited
  }
  await next()
}

/* ------------------------------------------------------------------ */
/* 中间件注册与路由挂载                                                  */
/* ------------------------------------------------------------------ */

app.use('*', requestIdMiddleware)
app.use('*', corsMiddleware)
app.use('*', authMiddleware)

// 认证（§5.2）：register / login / logout / me
app.route('/api/auth', authRoutes)
// 供应商（§5.2）：CRUD + test + models
app.route('/api/providers', providerRoutes)
// 工作区（§5.2）：CRUD + 文件树 / 内容读写 / 搜索
app.route('/api/workspaces', workspaceRoutes)
// 手动终端执行（§5.2）：POST /api/workspaces/:id/exec（与上一行同前缀，路径不冲突）
app.route('/api/workspaces', shellRoutes)
// 会话 / 消息 / 审批 / 审计（§5.2、§6）：挂 /api，内含 /workspaces/:id/conversations 子路径
app.route('/api', conversationRoutes)
// 执行后端 / agent token / WS 升级（§8）：挂 /api，含 /terminal/connect、/agent/connect
app.route('/api', backendRoutes)
// 博客互动（评论/点赞/浏览量/说说，公开免鉴权，数据存 BLOG_DB）
app.route('/api/blog', blogRoutes)
// T04 管理后台（8 个端点，组内 adminAuth 鉴权；index.ts 已对前缀放行 JWT 中间件）
app.route('/api/blog/admin', adminRoutes)

// 地域与镜像信息（§12-D2）：免鉴权。落地页据此展示「国内/海外推荐入口」提示，
// 静态镜像（GitHub Pages 等） fetch 失败时静默降级为静态镜像列表。
app.get('/api/region', (c) => {
  const country = c.req.raw.cf?.country ?? 'unknown'
  const appUrl = readEnvVar(c.env, 'APP_ORIGIN', '') || MAIN_DOMAIN
  return c.json({
    country,
    cnMirror: readEnvVar(c.env, 'CN_MIRROR_URL', DEFAULT_CN_MIRROR),
    appUrl,
    mirrors: {
      main: appUrl,
      cloudflare: appUrl,
      cfPages: CF_PAGES_MIRROR,
      githubPages: DEFAULT_CN_MIRROR,
      giteePages: GITEE_PAGES_MIRROR,
      homepage: HOMEPAGE_URL,
      blog: BLOG_URL,
    },
  })
})

/** 统一错误归一化（§5.1）：HttpError 原样渲染；未预期异常 500 且细节只进日志 */
app.onError((err, c) => {
  const requestId = requestIdByRequest.get(c.req.raw) ?? 'unknown'
  if (isHttpError(err)) {
    console.log(
      JSON.stringify({
        level: 'warn',
        requestId,
        method: c.req.method,
        path: c.req.path,
        code: err.code,
        status: err.status,
        message: err.message,
      }),
    )
    return jsonError(err.code, err.message, err.status, err.details)
  }
  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      method: c.req.method,
      path: c.req.path,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  )
  return jsonError('INTERNAL', '服务器内部错误', 500)
})

/** 未匹配路由：JSON 404（SPA 前端路由由 ASSETS 的 not_found_handling 负责回退） */
app.notFound((c) => {
  return jsonError('NOT_FOUND', '接口不存在', 404)
})

/* ------------------------------------------------------------------ */
/* Worker 默认导出：/api/* → Hono；其余 → 静态资源绑定                    */
/* ------------------------------------------------------------------ */

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx)
    }
    // 不做地域跳转：所有访客（含国内）统一由本 Worker 直接服务，
    // 国内可达镜像入口经落地页「访问入口」导航区与 /api/region 提示自行选择。
    try {
      // 静态资源 / SPA 回退（index.html）；ASSETS 对不存在路径按
      // not_found_handling 配置返回 index.html（GET）或 405（非 GET）
      return await env.ASSETS.fetch(request)
    } catch {
      // 资源绑定异常（如不受支持的请求方法打到资源路由）归一化为 JSON 404
      return jsonError('NOT_FOUND', '资源不存在', 404)
    }
  },
  // T05 定时备份（wrangler.toml [triggers] crons = ["0 2 * * 1"]，周一 02:00 UTC）：
  // waitUntil 保证 backup 在 isolate 回收前执行完；异常由 backup 调用链上抛至此，
  // 记 console.error 后本周失败不重试，下周一自然重跑（设计 §5）。
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runWeeklyBackup(env).catch((err) => {
        console.error(
          JSON.stringify({ level: 'error', scope: 'backup', msg: '周备份失败', error: String(err) }),
        )
      }),
    )
  },
}

export default worker
