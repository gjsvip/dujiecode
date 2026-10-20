-- 博客互动数据库（gjsvip-blog-db）
-- 三端静态站（CF Pages / GitHub Pages / Gitee Pages）共用同一 Worker API，
-- 实现「国内发布的评论国际站也有数据」的全球同步。

-- 评论表（树形回复，parent_id 自引用）
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  parent_id INTEGER DEFAULT NULL,
  nickname TEXT NOT NULL,
  email_md5 TEXT NOT NULL,
  website TEXT DEFAULT '',
  content TEXT NOT NULL,
  status TEXT DEFAULT 'approved',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments(slug, status, created_at);

-- 点赞表（文章 + 评论，voter_hash 指纹去重，重复插入=取消）
CREATE TABLE IF NOT EXISTS likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  voter_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_unique ON likes(target_type, target_id, voter_hash);
CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id);

-- 浏览量表（每篇文章一行，UPSERT 累加）
CREATE TABLE IF NOT EXISTS views (
  slug TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 说说表（短动态）
CREATE TABLE IF NOT EXISTS says (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  images TEXT DEFAULT '',
  status TEXT DEFAULT 'approved',
  created_at TEXT DEFAULT (datetime('now'))
);
