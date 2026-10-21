// T04 数据迁移（scripts/migrate-t04.mjs，Node 内置模块，零新依赖）。
//
// 用法：node scripts/migrate-t04.mjs            # 默认 --remote
// 背景：SQLite 的 ALTER TABLE ADD COLUMN 无 IF NOT EXISTS，重复执行会报错，
//       故先用 PRAGMA table_info 守卫，再执行 schema-t04.sql（幂等 DDL）。
//
// 纪律（承接路线图 §6）：执行前先跑一次数据导出备份，例如
//   wrangler d1 export gjsvip-blog-db --remote --output=backup-pre-t04.sql
// 迁移为人工一次性动作，CI 不自动执行。
import { execSync } from 'node:child_process'

const DB = 'gjsvip-blog-db'

/** 执行 wrangler 命令（stderr 透传，stdout 捕获） */
const run = (cmd) =>
  execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

// 1) ALTER 守卫：comments.ip_hash 是否已存在
const info = JSON.parse(
  run(`wrangler d1 execute ${DB} --remote --json --command "PRAGMA table_info(comments)"`),
)
const hasIpHash = info[0].results.some((col) => col.name === 'ip_hash')
if (hasIpHash) {
  console.log('[migrate] comments.ip_hash 已存在，跳过 ALTER')
} else {
  run(`wrangler d1 execute ${DB} --remote --command "ALTER TABLE comments ADD COLUMN ip_hash TEXT"`)
  console.log('[migrate] 已添加 comments.ip_hash')
}

// 2) 幂等 DDL：banned / comment_emails / 索引 / 存量回填
run(`wrangler d1 execute ${DB} --remote --file=schema-t04.sql`)
console.log('[migrate] schema-t04.sql 应用完成')
