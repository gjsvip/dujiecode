/**
 * LLM 三协议流式适配器（架构文档 §3.4 #40 / §2 技术选型「LLM 流式」）。
 *
 * 将 OpenAI（/chat/completions）、Anthropic（/v1/messages）、Gemini
 * （generateContent:streamGenerateContent）三种上游 SSE 流归一化为内部事件：
 *   token | tool_call | usage | done | error
 * 请求侧负责 messages + tools 到各协议格式的转译；请求一律携带用户自带密钥。
 * 上游错误一律脱敏为 UPSTREAM_ERROR（原文仅进服务端日志，§11 安全红线）。
 */
import type { ProviderProtocol, ToolCall, ToolDefinition } from '@shared/types'

/* ------------------------------------------------------------------ */
/* 内部事件与请求类型                                                   */
/* ------------------------------------------------------------------ */

/** 归一化内部事件（Agent 循环只面向本联合类型编程） */
export type LlmEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; code: string; message: string }

/** 送入适配器的对话消息（与 D1 messages 行一一对应） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** role=assistant 时的工具调用列表 */
  toolCalls?: ToolCall[]
  /** role=tool 时关联的调用 ID */
  toolCallId?: string
  /** role=tool 时的工具名 */
  name?: string
}

/** 单次流式请求参数（协议与凭据在创建适配器时注入） */
export interface StreamChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  /** 客户端断开信号（Agent 循环透传 req.signal） */
  signal?: AbortSignal
}

/** 流式适配器接口（§13.4 类图 LlmAdapter） */
export interface LlmAdapter {
  streamChat(req: StreamChatRequest): AsyncGenerator<LlmEvent>
}

/** 适配器配置（协议 + 端点 + 用户密钥） */
export interface AdapterConfig {
  protocol: ProviderProtocol
  baseUrl: string
  apiKey: string
}

/* ------------------------------------------------------------------ */
/* URL 助手（providers 路由复用）                                       */
/* ------------------------------------------------------------------ */

/** 各协议官方默认 Base URL（base_url 为空时走默认端点） */
export function defaultBaseUrl(protocol: ProviderProtocol): string {
  switch (protocol) {
    case 'anthropic':
      return 'https://api.anthropic.com'
    case 'gemini':
      return 'https://generativelanguage.googleapis.com'
    case 'openai':
    case 'custom':
    default:
      return 'https://api.openai.com'
  }
}

/** 解析实际 Base URL：用户配置优先，否则用协议默认值 */
export function resolveBaseUrl(protocol: ProviderProtocol, baseUrl: string): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '')
  return trimmed !== '' ? trimmed : defaultBaseUrl(protocol)
}

/** 拼接 Base URL 与路径（自动处理两侧斜杠） */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/* ------------------------------------------------------------------ */
/* 通用流式读取与错误处理                                               */
/* ------------------------------------------------------------------ */

/** 上游非 2xx：原文仅进服务端日志，回事件流的消息脱敏 */
async function logUpstreamError(protocol: string, response: Response): Promise<void> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 500)
  } catch {
    // 忽略读取失败
  }
  console.error(
    JSON.stringify({ level: 'error', module: 'llm-adapter', protocol, msg: '上游返回错误', status: response.status, detail }),
  )
}

/** 脱敏后的上游错误消息（§5.1：502 UPSTREAM_ERROR） */
function sanitizedUpstreamMessage(status: number): string {
  return `供应商服务异常（HTTP ${status}），请稍后重试`
}

/** 逐行产出 SSE 数据行（自动切分跨 chunk 的不完整行） */
async function* streamLines(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        yield buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
      }
    }
    const tail = buffer.replace(/\r$/, '')
    if (tail.trim() !== '') {
      yield tail
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 读取已结束：忽略
    }
  }
}

/** 取 SSE `data:` 载荷；非数据行（event:/空行/注释）返回 null */
function sseData(line: string): string | null {
  if (!line.startsWith('data:')) {
    return null
  }
  return line.slice(5).trimStart()
}

/** 安全数值（非有限数归零） */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 生成合成工具调用 ID（Gemini 等不返回 ID 的协议使用） */
function syntheticCallId(seed: string): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `call_${seed}_${random}`
}

/** 归一化 finishReason（各协议取值 → 内部 stop / tool_calls / length） */
function mapFinishReason(reason: string): string {
  const value = (reason ?? '').toLowerCase()
  if (value === '' || value === 'stop' || value === 'end_turn') {
    return 'stop'
  }
  if (value === 'tool_calls' || value === 'tool_use') {
    return 'tool_calls'
  }
  if (value === 'length' || value === 'max_tokens') {
    return 'length'
  }
  return value
}

/** 适配器工厂：按协议返回对应实现（§13.4 类图 createAdapter） */
export function createAdapter(config: AdapterConfig): LlmAdapter {
  switch (config.protocol) {
    case 'anthropic':
      return new AnthropicAdapter(config)
    case 'gemini':
      return new GeminiAdapter(config)
    case 'openai':
    case 'custom':
    default:
      return new OpenAiAdapter(config)
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI 兼容协议（openai / custom）                                   */
/* ------------------------------------------------------------------ */

/** OpenAI SSE chunk 最小结构 */
interface OpenAiChunk {
  choices?: {
    delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** ChatMessage → OpenAI messages 元素 */
function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content }
  }
  if (message.role === 'assistant') {
    const out: Record<string, unknown> = { role: 'assistant', content: message.content === '' ? null : message.content }
    if (message.toolCalls && message.toolCalls.length > 0) {
      out.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }))
    }
    return out
  }
  return { role: message.role, content: message.content }
}

class OpenAiAdapter implements LlmAdapter {
  constructor(private readonly config: AdapterConfig) {}

  async *streamChat(req: StreamChatRequest): AsyncGenerator<LlmEvent> {
    const base = resolveBaseUrl(this.config.protocol, this.config.baseUrl)
    const url = joinUrl(base, '/chat/completions')
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOpenAiMessage),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (req.tools && req.tools.length > 0) {
      // OpenAI function 格式即 §7.1 定义的原生格式，直接透传
      body.tools = req.tools
      body.tool_choice = 'auto'
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!response.ok) {
      await logUpstreamError('openai', response)
      yield { type: 'error', code: 'UPSTREAM_ERROR', message: sanitizedUpstreamMessage(response.status) }
      return
    }

    // 工具调用按 index 累积（流式增量拼装，流末一次性发出完整 JSON）
    const toolSlots = new Map<number, { id: string; name: string; args: string }>()
    let finishReason = 'stop'

    for await (const line of streamLines(response)) {
      const payload = sseData(line)
      if (payload === null) {
        continue
      }
      if (payload === '[DONE]') {
        break
      }
      let chunk: OpenAiChunk
      try {
        chunk = JSON.parse(payload) as OpenAiChunk
      } catch {
        continue
      }
      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (delta?.content) {
        yield { type: 'token', text: delta.content }
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const slot = toolSlots.get(tc.index) ?? { id: '', name: '', args: '' }
          if (typeof tc.id === 'string' && tc.id !== '') {
            slot.id = tc.id
          }
          if (tc.function?.name) {
            slot.name += tc.function.name
          }
          if (tc.function?.arguments) {
            slot.args += tc.function.arguments
          }
          toolSlots.set(tc.index, slot)
        }
      }
      if (chunk.usage) {
        yield { type: 'usage', tokensIn: num(chunk.usage.prompt_tokens), tokensOut: num(chunk.usage.completion_tokens) }
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason
      }
    }

    for (const [index, slot] of [...toolSlots.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'tool_call',
        id: slot.id !== '' ? slot.id : syntheticCallId(`openai${index}`),
        name: slot.name !== '' ? slot.name : 'unknown',
        arguments: slot.args !== '' ? slot.args : '{}',
      }
    }
    yield { type: 'done', finishReason: mapFinishReason(finishReason) }
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic 协议                                                       */
/* ------------------------------------------------------------------ */

/** Anthropic SSE event 最小结构 */
interface AnthropicEvent {
  type: string
  index?: number
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
  usage?: { output_tokens?: number }
}

/** ChatMessage → Anthropic messages 元素（system 提取为顶层参数；tool 合并为 user 块） */
function toAnthropicMessages(messages: readonly ChatMessage[]): { system: string; messages: Record<string, unknown>[] } {
  const systemParts: string[] = []
  const out: Record<string, unknown>[] = []

  const pushUserContent = (content: unknown): void => {
    const last = out[out.length - 1]
    if (last && last.role === 'user') {
      if (typeof last.content === 'string') {
        last.content = [last.content, content]
      } else if (Array.isArray(last.content)) {
        ;(last.content as unknown[]).push(content)
      }
      return
    }
    out.push({ role: 'user', content })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content)
      continue
    }
    if (message.role === 'tool') {
      pushUserContent({ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content })
      continue
    }
    if (message.role === 'assistant') {
      const blocks: unknown[] = []
      if (message.content !== '') {
        blocks.push({ type: 'text', text: message.content })
      }
      for (const call of message.toolCalls ?? []) {
        let input: unknown = {}
        try {
          input = JSON.parse(call.arguments)
        } catch {
          input = {}
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input })
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : '' })
      continue
    }
    pushUserContent({ type: 'text', text: message.content })
  }
  return { system: systemParts.join('\n\n'), messages: out }
}

class AnthropicAdapter implements LlmAdapter {
  constructor(private readonly config: AdapterConfig) {}

  async *streamChat(req: StreamChatRequest): AsyncGenerator<LlmEvent> {
    const base = resolveBaseUrl(this.config.protocol, this.config.baseUrl)
    const url = joinUrl(base, '/v1/messages')
    const { system, messages } = toAnthropicMessages(req.messages)
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: 8192,
      stream: true,
      messages,
    }
    if (system !== '') {
      body.system = system
    }
    if (req.tools && req.tools.length > 0) {
      // OpenAI function 格式 → Anthropic tools（input_schema 承载 parameters）
      body.tools = req.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }))
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!response.ok) {
      await logUpstreamError('anthropic', response)
      yield { type: 'error', code: 'UPSTREAM_ERROR', message: sanitizedUpstreamMessage(response.status) }
      return
    }

    const toolSlots = new Map<number, { id: string; name: string; args: string }>()
    let inputTokens = 0
    let outputTokens = 0
    let finishReason = 'stop'

    for await (const line of streamLines(response)) {
      const payload = sseData(line)
      if (payload === null) {
        continue
      }
      let event: AnthropicEvent
      try {
        event = JSON.parse(payload) as AnthropicEvent
      } catch {
        continue
      }
      switch (event.type) {
        case 'message_start':
          inputTokens = num(event.message?.usage?.input_tokens)
          break
        case 'content_block_start':
          if (event.content_block?.type === 'tool_use' && event.index !== undefined) {
            toolSlots.set(event.index, {
              id: event.content_block.id ?? '',
              name: event.content_block.name ?? '',
              args: '',
            })
          }
          break
        case 'content_block_delta':
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield { type: 'token', text: event.delta.text }
          }
          if (event.delta?.type === 'input_json_delta' && event.delta.partial_json && event.index !== undefined) {
            const slot = toolSlots.get(event.index)
            if (slot) {
              slot.args += event.delta.partial_json
            }
          }
          break
        case 'message_delta':
          if (event.delta?.stop_reason) {
            finishReason = event.delta.stop_reason
          }
          if (event.usage?.output_tokens !== undefined) {
            outputTokens = num(event.usage.output_tokens)
          }
          break
        case 'error':
          yield { type: 'error', code: 'UPSTREAM_ERROR', message: '供应商流式响应返回错误' }
          return
        default:
          break
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: 'usage', tokensIn: inputTokens, tokensOut: outputTokens }
    }
    for (const [index, slot] of [...toolSlots.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'tool_call',
        id: slot.id !== '' ? slot.id : syntheticCallId(`anthropic${index}`),
        name: slot.name !== '' ? slot.name : 'unknown',
        arguments: slot.args !== '' ? slot.args : '{}',
      }
    }
    yield { type: 'done', finishReason: mapFinishReason(finishReason) }
  }
}

/* ------------------------------------------------------------------ */
/* Gemini 协议                                                          */
/* ------------------------------------------------------------------ */

/** Gemini streamGenerateContent chunk 最小结构 */
interface GeminiChunk {
  candidates?: {
    content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[] }
    finishReason?: string
  }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
  error?: { code?: number; message?: string; status?: string }
}

/** JSON Schema → Gemini Schema（type 大写、递归转换 properties/items） */
function toGeminiSchema(node: unknown): unknown {
  if (node === null || typeof node !== 'object') {
    return node
  }
  const input = node as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'type' && typeof value === 'string') {
      output.type = value.toUpperCase()
      continue
    }
    if (key === 'properties' && value !== null && typeof value === 'object') {
      const properties: Record<string, unknown> = {}
      for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
        properties[propKey] = toGeminiSchema(propValue)
      }
      output.properties = properties
      continue
    }
    if (key === 'items') {
      output.items = toGeminiSchema(value)
      continue
    }
    output[key] = value
  }
  return output
}

/** ChatMessage → Gemini contents（system 提取为 systemInstruction；tool 合并为 user 块） */
function toGeminiContents(messages: readonly ChatMessage[]): { role: string; parts: unknown[] }[] {
  const out: { role: string; parts: unknown[] }[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      continue
    }
    if (message.role === 'tool') {
      const part = { functionResponse: { name: message.name ?? 'tool', response: { result: message.content } } }
      const last = out[out.length - 1]
      if (last && last.role === 'user') {
        last.parts.push(part)
      } else {
        out.push({ role: 'user', parts: [part] })
      }
      continue
    }
    if (message.role === 'assistant') {
      const parts: unknown[] = []
      if (message.content !== '') {
        parts.push({ text: message.content })
      }
      for (const call of message.toolCalls ?? []) {
        let args: unknown = {}
        try {
          args = JSON.parse(call.arguments)
        } catch {
          args = {}
        }
        parts.push({ functionCall: { name: call.name, args } })
      }
      out.push({ role: 'model', parts })
      continue
    }
    const part = { text: message.content }
    const last = out[out.length - 1]
    if (last && last.role === 'user') {
      last.parts.push(part)
    } else {
      out.push({ role: 'user', parts: [part] })
    }
  }
  return out
}

class GeminiAdapter implements LlmAdapter {
  constructor(private readonly config: AdapterConfig) {}

  async *streamChat(req: StreamChatRequest): AsyncGenerator<LlmEvent> {
    const base = resolveBaseUrl(this.config.protocol, this.config.baseUrl)
    const url = `${joinUrl(base, `/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent`)}?alt=sse`
    const contents = toGeminiContents(req.messages)
    const body: Record<string, unknown> = { contents }

    const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content)
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] }
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            parameters: toGeminiSchema(tool.function.parameters),
          })),
        },
      ]
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.apiKey },
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!response.ok) {
      await logUpstreamError('gemini', response)
      yield { type: 'error', code: 'UPSTREAM_ERROR', message: sanitizedUpstreamMessage(response.status) }
      return
    }

    const toolCalls: ToolCall[] = []
    let tokensIn = 0
    let tokensOut = 0
    let finishReason = 'stop'

    for await (const line of streamLines(response)) {
      const payload = sseData(line)
      if (payload === null) {
        continue
      }
      let chunk: GeminiChunk
      try {
        chunk = JSON.parse(payload) as GeminiChunk
      } catch {
        continue
      }
      if (chunk.error) {
        yield { type: 'error', code: 'UPSTREAM_ERROR', message: '供应商流式响应返回错误' }
        return
      }
      const candidate = chunk.candidates?.[0]
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) {
          yield { type: 'token', text: part.text }
        }
        if (part.functionCall) {
          // Gemini 不返回调用 ID：合成 ID 并在本会话内保持稳定
          toolCalls.push({
            id: syntheticCallId(`gemini${toolCalls.length}`),
            name: part.functionCall.name ?? 'unknown',
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          })
        }
      }
      if (candidate?.finishReason) {
        finishReason = candidate.finishReason
      }
      if (chunk.usageMetadata) {
        tokensIn = num(chunk.usageMetadata.promptTokenCount)
        tokensOut = num(chunk.usageMetadata.candidatesTokenCount)
      }
    }

    if (tokensIn > 0 || tokensOut > 0) {
      yield { type: 'usage', tokensIn, tokensOut }
    }
    for (const call of toolCalls) {
      yield { type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments }
    }
    yield { type: 'done', finishReason: mapFinishReason(finishReason) }
  }
}
