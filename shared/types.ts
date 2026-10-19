/**
 * 渡劫code 前后端共享类型契约（架构文档 §3.2 #9 / §4 / §5）。
 * 本文件为零依赖纯类型声明，前后端均经 tsconfig paths 与 vite alias 的 `@shared/*` 引用；
 * 字段一律 camelCase，时间一律 ISO 8601 UTC 字符串（§11 共享约定）。
 */

/** 认证用户对外视图（绝不包含 password_hash） */
export interface User {
  id: string
  email: string
  displayName: string
  createdAt: string
}

/** LLM 供应商协议类型（D1 providers.protocol CHECK 约束保持一致） */
export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini' | 'custom'

/** 模型缓存条目（providers.models_cache JSON 数组元素） */
export interface ProviderModel {
  id: string
}

/** 供应商对外视图（密钥仅以 keyTail 末 4 位展示，永不回传明文或密文） */
export interface ProviderView {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  defaultModel: string
  models: ProviderModel[]
  enabled: boolean
  createdAt: string
  keyTail: string
}

/** 工作区完整实体（GET /api/workspaces/:id） */
export interface Workspace {
  id: string
  name: string
  description: string
  /** 'vfs' 或 exec_backends.id */
  defaultBackend: string
  createdAt: string
  updatedAt: string
}

/** 工作区列表摘要（GET /api/workspaces，含文件计数） */
export interface WorkspaceSummary {
  id: string
  name: string
  fileCount: number
  updatedAt: string
}

/** 文件节点类型 */
export type FileType = 'file' | 'dir'

/** 文件树节点（目录携带 children，文件携带 size） */
export interface FileNode {
  id: string
  name: string
  type: FileType
  children?: FileNode[]
  size?: number
}

/** 会话状态机（D1 conversations.status CHECK 约束） */
export type ConversationStatus =
  | 'idle'
  | 'streaming'
  | 'awaiting_approval'
  | 'done'
  | 'aborted'
  | 'error'

/** 会话实体 */
export interface Conversation {
  id: string
  workspaceId: string
  title: string
  /** provider 被删除后置空（ON DELETE SET NULL） */
  providerId: string | null
  model: string
  status: ConversationStatus
  createdAt: string
  updatedAt: string
}

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'tool'

/** 模型发起的工具调用（arguments 为完整 JSON 字符串，见 §5.3） */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** 对话消息 */
export interface Message {
  id: string
  role: MessageRole
  content: string
  /** role=assistant 时的工具调用列表（D1 tool_calls JSON） */
  toolCalls?: ToolCall[]
  /** role=tool 时关联的调用 ID */
  toolCallId?: string
  /** role=tool 时的工具名 */
  name?: string
  tokensIn: number
  tokensOut: number
  createdAt: string
}

/** 审批状态 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

/** 审批记录（arguments 为 JSON 字符串，与 D1 存储一致） */
export interface Approval {
  id: string
  conversationId: string
  toolName: string
  arguments: string
  /** 命中的危险规则说明 */
  reason: string
  status: ApprovalStatus
  decidedAt: string | null
  createdAt: string
}

/** 审计风险级别 */
export type AuditRisk = 'normal' | 'dangerous'

/** 审计结果 */
export type AuditResult = 'success' | 'failure' | 'rejected'

/** 审计日志 */
export interface AuditLog {
  id: string
  workspaceId: string | null
  action: string
  target: string
  backend: string
  risk: AuditRisk
  result: AuditResult
  detail: string
  createdAt: string
}

/** 执行后端在线状态 */
export type BackendStatus = 'online' | 'offline'

/** 执行后端（用户自有 Linux 服务器，agent 主动外连，Worker 不直连） */
export interface ExecBackend {
  id: string
  name: string
  host: string
  status: BackendStatus
  lastSeenAt: string | null
  enabled: boolean
}

/** agent token 视图（明文仅在创建时返回一次，这里只有元数据） */
export interface AgentTokenView {
  id: string
  name: string
  lastUsedAt: string | null
  revoked: boolean
  createdAt: string
}

/** 工具名（6 个内置工具，见 §7.1） */
export type ToolName =
  | 'list_files'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'search_files'
  | 'run_command'

/** OpenAI function 格式工具定义（三协议适配器各自转译，见 §7.1） */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

/** SSE 事件联合类型（§5.3；事件名集合固定，data 为单行 JSON） */
export type SSEEvent =
  | { event: 'meta'; data: { conversationId: string; messageId: string } }
  | { event: 'token'; data: { text: string } }
  | { event: 'tool_call'; data: ToolCall }
  | {
      event: 'approval_request'
      data: { approvalId: string; toolName: string; command: string; reason: string }
    }
  | { event: 'approval_resolved'; data: { approvalId: string; decision: 'approve' | 'reject' } }
  | {
      event: 'tool_result'
      data: { id: string; name: string; ok: boolean; output: string; truncated: boolean }
    }
  | { event: 'usage'; data: { tokensIn: number; tokensOut: number } }
  | { event: 'done'; data: { messageId: string; finishReason: string; rounds: number } }
  | { event: 'error'; data: { code: string; message: string } }

/**
 * Agent JSON 行协议帧（浏览器 ⇄ 服务器代理，经 DO 透传，§5.4）。
 * 每帧一个 JSON 对象（UTF-8 一行）；二进制字段一律 base64。
 */
export type AgentWsMessage =
  | { type: 'hello'; version: string; hostname: string; platform: string }
  | { type: 'exec'; id: string; command: string; timeoutSec?: number }
  | { type: 'spawn'; id: string; cols: number; rows: number; cmd?: string }
  | { type: 'data'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string }
  | { type: 'exit'; id: string; code: number }
  | { type: 'error'; id?: string; message: string }
  | { type: 'ping' }
  | { type: 'pong' }

/** 统一错误响应体（§5.1） */
export interface ApiError {
  code: string
  message: string
  details?: unknown
}

/** 错误码表（§5.1；前后端 switch 分支共用） */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'DANGEROUS_COMMAND'
  | 'NOT_FOUND'
  | 'EMAIL_TAKEN'
  | 'NAME_TAKEN'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'MAX_ROUNDS'
  | 'ABORTED'
  | 'INTERNAL'

/** POST /api/auth/register 请求体 */
export interface RegisterRequest {
  email: string
  password: string
  displayName?: string
}

/** POST /api/auth/login 请求体 */
export interface LoginRequest {
  email: string
  password: string
}

/** 认证端点响应体（register / login / me 均为 {user}） */
export interface AuthResponse {
  user: User
}

/** 危险命令规则（§7.2；pattern 为正则字符串，Worker 侧以 'i' 标志编译） */
export interface DangerRule {
  id: string
  label: string
  pattern: string
}
