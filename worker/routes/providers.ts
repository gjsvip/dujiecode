/**
 * 供应商路由（架构文档 §5.2 供应商端点表 / §9.3 环境变量清单）。
 *
 * - 密钥经 core.ts AES-256-GCM 信封加密落库（providers.api_key_enc）；
 *   列表仅返回 keyTail（明文末 4 位），绝不回传明文或密文；
 * - POST test：最小 max_tokens=1 探活，5 秒超时（≤5s 返回）；
 * - POST models：按协议分支拉取 /models、/v1/models、/v1beta/models 并缓存 models_cache；
 * - 上游错误脱敏为 UPSTREAM_ERROR（原文仅进服务端日志）。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ProviderModel, ProviderProtocol, ProviderView } from '@shared/types'
import { dbAll, dbFirst, dbRun, decryptSecret, encryptSecret, httpError, isUniqueConstraintError, newId, nowIso } from '../lib/core'
import type { AppEnv } from '../types'
import { joinUrl, resolveBaseUrl } from '../llm/adapters'
import { readJsonObject, optionalString, requiredString, type ProviderRow } from './workspaces'

/** 探活超时（毫秒）：契约要求 ≤5s 返回 */
const TEST_TIMEOUT_MS = 5000
/** 模型列表拉取超时（毫秒） */
const MODELS_TIMEOUT_MS = 8000

/** 协议白名单（与 schema.sql providers.protocol CHECK 一致） */
const PROTOCOLS: readonly ProviderProtocol[] = ['openai', 'anthropic', 'gemini', 'custom']

function isProtocol(value: unknown): value is ProviderProtocol {
  return typeof value === 'string' && (PROTOCOLS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ */
/* 视图转换                                                             */
/* ------------------------------------------------------------------ */

/** 解析 models_cache JSON（损坏时退化为空数组） */
function parseModelsCache(raw: string): ProviderModel[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    const models: ProviderModel[] = []
    for (const item of parsed) {
      if (typeof item === 'object' && item !== null) {
        const id = (item as { id?: unknown }).id
        if (typeof id === 'string') {
          models.push({ id })
        }
      }
    }
    return models
  } catch {
    return []
  }
}

/** DB 行 → 对外视图（keyTail 需解密后取末 4 位；解密失败不阻塞列表） */
async function toProviderView(env: AppEnv['Bindings'], row: ProviderRow): Promise<ProviderView> {
  let keyTail = ''
  try {
    const plain = await decryptSecret(row.api_key_enc, env.ENCRYPTION_KEY)
    keyTail = plain.slice(-4)
  } catch {
    keyTail = ''
  }
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as ProviderProtocol,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    models: parseModelsCache(row.models_cache),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    keyTail,
  }
}

/** 记录上游错误原文（仅服务端日志；回前端的消息必须脱敏） */
async function logUpstream(module: string, context: string, response: Response): Promise<void> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 500)
  } catch {
    // 忽略读取失败
  }
  console.error(
    JSON.stringify({ level: 'error', module, msg: '供应商上游错误', context, status: response.status, detail }),
  )
}

/** 带超时的 fetch（AbortController 实现，兼容各运行时） */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* 探活 / 模型列表                                                      */
/* ------------------------------------------------------------------ */

/** 最小 max_tokens=1 探活请求（按协议分支构造非流式请求） */
async function probeProvider(
  env: AppEnv['Bindings'],
  provider: ProviderRow,
  model: string,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now()
  const base = resolveBaseUrl(provider.protocol as ProviderProtocol, provider.base_url)
  const apiKey = await decryptSecret(provider.api_key_enc, env.ENCRYPTION_KEY)
  const protocol = provider.protocol as ProviderProtocol

  let url: string
  let init: RequestInit
  if (protocol === 'anthropic') {
    url = joinUrl(base, '/v1/messages')
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    }
  } else if (protocol === 'gemini') {
    url = joinUrl(base, `/v1beta/models/${encodeURIComponent(model)}:generateContent`)
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    }
  } else {
    // openai 与 custom 均走 OpenAI 兼容 /chat/completions
    url = joinUrl(base, '/chat/completions')
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    }
  }

  try {
    const response = await fetchWithTimeout(url, init, TEST_TIMEOUT_MS)
    const latencyMs = Date.now() - started
    if (!response.ok) {
      await logUpstream('providers', 'test', response)
      return { ok: false, latencyMs, error: `供应商返回 HTTP ${response.status}` }
    }
    return { ok: true, latencyMs }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: aborted ? '连接超时（5 秒）' : '无法连接供应商',
    }
  }
}

/** 按协议分支拉取模型列表：/models（openai/custom）、/v1/models（anthropic）、/v1beta/models（gemini） */
async function fetchModels(
  env: AppEnv['Bindings'],
  provider: ProviderRow,
): Promise<{ models: ProviderModel[]; cachedAt: string }> {
  const base = resolveBaseUrl(provider.protocol as ProviderProtocol, provider.base_url)
  const apiKey = await decryptSecret(provider.api_key_enc, env.ENCRYPTION_KEY)
  const protocol = provider.protocol as ProviderProtocol

  let url: string
  let headers: Record<string, string>
  if (protocol === 'anthropic') {
    url = joinUrl(base, '/v1/models')
    headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  } else if (protocol === 'gemini') {
    url = joinUrl(base, '/v1beta/models')
    headers = { 'x-goog-api-key': apiKey }
  } else {
    url = joinUrl(base, '/models')
    headers = { authorization: `Bearer ${apiKey}` }
  }

  const response = await fetchWithTimeout(url, { method: 'GET', headers }, MODELS_TIMEOUT_MS)
  if (!response.ok) {
    await logUpstream('providers', 'models', response)
    throw httpError('UPSTREAM_ERROR', `拉取模型列表失败（HTTP ${response.status}）`, 502)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw httpError('UPSTREAM_ERROR', '供应商返回的模型列表不是合法 JSON', 502)
  }

  const ids: string[] = []
  if (protocol === 'gemini') {
    const list = (data as { models?: { name?: unknown }[] }).models
    if (Array.isArray(list)) {
      for (const item of list) {
        const name = item?.name
        if (typeof name === 'string' && name !== '') {
          // Gemini 返回 'models/gemini-pro'，统一去掉前缀
          ids.push(name.startsWith('models/') ? name.slice('models/'.length) : name)
        }
      }
    }
  } else {
    const list = (data as { data?: { id?: unknown }[] }).data
    if (Array.isArray(list)) {
      for (const item of list) {
        const id = item?.id
        if (typeof id === 'string' && id !== '') {
          ids.push(id)
        }
      }
    }
  }

  const models: ProviderModel[] = ids.map((id) => ({ id }))
  const cachedAt = nowIso()
  await dbRun(env.DB, 'UPDATE providers SET models_cache = ?, models_cached_at = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(models),
    cachedAt,
    cachedAt,
    provider.id,
  ])
  return { models, cachedAt }
}

/* ------------------------------------------------------------------ */
/* 归属校验                                                             */
/* ------------------------------------------------------------------ */

/** 加载供应商并校验归属：不存在 → 404；不属于当前用户 → 403（§12-D10） */
async function requireProvider(c: Context<AppEnv>, providerId: string): Promise<ProviderRow> {
  if (providerId === '') {
    throw httpError('VALIDATION_ERROR', '缺少供应商 ID', 400)
  }
  const row = await dbFirst<ProviderRow>(c.env.DB, 'SELECT * FROM providers WHERE id = ?', [providerId])
  if (!row) {
    throw httpError('NOT_FOUND', '供应商不存在', 404)
  }
  if (row.user_id !== c.get('userId')) {
    throw httpError('FORBIDDEN', '无权访问该供应商', 403)
  }
  return row
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

const providerRoutes = new Hono<AppEnv>()

/** GET /api/providers —— 200 {providers:[...keyTail]} */
providerRoutes.get('/', async (c) => {
  const rows = await dbAll<ProviderRow>(
    c.env.DB,
    'SELECT * FROM providers WHERE user_id = ? ORDER BY created_at DESC',
    [c.get('userId')],
  )
  const providers: ProviderView[] = []
  for (const row of rows) {
    providers.push(await toProviderView(c.env, row))
  }
  return c.json({ providers }, 200)
})

/** POST /api/providers —— 201 {provider}（密钥加密落库） */
providerRoutes.post('/', async (c) => {
  const body = await readJsonObject(c)
  const name = requiredString(body, 'name', '供应商名称').slice(0, 80)
  const protocol = body.protocol
  if (!isProtocol(protocol)) {
    throw httpError('VALIDATION_ERROR', "protocol 必须为 'openai' | 'anthropic' | 'gemini' | 'custom'", 400)
  }
  const apiKey = requiredString(body, 'apiKey', 'API Key')
  const baseUrl = optionalString(body, 'baseUrl')?.trim() ?? ''
  if (protocol === 'custom' && baseUrl === '') {
    throw httpError('VALIDATION_ERROR', 'custom 协议必须提供 baseUrl', 400)
  }
  const defaultModel = optionalString(body, 'defaultModel') ?? ''

  const now = nowIso()
  const row: ProviderRow = {
    id: newId('prv_'),
    user_id: c.get('userId'),
    name,
    protocol,
    base_url: baseUrl,
    api_key_enc: await encryptSecret(apiKey, c.env.ENCRYPTION_KEY),
    default_model: defaultModel,
    models_cache: '[]',
    models_cached_at: null,
    enabled: 1,
    created_at: now,
    updated_at: now,
  }
  try {
    await dbRun(
      c.env.DB,
      'INSERT INTO providers (id, user_id, name, protocol, base_url, api_key_enc, default_model, models_cache, models_cached_at, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        row.id,
        row.user_id,
        row.name,
        row.protocol,
        row.base_url,
        row.api_key_enc,
        row.default_model,
        row.models_cache,
        row.models_cached_at,
        row.enabled,
        row.created_at,
        row.updated_at,
      ],
    )
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw httpError('NAME_TAKEN', '同名供应商已存在', 409)
    }
    throw err
  }
  return c.json({ provider: await toProviderView(c.env, row) }, 201)
})

/** PATCH /api/providers/:id —— 200 {provider} */
providerRoutes.patch('/:id', async (c) => {
  const row = await requireProvider(c, c.req.param('id'))
  const body = await readJsonObject(c)

  const name = optionalString(body, 'name')?.slice(0, 80) ?? row.name
  const baseUrl = optionalString(body, 'baseUrl')?.trim() ?? row.base_url
  const defaultModel = optionalString(body, 'defaultModel') ?? row.default_model
  const enabled = typeof body.enabled === 'boolean' ? (body.enabled ? 1 : 0) : row.enabled
  const protocol = isProtocol(body.protocol) ? body.protocol : (row.protocol as ProviderProtocol)
  if (protocol === 'custom' && baseUrl === '') {
    throw httpError('VALIDATION_ERROR', 'custom 协议必须提供 baseUrl', 400)
  }
  const apiKey = optionalString(body, 'apiKey')
  const apiKeyEnc = apiKey !== undefined && apiKey !== '' ? await encryptSecret(apiKey, c.env.ENCRYPTION_KEY) : row.api_key_enc

  try {
    await dbRun(
      c.env.DB,
      'UPDATE providers SET name = ?, protocol = ?, base_url = ?, api_key_enc = ?, default_model = ?, enabled = ?, updated_at = ? WHERE id = ?',
      [name, protocol, baseUrl, apiKeyEnc, defaultModel, enabled, nowIso(), row.id],
    )
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw httpError('NAME_TAKEN', '同名供应商已存在', 409)
    }
    throw err
  }
  const updated = await dbFirst<ProviderRow>(c.env.DB, 'SELECT * FROM providers WHERE id = ?', [row.id])
  if (!updated) {
    throw httpError('NOT_FOUND', '供应商不存在', 404)
  }
  return c.json({ provider: await toProviderView(c.env, updated) }, 200)
})

/** DELETE /api/providers/:id —— 204 */
providerRoutes.delete('/:id', async (c) => {
  await requireProvider(c, c.req.param('id'))
  await dbRun(c.env.DB, 'DELETE FROM providers WHERE id = ?', [c.req.param('id')])
  return c.body(null, 204)
})

/** POST /api/providers/:id/test —— 200 {ok, latencyMs, error?}（max_tokens=1 探活） */
providerRoutes.post('/:id/test', async (c) => {
  const row = await requireProvider(c, c.req.param('id'))
  let body: Record<string, unknown> = {}
  try {
    body = await c.req.json()
  } catch {
    // 允许空体：使用默认模型
  }
  const model = optionalString(body, 'model') ?? row.default_model
  if (model.trim() === '') {
    throw httpError('VALIDATION_ERROR', '请先设置默认模型或在请求体中指定 model', 400)
  }
  const result = await probeProvider(c.env, row, model)
  return c.json(result, 200)
})

/** POST /api/providers/:id/models —— 200 {models:[{id}], cachedAt} */
providerRoutes.post('/:id/models', async (c) => {
  const row = await requireProvider(c, c.req.param('id'))
  const result = await fetchModels(c.env, row)
  return c.json(result, 200)
})

export default providerRoutes
