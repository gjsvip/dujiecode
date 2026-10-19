/**
 * 工作区状态 Store（架构文档 §3.3 #16 / §6.3 workspace 行）。
 *
 * 状态：workspaces / currentId / current / tree / tabs / activeTab /
 *       toasts / pendingApprovalCount / searchResults；
 * action：loadWorkspaces / createWorkspace / loadWorkspace / loadTree /
 *         createNode / renameNode / deleteNode / openFile / closeTab /
 *         setActiveTab / updateTabContent / saveFile / searchFiles /
 *         pushToast / dismissToast / setPendingApprovalCount /
 *         requestApprovalFocus。
 *
 * API 路径严格按 §5.2「工作区与文件」端点表；错误经 api.ts 归一化为
 * ApiError（§5.1），mutations 失败时 toast 提示并向上抛出，由调用方
 * （FileTree / EditorPane）决定如何复位本地编辑态。
 */
import { create } from 'zustand'
import { ApiError, api } from '../api'
import type { FileNode, Workspace, WorkspaceSummary } from '@shared/types'

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

/** 编辑器 Tab（§6.3 tabs[]；dirty 由 content 与 savedContent 比较得出） */
export interface EditorTab {
  /** 工作区相对路径（Tab 唯一键） */
  path: string
  /** 文件名（路径末段） */
  name: string
  /** 当前编辑内容 */
  content: string
  /** 最近一次保存（或打开）时的内容，用于 dirty 判定 */
  savedContent: string
  dirty: boolean
  /** 内容加载中（打开文件时） */
  loading: boolean
  error: string | null
  /** Monaco 语言 ID（按扩展名识别） */
  language: string
}

/** 轻提示（§6.3 toasts[]；约 3.2s 自动消失） */
export interface Toast {
  id: string
  kind: 'ok' | 'err'
  text: string
}

/** 搜索结果条目（GET /api/workspaces/:id/files/search） */
export interface SearchMatch {
  path: string
  line?: number
  snippet?: string
}

/** 扩展名 → Monaco 语言 ID 映射（§3.3 #26 语言识别） */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  pyw: 'python',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  txt: 'plaintext',
  log: 'plaintext',
  env: 'plaintext',
}

/** 按扩展名识别 Monaco 语言（未知扩展名回落 plaintext） */
export function languageOf(fileName: string): string {
  const lower = fileName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot === -1 ? lower : lower.slice(dot + 1)
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}

/** 路径末段（文件名）；空路径时回落原值 */
function baseName(path: string): string {
  const seg = path.split('/').pop()
  return seg !== undefined && seg !== '' ? seg : path
}

/** 路径的父目录（根目录为 ''） */
function parentPath(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

/** toast 自增 ID（模块级，避免与消息 ID 混淆） */
let toastSeq = 0

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/** 工作区 Store 状态与动作（§6.3） */
export interface WorkspaceState {
  /** 工作区摘要列表（GET /api/workspaces） */
  workspaces: WorkspaceSummary[]
  /** 当前工作区 ID（与路由 /w/:workspaceId 同步） */
  currentId: string | null
  /** 当前工作区完整实体（GET /api/workspaces/:id） */
  current: Workspace | null
  /** 文件树根节点（GET /api/workspaces/:id 的 tree） */
  tree: FileNode | null
  /** 工作区加载 / 错误态 */
  loading: boolean
  error: string | null
  /** 编辑器 Tab 列表与当前激活 Tab（path） */
  tabs: EditorTab[]
  activeTab: string | null
  /** 轻提示队列 */
  toasts: Toast[]
  /** 待处理审批计数（chat store 经 SSE 同步；Layout 铃铛读取，§6.3） */
  pendingApprovalCount: number
  /** 审批聚焦序号（顶栏铃铛点击后自增，ChatPanel 监听并滚动到审批卡片） */
  approvalFocusSeq: number
  /** 搜索结果与搜索态 */
  searchResults: SearchMatch[]
  searching: boolean

  /** GET /api/workspaces */
  loadWorkspaces: () => Promise<void>
  /** POST /api/workspaces；返回完整工作区实体 */
  createWorkspace: (name: string, description?: string) => Promise<Workspace>
  /** GET /api/workspaces/:id（workspace + tree）；切换工作区时重置 Tab */
  loadWorkspace: (id: string) => Promise<void>
  /** 重新拉取当前工作区的树（保存文件后刷新 size 等） */
  loadTree: () => Promise<void>
  /** POST /api/workspaces/:id/files（新建文件 / 目录） */
  createNode: (path: string, type: 'file' | 'dir', content?: string) => Promise<void>
  /** POST /api/workspaces/:id/files/rename（重命名 / 移动） */
  renameNode: (path: string, newPath: string) => Promise<void>
  /** DELETE /api/workspaces/:id/files?path=（目录递归） */
  deleteNode: (path: string) => Promise<void>
  /** 打开文件编辑器 Tab（GET files/content；已打开则仅激活） */
  openFile: (path: string) => Promise<void>
  /** 关闭 Tab（dirty 时由 EditorPane 弹确认，不在此处拦截） */
  closeTab: (path: string) => void
  /** 激活 Tab */
  setActiveTab: (path: string) => void
  /** 更新 Tab 内容并重算 dirty */
  updateTabContent: (path: string, content: string) => void
  /** PUT files/content 保存（写 R2 + 更新 size/updated_at） */
  saveFile: (path: string) => Promise<void>
  /** GET files/search?q= */
  searchFiles: (query: string) => Promise<void>
  /** 清空搜索结果 */
  clearSearch: () => void
  /** 弹出轻提示（自动消失） */
  pushToast: (kind: 'ok' | 'err', text: string) => void
  /** 手动关闭轻提示 */
  dismissToast: (id: string) => void
  /** 设置待处理审批计数（chat store 调用） */
  setPendingApprovalCount: (count: number) => void
  /** 请求聚焦审批卡片（顶栏铃铛调用） */
  requestApprovalFocus: () => void
}

/** 工作区 Store（§6.3：WorkspaceStore --> ApiClient） */
export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  currentId: null,
  current: null,
  tree: null,
  loading: false,
  error: null,
  tabs: [],
  activeTab: null,
  toasts: [],
  pendingApprovalCount: 0,
  approvalFocusSeq: 0,
  searchResults: [],
  searching: false,

  loadWorkspaces: async () => {
    try {
      const res = await api.get<{ workspaces: WorkspaceSummary[] }>('/api/workspaces')
      set({ workspaces: res.workspaces })
    } catch (err) {
      get().pushToast('err', err instanceof ApiError ? err.message : '工作区列表加载失败')
    }
  },

  createWorkspace: async (name: string, description?: string) => {
    const res = await api.post<{ workspace: Workspace }>('/api/workspaces', {
      name: name.trim(),
      description: description?.trim() || undefined,
    })
    // POST 返回完整 Workspace，列表项需要 WorkspaceSummary（新工作区无文件）
    const summary: WorkspaceSummary = {
      id: res.workspace.id,
      name: res.workspace.name,
      fileCount: 0,
      updatedAt: res.workspace.updatedAt,
    }
    set({ workspaces: [summary, ...get().workspaces.filter((w) => w.id !== summary.id)] })
    return res.workspace
  },

  loadWorkspace: async (id: string) => {
    set({ loading: true, error: null, currentId: id, tabs: [], activeTab: null })
    try {
      const res = await api.get<{ workspace: Workspace; tree: FileNode }>(`/api/workspaces/${id}`)
      // 防御：加载期间用户可能已切换到其他工作区
      if (get().currentId !== id) {
        return
      }
      set({ current: res.workspace, tree: res.tree, loading: false })
    } catch (err) {
      if (get().currentId !== id) {
        return
      }
      set({
        loading: false,
        error: err instanceof ApiError ? err.message : '工作区加载失败',
      })
    }
  },

  loadTree: async () => {
    const id = get().currentId
    if (id === null) {
      return
    }
    try {
      const res = await api.get<{ workspace: Workspace; tree: FileNode }>(`/api/workspaces/${id}`)
      if (get().currentId !== id) {
        return
      }
      set({ current: res.workspace, tree: res.tree })
    } catch {
      // 树刷新失败不打断用户操作（如保存后的静默刷新）
    }
  },

  createNode: async (path: string, type: 'file' | 'dir', content?: string) => {
    const id = get().currentId
    if (id === null) {
      get().pushToast('err', '尚未打开工作区')
      return
    }
    try {
      await api.post(`/api/workspaces/${id}/files`, { path, type, content })
      await get().loadTree()
    } catch (err) {
      get().pushToast('err', err instanceof ApiError ? err.message : '创建失败')
      throw err
    }
  },

  renameNode: async (path: string, newPath: string) => {
    const id = get().currentId
    if (id === null) {
      get().pushToast('err', '尚未打开工作区')
      return
    }
    try {
      await api.post(`/api/workspaces/${id}/files/rename`, { path, newPath })
      // 同步已打开 Tab 的路径（目录重命名时按前缀迁移）
      set({
        tabs: get().tabs.map((tab) =>
          tab.path === path || tab.path.startsWith(`${path}/`)
            ? { ...tab, path: newPath + tab.path.slice(path.length), name: baseName(tab.path) }
            : tab,
        ),
      })
      await get().loadTree()
    } catch (err) {
      get().pushToast('err', err instanceof ApiError ? err.message : '重命名失败')
      throw err
    }
  },

  deleteNode: async (path: string) => {
    const id = get().currentId
    if (id === null) {
      get().pushToast('err', '尚未打开工作区')
      return
    }
    try {
      await api.del(`/api/workspaces/${id}/files?path=${encodeURIComponent(path)}`)
      // 关闭被删路径下的全部 Tab
      const activeTab = get().activeTab
      set({
        tabs: get().tabs.filter((tab) => tab.path !== path && !tab.path.startsWith(`${path}/`)),
        activeTab:
          activeTab !== null &&
          (activeTab === path || activeTab.startsWith(`${path}/`))
            ? (get().tabs.find((tab) => tab.path !== path && !tab.path.startsWith(`${path}/`))?.path ?? null)
            : activeTab,
      })
      await get().loadTree()
    } catch (err) {
      get().pushToast('err', err instanceof ApiError ? err.message : '删除失败')
      throw err
    }
  },

  openFile: async (path: string) => {
    const id = get().currentId
    if (id === null) {
      get().pushToast('err', '尚未打开工作区')
      return
    }
    const existing = get().tabs.find((tab) => tab.path === path)
    if (existing) {
      set({ activeTab: path })
      return
    }
    const name = baseName(path)
    const tab: EditorTab = {
      path,
      name,
      content: '',
      savedContent: '',
      dirty: false,
      loading: true,
      error: null,
      language: languageOf(name),
    }
    set({ tabs: [...get().tabs, tab], activeTab: path })
    try {
      const res = await api.get<{ content: string; size: number; mime: string }>(
        `/api/workspaces/${id}/files/content?path=${encodeURIComponent(path)}`,
      )
      set({
        tabs: get().tabs.map((t) =>
          t.path === path
            ? { ...t, content: res.content, savedContent: res.content, loading: false }
            : t,
        ),
      })
    } catch (err) {
      set({
        tabs: get().tabs.map((t) =>
          t.path === path
            ? { ...t, loading: false, error: err instanceof ApiError ? err.message : '文件打开失败' }
            : t,
        ),
      })
    }
  },

  closeTab: (path: string) => {
    const tabs = get().tabs.filter((tab) => tab.path !== path)
    const activeTab =
      get().activeTab === path ? (tabs[tabs.length - 1]?.path ?? null) : get().activeTab
    set({ tabs, activeTab })
  },

  setActiveTab: (path: string) => {
    set({ activeTab: path })
  },

  updateTabContent: (path: string, content: string) => {
    set({
      tabs: get().tabs.map((tab) =>
        tab.path === path ? { ...tab, content, dirty: content !== tab.savedContent } : tab,
      ),
    })
  },

  saveFile: async (path: string) => {
    const id = get().currentId
    const tab = get().tabs.find((t) => t.path === path)
    if (id === null || tab === undefined) {
      return
    }
    try {
      await api.put(`/api/workspaces/${id}/files/content`, { path, content: tab.content })
      set({
        tabs: get().tabs.map((t) =>
          t.path === path ? { ...t, savedContent: t.content, dirty: false } : t,
        ),
      })
      get().pushToast('ok', `已保存 ${tab.name}`)
      // 静默刷新树（文件 size / updated_at 可能变化）
      void get().loadTree()
    } catch (err) {
      get().pushToast('err', err instanceof ApiError ? err.message : '保存失败')
      throw err
    }
  },

  searchFiles: async (query: string) => {
    const id = get().currentId
    const q = query.trim()
    if (id === null || q === '') {
      set({ searchResults: [], searching: false })
      return
    }
    set({ searching: true })
    try {
      const res = await api.get<{ matches: SearchMatch[] }>(
        `/api/workspaces/${id}/files/search?q=${encodeURIComponent(q)}`,
      )
      set({ searchResults: res.matches, searching: false })
    } catch (err) {
      set({ searchResults: [], searching: false })
      get().pushToast('err', err instanceof ApiError ? err.message : '搜索失败')
    }
  },

  clearSearch: () => {
    set({ searchResults: [], searching: false })
  },

  pushToast: (kind: 'ok' | 'err', text: string) => {
    toastSeq += 1
    const toast: Toast = { id: `toast_${Date.now().toString(36)}_${toastSeq}`, kind, text }
    set({ toasts: [...get().toasts, toast] })
    setTimeout(() => {
      get().dismissToast(toast.id)
    }, 3200)
  },

  dismissToast: (id: string) => {
    set({ toasts: get().toasts.filter((toast) => toast.id !== id) })
  },

  setPendingApprovalCount: (count: number) => {
    set({ pendingApprovalCount: Math.max(0, count) })
  },

  requestApprovalFocus: () => {
    set({ approvalFocusSeq: get().approvalFocusSeq + 1 })
  },
}))
