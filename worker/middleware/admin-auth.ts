/**
 * T04 管理 API 鉴权（middleware/admin-auth.ts）—— X-Admin-Token + KV 哈希比对
 * （设计 §2.1，决策 D1）。
 *
 * 机制：
 * - 令牌仅经请求头 `X-Admin-Token` 传递，KV 只存 SHA-256（`admin:token_hash`）；
 * - 常量时间比对（timingSafeEqualHex），防时序侧信道；
 * - 失败限流：5 次 / 5 分钟 / IP（KV `admin:auth:fail:{ipBanHash}`，TTL 300s），
 *   第 6 次起直接 429 ADMIN_RATE_LIMITED；
 * - 与全局 JWT 中间件正交：index.ts 对 `/api/blog/admin/` 前缀放行后由本中间件承接，
 *   不占用用户会话（静态博客站无 cookie 会话，header 直插即可）。
 *
 * 纪律：日志禁止打印 token 明文（只可能出现哈希或前缀长度）。
 */
import type { MiddlewareHandler } from 'hono'
import type { AppEnv, Env } from '../types'
import { sha256Hex } from '../lib/core'
import { blogSalt, ipBanHash, requestIp } from '../lib/visitor'

/** 管理令牌请求头（CORS_ALLOWED_HEADERS 已同步放行） */
export const ADMIN_TOKEN_HEADER = 'X-Admin-Token'
/** KV 键：sha256Hex(admin token)，64hex（人工一次性初始化，见 runbook） */
const KV_TOKEN_HASH_KEY = 'admin:token_hash'
/** 失败限流：5 次 / 5 分钟 / IP */
const MAX_FAILS = 5
const FAIL_TTL_SEC = 300

/**
 * 常量时间十六进制串比对（防时序攻击）。
 * 长度不等直接 false（长度信息不敏感：token 哈希恒为 64hex）。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * 校验管理令牌：无记录/无头/空白头/不匹配均为 false。
 * 存储值 trim 后比对（容忍 KV 写入时带入的换行）。
 */
export async function verifyAdminToken(env: Env, header: string | undefined): Promise<boolean> {
  if (header === undefined || header.trim() === '') return false
  const stored = await env.KV.get(KV_TOKEN_HASH_KEY)
  if (stored === null) return false
  return timingSafeEqualHex(await sha256Hex(header.trim()), stored.trim())
}

/** 失败限流 KV 键（按 IP 黑名单哈希分桶，与公开评论限流键域隔离） */
function failCountKey(ipBan: string): string {
  return `admin:auth:fail:${ipBan}`
}

/**
 * 管理路由组中间件（adminRoutes.use('*', adminAuth)）。
 * 顺序：IP 失败限流检查 → 令牌比对 → 失败计数 +1。
 */
export const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ipBan = await ipBanHash(requestIp(c.req.raw), blogSalt(c.env))
  const failKey = failCountKey(ipBan)
  const used = Number.parseInt((await c.env.KV.get(failKey)) ?? '0', 10)
  if (Number.isFinite(used) && used >= MAX_FAILS) {
    return c.json({ code: 'ADMIN_RATE_LIMITED', message: '失败次数过多，请 5 分钟后再试' }, 429)
  }
  const ok = await verifyAdminToken(c.env, c.req.header(ADMIN_TOKEN_HEADER))
  if (!ok) {
    await c.env.KV.put(failKey, String(used + 1), { expirationTtl: FAIL_TTL_SEC })
    return c.json({ code: 'ADMIN_UNAUTHORIZED', message: '管理令牌无效' }, 401)
  }
  await next()
}
