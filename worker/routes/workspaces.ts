/**
 * 工作区与文件路由（架构文档 §5.2「工作区与文件」端点表 / §4.2 R2 Key 规范）。
 *
 * 本文件同时承担 FileService 职责（§13.4 类图）：目录树 / 内容读写（R2）/
 * 新建 / 重命名 / 删除 / 搜索的纯 IO 实现，供 agent/tools.ts 与
 * routes/shell.ts 复用，避免跨模块重复实现。
 *
 * R2 Key 规范：`ws/{workspaceId}/{normalizedPath}`；删除工作区时按前缀分页列举删除。
 * 归属校验：全部查询强制 user_id 过滤（§12-D10，越权返回 403 FORBIDDEN）。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { FileNode, Workspace, WorkspaceSummary } from '@shared/types'
import { ID_PREFIX } from '@shared/constants'
import { dbAll, dbFirst, dbRun, httpError, isUniqueConstraintError, newId, nowIso } from '../lib/core'
import type { AppEnv, Env } from '../types'
import {
  VfsPathError,
  buildPathMap,
  byteLength,
  collectSubtree,
  deleteFileRows,
  findChild,
  guessMime,
  joinNormalized,
  normalizePath,
  r2KeyFor,
  type VfsFileRow,
} from '../vfs/shell'

/* ------------------------------------------------------------------ */
/* 行模型与视图转换                                                     */
/* ------------------------------------------------------------------ */

/** workspaces 表原始行 */
export interface WorkspaceRow {
  id: string
  user_id: string
  name: string
  description: string
  default_backend: string
  created_at: string
  updated_at: string
}

/** providers 表原始行（ conversations 路由复用） */
export interface ProviderRow {
  id: string
  user_id: string
  name: string
  protocol: string
  base_url: string
  api_key_enc: string
  default_model: string
  models_cache: string
  models_cached_at: string | null
  enabled: number
  created_at: string
  updated_at: string
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultBackend: row.default_backend,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toFileNode(row: VfsFileRow): FileNode {
  if (row.type === 'dir') {
    return { id: row.id, name: row.name, type: 'dir' }
  }
  return { id: row.id, name: row.name, type: 'file', size: row.size }
}

/* ------------------------------------------------------------------ */
/* 请求解析助手（路由模块共享；auth.ts 内的同名助手为私有副本，不导出）    */
/* ------------------------------------------------------------------ */

/** 解析并校验 JSON 对象请求体，非法一律 400 VALIDATION_ERROR */
export async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await c.req.json()
  } catch {
    throw httpError('VALIDATION_ERROR', '请求体不是合法的 JSON', 400)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw httpError('VALIDATION_ERROR', '请求体必须是 JSON 对象', 400)
  }
  return parsed as Record<string, unknown>
}

/** 读取必填字符串字段（空串 / 非字符串视为缺失） */
export function requiredString(body: Record<string, unknown>, key: string, label: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError('VALIDATION_ERROR', `${label}不能为空`, 400)
  }
  return value
}

/** 读取可选字符串字段（缺失 / 非字符串返回 undefined） */
export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

/* ------------------------------------------------------------------ */
/* 归属校验                                                             */
/* ------------------------------------------------------------------ */

/**
 * 加载工作区并校验归属：不存在 → 404；不属于当前用户 → 403（§12-D10）。
 */
export async function requireWorkspace(c: Context<AppEnv>, workspaceId: string): Promise<WorkspaceRow> {
  if (workspaceId === '') {
    throw httpError('VALIDATION_ERROR', '缺少工作区 ID', 400)
  }
  const row = await dbFirst<WorkspaceRow>(c.env.DB, 'SELECT * FROM workspaces WHERE id = ?', [workspaceId])
  if (!row) {
    throw httpError('NOT_FOUND', '工作区不存在', 404)
  }
  if (row.user_id !== c.get('userId')) {
    throw httpError('FORBIDDEN', '无权访问该工作区', 403)
  }
  return row
}

/** 路径规范化（路由版）：越界路径转换为 400 VALIDATION_ERROR */
function safeNormalize(path: string): string {
  try {
    return normalizePath(path)
  } catch {
    throw httpError('VALIDATION_ERROR', '路径非法：不允许越出工作区根目录', 400)
  }
}

/* ------------------------------------------------------------------ */
/* FileService：路径解析与内容读写                                      */
/* ------------------------------------------------------------------ */

/** 按路径解析文件节点；空路径返回 null（根目录） */
export async function resolvePathNode(
  env: Env,
  workspaceId: string,
  path: string,
): Promise<VfsFileRow | null> {
  const normalized = normalizePath(path)
  if (normalized === '') {
    return null
  }
  let parentId = ''
  let node: VfsFileRow | null = null
  for (const segment of normalized.split('/')) {
    node = await findChild(env, workspaceId, parentId, segment)
    if (!node) {
      return null
    }
    parentId = node.id
  }
  return node
}

/** 解析路径的父节点（父目录必须存在且为目录） */
async function resolveParent(
  env: Env,
  workspaceId: string,
  normalized: string,
): Promise<VfsFileRow | null> {
  const parentPath = normalized.split('/').slice(0, -1).join('/')
  if (parentPath === '') {
    return null
  }
  const parent = await resolvePathNode(env, workspaceId, parentPath)
  if (!parent || parent.type !== 'dir') {
    throw httpError('NOT_FOUND', '父目录不存在', 404)
  }
  return parent
}

/** 读取文件内容（D1 元数据 + R2 对象）；文件不存在返回 null */
export async function readWorkspaceFile(
  env: Env,
  workspaceId: string,
  path: string,
): Promise<{ content: string; size: number; mime: string } | null> {
  const node = await resolvePathNode(env, workspaceId, path)
  if (!node || node.type !== 'file' || !node.r2_key) {
    return null
  }
  const obj = await env.R2.get(node.r2_key)
  if (!obj) {
    return null
  }
  const content = await obj.text()
  return { content, size: node.size, mime: node.mime }
}

/** 写入文件内容（R2 put + D1 upsert），返回最新节点行 */
export async function writeWorkspaceFile(
  env: Env,
  workspaceId: string,
  path: string,
  content: string,
): Promise<VfsFileRow> {
  const normalized = safeNormalize(path)
  if (normalized === '') {
    throw httpError('VALIDATION_ERROR', '路径不能为空', 400)
  }
  const parent = await resolveParent(env, workspaceId, normalized)
  const name = normalized.split('/').pop() as string
  const existing = await findChild(env, workspaceId, parent?.id ?? '', name)
  if (existing && existing.type === 'dir') {
    throw httpError('NAME_TAKEN', '同名目录已存在', 409)
  }

  const size = byteLength(content)
  const mime = guessMime(name)
  const r2Key = r2KeyFor(workspaceId, normalized)
  const now = nowIso()
  await env.R2.put(r2Key, content, { httpMetadata: { contentType: mime } })

  if (existing) {
    await dbRun(env.DB, 'UPDATE files SET size = ?, mime = ?, r2_key = ?, updated_at = ? WHERE id = ?', [
      size,
      mime,
      r2Key,
      now,
      existing.id,
    ])
    return { ...existing, size, mime, r2_key: r2Key, updated_at: now }
  }

  const row: VfsFileRow = {
    id: newId(ID_PREFIX.file),
    workspace_id: workspaceId,
    parent_id: parent?.id ?? '',
    name,
    type: 'file',
    size,
    mime,
    r2_key: r2Key,
    created_at: now,
    updated_at: now,
  }
  await dbRun(
    env.DB,
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

/** 创建目录（语义同 mkdir -p：自动补齐缺失父目录）；已存在返回 409 */
export async function createDirectory(env: Env, workspaceId: string, path: string): Promise<VfsFileRow> {
  const normalized = safeNormalize(path)
  if (normalized === '') {
    throw httpError('VALIDATION_ERROR', '路径不能为空', 400)
  }
  const segments = normalized.split('/')
  let parentId = ''
  let last: VfsFileRow | null = null
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string
    const existing = await findChild(env, workspaceId, parentId, segment)
    if (existing) {
      if (i === segments.length - 1) {
        throw httpError('NAME_TAKEN', '同名文件或目录已存在', 409)
      }
      if (existing.type === 'file') {
        throw httpError('VALIDATION_ERROR', `路径中的 ${segment} 是文件，无法作为目录`, 400)
      }
      parentId = existing.id
      last = existing
      continue
    }
    const now = nowIso()
    const row: VfsFileRow = {
      id: newId(ID_PREFIX.file),
      workspace_id: workspaceId,
      parent_id: parentId,
      name: segment,
      type: 'dir',
      size: 0,
      mime: '',
      r2_key: null,
      created_at: now,
      updated_at: now,
    }
    await dbRun(
      env.DB,
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
    parentId = row.id
    last = row
  }
  if (!last) {
    throw httpError('INTERNAL', '目录创建失败', 500)
  }
  return last
}

/** 递归删除节点（目录）：同步删除 R2 对象与 D1 行 */
export async function deleteNode(env: Env, workspaceId: string, path: string): Promise<void> {
  const normalized = safeNormalize(path)
  if (normalized === '') {
    throw httpError('VALIDATION_ERROR', '根目录不可删除', 400)
  }
  const node = await resolvePathNode(env, workspaceId, normalized)
  if (!node) {
    throw httpError('NOT_FOUND', '路径不存在', 404)
  }
  const subtree = await collectSubtree(env, workspaceId, node)
  await deleteFileRows(env, workspaceId, subtree)
}

/** 重命名 / 移动节点（R2 copy + delete），返回新节点 */
export async function renameNode(
  env: Env,
  workspaceId: string,
  fromPath: string,
  toPath: string,
): Promise<VfsFileRow> {
  const fromNorm = safeNormalize(fromPath)
  const toNorm = safeNormalize(toPath)
  if (fromNorm === '' || toNorm === '') {
    throw httpError('VALIDATION_ERROR', '源路径与目标路径不能为空', 400)
  }
  const src = await resolvePathNode(env, workspaceId, fromNorm)
  if (!src) {
    throw httpError('NOT_FOUND', '源路径不存在', 404)
  }
  if (await resolvePathNode(env, workspaceId, toNorm)) {
    throw httpError('NAME_TAKEN', '目标路径已存在', 409)
  }
  const parent = await resolveParent(env, workspaceId, toNorm)
  const toName = toNorm.split('/').pop() as string
  const now = nowIso()

  // 先迁移元数据，再迁移 R2 对象
  await dbRun(env.DB, 'UPDATE files SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?', [
    parent?.id ?? '',
    toName,
    now,
    src.id,
  ])

  const oldPrefix = r2KeyFor(workspaceId, fromNorm)
  const subtree = src.type === 'dir' ? await collectSubtree(env, workspaceId, src) : [src]
  for (const row of subtree) {
    if (row.type !== 'file' || !row.r2_key) {
      continue
    }
    const newKey =
      src.type === 'file'
        ? r2KeyFor(workspaceId, toNorm)
        : r2KeyFor(workspaceId, joinNormalized(toNorm, row.r2_key.slice(oldPrefix.length + 1)))
    if (newKey === row.r2_key) {
      continue
    }
    const obj = await env.R2.get(row.r2_key)
    if (obj && obj.body) {
      await env.R2.put(newKey, obj.body, {
        httpMetadata: { contentType: obj.httpMetadata?.contentType ?? guessMime(row.name) },
      })
      await env.R2.delete(row.r2_key)
    }
    await dbRun(env.DB, 'UPDATE files SET r2_key = ?, updated_at = ? WHERE id = ?', [newKey, now, row.id])
  }

  const moved = await resolvePathNode(env, workspaceId, toNorm)
  if (!moved) {
    throw httpError('INTERNAL', '重命名后节点读取失败', 500)
  }
  return moved
}

/** 构建工作区文件树（根节点为工作区自身） */
export async function getWorkspaceTree(env: Env, workspaceId: string, name: string): Promise<FileNode> {
  const rows = await dbAll<VfsFileRow>(
    env.DB,
    'SELECT id, parent_id, name, type, size FROM files WHERE workspace_id = ?',
    [workspaceId],
  )
  const byParent = new Map<string, VfsFileRow[]>()
  for (const row of rows) {
    const list = byParent.get(row.parent_id) ?? []
    list.push(row)
    byParent.set(row.parent_id, list)
  }
  const build = (parentId: string): FileNode[] =>
    (byParent.get(parentId) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) =>
        row.type === 'dir'
          ? { id: row.id, name: row.name, type: 'dir' as const, children: build(row.id) }
          : { id: row.id, name: row.name, type: 'file' as const, size: row.size },
      )
  return { id: workspaceId, name, type: 'dir', children: build('') }
}

/** 搜索选项 */
export interface SearchOptions {
  /** 限定搜索目录（默认整个工作区） */
  path?: string
  /** 是否搜索文件内容（默认 true；false 时仅匹配文件名） */
  content?: boolean
  /** 结果上限（默认 50，最大 100） */
  limit?: number
}

/** 搜索结果（path 为工作区相对路径；内容匹配携带行号与摘要） */
export interface SearchMatch {
  path: string
  line?: number
  snippet?: string
}

/**
 * 搜索：先按文件名（大小写不敏感子串），再按文件内容（grep 语义）。
 * 内容搜索最多扫描 100 个文件、单文件超过 512KB 跳过，控制 R2 读取成本。
 */
export async function searchWorkspace(
  env: Env,
  workspaceId: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchMatch[]> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50))
  const searchContent = options.content !== false
  const basePath = safeNormalize(options.path ?? '')

  const rows = await dbAll<VfsFileRow>(env.DB, 'SELECT * FROM files WHERE workspace_id = ?', [workspaceId])
  const pathMap = buildPathMap(rows)
  const lower = query.toLowerCase()
  const matches: SearchMatch[] = []

  // 1) 文件名匹配（文件与目录）
  for (const row of rows) {
    if (matches.length >= limit) {
      break
    }
    if (row.name.toLowerCase().includes(lower)) {
      matches.push({ path: pathMap.get(row.id) ?? row.name })
    }
  }

  // 2) 内容匹配
  if (searchContent && matches.length < limit) {
    const candidates = rows.filter((row) => {
      if (row.type !== 'file' || !row.r2_key) {
        return false
      }
      if (basePath === '') {
        return true
      }
      const path = pathMap.get(row.id) ?? ''
      return path === basePath || path.startsWith(`${basePath}/`)
    })
    for (const row of candidates.slice(0, 100)) {
      if (matches.length >= limit) {
        break
      }
      if (row.size > 512 * 1024) {
        continue
      }
      const obj = await env.R2.get(row.r2_key as string)
      if (!obj) {
        continue
      }
      const content = await obj.text()
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= limit) {
          break
        }
        const line = lines[i] as string
        if (line.toLowerCase().includes(lower)) {
          matches.push({
            path: pathMap.get(row.id) ?? row.name,
            line: i + 1,
            snippet: line.trim().slice(0, 120),
          })
        }
      }
    }
  }
  return matches
}

/** 按 R2 前缀分页列举删除工作区全部对象（§4.2 删除语义） */
async function deleteWorkspaceObjects(env: Env, workspaceId: string): Promise<void> {
  const prefix = `ws/${workspaceId}/`
  let cursor: string | undefined
  do {
    const listed = await env.R2.list({ prefix, limit: 500, cursor })
    if (listed.objects.length > 0) {
      await env.R2.delete(listed.objects.map((obj) => obj.key))
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor !== undefined)
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

const workspaceRoutes = new Hono<AppEnv>()

/** GET /api/workspaces —— 200 {workspaces:[{id,name,fileCount,updatedAt}]} */
workspaceRoutes.get('/', async (c) => {
  const rows = await dbAll<WorkspaceRow & { file_count: number }>(
    c.env.DB,
    "SELECT w.*, (SELECT COUNT(*) FROM files f WHERE f.workspace_id = w.id AND f.type = 'file') AS file_count FROM workspaces w WHERE w.user_id = ? ORDER BY w.updated_at DESC",
    [c.get('userId')],
  )
  const workspaces: WorkspaceSummary[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    fileCount: Number(row.file_count ?? 0),
    updatedAt: row.updated_at,
  }))
  return c.json({ workspaces }, 200)
})

/** POST /api/workspaces —— 201 {workspace}；409 NAME_TAKEN */
workspaceRoutes.post('/', async (c) => {
  const body = await readJsonObject(c)
  const name = requiredString(body, 'name', '工作区名称').slice(0, 80)
  const description = optionalString(body, 'description')?.slice(0, 500) ?? ''

  const now = nowIso()
  const row: WorkspaceRow = {
    id: newId(ID_PREFIX.workspace),
    user_id: c.get('userId'),
    name,
    description,
    default_backend: 'vfs',
    created_at: now,
    updated_at: now,
  }
  try {
    await dbRun(
      c.env.DB,
      'INSERT INTO workspaces (id, user_id, name, description, default_backend, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.user_id, row.name, row.description, row.default_backend, row.created_at, row.updated_at],
    )
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw httpError('NAME_TAKEN', '同名工作区已存在', 409)
    }
    throw err
  }
  return c.json({ workspace: toWorkspace(row) }, 201)
})

/** GET /api/workspaces/:id —— 200 {workspace, tree:FileNode} */
workspaceRoutes.get('/:id', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const tree = await getWorkspaceTree(c.env, ws.id, ws.name)
  return c.json({ workspace: toWorkspace(ws), tree }, 200)
})

/** PATCH /api/workspaces/:id —— 200 {workspace} */
workspaceRoutes.patch('/:id', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const body = await readJsonObject(c)

  const name = optionalString(body, 'name')?.slice(0, 80) ?? ws.name
  const description = optionalString(body, 'description')?.slice(0, 500) ?? ws.description
  const defaultBackend = optionalString(body, 'defaultBackend') ?? ws.default_backend

  try {
    await dbRun(
      c.env.DB,
      'UPDATE workspaces SET name = ?, description = ?, default_backend = ?, updated_at = ? WHERE id = ?',
      [name, description, defaultBackend, nowIso(), ws.id],
    )
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw httpError('NAME_TAKEN', '同名工作区已存在', 409)
    }
    throw err
  }
  const updated = await dbFirst<WorkspaceRow>(c.env.DB, 'SELECT * FROM workspaces WHERE id = ?', [ws.id])
  if (!updated) {
    throw httpError('NOT_FOUND', '工作区不存在', 404)
  }
  return c.json({ workspace: toWorkspace(updated) }, 200)
})

/** DELETE /api/workspaces/:id —— 204（级联删 D1 元数据 + R2 前缀对象） */
workspaceRoutes.delete('/:id', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  // 显式级联删除（不依赖 D1 外键开关，保证删除彻底）
  await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = ?)',
    ).bind(ws.id),
    c.env.DB.prepare(
      'DELETE FROM approvals WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = ?)',
    ).bind(ws.id),
    c.env.DB.prepare('DELETE FROM conversations WHERE workspace_id = ?').bind(ws.id),
    c.env.DB.prepare('DELETE FROM files WHERE workspace_id = ?').bind(ws.id),
    c.env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(ws.id),
  ])
  await deleteWorkspaceObjects(c.env, ws.id)
  return c.body(null, 204)
})

/** POST /api/workspaces/:id/files —— 201 {node} */
workspaceRoutes.post('/:id/files', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const body = await readJsonObject(c)
  const path = requiredString(body, 'path', '路径')
  const rawType = body.type
  if (rawType !== 'file' && rawType !== 'dir') {
    throw httpError('VALIDATION_ERROR', "type 必须为 'file' 或 'dir'", 400)
  }
  const content = optionalString(body, 'content') ?? ''

  const node =
    rawType === 'dir'
      ? await createDirectory(c.env, ws.id, path)
      : await writeWorkspaceFile(c.env, ws.id, path, content)
  return c.json({ node: toFileNode(node) }, 201)
})

/** GET /api/workspaces/:id/files?path= —— 200 {node, children?} */
workspaceRoutes.get('/:id/files', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const path = c.req.query('path') ?? ''
  if (path === '') {
    const children = await dbAll<VfsFileRow>(
      c.env.DB,
      'SELECT * FROM files WHERE workspace_id = ? AND parent_id = ? ORDER BY name',
      [ws.id, ''],
    )
    return c.json(
      { node: { id: ws.id, name: ws.name, type: 'dir' as const }, children: children.map(toFileNode) },
      200,
    )
  }
  const node = await resolvePathNode(c.env, ws.id, path)
  if (!node) {
    throw httpError('NOT_FOUND', '路径不存在', 404)
  }
  if (node.type === 'dir') {
    const children = await dbAll<VfsFileRow>(
      c.env.DB,
      'SELECT * FROM files WHERE workspace_id = ? AND parent_id = ? ORDER BY name',
      [ws.id, node.id],
    )
    return c.json({ node: toFileNode(node), children: children.map(toFileNode) }, 200)
  }
  return c.json({ node: toFileNode(node) }, 200)
})

/** GET /api/workspaces/:id/files/content?path= —— 200 {content, size, mime} */
workspaceRoutes.get('/:id/files/content', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const path = c.req.query('path') ?? ''
  if (path === '') {
    throw httpError('VALIDATION_ERROR', '缺少 path 参数', 400)
  }
  const file = await readWorkspaceFile(c.env, ws.id, path)
  if (!file) {
    throw httpError('NOT_FOUND', '文件不存在', 404)
  }
  return c.json({ content: file.content, size: file.size, mime: file.mime }, 200)
})

/** PUT /api/workspaces/:id/files/content —— 200 {node}（写 R2 + 更新 size/updated_at） */
workspaceRoutes.put('/:id/files/content', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const body = await readJsonObject(c)
  const path = requiredString(body, 'path', '路径')
  const content = body.content
  if (typeof content !== 'string') {
    throw httpError('VALIDATION_ERROR', '缺少 content 字段', 400)
  }
  const node = await writeWorkspaceFile(c.env, ws.id, path, content)
  return c.json({ node: toFileNode(node) }, 200)
})

/** DELETE /api/workspaces/:id/files?path= —— 204（目录递归） */
workspaceRoutes.delete('/:id/files', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const path = c.req.query('path') ?? ''
  if (path === '') {
    throw httpError('VALIDATION_ERROR', '缺少 path 参数', 400)
  }
  await deleteNode(c.env, ws.id, path)
  return c.body(null, 204)
})

/** POST /api/workspaces/:id/files/rename —— 200 {node}（R2 copy+delete） */
workspaceRoutes.post('/:id/files/rename', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const body = await readJsonObject(c)
  const path = requiredString(body, 'path', '原路径')
  const newPath = requiredString(body, 'newPath', '新路径')
  const node = await renameNode(c.env, ws.id, path, newPath)
  return c.json({ node: toFileNode(node) }, 200)
})

/** GET /api/workspaces/:id/files/search?q= —— 200 {matches:[{path,line?,snippet?}]} */
workspaceRoutes.get('/:id/files/search', async (c) => {
  const ws = await requireWorkspace(c, c.req.param('id'))
  const query = (c.req.query('q') ?? '').trim()
  if (query === '') {
    throw httpError('VALIDATION_ERROR', '缺少搜索关键字 q', 400)
  }
  const matches = await searchWorkspace(c.env, ws.id, query, {})
  return c.json({ matches }, 200)
})

export default workspaceRoutes
