/**
 * 认证路由（架构文档 §5.2 认证端点表）：
 * POST register / login / logout、GET me。
 * - 密码 PBKDF2-SHA256（10 万次迭代 + 16 字节随机盐）哈希后存 D1；
 * - JWT HS256 存 HttpOnly Cookie `dj_session`（SameSite=Lax / Secure / Path=/），
 *   会话记录落 KV（删除即登出 / 服务端吊销）；
 * - 登录限流 5 次 / 分 / IP（KV 计数，超限 429 并带 Retry-After）。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AuthResponse, User } from '@shared/types'
import { ID_PREFIX, RATE_LIMITS, TOKEN_TTL_DAYS } from '@shared/constants'
import type { SessionRecord } from '../lib/core'
import {
  dbFirst,
  dbRun,
  hashPassword,
  httpError,
  isUniqueConstraintError,
  newId,
  nowIso,
  signJwt,
  verifyJwt,
  verifyPassword,
} from '../lib/core'
import type { AppEnv } from '../types'

/** users 表原始行（snake_case，仅在本文件内转换为 camelCase 视图） */
interface UserRow {
  id: string
  email: string
  password_hash: string
  display_name: string
  created_at: string
}

/** 会话 Cookie 名（HttpOnly，前端 JS 不可读） */
const SESSION_COOKIE = 'dj_session'
/** 会话有效期（秒）= TOKEN_TTL_DAYS 天 */
const SESSION_TTL_SEC = TOKEN_TTL_DAYS * 24 * 60 * 60
/** 登录限流 KV 计数 TTL（秒）：120s 覆盖前后两个分钟桶，保证窗口滑动 */
const LOGIN_RATE_TTL_SEC = 120

const authRoutes = new Hono<AppEnv>()

/** DB 行 → 对外 User 视图 */
function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at }
}

/** 邮箱规范化：去首尾空白并转小写（D1 users.email UNIQUE 即按此存储） */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError('VALIDATION_ERROR', '邮箱格式不正确', 400)
  }
}

/** 密码规则（§5.2）：8–72 字符，需含字母与数字 */
function validatePassword(password: string): void {
  if (password.length < 8 || password.length > 72) {
    throw httpError('VALIDATION_ERROR', '密码长度需为 8–72 个字符', 400)
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw httpError('VALIDATION_ERROR', '密码需同时包含字母与数字', 400)
  }
}

/** 解析并校验 JSON 对象请求体，非法一律 400 VALIDATION_ERROR */
async function parseJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await c.req.json()
  } catch {
    throw httpError('VALIDATION_ERROR', '请求体不是合法的 JSON', 400)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw httpError('VALIDATION_ERROR', '请求体必须是 JSON 对象', 400)
  }
  return parsed as Record<string, unknown>
}

/** 读取必填字符串字段（空串 / 非字符串视为缺失） */
function readRequiredString(body: Record<string, unknown>, key: string, label: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError('VALIDATION_ERROR', `${label}不能为空`, 400)
  }
  return value
}

/** 客户端 IP：优先 CF-Connecting-IP，回退 X-Forwarded-For 首段 */
function clientIp(c: Context<AppEnv>): string {
  const cfIp = c.req.header('CF-Connecting-IP')
  if (cfIp) {
    return cfIp
  }
  const forwarded = c.req.header('X-Forwarded-For')
  const firstHop = forwarded?.split(',')[0]?.trim()
  return firstHop !== undefined && firstHop !== '' ? firstHop : 'unknown'
}

/**
 * 登录限流：5 次 / 分 / IP（KV `ratelimit:login:{ip}:{minuteBucket}`，§4.3）。
 * 超限返回带 Retry-After 的 429 响应（由调用方直接返回，确保响应头一定送达）；
 * 未超限则计数 +1。每次尝试（含失败）均计数。
 */
async function checkLoginRateLimit(c: Context<AppEnv>): Promise<Response | undefined> {
  const ip = clientIp(c)
  const bucket = Math.floor(Date.now() / (RATE_LIMITS.login.windowSec * 1000))
  const key = `ratelimit:login:${ip}:${bucket}`
  const raw = await c.env.KV.get(key)
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10)
  const used = Number.isFinite(parsed) ? parsed : 0
  if (used >= RATE_LIMITS.login.limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil(((bucket + 1) * RATE_LIMITS.login.windowSec * 1000 - Date.now()) / 1000),
    )
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ code: 'RATE_LIMITED', message: '登录尝试过于频繁，请稍后再试' }, 429)
  }
  await c.env.KV.put(key, String(used + 1), { expirationTtl: LOGIN_RATE_TTL_SEC })
  return undefined
}

/** 签发会话：JWT（HS256，7 天）+ KV 会话记录 + HttpOnly Cookie */
async function setSession(c: Context<AppEnv>, user: User): Promise<void> {
  const jti = newId('jti_')
  const issuedAtSec = Math.floor(Date.now() / 1000)
  const expiresAtSec = issuedAtSec + SESSION_TTL_SEC
  const token = await signJwt(
    { sub: user.id, email: user.email, jti, iat: issuedAtSec, exp: expiresAtSec },
    c.env.JWT_SECRET,
  )
  const record: SessionRecord = {
    userId: user.id,
    email: user.email,
    createdAt: nowIso(),
    exp: expiresAtSec,
  }
  await c.env.KV.put(`session:${jti}`, JSON.stringify(record), { expirationTtl: SESSION_TTL_SEC })
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    path: '/',
    maxAge: SESSION_TTL_SEC,
  })
}

/** 登出：验签 Cookie 取 jti → 删 KV 会话（服务端吊销）→ 清除 Cookie */
async function clearSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    try {
      const payload = await verifyJwt(token, c.env.JWT_SECRET)
      await c.env.KV.delete(`session:${payload.jti}`)
    } catch {
      // 令牌已失效 / 被篡改：无需删除 KV，仅清除 Cookie 即可
    }
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, sameSite: 'Lax', httpOnly: true })
}

/** POST /api/auth/register —— 201 {user} + Set-Cookie；409 EMAIL_TAKEN */
authRoutes.post('/register', async (c) => {
  const body = await parseJsonObject(c)
  const email = normalizeEmail(readRequiredString(body, 'email', '邮箱'))
  const password = readRequiredString(body, 'password', '密码')
  const rawDisplayName = body.displayName
  const displayName = typeof rawDisplayName === 'string' ? rawDisplayName.trim().slice(0, 50) : ''
  validateEmail(email)
  validatePassword(password)

  const existing = await dbFirst<Pick<UserRow, 'id'>>(c.env.DB, 'SELECT id FROM users WHERE email = ?', [email])
  if (existing) {
    throw httpError('EMAIL_TAKEN', '该邮箱已被注册', 409)
  }

  const id = newId(ID_PREFIX.user)
  const passwordHash = await hashPassword(password)
  const now = nowIso()
  try {
    await dbRun(
      c.env.DB,
      'INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, email, passwordHash, displayName, now, now],
    )
  } catch (err) {
    // 并发注册同一邮箱时唯一约束冲突，归一化为 409 EMAIL_TAKEN
    if (isUniqueConstraintError(err)) {
      throw httpError('EMAIL_TAKEN', '该邮箱已被注册', 409)
    }
    throw err
  }

  const user: User = { id, email, displayName, createdAt: now }
  await setSession(c, user)
  const response: AuthResponse = { user }
  return c.json(response, 201)
})

/** POST /api/auth/login —— 200 {user} + Set-Cookie；401 INVALID_CREDENTIALS */
authRoutes.post('/login', async (c) => {
  const limited = await checkLoginRateLimit(c)
  if (limited) {
    return limited
  }

  const body = await parseJsonObject(c)
  const email = normalizeEmail(readRequiredString(body, 'email', '邮箱'))
  const password = readRequiredString(body, 'password', '密码')
  validateEmail(email)

  const row = await dbFirst<UserRow>(
    c.env.DB,
    'SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = ?',
    [email],
  )
  // 用户不存在与密码错误返回同一错误，避免账号枚举
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw httpError('INVALID_CREDENTIALS', '邮箱或密码错误', 401)
  }

  const user = toUser(row)
  await setSession(c, user)
  const response: AuthResponse = { user }
  return c.json(response, 200)
})

/** POST /api/auth/logout —— 204（删 KV 会话 + 清除 Cookie） */
authRoutes.post('/logout', async (c) => {
  await clearSession(c)
  return c.body(null, 204)
})

/** GET /api/auth/me —— 200 {user}（依赖入口 JWT 鉴权中间件注入 userId） */
authRoutes.get('/me', async (c) => {
  const userId = c.get('userId')
  const row = await dbFirst<UserRow>(
    c.env.DB,
    'SELECT id, email, display_name, created_at FROM users WHERE id = ?',
    [userId],
  )
  if (!row) {
    throw httpError('UNAUTHORIZED', '用户不存在或会话已失效', 401)
  }
  const response: AuthResponse = { user: toUser(row) }
  return c.json(response, 200)
})

export default authRoutes
