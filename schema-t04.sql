-- T04 增量 schema（评论系统增强，幂等：CREATE IF NOT EXISTS + WHERE IS NULL，重复执行安全）
-- 对应设计：docs/ARCH-T04-COMMENT-ADMIN-2026-10-21.md §1
-- 执行顺序：先 scripts/migrate-t04.mjs（ALTER 守卫加 comments.ip_hash），再应用本文件。

-- 黑名单表（email_md5 / ip_hash 双维度；UNIQUE + INSERT OR IGNORE 天然幂等，解黑 = DELETE）
CREATE TABLE IF NOT EXISTS banned (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ban_type TEXT NOT NULL,            -- 'email_md5' | 'ip_hash'
  ban_value TEXT NOT NULL,           -- email_md5(32hex) 或 ip_hash(64hex)
  reason TEXT DEFAULT '',            -- 拉黑原因（管理员填写，可空）
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_banned_unique ON banned(ban_type, ban_value);
CREATE INDEX IF NOT EXISTS idx_banned_type ON banned(ban_type);

-- 回复通知邮箱表（D4：明文邮箱隔离存放，可独立 purge，不进任何公开查询）
CREATE TABLE IF NOT EXISTS comment_emails (
  comment_id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 管理列表索引：按 status 分页（created_at DESC, id DESC）与回复数统计/通知查父
CREATE INDEX IF NOT EXISTS idx_comments_status_created ON comments(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

-- 存量兜底：迁移前评论无 ip_hash，回填为空串（幂等，可重复执行；
-- 注意 ALTER TABLE ADD COLUMN ip_hash 由 scripts/migrate-t04.mjs 守卫执行，
-- SQLite 不支持 ADD COLUMN IF NOT EXISTS）
UPDATE comments SET ip_hash = '' WHERE ip_hash IS NULL;
