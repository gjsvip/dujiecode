/**
 * Worker 环境绑定与 Hono 上下文变量类型（架构文档 §9.1 / §13.4 类图 Env）。
 */

/** Cloudflare 资源绑定（wrangler.toml 声明） */
export interface Env {
  /** D1 数据库：用户 / 供应商 / 目录树 / 消息 / 审批 / 审计 / 后端元数据 */
  DB: D1Database
  /** D1 数据库：博客互动（评论 / 点赞 / 浏览量 / 说说，三端静态站共用） */
  BLOG_DB: D1Database
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
  /* ---------------- T04 评论系统增强（可选，缺省均有安全默认值） ---------------- */
  /** 博客盐：访客指纹 / IP 黑名单双轨派生用（缺省 'gjsvip-blog'，见 lib/visitor.ts） */
  BLOG_SALT?: string
  /** Turnstile 服务端密钥（wrangler secret；S2 灰度时配置，缺失时校验自动放行） */
  TURNSTILE_SECRET?: string
  /** Turnstile 站点密钥（公开值，可入 git；可被 KV cfg:turnstile_site_key 覆盖） */
  TURNSTILE_SITE_KEY?: string
  /** Resend API Key（wrangler secret；缺失时通知自动降级跳过，不影响评论） */
  RESEND_API_KEY?: string
  /** 回复通知邮件发件人（缺省「渡劫code <noreply@520691.xyz>」，需 Resend 域名验证） */
  MAIL_FROM?: string
  /** 博文 URL 前缀（通知邮件链接；缺省 https://www.520691.xyz/posts/） */
  BLOG_POST_URL_BASE?: string
}

/** 鉴权中间件注入的上下文变量（§5.1 认证中间件行为） */
export interface AppVariables {
  /** 当前用户 ID（usr_ 前缀） */
  userId: string
  /** 当前用户邮箱（规范化后） */
  email: string
  /** 当前会话 JWT 的 jti（登出时按 session:{jti} 删除 KV 记录） */
  jti: string
  /** 请求 ID（requestId 中间件注入；T04 起业务日志可带此字段关联访问日志） */
  requestId: string
}

/** Hono 应用环境类型：Bindings + Variables */
export type AppEnv = {
  Bindings: Env
  Variables: AppVariables
}
