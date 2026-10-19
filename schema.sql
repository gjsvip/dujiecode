-- 渡劫code D1 初始化脚本
-- 执行：wrangler d1 execute dujiecode-db --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                 -- usr_ + 随机
  email         TEXT NOT NULL UNIQUE,             -- 小写规范化后存储
  password_hash TEXT NOT NULL,                    -- pbkdf2_sha256$100000$<saltHex>$<hashHex>
  display_name  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,                    -- ISO 8601 UTC
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id               TEXT PRIMARY KEY,              -- prv_
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  protocol         TEXT NOT NULL CHECK (protocol IN ('openai','anthropic','gemini','custom')),
  base_url         TEXT NOT NULL DEFAULT '',      -- 自定义端点；官方协议可留空走默认
  api_key_enc      TEXT NOT NULL,                 -- v1:<ivB64>:<ctB64>（AES-256-GCM 信封加密）
  default_model    TEXT NOT NULL DEFAULT '',
  models_cache     TEXT NOT NULL DEFAULT '[]',    -- JSON: [{id}]
  models_cached_at TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id              TEXT PRIMARY KEY,               -- ws_
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  default_backend TEXT NOT NULL DEFAULT 'vfs',    -- 'vfs' 或 exec_backends.id
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,                  -- fil_
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id    TEXT NOT NULL DEFAULT '',          -- '' 表示根目录（避免 NULL 唯一索引问题）
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('file','dir')),
  size         INTEGER NOT NULL DEFAULT 0,
  mime         TEXT NOT NULL DEFAULT '',
  r2_key       TEXT,                              -- ws/<workspaceId>/<path>，仅文件
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (workspace_id, parent_id, name)
);
CREATE INDEX IF NOT EXISTS idx_files_parent ON files(workspace_id, parent_id);

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,                  -- cnv_
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '新会话',
  provider_id  TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'idle'
               CHECK (status IN ('idle','streaming','awaiting_approval','done','aborted','error')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_ws ON conversations(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,               -- msg_
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content         TEXT NOT NULL DEFAULT '',
  tool_calls      TEXT,                           -- JSON: [{id,name,arguments}]
  tool_call_id    TEXT,                           -- role=tool 时关联调用
  name            TEXT,                           -- 工具名
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,               -- apr_
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  arguments       TEXT NOT NULL,                  -- JSON
  reason          TEXT NOT NULL DEFAULT '',       -- 命中的危险规则说明
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected')),
  decided_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appr_user_status ON approvals(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS exec_backends (
  id           TEXT PRIMARY KEY,                  -- bk_
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  host         TEXT NOT NULL DEFAULT '',          -- 仅备注用；agent 主动外连，Worker 不直连
  status       TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
  last_seen_at TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id           TEXT PRIMARY KEY,                  -- agt_
  backend_id   TEXT NOT NULL REFERENCES exec_backends(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT 'default',
  token_hash   TEXT NOT NULL UNIQUE,              -- SHA-256(token) 十六进制，不可逆
  last_used_at TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY,                  -- aud_
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,                     -- exec_command/approval/file_write/file_delete/backend_connect/agent_auth_fail
  target       TEXT NOT NULL DEFAULT '',          -- 命令或路径
  backend      TEXT NOT NULL DEFAULT 'vfs',
  risk         TEXT NOT NULL DEFAULT 'normal' CHECK (risk IN ('normal','dangerous')),
  result       TEXT NOT NULL DEFAULT 'success' CHECK (result IN ('success','failure','rejected')),
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at DESC);
