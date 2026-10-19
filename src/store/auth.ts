/**
 * 认证状态 Store（架构文档 §3.3 #15 / §6.3 auth 行）。
 *
 * 状态：user / loading；
 * action：bootstrap（GET /api/auth/me 恢复会话）、login、register、logout。
 * 会话令牌存于 HttpOnly Cookie（dj_session），前端只持有 user 视图（§0 / §5.2）。
 */
import { create } from 'zustand'
import { api } from '../api'
import type { AuthResponse, LoginRequest, RegisterRequest, User } from '@shared/types'

/** 认证 Store 状态与动作（§6.3） */
export interface AuthState {
  /** 当前登录用户；未登录为 null */
  user: User | null
  /** 请求进行中（bootstrap / login / register / logout） */
  loading: boolean
  /** 恢复会话：GET /api/auth/me；未登录静默置空（401 不算错误） */
  bootstrap: () => Promise<void>
  /** 邮箱 + 密码登录；失败抛 ApiError（如 INVALID_CREDENTIALS / RATE_LIMITED） */
  login: (email: string, password: string) => Promise<User>
  /** 注册并自动登录（响应 Set-Cookie）；失败抛 ApiError（如 EMAIL_TAKEN） */
  register: (email: string, password: string, displayName?: string) => Promise<User>
  /** 登出：删除服务端 KV 会话并清空本地 user */
  logout: () => Promise<void>
}

/** 认证 Store（§6.3：AuthStore --> ApiClient） */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: false,

  bootstrap: async () => {
    set({ loading: true })
    try {
      const res = await api.get<AuthResponse>('/api/auth/me')
      set({ user: res.user, loading: false })
    } catch {
      // 未登录 / 网络异常均视为无会话，由路由守卫决定跳转
      set({ user: null, loading: false })
    }
  },

  login: async (email: string, password: string) => {
    set({ loading: true })
    try {
      const body: LoginRequest = { email, password }
      const res = await api.post<AuthResponse>('/api/auth/login', body)
      set({ user: res.user, loading: false })
      return res.user
    } catch (err) {
      set({ loading: false })
      throw err
    }
  },

  register: async (email: string, password: string, displayName?: string) => {
    set({ loading: true })
    try {
      const body: RegisterRequest = { email, password, displayName }
      const res = await api.post<AuthResponse>('/api/auth/register', body)
      set({ user: res.user, loading: false })
      return res.user
    } catch (err) {
      set({ loading: false })
      throw err
    }
  },

  logout: async () => {
    try {
      await api.post<void>('/api/auth/logout')
    } finally {
      // 即使服务端登出失败也清空本地态，避免停留在"假登录"界面
      set({ user: null })
    }
  },
}))
