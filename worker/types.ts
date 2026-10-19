/**
 * Worker 环境绑定与 Hono 上下文变量类型（架构文档 §9.1 / §13.4 类图 Env）。
 */

/** Cloudflare 资源绑定（wrangler.toml 声明） */
export interface Env {
  /** D1 数据库：用户 / 供应商 / 目录树 / 消息 / 审批 / 审计 / 后端元数据 */
  DB: D1Database
  /** Workers KV：会话 / 限流 / 中止 / 放行名单（§4.3 Key 规范） */
  KV: KVNamespace
  /** R2 对象存储：工作区文件内容（Key：ws/{workspaceId}/{path}） */
  R2: R2Bucket
  /** Durable Object 命名空间：TerminalRoom 终端房间 */
  TERMINAL_ROOM: DurableObjectNamespace
  /** 静态资源绑定（dist/，SPA not_found_handling 回退 index.html） */
  ASSETS: Fetcher
  /** 信封加密主密钥（32 字节 hex，wrangler secret；丢失=全部密钥不可解密） */
  ENCRYPTION_KEY: string
  /** JWT HS256 签名密钥（wrangler secret；轮换会使全部会话失效） */
  JWT_SECRET: string
}

/** 鉴权中间件注入的上下文变量（§5.1 认证中间件行为） */
export interface AppVariables {
  /** 当前用户 ID（usr_ 前缀） */
  userId: string
  /** 当前用户邮箱（规范化后） */
  email: string
  /** 当前会话 JWT 的 jti（登出时按 session:{jti} 删除 KV 记录） */
  jti: string
}

/** Hono 应用环境类型：Bindings + Variables */
export type AppEnv = {
  Bindings: Env
  Variables: AppVariables
}
