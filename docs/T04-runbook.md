# T04 Runbook（评论系统增强：secrets / KV / 灰度 / 备份恢复）

| 项 | 值 |
|---|---|
| 文档 ID | T04-runbook |
| 对应设计 | `docs/ARCH-T04-COMMENT-ADMIN-2026-10-21.md` |
| Worker | dujiecode（345 账号，主域 dujiecone.520691.xyz） |
| 数据层 | D1 `gjsvip-blog-db` + KV `1c168f5887d5457b8fa456084c9ca4b1` + R2 `dujiecode-files` |

## 1. Secrets 清单（wrangler secret put，一次性人工）

| Secret | 用途 | 缺失时行为 |
|---|---|---|
| `TURNSTILE_SECRET` | Turnstile 服务端校验 | WARN + 放行（`secret_missing`） |
| `RESEND_API_KEY` | 回复通知邮件（Resend） | INFO + 跳过（`no_api_key`），评论不受影响 |

```bash
# Turnstile 密钥对：Cloudflare Dashboard → Turnstile → 添加站点（域名 520691.xyz）获取
printf '%s' '<TURNSTILE_SECRET>' | npx wrangler secret put TURNSTILE_SECRET

# Resend：resend.com 注册 → API Keys → Create；并验证 520691.xyz 域名 DNS（否则 send_failed）
printf '%s' '<RESEND_API_KEY>' | npx wrangler secret put RESEND_API_KEY
```

## 2. Vars（wrangler.toml，已随代码入库，无需人工）

| Var | 值 | 说明 |
|---|---|---|
| `TURNSTILE_SITE_KEY` | `""` | 公开站点密钥；可被 KV `cfg:turnstile_site_key` 覆盖（免部署轮换） |
| `MAIL_FROM` | `渡劫code <noreply@520691.xyz>` | 发件人（需 Resend 域名验证） |
| `BLOG_POST_URL_BASE` | `https://www.520691.xyz/posts/` | 通知邮件博文链接前缀 |

## 3. KV 开关键（前缀即域）

| 键 | 默认 | 含义 | 设置命令 |
|---|---|---|---|
| `admin:token_hash` | 无 | sha256Hex(admin token)，64hex | 见 §4 |
| `cfg:turnstile_enabled` | `'0'` | Turnstile 总开关 | `wrangler kv key put --binding=KV --namespace-id=1c168f5887d5457b8fa456084c9ca4b1 cfg:turnstile_enabled 1` |
| `cfg:turnstile_site_key` | 空（回退 var） | 站点密钥免部署轮换 | 同上 |
| `cfg:turnstile_fail_open` | `'1'` | 服务不可达时放行 | 同上 |
| `cfg:moderation_enabled` | `'0'` | 审核队列 | 同上 |
| `cfg:notify_enabled` | `'1'` | 邮件通知总闸 | 同上 |
| `blog:backup:last` | 自动 | 备份状态标记（admin stats 读） | 自动，勿手写 |

## 4. 管理令牌初始化（S1，人工一次性）

```bash
TOKEN=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
wrangler kv key put --binding=KV --namespace-id=1c168f5887d5457b8fa456084c9ca4b1 \
  admin:token_hash "$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)"
# TOKEN 明文交博主保存（密码管理器）；丢失 = 重走上面两步换新 token
```

- 管理页：`https://www.520691.xyz/admin/`（博客仓库，token 存 sessionStorage）。
- 失败限流：同 IP 5 次失败锁 5 分钟（`429 ADMIN_RATE_LIMITED`）。
- 回滚：删 KV `admin:token_hash` → 管理 API 全 401，公开面无损。

## 5. 数据迁移（已完成，记录备查）

```bash
# 备份（迁移前纪律）
wrangler d1 export gjsvip-blog-db --remote --output=/tmp/backup-pre-t04.sql
# 迁移（ALTER 守卫 + 幂等 DDL；可重复执行）
node scripts/migrate-t04.mjs
```

## 6. 灰度步骤与回滚（S0-S5）

| 步骤 | 动作 | 观察 | 回滚 |
|---|---|---|---|
| S0 基础 | 跑迁移 → 部署（moderation/turnstile 均关，行为与现网一致） | 评论/点赞/浏览回归正常；`/api/blog/config` 可访问 | git revert + CI 重部署（≤5 分钟） |
| S1 管理 API | KV 写入 `admin:token_hash`；curl/管理页冒烟 | 401/429 防护生效；操作不误伤公开数据 | 删 KV `admin:token_hash` |
| S2 Turnstile | 配 secret + site key；`cfg:turnstile_enabled=1`；前端发版渲染 widget | 48h：`wrangler tail` 看 TURNSTILE_FAILED/BANNED 计数；真实读者投诉为 0 | KV 置 `'0'`（≤60s 全网生效，前端不再渲染，**无需发版**） |
| S3 审核队列 | 先 `cfg:moderation_enabled=0` 双跑：管理后台试审核/隐藏验证无误 → 再置 `'1'` | pending 队列积压量；审批通过后通知邮件可达 | KV 置 `'0'`；**存量 pending 不会自动转 approved**——回滚前先清零：`wrangler d1 execute gjsvip-blog-db --remote --command "UPDATE comments SET status='approved' WHERE status='pending'"` |
| S4 邮件通知 | 配 `RESEND_API_KEY`；`cfg:notify_enabled` 默认已 `'1'` | 测试回复触发邮件；到达率 | KV 置 `'0'` 或删 secret（自动 `no_api_key` 降级） |
| S5 备份 | `[triggers]` 随 S0 部署已生效；周一 02:00 UTC 首个文件落 R2 | R2 出现 `dujie-comments/<日期>.json`；KV `blog:backup:last` 更新 | 删 `[triggers]` 段重新部署（备份停止，历史文件保留） |

> 所有开关回滚都是 **KV 级秒级操作**，不动代码；代码级回滚才是 git revert。
> 灰度期每一步满足观察项再下一步。**S2-S5 为人工配置步骤（博主操作），工程师做到 S1。**

## 7. 备份恢复步骤

```bash
# 1) 取回最近备份（R2 → 本地）
wrangler r2 object get dujiecode-files/dujie-comments/2026-10-21.json --file=backup.json

# 2) 校验结构：exportedAt / db / tables{comments,says} / counts

# 3) 导入 D1（示例：整表重建后灌回；评论表按 id 灌回可保楼层关系）
wrangler d1 execute gjsvip-blog-db --remote --file=restore-comments.sql
# restore-comments.sql 由 backup.json 生成：
#   DELETE FROM comments; DELETE FROM comment_emails;
#   INSERT INTO comments (id,slug,parent_id,nickname,email_md5,website,content,status,created_at,ip_hash) VALUES (...);
```

- 备份内容：comments + says **全量**（含 pending/hidden，恢复用不过滤状态）；
- 保留策略：最近 12 份（≈3 个月），更旧自动删；
- 本地验证 scheduled：`wrangler dev` 后 `curl "http://localhost:8787/__scheduled?cron=0+2+*+*+1"`。

## 8. 应急速查

| 症状 | 第一动作 |
|---|---|
| 评论 400 TURNSTILE_TOKEN_MISSING 潮涌 | `cfg:turnstile_enabled=0`（前端不再渲染 widget，≤60s 生效） |
| 管理页 401 | 检查 KV `admin:token_hash` 是否被删；token 是否带错 |
| 管理页 429 | 等 5 分钟（同 IP 失败计数 TTL），或换网络 |
| 通知邮件不到 | Resend 域名是否验证；`cfg:notify_enabled`；`wrangler tail` 看 `scope:notify` |
| 备份未生成 | `wrangler tail` 看 `scope:backup`；确认 `[triggers]` 仍在 wrangler.toml |
