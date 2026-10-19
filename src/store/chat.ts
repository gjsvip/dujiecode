/**
 * 对话状态 Store（架构文档 §3.3 #17 / §6.3 chat 行）。
 *
 * 状态：conversations / activeConversationId / messages / streamingText /
 *       currentToolCall / status / usage / error；
 * action：loadConversations / selectConversation / createConversation /
 *         send（消费 §5.3 SSE 事件流）/ abort / regenerate / decideApproval。
 *
 * SSE 事件（§5.3）：meta / token / tool_call / approval_request /
 * approval_resolved / tool_result / usage / done / error。
 * - token 逐 token 追加渲染（streamingText + 流式 assistant 消息 content）；
 * - tool_call 生成工具步骤卡片，tool_result 回填结果（含截断标记）；
 * - approval_request 内联审批卡片并同步 workspace store 铃铛计数，
 *   decideApproval 走 POST approvals/:id（含 alwaysAllow 放行名单）。
 */
import { create } from 'zustand'
import { ApiError, api, streamSSE, type SSEFrame } from '../api'
import { useWorkspaceStore } from './workspace'
import type { Approval, Conversation, Message, ToolCall } from '@shared/types'

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

/** 对话状态机（与 D1 conversations.status 对齐，§4.1） */
export type ChatStatus = 'idle' | 'streaming' | 'awaiting_approval' | 'done' | 'aborted' | 'error'

/** 工具步骤状态 */
export type ToolStepStatus = 'running' | 'awaiting_approval' | 'ok' | 'error'

/** 工具步骤卡片（tool_call → tool_result 的 UI 聚合） */
export interface ToolStep {
  /** tool_call 的调用 ID（与 tool_result.id 对应） */
  id: string
  /** 工具名（§7.1 六个内置工具之一） */
  name: string
  /** 原始参数 JSON 字符串（§5.3 tool_call.arguments） */
  args: string
  status: ToolStepStatus
  /** 工具执行输出（tool_result.output） */
  output?: string
  /** 输出是否被截断（tool_result.truncated，§5.3） */
  truncated?: boolean
  /** 内联审批卡片（approval_request 挂到当前 running 步骤） */
  approval?: {
    approvalId: string
    /** 命令或目标路径（approval_request.command） */
    command: string
    /** 危险原因（approval_request.reason） */
    reason: string
    /** 用户决策；null 表示等待中 */
    decision: 'approve' | 'reject' | null
  }
}

/** 可渲染对话消息（user / assistant；tool 消息折叠进 assistant.steps） */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** 流式进行中（assistant 消息；结束后置 false） */
  streaming?: boolean
  /** 工具步骤卡片列表（按调用顺序） */
  steps?: ToolStep[]
}

/** SSE 事件 data 的宽松读取视图（逐字段防御性转换） */
type EventData = Record<string, unknown>

/** 当前进行中的流的中止控制器（模块级，避免入 state） */
let activeAbort: AbortController | null = null

/* ------------------------------------------------------------------ */
/* 内部助手                                                             */
/* ------------------------------------------------------------------ */

/** 从历史消息重建可渲染列表：tool 消息挂到对应 assistant 步骤 */
function rebuildMessages(rows: Message[]): ChatMessage[] {
  const items: ChatMessage[] = []
  for (const row of rows) {
    if (row.role === 'user') {
      items.push({ id: row.id, role: 'user', content: row.content, createdAt: row.createdAt })
    } else if (row.role === 'assistant') {
      const steps: ToolStep[] = (row.toolCalls ?? []).map((call) => ({
        id: call.id,
        name: call.name,
        args: call.arguments,
        status: 'ok',
      }))
      items.push({
        id: row.id,
        role: 'assistant',
        content: row.content,
        createdAt: row.createdAt,
        steps,
      })
    } else if (row.role === 'tool') {
      const step = findStep(items, row.toolCallId)
      if (step !== null) {
        step.output = row.content
        step.status = 'ok'
      }
    }
  }
  return items
}

/** 在消息列表中按 toolCallId 查找步骤 */
function findStep(items: ChatMessage[], toolCallId: string | undefined): ToolStep | null {
  if (toolCallId === undefined || toolCallId === '') {
    return null
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const steps = items[i]?.steps ?? []
    for (let j = steps.length - 1; j >= 0; j -= 1) {
      const step = steps[j]
      if (step !== undefined && step.id === toolCallId) {
        return step
      }
    }
  }
  return null
}

/** 从审批参数 JSON 提取展示用命令 / 路径 */
function extractCommand(argumentsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (typeof parsed === 'object' && parsed !== null) {
      const bag = parsed as { command?: unknown; path?: unknown }
      if (typeof bag.command === 'string') {
        return bag.command
      }
      if (typeof bag.path === 'string') {
        return bag.path
      }
    }
  } catch {
    // 参数非法时回落空串
  }
  return ''
}

/** 合并审批记录到步骤卡片（历史恢复用）；返回 pending 计数 */
function mergeApprovals(items: ChatMessage[], approvals: Approval[]): number {
  let pending = 0
  for (const approval of approvals) {
    if (approval.status === 'pending') {
      pending += 1
    }
    // 按工具名匹配第一个尚未挂载审批的步骤
    let attached = false
    for (const item of items) {
      for (const step of item.steps ?? []) {
        if (!attached && step.name === approval.toolName && step.approval === undefined) {
          step.approval = {
            approvalId: approval.id,
            command: extractCommand(approval.arguments),
            reason: approval.reason,
            decision:
              approval.status === 'approved'
                ? 'approve'
                : approval.status === 'rejected'
                  ? 'reject'
                  : null,
          }
          if (approval.status === 'pending') {
            step.status = 'awaiting_approval'
          }
          attached = true
        }
      }
    }
  }
  return pending
}

/** 同步 workspace store 的待审批计数（铃铛徽标，§6.3） */
function bumpApprovalCount(delta: number): void {
  const store = useWorkspaceStore.getState()
  store.setPendingApprovalCount(store.pendingApprovalCount + delta)
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/** 对话 Store 状态与动作（§6.3） */
export interface ChatState {
  /** 当前工作区的会话列表（updated_at DESC） */
  conversations: Conversation[]
  /** 当前会话 ID；null 表示尚未选择（下一次发送时创建） */
  activeConversationId: string | null
  /** 可渲染消息列表 */
  messages: ChatMessage[]
  /** 当前流式 assistant 文本（逐 token 追加） */
  streamingText: string
  /** 当前正在处理的工具调用 */
  currentToolCall: ToolCall | null
  /** 对话状态机 */
  status: ChatStatus
  /** 累计 token 用量（usage 事件） */
  usage: { tokensIn: number; tokensOut: number }
  /** 错误信息（error 事件 / 网络异常） */
  error: string | null
  /** 会话 / 消息加载中 */
  loading: boolean

  /** GET /api/workspaces/:id/conversations；自动选中最近会话 */
  loadConversations: (workspaceId: string) => Promise<void>
  /** GET /api/conversations/:id（消息历史 + 审批恢复）；null 表示新会话 */
  selectConversation: (id: string | null) => Promise<void>
  /** POST /api/workspaces/:id/conversations */
  createConversation: (
    workspaceId: string,
    providerId: string,
    model: string,
    title?: string,
  ) => Promise<Conversation>
  /** POST /api/conversations/:id/messages（SSE Agent 流，§5.3） */
  send: (content: string, options?: { providerId?: string; model?: string }) => Promise<void>
  /** POST /api/conversations/:id/abort（写 KV abort 标志并中断本地流） */
  abort: () => Promise<void>
  /** 重生成：丢弃末尾 assistant 消息后重发最近一条用户消息 */
  regenerate: () => Promise<void>
  /** POST /api/conversations/:id/approvals/:approvalId（含 alwaysAllow） */
  decideApproval: (
    approvalId: string,
    decision: 'approve' | 'reject',
    alwaysAllow?: boolean,
  ) => Promise<void>
}

/** 对话 Store（§6.3：ChatStore --> ApiClient） */
export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  streamingText: '',
  currentToolCall: null,
  status: 'idle',
  usage: { tokensIn: 0, tokensOut: 0 },
  error: null,
  loading: false,

  loadConversations: async (workspaceId: string) => {
    set({ loading: true })
    try {
      const res = await api.get<{ conversations: Conversation[] }>(
        `/api/workspaces/${workspaceId}/conversations`,
      )
      set({ conversations: res.conversations, loading: false })
      // 当前选中会话不属于本工作区时，自动选中最近一个（或清空）
      const current = get().activeConversationId
      const stillValid = current !== null && res.conversations.some((c) => c.id === current)
      if (!stillValid) {
        const first = res.conversations[0]
        if (first !== undefined) {
          await get().selectConversation(first.id)
        } else {
          set({ activeConversationId: null, messages: [], status: 'idle' })
        }
      }
    } catch (err) {
      set({ loading: false, error: err instanceof ApiError ? err.message : '会话列表加载失败' })
    }
  },

  selectConversation: async (id: string | null) => {
    if (id === null) {
      set({
        activeConversationId: null,
        messages: [],
        streamingText: '',
        currentToolCall: null,
        status: 'idle',
        error: null,
        usage: { tokensIn: 0, tokensOut: 0 },
      })
      return
    }
    set({
      loading: true,
      activeConversationId: id,
      messages: [],
      streamingText: '',
      currentToolCall: null,
      status: 'idle',
      error: null,
      usage: { tokensIn: 0, tokensOut: 0 },
    })
    try {
      const res = await api.get<{ conversation: Conversation; messages: Message[] }>(
        `/api/conversations/${id}`,
      )
      const items = rebuildMessages(res.messages)
      // 恢复审批卡片状态（pending 计数同步铃铛）
      let pending = 0
      try {
        const appr = await api.get<{ approvals: Approval[] }>(`/api/conversations/${id}/approvals`)
        pending = mergeApprovals(items, appr.approvals)
      } catch {
        // 审批恢复失败不阻塞消息渲染
      }
      useWorkspaceStore.getState().setPendingApprovalCount(pending)
      set({ messages: items, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof ApiError ? err.message : '消息加载失败' })
    }
  },

  createConversation: async (
    workspaceId: string,
    providerId: string,
    model: string,
    title?: string,
  ) => {
    const res = await api.post<{ conversation: Conversation }>(
      `/api/workspaces/${workspaceId}/conversations`,
      { providerId, model, title },
    )
    set({
      conversations: [res.conversation, ...get().conversations],
      activeConversationId: res.conversation.id,
      messages: [],
      streamingText: '',
      currentToolCall: null,
      status: 'idle',
      error: null,
      usage: { tokensIn: 0, tokensOut: 0 },
    })
    return res.conversation
  },

  send: async (content: string, options?: { providerId?: string; model?: string }) => {
    const state = get()
    const convId = state.activeConversationId
    if (convId === null) {
      throw new ApiError('VALIDATION_ERROR', '请先创建或选择一个会话')
    }
    if (state.status === 'streaming' || state.status === 'awaiting_approval') {
      return
    }

    const now = new Date().toISOString()
    const userMessage: ChatMessage = {
      id: `local_user_${Date.now().toString(36)}`,
      role: 'user',
      content,
      createdAt: now,
    }
    const assistantMessage: ChatMessage = {
      id: 'streaming',
      role: 'assistant',
      content: '',
      createdAt: now,
      streaming: true,
      steps: [],
    }

    activeAbort = new AbortController()
    set({
      messages: [...state.messages, userMessage, assistantMessage],
      streamingText: '',
      currentToolCall: null,
      status: 'streaming',
      error: null,
      usage: { tokensIn: 0, tokensOut: 0 },
    })

    /** 流式收尾：统一落终态并解除 streaming 标记 */
    const finalize = (status: ChatStatus): void => {
      set({
        status,
        streamingText: '',
        currentToolCall: null,
        messages: get().messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      })
    }

    /** 单帧 SSE 事件处理（§5.3 事件契约） */
    const onFrame = (frame: SSEFrame<EventData>): void => {
      const data = frame.data
      switch (frame.event) {
        case 'meta': {
          // 流开始：把占位 assistant 消息对齐到服务端 messageId
          const messageId = typeof data.messageId === 'string' ? data.messageId : ''
          if (messageId !== '') {
            set({
              messages: get().messages.map((m) =>
                m.id === 'streaming' ? { ...m, id: messageId } : m,
              ),
            })
          }
          break
        }
        case 'token': {
          // 逐 token 追加渲染
          const text = typeof data.text === 'string' ? data.text : ''
          if (text === '') {
            break
          }
          set({ streamingText: get().streamingText + text })
          set({
            messages: get().messages.map((m) =>
              m.streaming ? { ...m, content: m.content + text } : m,
            ),
          })
          break
        }
        case 'tool_call': {
          // 工具步骤卡片入列（arguments 为完整 JSON 字符串）
          const call: ToolCall = {
            id: typeof data.id === 'string' ? data.id : '',
            name: typeof data.name === 'string' ? data.name : '',
            arguments: typeof data.arguments === 'string' ? data.arguments : '',
          }
          set({ currentToolCall: call })
          set({
            messages: get().messages.map((m) =>
              m.streaming
                ? {
                    ...m,
                    steps: [
                      ...(m.steps ?? []),
                      { id: call.id, name: call.name, args: call.arguments, status: 'running' },
                    ],
                  }
                : m,
            ),
          })
          break
        }
        case 'approval_request': {
          // 命中危险规则：挂审批卡片到当前 running 步骤，铃铛 +1
          const approvalId = typeof data.approvalId === 'string' ? data.approvalId : ''
          const command = typeof data.command === 'string' ? data.command : ''
          const reason = typeof data.reason === 'string' ? data.reason : ''
          set({ status: 'awaiting_approval' })
          set({
            messages: get().messages.map((m) =>
              m.streaming
                ? {
                    ...m,
                    steps: (m.steps ?? []).map((step) =>
                      step.status === 'running'
                        ? {
                            ...step,
                            status: 'awaiting_approval',
                            approval: { approvalId, command, reason, decision: null },
                          }
                        : step,
                    ),
                  }
                : m,
            ),
          })
          bumpApprovalCount(1)
          break
        }
        case 'approval_resolved': {
          // 用户已决策（可能来自另一设备）：回填决策并恢复 running
          const approvalId = typeof data.approvalId === 'string' ? data.approvalId : ''
          const decision = data.decision === 'reject' ? 'reject' : 'approve'
          set({ status: 'streaming' })
          set({
            messages: get().messages.map((m) =>
              m.streaming
                ? {
                    ...m,
                    steps: (m.steps ?? []).map((step) =>
                      step.approval?.approvalId === approvalId
                        ? { ...step, status: 'running', approval: { ...step.approval, decision } }
                        : step,
                    ),
                  }
                : m,
            ),
          })
          bumpApprovalCount(-1)
          break
        }
        case 'tool_result': {
          // 工具执行结果回填（含截断标记）
          const id = typeof data.id === 'string' ? data.id : ''
          const ok = data.ok === true
          const output = typeof data.output === 'string' ? data.output : ''
          const truncated = data.truncated === true
          set({ currentToolCall: null })
          set({
            messages: get().messages.map((m) =>
              m.streaming
                ? {
                    ...m,
                    steps: (m.steps ?? []).map((step) =>
                      step.id === id
                        ? { ...step, status: ok ? 'ok' : 'error', output, truncated }
                        : step,
                    ),
                  }
                : m,
            ),
          })
          break
        }
        case 'usage': {
          set({
            usage: {
              tokensIn: typeof data.tokensIn === 'number' ? data.tokensIn : 0,
              tokensOut: typeof data.tokensOut === 'number' ? data.tokensOut : 0,
            },
          })
          break
        }
        case 'done': {
          finalize('done')
          break
        }
        case 'error': {
          const message = typeof data.message === 'string' ? data.message : '对话出错'
          set({ status: 'error', error: message })
          finalize('error')
          break
        }
        default:
          break
      }
    }

    try {
      await streamSSE<EventData>(
        `/api/conversations/${convId}/messages`,
        {
          content,
          ...(options?.providerId !== undefined && options.providerId !== ''
            ? { providerId: options.providerId }
            : {}),
          ...(options?.model !== undefined && options.model !== '' ? { model: options.model } : {}),
        },
        onFrame,
        activeAbort.signal,
      )
      // 流正常结束但未收到 done（异常断流）：兜底收尾
      const current = get().status
      if (current === 'streaming' || current === 'awaiting_approval') {
        finalize('done')
      }
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name
      if (name === 'AbortError') {
        finalize('aborted')
      } else {
        const message = err instanceof ApiError ? err.message : '对话流中断，请重试'
        set({ status: 'error', error: message })
        finalize('error')
      }
    } finally {
      activeAbort = null
    }
  },

  abort: async () => {
    const convId = get().activeConversationId
    if (convId === null) {
      return
    }
    try {
      await api.post(`/api/conversations/${convId}/abort`)
    } catch {
      // 服务端中止失败时仍中断本地流，避免界面卡在生成态
    }
    activeAbort?.abort()
    set({
      status: 'aborted',
      streamingText: '',
      currentToolCall: null,
      messages: get().messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    })
  },

  regenerate: async () => {
    const messages = get().messages
    // 丢弃末尾连续的 assistant 消息（含未完成的流式消息）
    let end = messages.length
    while (end > 0 && messages[end - 1]?.role === 'assistant') {
      end -= 1
    }
    const lastUser = [...messages.slice(0, end)].reverse().find((m) => m.role === 'user')
    if (lastUser === undefined) {
      return
    }
    set({ messages: messages.slice(0, end) })
    await get().send(lastUser.content)
  },

  decideApproval: async (
    approvalId: string,
    decision: 'approve' | 'reject',
    alwaysAllow = false,
  ) => {
    const convId = get().activeConversationId
    if (convId === null) {
      return
    }
    // 乐观更新：立即回填决策，SSE approval_resolved 到达时确认
    const rollback = (): void => {
      set({
        messages: get().messages.map((m) => ({
          ...m,
          steps: m.steps?.map((step) =>
            step.approval?.approvalId === approvalId
              ? { ...step, approval: { ...step.approval, decision: null } }
              : step,
          ),
        })),
      })
    }
    set({
      messages: get().messages.map((m) => ({
        ...m,
        steps: m.steps?.map((step) =>
          step.approval?.approvalId === approvalId
            ? { ...step, approval: { ...step.approval, decision } }
            : step,
        ),
      })),
    })
    try {
      await api.post(`/api/conversations/${convId}/approvals/${approvalId}`, {
        decision,
        alwaysAllow,
      })
    } catch (err) {
      rollback()
      throw err
    }
  },
}))
