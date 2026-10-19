/**
 * 虚拟 Shell（架构文档 §3.4 #41 / §7.1 run_command 的 vfs 执行目标）。
 *
 * 职责：
 * - tokenize：命令分词（单/双引号、反斜杠转义），纯函数，可单测；
 * - normalizePath / r2KeyFor：VFS 路径规范化与 R2 Key 生成（§4.2），纯函数；
 * - VirtualShell：白名单 16 命令解释器（pwd/ls/cat/echo/mkdir/touch/rm/cp/mv/
 *   grep/find/head/tail/wc/clear/help），作用于 D1 元数据（files 表）+ R2 内容；
 * - 非白名单命令一律拒绝（退出码 127），绝不调用真实系统命令。
 *
 * 设计约束：纯解析函数（tokenize / normalizePath / buildPathMap）与 IO
 * （VirtualShell.execute）严格分离，保证 tests/vfs-shell.test.ts 可单测。
 */
import type { Env } from '../types'
import { ID_PREFIX, SHELL_WHITELIST } from '@shared/constants'
import { dbAll, dbFirst, dbRun, newId, nowIso } from '../lib/core'

/* ------------------------------------------------------------------ */
/* 结果与错误类型                                                       */
/* ------------------------------------------------------------------ */

/** 虚拟 Shell 单次执行结果 */
export interface ShellResult {
  /** 输出文本（stdout 与错误提示合并，便于终端直接渲染） */
  output: string
  /** 退出码：0 成功；1 普通错误；127 命令不在白名单 */
  exitCode: number
  /** clear 命令请求调用方清屏（VFS 无状态，本身无清屏语义） */
  clear?: boolean
}

/** VFS 路径非法（越界等）：路由层转换为 400，Shell 层转换为退出码 1 */
export class VfsPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VfsPathError'
  }
}

/** Shell 内部错误：携带退出码，由 VirtualShell.execute 捕获后转为 ShellResult */
class ShellError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message)
    this.name = 'ShellError'
  }
}

/* ------------------------------------------------------------------ */
/* 纯解析函数（无 IO，可单测）                                          */
/* ------------------------------------------------------------------ */

/**
 * 命令分词（纯函数）：
 * - 空白字符分隔（连续空白视为一个分隔符）；
 * - 单引号：完全字面量（不支持转义）；
 * - 双引号：允许 \" \\ \$ \` 转义，其余字符原样保留；
 * - 反斜杠：转义下一个字符（含空白与引号）；
 * - 空引号 '' / "" 产生空参数；未闭合引号宽容按行尾结束处理。
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string

    // 单引号内：完全字面量
    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    // 双引号内：仅转义 " \ $ `
    if (quote === '"') {
      if (ch === '"') {
        quote = null
        continue
      }
      if (ch === '\\' && i + 1 < line.length) {
        const next = line[i + 1] as string
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next
          i++
          continue
        }
      }
      current += ch
      continue
    }

    // 无引号上下文
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\') {
      if (i + 1 < line.length) {
        current += line[i + 1] as string
        started = true
        i++
      }
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }

  if (started) {
    tokens.push(current)
  }
  return tokens
}

/**
 * 路径规范化（§4.2，纯函数）：
 * 去首尾空白与前导 `/`，折叠 `.` 段与 `..` 段；`..` 越出根目录时抛 VfsPathError。
 * 返回不带前导斜杠的工作区相对路径（根目录返回空串）。
 */
export function normalizePath(path: string): string {
  const raw = path.trim()
  if (raw === '') {
    return ''
  }
  const stack: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (stack.length === 0) {
        throw new VfsPathError('路径越界：不允许超出工作区根目录')
      }
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  return stack.join('/')
}

/** R2 Key 生成（§4.2）：`ws/{workspaceId}/{normalizedPath}` */
export function r2KeyFor(workspaceId: string, normalizedPath: string): string {
  return `ws/${workspaceId}/${normalizedPath}`
}

/** 规范化路径拼接（任一段为空时退化为另一段） */
export function joinNormalized(parent: string, name: string): string {
  if (parent === '') {
    return name
  }
  if (name === '') {
    return parent
  }
  return `${parent}/${name}`
}

/** UTF-8 字节长度（与 R2 对象 size 语义一致） */
const textEncoder = new TextEncoder()

export function byteLength(text: string): number {
  return textEncoder.encode(text).length
}

/** 扩展名 → MIME（§4.2：.ts→text/plain 等，未知用 application/octet-stream） */
const MIME_BY_EXT: Record<string, string> = {
  ts: 'text/plain',
  tsx: 'text/plain',
  js: 'text/javascript',
  jsx: 'text/plain',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  md: 'text/plain',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/plain',
  py: 'text/plain',
  sh: 'text/plain',
  bash: 'text/plain',
  yml: 'text/plain',
  yaml: 'text/plain',
  toml: 'text/plain',
  ini: 'text/plain',
  sql: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  hpp: 'text/plain',
  vue: 'text/plain',
  xml: 'text/plain',
  env: 'text/plain',
  lock: 'text/plain',
  log: 'text/plain',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
}

/** 按扩展名推断 Content-Type（未知扩展名 → application/octet-stream） */
export function guessMime(name: string): string {
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex < 0 || dotIndex === name.length - 1) {
    return 'application/octet-stream'
  }
  const ext = name.slice(dotIndex + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * 构建「节点 ID → 相对路径」映射（纯函数）。
 * 供 grep / find / search 输出可读路径；父链缺失时静默截断（防御脏数据）。
 */
export function buildPathMap(rows: readonly VfsFileRow[]): Map<string, string> {
  const byId = new Map<string, VfsFileRow>()
  for (const row of rows) {
    byId.set(row.id, row)
  }
  const cache = new Map<string, string>()
  const pathOf = (row: VfsFileRow): string => {
    const cached = cache.get(row.id)
    if (cached !== undefined) {
      return cached
    }
    const segments: string[] = [row.name]
    let current = row
    while (current.parent_id !== '') {
      const parent = byId.get(current.parent_id)
      if (!parent) {
        break
      }
      segments.unshift(parent.name)
      current = parent
    }
    const path = segments.join('/')
    cache.set(row.id, path)
    return path
  }
  const result = new Map<string, string>()
  for (const row of rows) {
    result.set(row.id, pathOf(row))
  }
  return result
}

/** 简易 glob 匹配（仅 * 与 ?），大小写不敏感 */
export function wildcardMatch(pattern: string, text: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(text)
}

/* ------------------------------------------------------------------ */
/* D1 行模型与共享 IO 助手                                             */
/* ------------------------------------------------------------------ */

/** files 表原始行（snake_case，仅模块内使用，对外统一转 FileNode） */
export interface VfsFileRow {
  id: string
  workspace_id: string
  parent_id: string
  name: string
  type: 'file' | 'dir'
  size: number
  mime: string
  r2_key: string | null
  created_at: string
  updated_at: string
}

/** 读取单个子节点 */
export async function findChild(
  env: Env,
  workspaceId: string,
  parentId: string,
  name: string,
): Promise<VfsFileRow | null> {
  return dbFirst<VfsFileRow>(
    env.DB,
    'SELECT * FROM files WHERE workspace_id = ? AND parent_id = ? AND name = ?',
    [workspaceId, parentId, name],
  )
}

/** 读取直接子节点（按名称排序） */
export async function listChildrenRows(
  env: Env,
  workspaceId: string,
  parentId: string,
): Promise<VfsFileRow[]> {
  const rows = await dbAll<VfsFileRow>(
    env.DB,
    'SELECT * FROM files WHERE workspace_id = ? AND parent_id = ?',
    [workspaceId, parentId],
  )
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** 收集以 node 为根的整棵子树（含自身，广度优先） */
export async function collectSubtree(
  env: Env,
  workspaceId: string,
  node: VfsFileRow,
): Promise<VfsFileRow[]> {
  const rows: VfsFileRow[] = []
  const queue: VfsFileRow[] = [node]
  while (queue.length > 0) {
    const current = queue.shift() as VfsFileRow
    rows.push(current)
    if (current.type === 'dir') {
      const children = await listChildrenRows(env, workspaceId, current.id)
      queue.push(...children)
    }
  }
  return rows
}

/** 删除一组文件节点：先删 R2 对象，再删 D1 行（分批，避开 SQL 参数上限） */
export async function deleteFileRows(
  env: Env,
  workspaceId: string,
  rows: readonly VfsFileRow[],
): Promise<void> {
  for (const row of rows) {
    if (row.type === 'file' && row.r2_key) {
      await env.R2.delete(row.r2_key)
    }
  }
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50)
    const placeholders = chunk.map(() => '?').join(', ')
    await dbRun(env.DB, `DELETE FROM files WHERE workspace_id = ? AND id IN (${placeholders})`, [
      workspaceId,
      ...chunk.map((row) => row.id),
    ])
  }
}

/* ------------------------------------------------------------------ */
/* 参数解析（纯函数）                                                   */
/* ------------------------------------------------------------------ */

/** 解析后的命令行参数（白名单命令均只使用短选项） */
interface ParsedArgs {
  flags: Set<string>
  /** -n 的数值（支持 `-n 10` 与 `-n10` 两种形式），未指定为 null */
  numeric: number | null
  operands: string[]
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Set<string>()
  let numeric: number | null = null
  const operands: string[] = []

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) {
      continue
    }
    // 选项：-x / -xyz 组合 / -n10 / -n 10；`-` 与 `-5` 视为操作数
    if (arg.length > 1 && arg.startsWith('-') && !/^-\d/.test(arg)) {
      const body = arg.slice(1)
      const nMatch = /^n(\d+)?$/.exec(body)
      if (nMatch) {
        flags.add('-n')
        if (nMatch[1] !== undefined) {
          numeric = Number.parseInt(nMatch[1], 10)
        } else {
          const next = argv[i + 1]
          if (next !== undefined && /^\d+$/.test(next)) {
            numeric = Number.parseInt(next, 10)
            i++
          }
        }
        continue
      }
      for (const ch of body) {
        flags.add(`-${ch}`)
      }
      continue
    }
    operands.push(arg)
  }

  return { flags, numeric, operands }
}

/* ------------------------------------------------------------------ */
/* 虚拟 Shell 解释器                                                    */
/* ------------------------------------------------------------------ */

/**
 * 虚拟 Shell：白名单命令解释器。
 * 每个 execute 调用相互独立（无持久 cwd），路径一律相对工作区根目录解析。
 */
export class VirtualShell {
  constructor(private readonly env: Env) {}

  /**
   * 执行一条命令。
   * @param command 完整命令行（如 `ls -l src`）
   * @param workspaceId 工作区 ID（ws_ 前缀）
   */
  async execute(command: string, workspaceId: string): Promise<ShellResult> {
    const line = command.trim()
    if (line === '') {
      return { output: '', exitCode: 0 }
    }
    const argv = tokenize(line)
    const name = argv[0] ?? ''

    // 白名单校验：非白名单命令明确拒绝（§3.4 #41）
    if (!(SHELL_WHITELIST as readonly string[]).includes(name)) {
      return {
        output: `sh: 不支持的命令: ${name}（不在白名单，输入 help 查看可用命令）\n`,
        exitCode: 127,
      }
    }

    try {
      switch (name) {
        case 'pwd':
          return this.ok('/\n')
        case 'help':
          return this.ok(this.helpText())
        case 'clear':
          return { output: '', exitCode: 0, clear: true }
        case 'ls':
          return await this.cmdLs(workspaceId, argv)
        case 'cat':
          return await this.cmdCat(workspaceId, argv)
        case 'echo':
          return this.ok(echoText(argv))
        case 'mkdir':
          return await this.cmdMkdir(workspaceId, argv)
        case 'touch':
          return await this.cmdTouch(workspaceId, argv)
        case 'rm':
          return await this.cmdRm(workspaceId, argv)
        case 'cp':
          return await this.cmdCp(workspaceId, argv)
        case 'mv':
          return await this.cmdMv(workspaceId, argv)
        case 'grep':
          return await this.cmdGrep(workspaceId, argv)
        case 'find':
          return await this.cmdFind(workspaceId, argv)
        case 'head':
          return await this.cmdHeadTail(workspaceId, argv, 'head')
        case 'tail':
          return await this.cmdHeadTail(workspaceId, argv, 'tail')
        case 'wc':
          return await this.cmdWc(workspaceId, argv)
        default:
          return { output: `sh: 未实现的命令: ${name}\n`, exitCode: 127 }
      }
    } catch (err) {
      if (err instanceof ShellError) {
        return { output: `${name}: ${err.message}\n`, exitCode: err.exitCode }
      }
      if (err instanceof VfsPathError) {
        return { output: `${name}: ${err.message}\n`, exitCode: 1 }
      }
      throw err
    }
  }

  /* ------------------------------ 内部助手 ------------------------------ */

  private ok(output: string): ShellResult {
    return { output, exitCode: 0 }
  }

  /** 解析路径：空路径返回 null（根目录）；不存在返回 null；中间节点为文件时抛错 */
  private async resolve(workspaceId: string, path: string): Promise<VfsFileRow | null> {
    const normalized = normalizePath(path)
    if (normalized === '') {
      return null
    }
    const segments = normalized.split('/')
    let parentId = ''
    let node: VfsFileRow | null = null
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string
      node = await findChild(this.env, workspaceId, parentId, segment)
      if (!node) {
        return null
      }
      if (node.type === 'file' && i < segments.length - 1) {
        throw new ShellError(`${path}: ${segment} 不是目录`)
      }
      parentId = node.id
    }
    return node
  }

  /** resolve 的必须存在版本（根目录除外） */
  private async resolveRequired(workspaceId: string, path: string): Promise<VfsFileRow | null> {
    const normalized = normalizePath(path)
    if (normalized === '') {
      return null
    }
    const node = await this.resolve(workspaceId, path)
    if (!node) {
      throw new ShellError(`${path}: 不存在该文件或目录`)
    }
    return node
  }

  private async readR2(r2Key: string): Promise<string> {
    if (r2Key === '') {
      return ''
    }
    const obj = await this.env.R2.get(r2Key)
    if (!obj) {
      return ''
    }
    return obj.text()
  }

  /** 写入 R2 并返回 Key（Content-Type 按扩展名推断） */
  private async writeR2(workspaceId: string, normalizedPath: string, name: string, content: string): Promise<string> {
    const r2Key = r2KeyFor(workspaceId, normalizedPath)
    await this.env.R2.put(r2Key, content, { httpMetadata: { contentType: guessMime(name) } })
    return r2Key
  }

  private async insertRow(
    workspaceId: string,
    parentId: string,
    name: string,
    type: 'file' | 'dir',
    size: number,
    mime: string,
    r2Key: string | null,
  ): Promise<VfsFileRow> {
    const now = nowIso()
    const row: VfsFileRow = {
      id: newId(ID_PREFIX.file),
      workspace_id: workspaceId,
      parent_id: parentId,
      name,
      type,
      size,
      mime,
      r2_key: r2Key,
      created_at: now,
      updated_at: now,
    }
    await dbRun(
      this.env.DB,
      'INSERT INTO files (id, workspace_id, parent_id, name, type, size, mime, r2_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        row.id,
        row.workspace_id,
        row.parent_id,
        row.name,
        row.type,
        row.size,
        row.mime,
        row.r2_key,
        row.created_at,
        row.updated_at,
      ],
    )
    return row
  }

  /** 按相对路径创建目录（父目录必须已存在）并返回新行 */
  private async createDir(workspaceId: string, normalized: string, parentId: string): Promise<VfsFileRow> {
    const name = normalized.split('/').pop() ?? normalized
    return this.insertRow(workspaceId, parentId, name, 'dir', 0, '', null)
  }

  /* ------------------------------ 命令实现 ------------------------------ */

  /** ls [-a] [路径...]：列目录内容；目录名带 `/` 后缀 */
  private async cmdLs(workspaceId: string, argv: readonly string[]): Promise<ShellResult> {
    const operands = argv.slice(1).filter((a) => !a.startsWith('-') || a === '-')
    const targets = operands.length > 0 ? operands : ['']
    const chunks: string[] = []
    let exitCode = 0

    for (const target of targets) {
      if (operands.length > 1) {
        chunks.push(`${target === '' ? '/' : target}:\n`)
      }
      try {
        const node = await this.resolveRequired(workspaceId, target)
        if (node && node.type === 'file') {
          chunks.push(`${node.name}\n`)
          continue
        }
        const rows = await listChildrenRows(this.env, workspaceId, node ? node.id : '')
        chunks.push(
          rows.map((r) => (r.type === 'dir' ? `${r.name}/` : r.name)).join('\n') + (rows.length > 0 ? '\n' : ''),
        )
      } catch (err) {
        if (err instanceof ShellError) {
          chunks.push(`${err.message}\n`)
          exitCode = 1
          continue
        }
        throw err
      }
    }
    return { output: chunks.join('\n'), exitCode }
  }

  /** cat <文件...>：拼接输出文件内容 */
  private async cmdCat(workspaceId: string, argv: readonly string[]): Promise<ShellResult> {
    const paths = argv.slice(1).filter((a) => !a.startsWith('-') || a === '-')
    if (paths.length === 0) {
      throw new ShellError('缺少文件参数')
    }
    const parts: string[] = []
    let exitCode = 0
    for (const path of paths) {
      const node = await this.resolveRequired(workspaceId, path)
      if (!node || node.type !== 'file') {
        parts.push(`cat: ${path}: 不是常规文件\n`)
        exitCode = 1
        continue
      }
      const content = await this.readR2(node.r2_key ?? '')
      parts.push(content === '' || content.endsWith('\n') ? content : `${content}\n`)
    }
    return { output: parts.join(''), exitCode }
  }

  /** mkdir [-p] <目录...>：创建目录；-p 时自动补齐缺失父目录 */
  private async cmdMkdir(workspaceId: string, argv: readonly string[]): Promise<ShellResult> {
    const parsed = parseArgs(argv)
    const parents = parsed.flags.has('-p') || parsed.flags.has('-P')
    const operands = parsed.operands
    if (operands.length === 0) {
      throw new ShellError('缺少目录参数')
    }
    const outputs: string[] = []
    let exitCode = 0

    for (const raw of operands) {
      try {
        const normalized = normalizePath(raw)
        if (normalized === '') {
          outputs.push(`mkdir: ${raw}: 不能创建根目录\n`)
          exitCode = 1
          continue
        }
        const segments = normalized.split('/')
        let parentId = ''
        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i] as string
          const existing = await findChild(this.env, workspaceId, parentId, segment)
          if (existing) {
            if (i === segments.length - 1) {
              outputs.push(`mkdir: ${raw}: 文件或目录已存在\n`)
              exitCode = 1
              break
            }
            if (existing.type === 'file') {
              throw new ShellError(`${raw}: ${segment} 不是目录`)
            }
            parentId = existing.id
            continue
          }
          if (i < segments.length - 1 && !parents) {
            throw new ShellError(`${raw}: 父目录不存在（可使用 -p 自动创建）`)
          }
          const created = await this.createDir(workspaceId, segments.slice(0, i + 1).join('/'), parentId)
          parentId = created.id
        }
      } catch (err) {
        if (err instanceof ShellError) {
          outputs.push(`mkdir: ${err.message}\n`)
          exitCode = 1
          continue
        }
        throw err
      }
    }
    return { output: outputs.join(''), exitCode }
  }

  /** touch <文件...>：不存在则创建空文件；存在则刷新 updated_at */
  private async cmdTouch(workspaceId: string, argv: readonly string[]): Promise<ShellResult> {
    const operands = argv.slice(1).filter((a) => !a.startsWith('-') || a === '-')
    if (operands.length === 0) {
      throw new ShellError('缺少文件参数')
    }
    const outputs: string[] = []
    let exitCode = 0

    for (const raw of operands) {
      try {
        const normalized = normalizePath(raw)
        if (normalized === '') {
          throw new ShellError(`${raw}: 路径不能为空`)
        }
        const segments = normalized.split('/')
        const name = segments[segments.length - 1] as string
        const parentPath = segments.slice(0, -1).join('/')
        const parent = parentPath === '' ? null : await this.resolveRequired(workspaceId, parentPath)
        if (parentPath !== '' && (!parent || parent.type !== 'dir')) {
          throw new ShellError(`${raw}: 父目录不存在`)
        }
        const existing = await findChild(this.env, workspaceId, parent?.id ?? '', name)
        if (existing) {
          if (existing.type === 'dir') {
            throw new ShellError(`${raw}: 是一个目录`)
          }
          await dbRun(this.env.DB, 'UPDATE files SET updated_at = ? WHERE id = ?', [nowIso(), existing.id])
          continue
        }
        const r2Key = await this.writeR2(workspaceId, normalized, name, '')
        await this.insertRow(workspaceId, parent?.id ?? '', name, 'file', 0, guessMime(name), r2Key)
      } catch (err) {
        if (err instanceof ShellError) {
          outputs.push(`touch: ${err.message}\n`)
          exitCode = 1
          continue
        }
        throw err
      }
    }
    return { output: outputs.join(''), exitCode }
  }

  /** rm [-r] [-f] <路径...>：删除文件或目录（目录需 -r，递归同步删 R2） */
  private async cmdRm(workspaceId: string, argv: readonly string[]): Promise<ShellResult> {
    const parsed = parseArgs(argv)
    const recursive = parsed.flags.has('-r') || parsed.flags.has('-R')
    const force = parsed.flags.has('-f')
    const operands = parsed.operands
    if (operands.length === 0) {
      throw new ShellError('缺少文件或目录参数')
    }
    const outputs: string[] = []
    let exitCode = 0

    for (const raw of operands) {
      try {
        const node = await this.resolve(workspaceId, raw)
        if (!node) {
          if (!force) {
            outputs.push(`rm: ${raw}: 不存在该文件或目录\n`)
            exitCode = 1
          }
          continue
        }
        if (node.type === 'dir' && !recursive) {
          outputs.push(`rm: ${raw}: 是一个目录（使用 -r 递归删除）\n`)
          exitCode = 1
          continue
        }
        const subtree = await collectSubtree(this.env, workspaceId, node)
        await deleteFileRows(this.env, workspaceId, subtree)
      } catch (err) {
        if (err instanceof ShellError) {
          outputs.push(`rm: ${err.message}\n`)
          exitCode = 1
          continue
        }
        throw err
      }
    }
    return { output: outputs.join(''), exitCode }
  }

  /** cp [-r] <源> <目标>：复制文件 / 目录（目录需 -r） */
  private async cmdCp(workspaceId: string, argv: readonly string[]): Promise<ShellResult> {
    const parsed = parseArgs(argv)
    const recursive = parsed.flags.has('-r') || parsed.flags.has('-R')
    const operands = parsed.operands
    if (operands.length < 2) {
      throw new ShellError('用法: cp [-r] <源> <目标>')
    }
    const srcRaw = operands[0] as string
    const dstRaw = operands[1] as string

    const src = await this.resolveRequired(workspaceId, srcRaw)
    if (!src) {
      throw new ShellError(`${srcRaw}: 不存在该文件或目录`)
    }
    if (src.type === 'dir' && !recursive) {
      throw new ShellError(`${srcRaw}: 是一个目录（使用 -r 递归复制）`)
    }

    const dst = await this.resolve(workspaceId, dstRaw)
    let dstNormalized: string
    let dstParentId: string
    let dstName: string
    if (dst && dst.type === 'dir') {
      dstParentId = dst.id
      dstName = src.name
      dstNormalized = joinNormalized(normalizePath(dstRaw), src.name)
    } else {
      if (dst) {
        throw new ShellError(`${dstRaw}: 目标已存在`)
      }
      dstNormalized = normalizePath(dstRaw)
      if (dstNormalized === '') {
        throw new ShellError(`${dstRaw}: 目标路径不能为空`)
      }
      const segments = dstNormalized.split('/')
      dstName = segments[segments.length - 1] as string
      const parentPath = segments.slice(0, -1).join('/')
      const parent = parentPath === '' ? null : await this.resolveRequired(workspaceId, parentPath)
      if (parentPath !== '' && (!parent || parent.type !== 'dir')) {
        throw new ShellError(`${dstRaw}: 目标父目录不存在`)
      }
      dstParentId = parent?.id ?? ''
    }

    await this.copyNode(workspaceId, src, dstParentId, dstNormalized, dstName)
    return this.ok('')
  }

  private async copyNode(
    workspaceId: string,
    src: VfsFileRow,
    dstParentId: string,
    dstPath: string,
    dstName: string,
  ): Promise<void> {
    const content = src.type === 'file' ? await this.readR2(src.r2_key ?? '') : ''
    const r2Key = src.type === 'file' ? await this.writeR2(workspaceId, dstPath, dstName, content) : null
    const created = await this.insertRow(
      workspaceId,
      dstParentId,
      dstName,
      src.type,
      src.type === 'file' ? byteLength(content) : 0,
      src.mime,
      r2Key,
    )
    if (src.type === 'dir') {
      const children = await listChildrenRows(this.env, workspaceId, src.id)
      for (const child of children) {
        await this.copyNode(workspaceId, child, created.id, joinNormalized(dstPath, child.name), child.name)
      }
    }
  }

  /** mv <源> <目标>：移动 / 重命名（R2 copy + delete） */
  private async cmdMv(workspaceId: string, argv: readonly string[]): Promise<ShellResult> {
    const operands = argv.slice(1).filter((a) => !a.startsWith('-') || a === '-')
    if (operands.length < 2) {
      throw new ShellError('用法: mv <源> <目标>')
    }
    const srcRaw = operands[0] as string
    const dstRaw = operands[1] as string

    const src = await this.resolveRequired(workspaceId, srcRaw)
    if (!src) {
      throw new ShellError(`${srcRaw}: 不存在该文件或目录`)
    }

    const dst = await this.resolve(workspaceId, dstRaw)
    let dstNormalized: string
    let dstParentId: string
    let dstName: string
    if (dst && dst.type === 'dir') {
      if (dst.id === src.id) {
        throw new ShellError(`${dstRaw}: 不能将目录移动到自身`)
      }
      dstParentId = dst.id
      dstName = src.name
      dstNormalized = joinNormalized(normalizePath(dstRaw), src.name)
    } else {
      if (dst) {
        throw new ShellError(`${dstRaw}: 目标已存在`)
      }
      dstNormalized = normalizePath(dstRaw)
      if (dstNormalized === '') {
        throw new ShellError(`${dstRaw}: 目标路径不能为空`)
      }
      const segments = dstNormalized.split('/')
      dstName = segments[segments.length - 1] as string
      const parentPath = segments.slice(0, -1).join('/')
      const parent = parentPath === '' ? null : await this.resolveRequired(workspaceId, parentPath)
      if (parentPath !== '' && (!parent || parent.type !== 'dir')) {
        throw new ShellError(`${dstRaw}: 目标父目录不存在`)
      }
      dstParentId = parent?.id ?? ''
    }

    await this.moveNode(workspaceId, src, srcRaw, dstParentId, dstNormalized, dstName)
    return this.ok('')
  }

  private async moveNode(
    workspaceId: string,
    src: VfsFileRow,
    srcRaw: string,
    dstParentId: string,
    dstPath: string,
    dstName: string,
  ): Promise<void> {
    const srcNormalized = normalizePath(srcRaw)
    const oldPrefix = r2KeyFor(workspaceId, srcNormalized)
    const now = nowIso()

    // 先迁移元数据，再迁移 R2 对象
    await dbRun(this.env.DB, 'UPDATE files SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?', [
      dstParentId,
      dstName,
      now,
      src.id,
    ])

    const subtree =
      src.type === 'dir' ? await collectSubtree(this.env, workspaceId, src) : [src]
    for (const row of subtree) {
      if (row.type !== 'file' || !row.r2_key) {
        continue
      }
      const newKey =
        src.type === 'file'
          ? r2KeyFor(workspaceId, dstPath)
          : r2KeyFor(workspaceId, joinNormalized(dstPath, row.r2_key.slice(oldPrefix.length + 1)))
      if (newKey === row.r2_key) {
        continue
      }
      const obj = await this.env.R2.get(row.r2_key)
      if (obj && obj.body) {
        await this.env.R2.put(newKey, obj.body, {
          httpMetadata: { contentType: obj.httpMetadata?.contentType ?? guessMime(row.name) },
        })
        await this.env.R2.delete(row.r2_key)
      }
      await dbRun(this.env.DB, 'UPDATE files SET r2_key = ?, updated_at = ? WHERE id = ?', [newKey, now, row.id])
    }
  }

  /** grep [-i] <模式> [路径...]：内容搜索；无路径时搜索整个工作区 */
  private async cmdGrep(workspaceId: string, argv: readonly string[]): Promise<ShellResult> {
    const parsed = parseArgs(argv)
    const ignoreCase = parsed.flags.has('-i')
    const operands = parsed.operands
    if (operands.length === 0) {
      throw new ShellError('用法: grep [-i] <模式> [路径...]')
    }
    const pattern = operands[0] as string
    const paths = operands.slice(1)

    let regex: RegExp | null = null
    try {
      regex = new RegExp(pattern, ignoreCase ? 'i' : '')
    } catch {
      regex = null // 非法正则退化为子串匹配
    }
    const matchesText = (text: string): boolean =>
      regex !== null ? regex.test(text) : text.toLowerCase().includes(pattern.toLowerCase())

    const targets = await this.collectFileTargets(workspaceId, paths)
    const rows = await dbAll<VfsFileRow>(this.env.DB, 'SELECT * FROM files WHERE workspace_id = ?', [workspaceId])
    const pathMap = buildPathMap(rows)

    const lines: string[] = []
    for (const target of targets) {
      const content = await this.readR2(target.r2_key ?? '')
      const all = content.split('\n')
      for (let i = 0; i < all.length; i++) {
        if (matchesText(all[i] as string)) {
          lines.push(`${pathMap.get(target.id) ?? target.name}:${i + 1}: ${all[i] as string}`)
        }
      }
    }
    if (lines.length === 0) {
      return { output: '', exitCode: 1 }
    }
    return { output: `${lines.join('\n')}\n`, exitCode: 0 }
  }

  /** 汇总 grep 目标：无路径 → 全部文件；文件 → 自身；目录 → 子树内全部文件 */
  private async collectFileTargets(
    workspaceId: string,
    paths: readonly string[],
  ): Promise<VfsFileRow[]> {
    if (paths.length === 0) {
      const rows = await dbAll<VfsFileRow>(this.env.DB, 'SELECT * FROM files WHERE workspace_id = ? AND type = ?', [
        workspaceId,
        'file',
      ])
      return rows
    }
    const targets: VfsFileRow[] = []
    for (const path of paths) {
      const node = await this.resolveRequired(workspaceId, path)
      if (!node) {
        continue
      }
      if (node.type === 'file') {
        targets.push(node)
        continue
      }
      const subtree = await collectSubtree(this.env, workspaceId, node)
      targets.push(...subtree.filter((r) => r.type === 'file'))
    }
    return targets
  }

  /** find [路径] [-name 模式] [-type f|d]：列出目录树 */
  private async cmdFind(workspaceId: string, argv: readonly string[]): Promise<ShellResult> {
    // 注意：此处不能走 parseArgs——`-name` / `-type` 是携带参数的长选项，
    // 会被通用短选项解析拆成 -n/-a/-m/-e 等 flag，导致过滤条件丢失。
    const operands = argv.slice(1)
    let namePattern: string | null = null
    let typeFilter: 'file' | 'dir' | null = null
    const rest: string[] = []
    for (let i = 0; i < operands.length; i++) {
      const op = operands[i] as string
      if (op === '-name') {
        namePattern = operands[i + 1] ?? null
        i++
        continue
      }
      if (op === '-type') {
        const t = operands[i + 1]
        typeFilter = t === 'f' ? 'file' : t === 'd' ? 'dir' : null
        i++
        continue
      }
      rest.push(op)
    }

    const startRaw = rest[0] ?? ''
    const start = await this.resolveRequired(workspaceId, startRaw)
    const rows = await dbAll<VfsFileRow>(this.env.DB, 'SELECT * FROM files WHERE workspace_id = ?', [workspaceId])
    const pathMap = buildPathMap(rows)
    const byParent = new Map<string, VfsFileRow[]>()
    for (const row of rows) {
      const list = byParent.get(row.parent_id) ?? []
      list.push(row)
      byParent.set(row.parent_id, list)
    }

    const results: string[] = []
    const walk = (node: VfsFileRow): void => {
      const path = pathMap.get(node.id) ?? node.name
      const typeOk = typeFilter === null || node.type === typeFilter
      const nameOk = namePattern === null || wildcardMatch(namePattern, node.name)
      if (typeOk && nameOk) {
        results.push(path)
      }
      if (node.type === 'dir') {
        for (const child of byParent.get(node.id) ?? []) {
          walk(child)
        }
      }
    }

    if (start) {
      walk(start)
    } else {
      for (const child of byParent.get('') ?? []) {
        walk(child)
      }
    }
    return { output: results.length > 0 ? `${results.join('\n')}\n` : '', exitCode: 0 }
  }

  /** head [-n N] <文件...> / tail [-n N] <文件...> */
  private async cmdHeadTail(
    workspaceId: string,
    argv: readonly string[],
    mode: 'head' | 'tail',
  ): Promise<ShellResult> {
    const parsed = parseArgs(argv)
    const count = parsed.numeric !== null && parsed.numeric > 0 ? parsed.numeric : 10
    const operands = parsed.operands
    if (operands.length === 0) {
      throw new ShellError('缺少文件参数')
    }
    const parts: string[] = []
    let exitCode = 0
    for (const raw of operands) {
      const node = await this.resolveRequired(workspaceId, raw)
      if (!node || node.type !== 'file') {
        parts.push(`${mode}: ${raw}: 不是常规文件\n`)
        exitCode = 1
        continue
      }
      const content = await this.readR2(node.r2_key ?? '')
      const lines = content.split('\n')
      // 末尾换行造成的空行不计入统计
      const effective = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
      const picked =
        mode === 'head'
          ? effective.slice(0, count)
          : effective.slice(Math.max(0, effective.length - count))
      parts.push(picked.join('\n') + (picked.length > 0 ? '\n' : ''))
    }
    return { output: parts.join(''), exitCode }
  }

  /** wc [-l] [-w] [-c] <文件...>：统计行数 / 单词数 / 字符数 */
  private async cmdWc(workspaceId: string, argv: readonly string[]): Promise<ShellResult> {
    const parsed = parseArgs(argv)
    const operands = parsed.operands
    if (operands.length === 0) {
      throw new ShellError('缺少文件参数')
    }
    const wantLines = parsed.flags.has('-l')
    const wantWords = parsed.flags.has('-w')
    const wantChars = parsed.flags.has('-c')
    const showAll = !wantLines && !wantWords && !wantChars

    const outLines: string[] = []
    let exitCode = 0
    let totalLines = 0
    let totalWords = 0
    let totalChars = 0

    for (const raw of operands) {
      const node = await this.resolveRequired(workspaceId, raw)
      if (!node || node.type !== 'file') {
        outLines.push(`wc: ${raw}: 不是常规文件`)
        exitCode = 1
        continue
      }
      const content = await this.readR2(node.r2_key ?? '')
      const lineCount = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
      const wordCount = content.split(/\s+/).filter((w) => w !== '').length
      const charCount = byteLength(content)
      totalLines += lineCount
      totalWords += wordCount
      totalChars += charCount
      const cols: number[] = []
      if (showAll || wantLines) {
        cols.push(lineCount)
      }
      if (showAll || wantWords) {
        cols.push(wordCount)
      }
      if (showAll || wantChars) {
        cols.push(charCount)
      }
      outLines.push(`${cols.join(' ')} ${raw}`)
    }
    if (operands.length > 1) {
      outLines.push(`${totalLines} ${totalWords} ${totalChars} total`)
    }
    return { output: `${outLines.join('\n')}\n`, exitCode }
  }

  private helpText(): string {
    const commands = SHELL_WHITELIST.map((cmd) => `  ${cmd}`).join('\n')
    return [
      '渡劫code 虚拟 Shell（白名单命令，作用于工作区虚拟文件系统）：',
      commands,
      '说明：命令经分词后解释执行，不支持管道、重定向与通配符展开；路径相对工作区根目录。',
    ].join('\n') + '\n'
  }
}

/** echo 文本拼接：支持 -n 抑制末尾换行 */
function echoText(argv: readonly string[]): string {
  const rest = argv.slice(1)
  const suppressNewline = rest[0] === '-n'
  const words = suppressNewline ? rest.slice(1) : rest
  return `${words.join(' ')}${suppressNewline ? '' : '\n'}`
}
