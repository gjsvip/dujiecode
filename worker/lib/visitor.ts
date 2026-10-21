/**
 * 访客指纹与 IP 哈希（lib/visitor.ts）—— 从 routes/blog.ts 平移，行为不变
 * （设计 §7.1：迁移前后 `visitorHash(同IP,同UA,同盐)` 输出必须一致，保证现网
 * 限流/点赞去重不回归）。
 *
 * 指纹双轨（易错点，务必保持盐前缀不同，不可互相替代）：
 * - `visitorHash = sha256(IP|UA|salt)`   限流 / 点赞去重（换 UA 即换指纹，属预期）；
 * - `ipBanHash   = sha256(IP|ipban|salt)` IP 黑名单（不含 UA，换 UA 不能绕开黑名单）。
 */
import type { Env } from '../types'
import { sha256Hex } from './core'

/** BLOG_SALT 缺省值（与迁移前 blog.ts 内联逻辑一致，保证现网指纹不变） */
export const DEFAULT_BLOG_SALT = 'gjsvip-blog'

/** 博客盐（KV/var 缺省 'gjsvip-blog'） */
export function blogSalt(env: Env): string {
  return env.BLOG_SALT ?? DEFAULT_BLOG_SALT
}

/**
 * 访客指纹：sha256(IP + '|' + UA + '|' + salt)，64 位小写 hex。
 * 用于评论限流与点赞去重（不存明文 IP）。
 */
export async function visitorHash(ip: string, ua: string, salt: string): Promise<string> {
  return sha256Hex(`${ip}|${ua}|${salt}`)
}

/**
 * IP 黑名单哈希：sha256(IP + '|ipban|' + salt)，64 位小写 hex。
 * 注意与 visitorHash 的盐前缀差异（`ipban` 段）——这是双轨设计的关键，
 * 改这里会同时破坏黑名单匹配与 banned 表语义。
 */
export async function ipBanHash(ip: string, salt: string): Promise<string> {
  return sha256Hex(`${ip}|ipban|${salt}`)
}

/** 取客户端 IP：CF-Connecting-IP 优先，回退 X-Forwarded-For，再兜底 0.0.0.0 */
export function requestIp(raw: Request): string {
  return raw.headers.get('CF-Connecting-IP') ?? raw.headers.get('X-Forwarded-For') ?? '0.0.0.0'
}
