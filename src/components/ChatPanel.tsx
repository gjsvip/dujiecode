/**
 * AI 对话面板（架构文档 §3.3 #27 / §6.2）：
 * 消息流（user / assistant / tool 三类气泡）、token 流式渲染、
 * 工具步骤卡片（工具名 + 参数 + 结果 + 截断标记）、审批卡片
 * （approval_request 内联：命令展示 + 危险原因 + 允许 / 拒绝 / 总是允许）、
 * 输入框（Enter 发送）、停止 / 重生成按钮。
 *
 * 数据全部来自 chat store（§5.3 SSE 事件消费）；供应商 / 模型选择器
 * 用于新建会话（POST /api/workspaces/:id/conversations 需要 providerId + model）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { api } from '../api'
import { useChatStore, type ChatMessage, type ToolStep } from '../store/chat'
import { useWorkspaceStore } from '../store/workspace'
import type { ProviderProtocol, ProviderView } from '@shared/types'

/* ------------------------------------------------------------------ */
/* 小部件                                                               */
/* ------------------------------------------------------------------ */

/** 类名拼接小工具 */
function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
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

const SendIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M12 19V5 M5.5 11.5 12 5l6.5 6.5" className={className} />
)
const StopIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M7 7h10v10H7z" className={className} />
)
const WrenchIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon
    path="M14.5 6.5a3.5 3.5 0 1 0 3.4 4.3l2.6 2.6-2.1 2.1-2.6-2.6a3.5 3.5 0 0 1-4.3-3.4l2.8 2.8 1.4-1.4-2.8-2.8"
    className={className}
  />
)
const ShieldIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon path="M12 3.5 5 6v5.5c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6l-7-2.5z" className={className} />
)
const RefreshIcon = ({ className }: { className?: string }): ReactNode => (
  <Icon
    path="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4"
    className={className}
  />
)

/** 协议中文标签 */
const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  custom: '自定义',
}

/* ------------------------------------------------------------------ */
/* 工具步骤卡片                                                         */
/* ------------------------------------------------------------------ */

/** 工具步骤状态徽标 */
const STEP_STATUS_META: Record<
  ToolStep['status'],
  { label: string; text: string; dot: string }
> = {
  running: { label: '执行中', text: 'text-accent', dot: 'bg-accent animate-pulse' },
  awaiting_approval: { label: '等待审批', text: 'text-warn', dot: 'bg-warn' },
  ok: { label: '完成', text: 'text-ok', dot: 'bg-ok' },
  error: { label: '失败', text: 'text-err', dot: 'bg-err' },
}

/** 审批决定回调 */
type DecideHandler = (approvalId: string, decision: 'approve' | 'reject', alwaysAllow: boolean) => void

/** 工具步骤卡片（tool_call + 审批 + tool_result 的聚合展示） */
function ToolStepCard({
  step,
  onDecide,
}: {
  step: ToolStep
  onDecide: DecideHandler
}): ReactNode {
  const [open, setOpen] = useState(false)
  const approval = step.approval
  const meta = STEP_STATUS_META[step.status]

  /** 参数 JSON 美化（非法 JSON 回落原文） */
  const argsPretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(step.args), null, 2)
    } catch {
      return step.args
    }
  }, [step.args])

  return (
    <div
      className="card overflow-hidden bg-panel/70"
      data-approval-pending={step.status === 'awaiting_approval' ? 'true' : undefined}
    >
      {/* 卡片头：工具名 + 状态 */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-elev/40"
        onClick={() => setOpen((prev) => !prev)}
      >
        <WrenchIcon className="h-3.5 w-3.5 shrink-0 text-dim" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text">{step.name}</span>
        <span className={cx('chip shrink-0', meta.text)}>
          <span className={cx('h-1.5 w-1.5 rounded-full', meta.dot)} />
          {meta.label}
        </span>
        <span className="shrink-0 text-[10px] text-dim">{open ? '▲' : '▼'}</span>
      </button>

      {/* 展开区：参数 + 输出 */}
      {open && (
        <div className="border-t border-border px-3 py-2">
          <p className="label">参数</p>
          <pre className="code-block max-h-40 text-[11px]">{argsPretty || '（无参数）'}</pre>
          {step.output !== undefined && (
            <>
              <p className="label mt-2">
                输出{step.truncated && <span className="ml-1 text-warn">（已截断）</span>}
              </p>
              <pre className="code-block max-h-52 whitespace-pre-wrap text-[11px]">
                {step.output === '' ? '（无输出）' : step.output}
              </pre>
            </>
          )}
        </div>
      )}

      {/* 审批卡片：等待决策 */}
      {approval !== undefined && approval.decision === null && (
        <div className="border-t border-warn/40 bg-warn/5 px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <ShieldIcon className="h-3.5 w-3.5 text-warn" />
            <p className="text-xs font-medium text-warn">需要审批</p>
          </div>
          <p className="mt-1 text-xs text-dim">{approval.reason}</p>
          <pre className="code-block mt-2 max-h-32 border-warn/30 whitespace-pre-wrap text-[11px] text-warn">
            {approval.command || '（无命令展示）'}
          </pre>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onDecide(approval.approvalId, 'approve', false)}
            >
              允许
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => onDecide(approval.approvalId, 'approve', true)}
            >
              总是允许
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => onDecide(approval.approvalId, 'reject', false)}
            >
              拒绝
            </button>
          </div>
        </div>
      )}

      {/* 审批卡片：已决策 */}
      {approval !== undefined && approval.decision !== null && (
        <div className="border-t border-border px-3 py-2 text-xs">
          {approval.decision === 'approve' ? (
            <span className="text-ok">已允许执行</span>
          ) : (
            <span className="text-err">已拒绝执行</span>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 消息气泡                                                             */
/* ------------------------------------------------------------------ */

/** 单条消息渲染（user 右对齐气泡 / assistant 文本 + 工具步骤卡片） */
function MessageBubble({
  message,
  onDecide,
}: {
  message: ChatMessage
  onDecide: DecideHandler
}): ReactNode {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent/20 px-3.5 py-2 text-[13px] leading-relaxed text-text">
          {message.content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {message.content !== '' && (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text">
          {message.content}
          {message.streaming === true && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />
          )}
        </div>
      )}
      {(message.steps ?? []).map((step) => (
        <ToolStepCard key={step.id} step={step} onDecide={onDecide} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 主组件                                                               */
/* ------------------------------------------------------------------ */

/** AI 对话面板（§3.3 #27） */
export default function ChatPanel({ workspaceId }: { workspaceId: string }): ReactNode {
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const messages = useChatStore((s) => s.messages)
  const status = useChatStore((s) => s.status)
  const currentToolCall = useChatStore((s) => s.currentToolCall)
  const usage = useChatStore((s) => s.usage)
  const error = useChatStore((s) => s.error)
  const loading = useChatStore((s) => s.loading)
  const send = useChatStore((s) => s.send)
  const abort = useChatStore((s) => s.abort)
  const regenerate = useChatStore((s) => s.regenerate)
  const decideApproval = useChatStore((s) => s.decideApproval)
  const createConversation = useChatStore((s) => s.createConversation)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const pushToast = useWorkspaceStore((s) => s.pushToast)
  const approvalFocusSeq = useWorkspaceStore((s) => s.approvalFocusSeq)

  // 供应商 / 模型（新建会话与切换模型用）
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  /** 是否粘贴底部（自动滚动开关） */
  const stickRef = useRef(true)

  const isStreaming = status === 'streaming' || status === 'awaiting_approval'
  const selectedProvider = providers.find((p) => p.id === providerId) ?? null

  /** 加载启用的供应商列表 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{ providers: ProviderView[] }>('/api/providers')
        if (cancelled) {
          return
        }
        const enabled = res.providers.filter((p) => p.enabled)
        setProviders(enabled)
        if (enabled.length > 0) {
          const first = enabled[0]
          if (first !== undefined) {
            setProviderId((prev) => (prev === '' ? first.id : prev))
            setModel((prev) => (prev === '' ? (first.defaultModel || first.models[0]?.id || '') : prev))
          }
        }
      } catch {
        // 供应商加载失败：输入区给出引导
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 切换供应商时重置默认模型 */
  useEffect(() => {
    const provider = providers.find((p) => p.id === providerId)
    if (provider !== undefined) {
      setModel(provider.defaultModel || provider.models[0]?.id || '')
    }
  }, [providerId, providers])

  /** 自动滚动（用户停留在底部时） */
  useEffect(() => {
    const el = scrollRef.current
    if (el !== null && stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, status])

  /** 顶栏铃铛：滚动到第一张待审批卡片 */
  useEffect(() => {
    if (approvalFocusSeq === 0) {
      return
    }
    const el = scrollRef.current?.querySelector('[data-approval-pending="true"]')
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [approvalFocusSeq])

  /** 滚动位置跟踪 */
  function onScroll(): void {
    const el = scrollRef.current
    if (el === null) {
      return
    }
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  /** 发送（无会话时先按所选供应商 / 模型创建） */
  async function handleSend(): Promise<void> {
    const text = input.trim()
    if (text === '' || sending || isStreaming) {
      return
    }
    if (providerId === '' || model === '') {
      pushToast('err', '请先选择供应商与模型（或到设置页配置）')
      return
    }
    setSending(true)
    try {
      let convId = activeConversationId
      if (convId === null) {
        const conversation = await createConversation(workspaceId, providerId, model)
        convId = conversation.id
      }
      setInput('')
      stickRef.current = true
      await send(text, { providerId, model })
    } catch {
      // send 内部已落错误态；网络层异常在此兜底提示
      pushToast('err', '发送失败，请重试')
    } finally {
      setSending(false)
    }
  }

  /** 审批决定（含总是允许） */
  async function handleDecide(
    approvalId: string,
    decision: 'approve' | 'reject',
    alwaysAllow: boolean,
  ): Promise<void> {
    try {
      await decideApproval(approvalId, decision, alwaysAllow)
    } catch {
      pushToast('err', '审批提交失败，请重试')
    }
  }

  /** 输入框按键：Enter 发送（Shift+Enter 换行；IME 组合中不触发） */
  function onInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void handleSend()
    }
  }

  const canRegenerate =
    !isStreaming &&
    (status === 'done' || status === 'aborted' || status === 'error') &&
    messages.some((m) => m.role === 'user')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：供应商 / 模型 / 新会话 */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <select
          className="field h-7 w-[7.5rem] shrink-0 px-1.5 text-[11px]"
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          title="供应商"
        >
          {providers.length === 0 && <option value="">未配置</option>}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {selectedProvider !== null && selectedProvider.models.length > 0 ? (
          <select
            className="field h-7 min-w-0 flex-1 px-1.5 text-[11px]"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            title="模型"
          >
            {selectedProvider.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="field h-7 min-w-0 flex-1 px-1.5 text-[11px]"
            value={model}
            placeholder="模型 ID"
            title="模型（可在设置页拉取列表）"
            onChange={(event) => setModel(event.target.value)}
          />
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm shrink-0"
          title="开始新会话"
          onClick={() => void selectConversation(null)}
        >
          ＋ 新会话
        </button>
      </div>

      {/* 消息流 */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3"
      >
        {loading && messages.length === 0 && (
          <p className="py-8 text-center text-xs text-dim">加载消息中…</p>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <ShieldIcon className="h-8 w-8 text-accent/60" />
            <p className="text-sm text-text">开始新对话</p>
            <p className="max-w-[16rem] text-xs leading-relaxed text-dim">
              描述你的需求，AI 将使用文件与终端工具协作完成。危险命令会触发审批卡片。
            </p>
            {providers.length === 0 && (
              <a href="/settings/providers" className="btn btn-outline btn-sm">
                前往配置供应商
              </a>
            )}
          </div>
        )}

        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} onDecide={(id, decision, always) => void handleDecide(id, decision, always)} />
        ))}

        {/* 流式状态行 */}
        {isStreaming && (
          <div className="flex items-center gap-2 text-[11px] text-dim">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {status === 'awaiting_approval'
              ? '等待审批…'
              : currentToolCall !== null
                ? `正在执行 ${currentToolCall.name}…`
                : '正在生成…'}
          </div>
        )}

        {status === 'error' && error !== null && (
          <p className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-xs text-err">{error}</p>
        )}
      </div>

      {/* 输入区 */}
      <div className="shrink-0 border-t border-border p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            className="field max-h-32 min-h-[38px] resize-none py-2"
            rows={1}
            placeholder={isStreaming ? '正在生成，可点击停止…' : '输入需求，Enter 发送，Shift+Enter 换行'}
            value={input}
            disabled={isStreaming}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          {isStreaming ? (
            <button
              type="button"
              className="btn btn-danger btn-sm shrink-0"
              onClick={() => void abort()}
            >
              <StopIcon className="h-3.5 w-3.5" />
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm shrink-0"
              disabled={input.trim() === '' || sending}
              onClick={() => void handleSend()}
            >
              <SendIcon className="h-3.5 w-3.5" />
              发送
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-[11px] text-dim">
          {canRegenerate && (
            <button
              type="button"
              className="flex items-center gap-1 transition-colors hover:text-accent"
              onClick={() => void regenerate()}
            >
              <RefreshIcon className="h-3 w-3" />
              重新生成
            </button>
          )}
          {usage.tokensOut > 0 && (
            <span>
              tokens {usage.tokensIn} ↑ / {usage.tokensOut} ↓
            </span>
          )}
          {conversations.length > 0 && activeConversationId !== null && (
            <span className="ml-auto truncate">
              {conversations.find((c) => c.id === activeConversationId)?.title ?? ''}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
