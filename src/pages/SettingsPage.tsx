/**
 * 设置页（架构文档 §3.3 #23 / §6.1 /settings/*）：
 * Tab：供应商 / 执行后端 / 通用，经 initialTab prop 区分（§6.1 路由表）。
 *
 * - 供应商：协议选择（OpenAI / Anthropic / Gemini / custom）、baseUrl、
 *   apiKey、默认模型、连接测试、拉取模型列表、启用开关；
 * - 执行后端：名称 / host、创建后仅展示一次的 agent token（含复制按钮）、
 *   token 列表 / 吊销、在线状态；
 * - 通用：账户信息、危险命令审计日志列表、静态加密安全说明。
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, api } from '../api'
import { useAuthStore } from '../store/auth'
import { useWorkspaceStore } from '../store/workspace'
import type {
  AgentTokenView,
  AuditLog,
  AuditResult,
  ExecBackend,
  ProviderModel,
  ProviderProtocol,
  ProviderView,
} from '@shared/types'

/* ------------------------------------------------------------------ */
/* 常量与小部件                                                         */
/* ------------------------------------------------------------------ */

/** 设置页签 */
export type SettingsTab = 'providers' | 'backends' | 'general'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'providers', label: '供应商' },
  { id: 'backends', label: '执行后端' },
  { id: 'general', label: '通用' },
]

/** 协议中文标签 */
const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  custom: '自定义',
}

/** 各协议 baseUrl 占位提示 */
const BASE_URL_PLACEHOLDER: Record<ProviderProtocol, string> = {
  openai: 'https://api.openai.com/v1（可留空走默认）',
  anthropic: 'https://api.anthropic.com（可留空走默认）',
  gemini: 'https://generativelanguage.googleapis.com（可留空走默认）',
  custom: 'https://your-endpoint.example.com/v1',
}

/** 审计结果中文标签 */
const RESULT_LABELS: Record<AuditResult, string> = {
  success: '成功',
  failure: '失败',
  rejected: '已拒绝',
}

/** 类名拼接小工具 */
function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** 复制按钮（剪贴板不可用时提示手动复制） */
function CopyButton({ text, label = '复制' }: { text: string; label?: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button type="button" className="btn btn-outline btn-sm shrink-0" onClick={() => void onCopy()}>
      {copied ? '已复制' : label}
    </button>
  )
}

/** 行内错误提示 */
function FormError({ message }: { message: string | null }): ReactNode {
  if (message === null || message === '') {
    return null
  }
  return (
    <p role="alert" className="mt-3 rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-xs text-err">
      {message}
    </p>
  )
}

/* ------------------------------------------------------------------ */
/* 供应商 Tab                                                           */
/* ------------------------------------------------------------------ */

/** 供应商表单状态 */
interface ProviderFormState {
  /** null 表示新建 */
  id: string | null
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  /** 编辑模式下留空表示不修改 */
  apiKey: string
  defaultModel: string
  enabled: boolean
}

/** 新建供应商表单初值 */
function emptyProviderForm(): ProviderFormState {
  return {
    id: null,
    name: '',
    protocol: 'openai',
    baseUrl: '',
    apiKey: '',
    defaultModel: '',
    enabled: true,
  }
}

/** 供应商管理 Tab */
function ProvidersTab(): ReactNode {
  const pushToast = useWorkspaceStore((s) => s.pushToast)
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<ProviderFormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await api.get<{ providers: ProviderView[] }>('/api/providers')
      setProviders(res.providers)
    } catch {
      // 列表加载失败保持空态
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 保存（新建 POST / 编辑 PATCH；apiKey 留空则不修改） */
  async function onSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (form === null) {
      return
    }
    const name = form.name.trim()
    if (name === '') {
      setFormError('请输入供应商名称')
      return
    }
    if (form.id === null && form.apiKey.trim() === '') {
      setFormError('请输入 API Key')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      if (form.id !== null) {
        const body: Record<string, unknown> = {
          name,
          baseUrl: form.baseUrl.trim(),
          defaultModel: form.defaultModel.trim(),
          enabled: form.enabled,
        }
        if (form.apiKey.trim() !== '') {
          body.apiKey = form.apiKey.trim()
        }
        await api.patch(`/api/providers/${form.id}`, body)
      } else {
        await api.post('/api/providers', {
          name,
          protocol: form.protocol,
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey.trim(),
          defaultModel: form.defaultModel.trim(),
        })
      }
      setForm(null)
      setTestResult(null)
      await load()
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  /** 连接测试（POST /:id/test，最小 max_tokens=1 探活） */
  async function onTest(): Promise<void> {
    if (form?.id == null) {
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await api.post<{ ok: boolean; latencyMs: number; error?: string }>(
        `/api/providers/${form.id}/test`,
        { model: form.defaultModel.trim() || undefined },
      )
      setTestResult(res)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof ApiError ? err.message : '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  /** 拉取模型列表（POST /:id/models，服务端缓存） */
  async function onFetchModels(): Promise<void> {
    if (form?.id == null) {
      return
    }
    setFetchingModels(true)
    try {
      const res = await api.post<{ models: ProviderModel[]; cachedAt: string }>(
        `/api/providers/${form.id}/models`,
      )
      await load()
      pushToast('ok', `已拉取 ${res.models.length} 个模型`)
    } catch (err) {
      pushToast('err', err instanceof ApiError ? err.message : '模型拉取失败')
    } finally {
      setFetchingModels(false)
    }
  }

  /** 删除供应商 */
  async function onDelete(id: string, name: string): Promise<void> {
    if (!window.confirm(`确认删除供应商「${name}」？关联会话将失去模型配置。`)) {
      return
    }
    try {
      await api.del(`/api/providers/${id}`)
      await load()
    } catch (err) {
      pushToast('err', err instanceof ApiError ? err.message : '删除失败')
    }
  }

  return (
    <div className="mt-5 space-y-4">
      {/* 供应商列表 */}
      <section className="card divide-y divide-border">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-sm font-semibold">供应商</h2>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setForm(emptyProviderForm())
              setFormError(null)
              setTestResult(null)
            }}
          >
            ＋ 添加供应商
          </button>
        </div>
        {loading && <p className="px-4 py-6 text-center text-xs text-dim">加载中…</p>}
        {!loading && providers.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-dim">
            尚未配置供应商。添加后即可在对话中选择模型。
          </p>
        )}
        {providers.map((provider) => (
          <div key={provider.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-text">{provider.name}</span>
                <span className="chip">{PROTOCOL_LABELS[provider.protocol]}</span>
                {!provider.enabled && <span className="chip text-warn">已停用</span>}
              </div>
              <p className="mt-1 truncate text-[11px] text-dim">
                {provider.baseUrl || '默认端点'} · 模型 {provider.defaultModel || '未设置'} · 密钥
                ••••{provider.keyTail}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm shrink-0"
              onClick={() => {
                setForm({
                  id: provider.id,
                  name: provider.name,
                  protocol: provider.protocol,
                  baseUrl: provider.baseUrl,
                  apiKey: '',
                  defaultModel: provider.defaultModel,
                  enabled: provider.enabled,
                })
                setFormError(null)
                setTestResult(null)
              }}
            >
              编辑
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm shrink-0 text-err"
              onClick={() => void onDelete(provider.id, provider.name)}
            >
              删除
            </button>
          </div>
        ))}
      </section>

      {/* 供应商表单 */}
      {form !== null && (
        <form className="card p-4 sm:p-5" onSubmit={(event) => void onSave(event)}>
          <h3 className="text-sm font-semibold">
            {form.id === null ? '添加供应商' : `编辑「${form.name}」`}
          </h3>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="pv-name">
                名称
              </label>
              <input
                id="pv-name"
                className="field"
                value={form.name}
                maxLength={80}
                placeholder="例如：OpenAI 官方"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="pv-protocol">
                协议
              </label>
              <select
                id="pv-protocol"
                className="field"
                value={form.protocol}
                disabled={form.id !== null}
                onChange={(event) =>
                  setForm({ ...form, protocol: event.target.value as ProviderProtocol })
                }
              >
                {(Object.keys(PROTOCOL_LABELS) as ProviderProtocol[]).map((protocol) => (
                  <option key={protocol} value={protocol}>
                    {PROTOCOL_LABELS[protocol]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="pv-base-url">
                Base URL
              </label>
              <input
                id="pv-base-url"
                className="field"
                value={form.baseUrl}
                placeholder={BASE_URL_PLACEHOLDER[form.protocol]}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="pv-key">
                API Key
              </label>
              <input
                id="pv-key"
                className="field"
                type="password"
                autoComplete="off"
                value={form.apiKey}
                placeholder={form.id === null ? 'sk-...' : '留空则不修改'}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="pv-model">
                默认模型
              </label>
              <input
                id="pv-model"
                className="field"
                value={form.defaultModel}
                placeholder="例如：gpt-4o-mini"
                onChange={(event) => setForm({ ...form, defaultModel: event.target.value })}
              />
            </div>
            <div className="flex items-end">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-text">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={form.enabled}
                  onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                />
                启用（对话中可选）
              </label>
            </div>
          </div>

          <FormError message={formError} />

          {/* 连接测试 / 拉取模型（需先保存） */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={form.id == null || testing}
              title={form.id == null ? '保存后可测试连接' : undefined}
              onClick={() => void onTest()}
            >
              {testing ? '测试中…' : '连接测试'}
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={form.id == null || fetchingModels}
              title={form.id == null ? '保存后可拉取模型' : undefined}
              onClick={() => void onFetchModels()}
            >
              {fetchingModels ? '拉取中…' : '拉取模型列表'}
            </button>
            {testResult !== null && (
              <span
                className={cx(
                  'text-xs',
                  testResult.ok ? 'text-ok' : 'text-err',
                )}
              >
                {testResult.ok
                  ? `连接成功（${testResult.latencyMs ?? 0} ms）`
                  : `连接失败：${testResult.error ?? '未知错误'}`}
              </span>
            )}
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setForm(null)
                setTestResult(null)
              }}
            >
              取消
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 执行后端 Tab                                                         */
/* ------------------------------------------------------------------ */

/** 仅展示一次的 agent token 载荷 */
interface NewTokenPayload {
  backendId: string
  token: string
}

/** 执行后端管理 Tab */
function BackendsTab(): ReactNode {
  const pushToast = useWorkspaceStore((s) => s.pushToast)
  const [backends, setBackends] = useState<ExecBackend[]>([])
  const [tokens, setTokens] = useState<Record<string, AgentTokenView[]>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [newToken, setNewToken] = useState<NewTokenPayload | null>(null)
  const [form, setForm] = useState({ name: '', host: '' })
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await api.get<{ backends: ExecBackend[] }>('/api/backends')
      setBackends(res.backends)
    } catch {
      // 加载失败保持空态
    }
  }, [])

  const loadTokens = useCallback(async (backendId: string): Promise<void> => {
    try {
      const res = await api.get<{ tokens: AgentTokenView[] }>(
        `/api/backends/${backendId}/tokens`,
      )
      setTokens((prev) => ({ ...prev, [backendId]: res.tokens }))
    } catch {
      pushToast('err', 'token 列表加载失败')
    }
  }, [pushToast])

  useEffect(() => {
    void load()
  }, [load])

  /** 创建后端（响应含明文 agent token，仅此次返回） */
  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const name = form.name.trim()
    if (name === '') {
      setFormError('请输入后端名称')
      return
    }
    setCreating(true)
    setFormError(null)
    try {
      const res = await api.post<{ backend: ExecBackend; agentToken: string }>('/api/backends', {
        name,
        host: form.host.trim() || undefined,
      })
      setNewToken({ backendId: res.backend.id, token: res.agentToken })
      setForm({ name: '', host: '' })
      await load()
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : '创建失败，请稍后重试')
    } finally {
      setCreating(false)
    }
  }

  /** 轮换 token（新建后可吊销旧 token） */
  async function onCreateToken(backendId: string): Promise<void> {
    try {
      const res = await api.post<{ agentToken: string }>(`/api/backends/${backendId}/tokens`, {})
      setNewToken({ backendId, token: res.agentToken })
      await loadTokens(backendId)
    } catch (err) {
      pushToast('err', err instanceof ApiError ? err.message : 'token 创建失败')
    }
  }

  /** 吊销 token（revoked=1；下次重连失效） */
  async function onRevoke(backendId: string, tokenId: string): Promise<void> {
    if (!window.confirm('吊销后使用该 token 的代理将在下次重连时失效，确认吊销？')) {
      return
    }
    try {
      await api.del(`/api/backends/${backendId}/tokens/${tokenId}`)
      await loadTokens(backendId)
    } catch (err) {
      pushToast('err', err instanceof ApiError ? err.message : '吊销失败')
    }
  }

  /** 删除后端 */
  async function onDelete(id: string, name: string): Promise<void> {
    if (!window.confirm(`确认删除执行后端「${name}」？其全部 agent token 将同时失效。`)) {
      return
    }
    try {
      await api.del(`/api/backends/${id}`)
      await load()
    } catch (err) {
      pushToast('err', err instanceof ApiError ? err.message : '删除失败')
    }
  }

  /** 一键安装命令（按当前页面协议派生 wss 地址） */
  const serverUrl = `${globalThis.location.protocol === 'https:' ? 'wss' : 'ws'}://${globalThis.location.host}`
  const installCommand =
    newToken !== null
      ? `python3 dujie-agent.py --server ${serverUrl} --backend-id ${newToken.backendId} --token ${newToken.token}`
      : ''

  return (
    <div className="mt-5 space-y-4">
      {/* agent token 仅展示一次 */}
      {newToken !== null && (
        <section className="card border-warn/50 bg-warn/5 p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-warn">
            <span className="h-1.5 w-1.5 rounded-full bg-warn" />
            agent token 仅展示一次
          </h3>
          <p className="mt-2 text-xs leading-relaxed text-dim">
            请立即复制并妥善保存；服务端仅存储其 SHA-256 哈希，丢失只能新建轮换。
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="code-block min-w-0 flex-1 text-[12px]">{newToken.token}</code>
            <CopyButton text={newToken.token} />
          </div>
          <p className="mt-3 text-[11px] text-dim">一键安装命令（在目标服务器执行）：</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="code-block min-w-0 flex-1 text-[11px]">{installCommand}</code>
            <CopyButton text={installCommand} label="复制命令" />
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-3"
            onClick={() => setNewToken(null)}
          >
            我已保存
          </button>
        </section>
      )}

      {/* 创建表单 */}
      <form className="card p-4 sm:p-5" onSubmit={(event) => void onCreate(event)}>
        <h3 className="text-sm font-semibold">添加执行后端</h3>
        <p className="mt-1 text-xs text-dim">
          在你自己的 Linux 服务器上运行 dujie-agent.py 主动外连，无需暴露端口。
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="bk-name">
              名称
            </label>
            <input
              id="bk-name"
              className="field"
              value={form.name}
              maxLength={80}
              placeholder="例如：生产服务器"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div>
            <label className="label" htmlFor="bk-host">
              Host（备注用）
            </label>
            <input
              id="bk-host"
              className="field"
              value={form.host}
              maxLength={200}
              placeholder="例如：192.168.1.10"
              onChange={(event) => setForm({ ...form, host: event.target.value })}
            />
          </div>
        </div>
        <FormError message={formError} />
        <div className="mt-4 flex justify-end">
          <button type="submit" className="btn btn-primary btn-sm" disabled={creating}>
            {creating ? '创建中…' : '创建并生成 token'}
          </button>
        </div>
      </form>

      {/* 后端列表 */}
      <section className="card divide-y divide-border">
        <div className="px-4 py-3">
          <h2 className="text-sm font-semibold">执行后端</h2>
        </div>
        {backends.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-dim">尚未添加执行后端</p>
        )}
        {backends.map((backend) => (
          <div key={backend.id} className="px-4 py-3">
            <div className="flex items-center gap-3">
              <span
                className={cx(
                  'h-2 w-2 shrink-0 rounded-full',
                  backend.status === 'online' ? 'bg-ok' : 'bg-dim',
                )}
                title={backend.status === 'online' ? '在线' : '离线'}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-text">{backend.name}</span>
                  <span className={cx('chip', backend.status === 'online' ? 'text-ok' : 'text-dim')}>
                    {backend.status === 'online' ? '在线' : '离线'}
                  </span>
                  {!backend.enabled && <span className="chip text-warn">已停用</span>}
                </div>
                <p className="mt-1 truncate text-[11px] text-dim">
                  {backend.host || '未填写 host'} · 最近在线{' '}
                  {backend.lastSeenAt !== null
                    ? new Date(backend.lastSeenAt).toLocaleString('zh-CN')
                    : '—'}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-outline btn-sm shrink-0"
                onClick={() => {
                  const next = expanded === backend.id ? null : backend.id
                  setExpanded(next)
                  if (next !== null) {
                    void loadTokens(backend.id)
                  }
                }}
              >
                {expanded === backend.id ? '收起 token' : '管理 token'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm shrink-0 text-err"
                onClick={() => void onDelete(backend.id, backend.name)}
              >
                删除
              </button>
            </div>

            {/* token 列表 */}
            {expanded === backend.id && (
              <div className="mt-3 rounded-lg border border-border bg-bg/60 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-medium text-dim">agent token</p>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => void onCreateToken(backend.id)}
                  >
                    ＋ 新建 token（轮换）
                  </button>
                </div>
                <div className="mt-2 divide-y divide-border">
                  {(tokens[backend.id] ?? []).map((token) => (
                    <div key={token.id} className="flex items-center gap-3 py-2 text-xs">
                      <span className="min-w-0 flex-1 truncate text-text">{token.name}</span>
                      <span className="shrink-0 text-dim">
                        创建于 {new Date(token.createdAt).toLocaleDateString('zh-CN')}
                      </span>
                      <span className="shrink-0 text-dim">
                        {token.lastUsedAt !== null
                          ? `用于 ${new Date(token.lastUsedAt).toLocaleDateString('zh-CN')}`
                          : '未使用'}
                      </span>
                      {token.revoked ? (
                        <span className="chip shrink-0 text-err">已吊销</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm shrink-0 text-err"
                          onClick={() => void onRevoke(backend.id, token.id)}
                        >
                          吊销
                        </button>
                      )}
                    </div>
                  ))}
                  {(tokens[backend.id] ?? []).length === 0 && (
                    <p className="py-2 text-[11px] text-dim">暂无 token</p>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 通用 Tab                                                             */
/* ------------------------------------------------------------------ */

/** 审计日志每页条数 */
const AUDIT_PAGE_SIZE = 50

/** 通用 Tab：账户信息 / 安全说明 / 审计日志 */
function GeneralTab(): ReactNode {
  const user = useAuthStore((s) => s.user)
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState(0)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (offset: number): Promise<void> => {
    setLoading(true)
    try {
      const res = await api.get<{ logs: AuditLog[]; total: number }>(
        `/api/audit-logs?limit=${AUDIT_PAGE_SIZE}&offset=${offset}`,
      )
      setLogs((prev) => (offset === 0 ? res.logs : [...prev, ...res.logs]))
      setTotal(res.total)
      setNextOffset(offset + res.logs.length)
    } catch {
      // 审计日志加载失败保持空态
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(0)
  }, [load])

  return (
    <div className="mt-5 space-y-5">
      {/* 账户信息 */}
      <section className="card p-4 sm:p-5">
        <h2 className="text-sm font-semibold">账户</h2>
        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-dim">邮箱</dt>
            <dd className="mt-0.5 truncate text-text">{user?.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-dim">显示名</dt>
            <dd className="mt-0.5 truncate text-text">{user?.displayName || '—'}</dd>
          </div>
          <div>
            <dt className="text-dim">注册时间</dt>
            <dd className="mt-0.5 text-text">
              {user !== null ? new Date(user.createdAt).toLocaleString('zh-CN') : '—'}
            </dd>
          </div>
        </dl>
      </section>

      {/* 静态加密安全说明 */}
      <section className="card p-4 sm:p-5">
        <h2 className="text-sm font-semibold">安全说明</h2>
        <ul className="mt-3 space-y-2 text-xs leading-relaxed text-dim">
          <li>
            • 供应商 API Key 与 agent token 均以<strong className="text-text">静态加密</strong>
            方式存储：API Key 使用服务端信封加密（AES-256-GCM，主密钥为 Workers Secret
            ENCRYPTION_KEY）；agent token 仅存 SHA-256 哈希（不可逆）。
          </li>
          <li>
            • 静态加密意味着持有服务端主密钥方可解密；请妥善保管 ENCRYPTION_KEY，
            丢失将导致全部已存密钥不可恢复。
          </li>
          <li>
            • 会话令牌存于 HttpOnly Cookie（dj_session），JavaScript 无法读取；
            登出即吊销服务端会话记录。
          </li>
          <li>
            • 危险命令在 AI 工具路径需审批、手动终端路径直接拒绝，全部记录于下方审计日志。
          </li>
        </ul>
      </section>

      {/* 审计日志 */}
      <section className="card p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">审计日志</h2>
          <span className="chip">共 {total} 条</span>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-xs">
            <thead>
              <tr className="text-left text-dim">
                <th className="pb-2 pr-3 font-medium">时间</th>
                <th className="pb-2 pr-3 font-medium">操作</th>
                <th className="pb-2 pr-3 font-medium">目标</th>
                <th className="pb-2 pr-3 font-medium">后端</th>
                <th className="pb-2 pr-3 font-medium">风险</th>
                <th className="pb-2 font-medium">结果</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="whitespace-nowrap py-2 pr-3 text-dim">
                    {new Date(log.createdAt).toLocaleString('zh-CN')}
                  </td>
                  <td className="py-2 pr-3 text-text">{log.action}</td>
                  <td
                    className="max-w-[14rem] truncate py-2 pr-3 font-mono text-dim"
                    title={log.target}
                  >
                    {log.target || '—'}
                  </td>
                  <td className="py-2 pr-3 text-dim">{log.backend}</td>
                  <td className="py-2 pr-3">
                    <span className={log.risk === 'dangerous' ? 'text-warn' : 'text-dim'}>
                      {log.risk === 'dangerous' ? '危险' : '普通'}
                    </span>
                  </td>
                  <td className="py-2">
                    <span
                      className={cx(
                        log.result === 'success'
                          ? 'text-ok'
                          : log.result === 'rejected'
                            ? 'text-warn'
                            : 'text-err',
                      )}
                    >
                      {RESULT_LABELS[log.result]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && !loading && (
            <p className="py-6 text-center text-xs text-dim">暂无审计记录</p>
          )}
        </div>
        {logs.length < total && (
          <button
            type="button"
            className="btn btn-outline btn-sm mt-3"
            disabled={loading}
            onClick={() => void load(nextOffset)}
          >
            {loading ? '加载中…' : '加载更多'}
          </button>
        )}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 主组件                                                               */
/* ------------------------------------------------------------------ */

/** 设置页（§3.3 #23；initialTab 由路由区分，§6.1） */
export default function SettingsPage({ initialTab = 'general' }: { initialTab?: SettingsTab }): ReactNode {
  const [tab, setTab] = useState<SettingsTab>(initialTab)

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-4 py-5 sm:py-8">
        <h1 className="text-xl font-semibold tracking-wide">设置</h1>

        {/* Tab 切换（窄屏横向滚动 + 44px 触控区） */}
        <div className="mt-4 flex gap-1 overflow-x-auto border-b border-border">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cx(
                '-mb-px shrink-0 border-b-2 px-4 py-2 text-sm transition-colors max-sm:min-h-[44px] max-sm:px-3',
                tab === item.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-dim hover:text-text',
              )}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'providers' && <ProvidersTab />}
        {tab === 'backends' && <BackendsTab />}
        {tab === 'general' && <GeneralTab />}
      </div>
    </div>
  )
}
