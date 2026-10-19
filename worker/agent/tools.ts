/**
 * Agent 工具定义与执行（架构文档 §3.4 #39 / §7.1 工具定义 / §7.2 危险规则）。
 *
 * - TOOL_DEFINITIONS：6 个工具的 JSON Schema（§7.1 原文照录，OpenAI function 格式，
 *   三协议适配器各自转译）；
 * - DangerMatcher / matchDanger：将 DANGER_RULES 编译为 RegExp(rule.pattern, 'i')；
 * - executeTool：list_files / read_file / write_file / edit_file / search_files 走 VFS
 *   （D1 元数据 + R2 内容），run_command 走虚拟 Shell 或 DO 远程中继；
 * - writeAuditLog：审计落库助手（手动终端、Agent 循环、审批决策共用）。
 *
 * 审批判定（命中危险规则 / 覆盖写）由 loop.ts 在执行前完成，本模块只负责执行。
 */
import type { DangerRule, ToolCall, ToolDefinition } from '@shared/types'
import { DANGER_RULES, ID_PREFIX, READ_FILE_MAX_CHARS } from '@shared/constants'
import { dbAll, dbFirst, dbRun, newId, nowIso } from '../lib/core'
import type { AuditResult, AuditRisk } from '@shared/types'
import type { Env } from '../types'
import { VirtualShell, type VfsFileRow } from '../vfs/shell'
import { execOnBackend } from '../routes/backends'
import {
  readWorkspaceFile,
  resolvePathNode,
  searchWorkspace,
  writeWorkspaceFile,
} from '../routes/workspaces'

/* ------------------------------------------------------------------ */
/* 工具定义（§7.1 原文照录）                                            */
/* ------------------------------------------------------------------ */

/** 6 个内置工具的 JSON Schema 定义（OpenAI function 格式） */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录内容（文件树）',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '目录路径，空为根目录' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建或覆盖文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '基于旧串替换的精确编辑',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '按文件名或内容搜索（grep 语义）',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'boolean' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在虚拟 Shell 或远程执行后端运行命令',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          backend: { type: 'string', description: 'vfs 或后端 ID，缺省用工作区默认' },
        },
        required: ['command'],
      },
    },
  },
]

/* ------------------------------------------------------------------ */
/* 危险规则匹配（§7.2）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 危险命令匹配器：构造时将规则表编译为 RegExp(rule.pattern, 'i')。
 * 'i' 标志且无 'g'，.test() 无状态，可安全复用同一实例。
 */
export class DangerMatcher {
  private readonly compiled: { rule: DangerRule; regex: RegExp }[]

  constructor(rules: readonly DangerRule[] = DANGER_RULES) {
    this.compiled = rules.map((rule) => ({ rule, regex: new RegExp(rule.pattern, 'i') }))
  }

  /** 返回首个命中的规则；未命中返回 null */
  match(command: string): DangerRule | null {
    for (const entry of this.compiled) {
      if (entry.regex.test(command)) {
        return entry.rule
      }
    }
    return null
  }
}

/** 模块级单例匹配器（DANGER_RULES 为常量表，编译一次重复使用） */
const defaultMatcher = new DangerMatcher()

/** 命令是否命中危险规则（便捷函数） */
export function matchDanger(command: string): DangerRule | null {
  return defaultMatcher.match(command)
}

/* ------------------------------------------------------------------ */
/* 审计日志                                                             */
/* ------------------------------------------------------------------ */

/** 审计写入入参（§4.1 audit_logs） */
export interface AuditInput {
  userId: string
  workspaceId?: string | null
  /** exec_command / approval / file_write / file_delete / backend_connect / agent_auth_fail */
  action: string
  target: string
  backend?: string
  risk?: AuditRisk
  result?: AuditResult
  detail?: string
}

/**
 * 写审计日志。审计失败不影响主流程（仅记服务端错误日志）。
 * 字段长度截断，避免超长命令 / 路径撑爆存储。
 */
export async function writeAuditLog(env: Env, input: AuditInput): Promise<void> {
  try {
    await dbRun(
      env.DB,
      'INSERT INTO audit_logs (id, user_id, workspace_id, action, target, backend, risk, result, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        newId(ID_PREFIX.audit),
        input.userId,
        input.workspaceId ?? null,
        input.action,
        input.target.slice(0, 500),
        input.backend ?? 'vfs',
        input.risk ?? 'normal',
        input.result ?? 'success',
        (input.detail ?? '').slice(0, 1000),
        nowIso(),
      ],
    )
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', module: 'audit', msg: '审计写入失败', detail: String(err) }))
  }
}

/* ------------------------------------------------------------------ */
/* 工具执行                                                             */
/* ------------------------------------------------------------------ */

/** 工具执行上下文（由 Agent 循环构造） */
export interface ToolContext {
  env: Env
  workspaceId: string
  userId: string
  /** 工作区默认执行后端（'vfs' 或 exec_backends.id） */
  defaultBackend: string
}

/** 工具执行结果（output 由调用方按 TOOL_OUTPUT_MAX_CHARS 截断） */
export interface ToolResult {
  ok: boolean
  output: string
}

/** 解析工具参数 JSON；非法 / 非对象时退化为空对象 */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 退化为空对象
  }
  return {}
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

function readInteger(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value)
  }
  return fallback
}

/**
 * 执行单个工具调用。
 * 任何异常均归一化为 { ok: false, output: 错误说明 }，绝不向上抛出
 * （循环层另有「重试 1 次」策略，见 §7.3）。
 */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  try {
    return await dispatchTool(call, ctx)
  } catch (err) {
    return { ok: false, output: `工具执行异常：${err instanceof Error ? err.message : '未知错误'}` }
  }
}

async function dispatchTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const args = parseToolArguments(call.arguments)
  switch (call.name) {
    case 'list_files':
      return await toolListFiles(args, ctx)
    case 'read_file':
      return await toolReadFile(args, ctx)
    case 'write_file':
      return await toolWriteFile(args, ctx)
    case 'edit_file':
      return await toolEditFile(args, ctx)
    case 'search_files':
      return await toolSearchFiles(args, ctx)
    case 'run_command':
      return await toolRunCommand(args, ctx)
    default:
      return { ok: false, output: `未知工具：${call.name}` }
  }
}

/** list_files：列出目录内容（目录带 `/` 后缀） */
async function toolListFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = readString(args, 'path')
  const node = await resolvePathNode(ctx.env, ctx.workspaceId, path)
  if (node && node.type === 'file') {
    return { ok: true, output: node.name }
  }
  const rows = await dbAll<VfsFileRow>(
    ctx.env.DB,
    'SELECT * FROM files WHERE workspace_id = ? AND parent_id = ? ORDER BY name',
    [ctx.workspaceId, node ? node.id : ''],
  )
  if (rows.length === 0) {
    return { ok: true, output: '（空目录）' }
  }
  const lines = rows.map((row) => (row.type === 'dir' ? `${row.name}/` : `${row.name}  (${row.size}B)`))
  return { ok: true, output: lines.join('\n') }
}

/** read_file：按行偏移读取（offset 默认第 1 行，limit 默认全部，受 READ_FILE_MAX_CHARS 限制） */
async function toolReadFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = readString(args, 'path')
  if (path === '') {
    return { ok: false, output: '缺少 path 参数' }
  }
  const file = await readWorkspaceFile(ctx.env, ctx.workspaceId, path)
  if (!file) {
    return { ok: false, output: `文件不存在：${path}` }
  }
  let content = file.content
  let truncated = false
  if (content.length > READ_FILE_MAX_CHARS) {
    content = content.slice(0, READ_FILE_MAX_CHARS)
    truncated = true
  }
  const lines = content.split('\n')
  const offset = Math.max(1, readInteger(args, 'offset', 1))
  const limit = Math.max(1, readInteger(args, 'limit', lines.length))
  const output = lines.slice(offset - 1, offset - 1 + limit).join('\n')
  const suffix = truncated ? `\n…（文件超过 ${READ_FILE_MAX_CHARS} 字符，已截断）` : ''
  return { ok: true, output: output + suffix }
}

/** write_file：创建或覆盖文件 */
async function toolWriteFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = readString(args, 'path')
  const content = args.content
  if (path === '') {
    return { ok: false, output: '缺少 path 参数' }
  }
  if (typeof content !== 'string') {
    return { ok: false, output: '缺少 content 参数' }
  }
  const row = await writeWorkspaceFile(ctx.env, ctx.workspaceId, path, content)
  return { ok: true, output: `已写入 ${path}（${row.size} 字节）` }
}

/** edit_file：基于旧串替换的精确编辑 */
async function toolEditFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = readString(args, 'path')
  const oldString = readString(args, 'old_string')
  const newString = readString(args, 'new_string')
  const replaceAll = args.replace_all === true
  if (path === '' || oldString === '' || newString === '') {
    return { ok: false, output: '缺少 path / old_string / new_string 参数' }
  }
  const file = await readWorkspaceFile(ctx.env, ctx.workspaceId, path)
  if (!file) {
    return { ok: false, output: `文件不存在：${path}` }
  }
  if (!file.content.includes(oldString)) {
    return { ok: false, output: '未找到匹配的旧字符串' }
  }
  const occurrences = file.content.split(oldString).length - 1
  if (occurrences > 1 && !replaceAll) {
    return { ok: false, output: `找到 ${occurrences} 处匹配，请提供更多上下文或设置 replace_all` }
  }
  const next = replaceAll ? file.content.split(oldString).join(newString) : file.content.replace(oldString, newString)
  await writeWorkspaceFile(ctx.env, ctx.workspaceId, path, next)
  return { ok: true, output: `已替换 ${replaceAll ? occurrences : 1} 处` }
}

/** search_files：按文件名或内容搜索（grep 语义） */
async function toolSearchFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = readString(args, 'pattern')
  if (pattern === '') {
    return { ok: false, output: '缺少 pattern 参数' }
  }
  const searchContent = args.content !== false
  const path = readString(args, 'path')
  const matches = await searchWorkspace(ctx.env, ctx.workspaceId, pattern, { path, content: searchContent })
  if (matches.length === 0) {
    return { ok: true, output: '（无匹配）' }
  }
  const lines = matches.map((match) =>
    match.line !== undefined ? `${match.path}:${match.line}: ${match.snippet ?? ''}` : match.path,
  )
  return { ok: true, output: lines.join('\n') }
}

/** run_command：虚拟 Shell 或远程执行后端 */
async function toolRunCommand(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = readString(args, 'command')
  if (command === '') {
    return { ok: false, output: '缺少 command 参数' }
  }
  const backend = readString(args, 'backend') || ctx.defaultBackend || 'vfs'

  if (backend === 'vfs') {
    const shell = new VirtualShell(ctx.env)
    const result = await shell.execute(command, ctx.workspaceId)
    return { ok: result.exitCode === 0, output: result.output === '' ? '（无输出）' : result.output }
  }

  // 远程后端：归属 + 启用 + 在线校验（不在线直接 error，不进审批，§7.1）
  const row = await dbFirst<{ id: string; status: string; enabled: number }>(
    ctx.env.DB,
    'SELECT id, status, enabled FROM exec_backends WHERE id = ? AND user_id = ?',
    [backend, ctx.userId],
  )
  if (!row) {
    return { ok: false, output: `执行后端不存在：${backend}` }
  }
  if (row.enabled !== 1) {
    return { ok: false, output: `执行后端已停用：${backend}` }
  }
  if (row.status !== 'online') {
    return { ok: false, output: `执行后端不在线：${backend}` }
  }
  const relay = await execOnBackend(ctx.env, backend, command)
  return { ok: relay.ok && relay.exitCode === 0, output: relay.output }
}
