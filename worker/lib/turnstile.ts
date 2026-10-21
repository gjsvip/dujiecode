/**
 * T04 Turnstile 人机校验（lib/turnstile.ts）—— 纯函数，无类（设计 §3.1）。
 *
 * 三分支降级（决策 D2，§3.4）：
 * - token 缺失/为空        → 400 TURNSTILE_TOKEN_MISSING（客户端 bug，应暴露）；
 * - success=false          → 403 TURNSTILE_FAILED（明确的机器流量判定，fail-closed）；
 * - siteverify 不可达       → fail_open=1（默认）：WARN + 放行；fail_open=0：503；
 * - TURNSTILE_SECRET 未配置 → WARN + 放行（允许「先上线开关、后补 secret」）。
 *
 * 所有降级放行都打 WARN 结构化日志（scope:'turnstile'），wrangler tail 可观测。
 */
import type { Env } from '../types'
import { getBlogConfig } from './config'

/** Cloudflare siteverify 端点（form-urlencoded 契约） */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** siteverify 超时（毫秒）：校验是评论链路一环，不能长时间悬挂 */
export const TURNSTILE_TIMEOUT_MS = 5000

/** 校验结论：ok=true 为放行（含各类降级放行）；ok=false 为拒绝（带 HTTP 状态与错误码） */
export type TurnstileOutcome =
  | { ok: true; reason: 'pass' | 'disabled' | 'fail_open' | 'secret_missing' }
  | {
      ok: false
      status: 400 | 403 | 503
      code: 'TURNSTILE_TOKEN_MISSING' | 'TURNSTILE_FAILED' | 'TURNSTILE_UNAVAILABLE'
      message: string
    }

/**
 * 校验 Turnstile token。
 *
 * @param env Worker 环境（KV 开关 + TURNSTILE_SECRET）
 * @param token 前端 widget 回调取得的 token（null/'' 按缺失处理）
 * @param remoteIp CF-Connecting-IP（Turnstile 据此做地域风控，非必填）
 */
export async function verifyTurnstile(
  env: Env,
  token: string | null,
  remoteIp: string | undefined,
): Promise<TurnstileOutcome> {
  const cfg = await getBlogConfig(env) // 60s 缓存（评论链路热路径，不做 fresh）
  if (!cfg.turnstileEnabled) return { ok: true, reason: 'disabled' }
  if (token === null || token === '') {
    return { ok: false, status: 400, code: 'TURNSTILE_TOKEN_MISSING', message: '请完成人机校验' }
  }
  if (env.TURNSTILE_SECRET === undefined || env.TURNSTILE_SECRET === '') {
    console.warn(JSON.stringify({ level: 'warn', scope: 'turnstile', msg: 'secret 未配置，跳过校验' }))
    return { ok: true, reason: 'secret_missing' }
  }
  try {
    const resp = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: remoteIp ?? '' }),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`siteverify HTTP ${resp.status}`)
    const data = (await resp.json()) as { success: boolean; 'error-codes'?: string[] }
    if (data.success) return { ok: true, reason: 'pass' }
    console.warn(
      JSON.stringify({
        level: 'warn',
        scope: 'turnstile',
        msg: 'verify failed',
        errorCodes: data['error-codes'] ?? [],
      }),
    )
    return { ok: false, status: 403, code: 'TURNSTILE_FAILED', message: '人机校验未通过，请重试' }
  } catch (err) {
    if (cfg.turnstileFailOpen) {
      console.warn(
        JSON.stringify({ level: 'warn', scope: 'turnstile', msg: 'siteverify 不可达，fail-open 放行', error: String(err) }),
      )
      return { ok: true, reason: 'fail_open' }
    }
    return { ok: false, status: 503, code: 'TURNSTILE_UNAVAILABLE', message: '校验服务暂不可用，请稍后重试' }
  }
}
