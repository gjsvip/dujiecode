/**
 * 渡劫code 前后端共享常量（架构文档 §3.2 #10 / §7.2 / §4.3）。
 * 前后端不得各自重复定义，统一经 `@shared/constants` 引用。
 */
import type { DangerRule } from './types'

/** SSE 事件名集合（§5.3；前端解析与 Worker 产出必须一致） */
export const SSE_EVENTS = {
  META: 'meta',
  TOKEN: 'token',
  TOOL_CALL: 'tool_call',
  APPROVAL_REQUEST: 'approval_request',
  APPROVAL_RESOLVED: 'approval_resolved',
  TOOL_RESULT: 'tool_result',
  USAGE: 'usage',
  DONE: 'done',
  ERROR: 'error',
} as const

/** Agent 循环最大轮次（§7.3；超出返回 MAX_ROUNDS） */
export const MAX_AGENT_ROUNDS = 25

/** 虚拟 Shell 白名单命令（§3.3 #41，共 16 个；非白名单一律拒绝） */
export const SHELL_WHITELIST = [
  'pwd',
  'ls',
  'cat',
  'echo',
  'mkdir',
  'touch',
  'rm',
  'cp',
  'mv',
  'grep',
  'find',
  'head',
  'tail',
  'wc',
  'clear',
  'help',
] as const

/**
 * 危险规则表（§7.2 全部 19 条）。
 * Worker 侧编译为 RegExp(rule.pattern, 'i') 匹配命令；命中即进审批（AI 路径）
 * 或直接拒绝（手动终端路径，§12-D4）。
 */
export const DANGER_RULES: readonly DangerRule[] = [
  {
    id: 'rm-rf',
    label: '递归强制删除',
    pattern: '(^|[;&|]\\s*)rm\\s+(-[a-zA-Z]*r[a-zA-Z]*\\s+)*(-[a-zA-Z]*f[a-zA-Z]*\\s+)?(/|~|\\*|\\$HOME)',
  },
  {
    id: 'git-force-push',
    label: '强推',
    pattern: 'git\\s+push\\s+.*(-f\\b|--force\\b)',
  },
  {
    id: 'git-reset-hard',
    label: '硬重置',
    pattern: 'git\\s+reset\\s+--hard',
  },
  {
    id: 'git-clean',
    label: '强制清理',
    pattern: 'git\\s+clean\\s+-[a-zA-Z]*d',
  },
  {
    id: 'sudo',
    label: '提权',
    pattern: '(^|[;&|]\\s*)sudo\\s',
  },
  {
    id: 'dd',
    label: '裸盘写入',
    pattern: '(^|[;&|]\\s*)dd\\s+if=',
  },
  {
    id: 'mkfs',
    label: '格式化',
    pattern: '\\bmkfs(\\.\\w+)?\\s',
  },
  {
    id: 'disk-redirect',
    label: '块设备重定向',
    pattern: '>\\s*/dev/(sd|nvme|hd|vd)',
  },
  {
    id: 'chmod-777',
    label: '全局放开权限',
    pattern: 'chmod\\s+(-[a-zA-Z]+\\s+)*777\\s',
  },
  {
    id: 'curl-sh',
    label: '远程脚本直执行',
    pattern: '(curl|wget)\\s+[^|]*\\|\\s*(sudo\\s+)?(ba)?sh',
  },
  {
    id: 'fork-bomb',
    label: 'Fork 炸弹',
    pattern: ':\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:',
  },
  {
    id: 'power',
    label: '关机重启',
    pattern: '(^|[;&|]\\s*)(shutdown|reboot|poweroff|halt)\\b',
  },
  {
    id: 'kill-9',
    label: '强杀进程',
    pattern: '\\bkill\\s+(-9|-?SIGKILL)\\b',
  },
  {
    id: 'docker-prune',
    label: '容器大清除',
    pattern: 'docker\\s+system\\s+prune',
  },
  {
    id: 'sql-drop',
    label: '删库删表',
    pattern: '\\b(drop\\s+(database|table)|truncate\\s+table)\\b',
  },
  {
    id: 'npm-publish',
    label: '发布包',
    pattern: '(npm|yarn|pnpm)\\s+publish',
  },
  {
    id: 'user-mgmt',
    label: '用户管理',
    pattern: '(^|[;&|]\\s*)(useradd|userdel|usermod)\\s',
  },
  {
    id: 'etc-write',
    label: '改系统配置',
    pattern: '(>|tee\\s+)\\s*/etc/',
  },
  {
    id: 'eval-b64',
    label: '编码执行',
    pattern: '\\beval\\s+.*base64',
  },
]

/**
 * KV 限流配额（§4.3）。
 * windowSec 为分钟桶长度；对应 KV key 的 TTL 120s，覆盖前后两个桶保证窗口滑动。
 */
export const RATE_LIMITS = {
  api: { limit: 60, windowSec: 60 },
  login: { limit: 5, windowSec: 60 },
  term: { limit: 120, windowSec: 60 },
} as const

/** JWT 会话有效期（天；KV session:{jti} 与 Cookie maxAge 共用） */
export const TOKEN_TTL_DAYS = 7

/** read_file 工具单次读取最大字符数 */
export const READ_FILE_MAX_CHARS = 100000

/** 工具执行结果回传模型前的最大字符数（超出截断） */
export const TOOL_OUTPUT_MAX_CHARS = 50000

/** 实体 ID 前缀（§11 ID 规范；newId(prefix) 追加 16 位 base62 随机后缀） */
export const ID_PREFIX = {
  user: 'usr_',
  provider: 'prv_',
  workspace: 'ws_',
  file: 'fil_',
  conversation: 'cnv_',
  message: 'msg_',
  approval: 'apr_',
  backend: 'bk_',
  agentToken: 'agt_',
  audit: 'aud_',
} as const
