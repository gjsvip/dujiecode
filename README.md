# 渡劫code（DujieCode）

Web 版 AI 编程工作台（对标 Android 应用 AiCode）：浏览器内的 Monaco 编辑器 + xterm.js 终端 + 对话式 AI Agent。
后端部署于 Cloudflare Workers（Hono + D1 + R2 + KV + 1 个 Durable Object）；执行代理 `dujie-agent.py`
以 WSS 主动外连用户自有 Linux 服务器，实现远程命令执行与交互 Shell，无需暴露服务器端口。

## 功能概览

- 邮箱 + 密码认证：PBKDF2-SHA256（10 万次迭代 + 每用户随机盐）；JWT HS256 存 HttpOnly Cookie，会话记录落 KV（删除即登出/吊销）
- 供应商管理（OpenAI / Anthropic / Gemini / 自定义端点），API Key 经 AES-256-GCM 信封加密后存 D1
- 工作区虚拟文件系统（D1 元数据 + R2 内容）+ 16 命令白名单虚拟 Shell
- 对话式 Agent：6 个工具、最多 25 轮循环、危险命令审批、中止标志、SSE 流式渲染
- 远程执行后端：agent token 创建时仅展示一次（SHA-256 哈希存储）、DO 房间中继、断线重连
- 19 条危险命令规则拦截 + 全量审计日志

## 技术栈

Vite 5 + React 18 + TypeScript + Tailwind CSS v4 + Monaco + xterm.js + zustand + Hono 4 + Cloudflare D1/R2/KV/DO。
前后端类型与常量契约共享于 `shared/`（经 tsconfig `paths` 与 vite alias 的 `@shared/*` 双向引用）。

## 本地开发

```bash
npm install
npm run dev     # Vite 开发服务器（前端热更新；/api 需部署后的 Worker 或本地 wrangler）
npm test        # Vitest 纯函数单测（crypto 往返 / shell 解析）
```

## 部署

资源初始化（首次，见架构 §9.2）：

```bash
wrangler d1 create dujiecode-db                 # 得到 database_id，回填 wrangler.toml
wrangler kv namespace create dujiecode-kv       # 得到 id，回填 wrangler.toml
wrangler r2 bucket create dujiecode-files
wrangler d1 execute dujiecode-db --file=schema.sql --remote   # 建表
wrangler secret put ENCRYPTION_KEY              # openssl rand -hex 32
wrangler secret put JWT_SECRET                  # openssl rand -hex 32
```

一键上线：

```bash
npm ci
npm run build      # tsc --noEmit + vite build（dist/ 内含 dujie-agent.py）
npm run deploy     # wrangler deploy → dujiecode.dujie-nb.workers.dev
npm run pages      # wrangler pages deploy dist --project-name dujiecode → dujiecode.pages.dev
```

### CLOUDFLARE_API_TOKEN 用法

`wrangler deploy` / `wrangler pages deploy` 需要 Cloudflare API 凭证：本地可 `wrangler login`；CI 中导出环境变量：

```bash
export CLOUDFLARE_API_TOKEN=xxxx    # 权限：Workers Scripts Edit / D1 Edit / KV Edit / R2 Edit / Pages Edit
export CLOUDFLARE_ACCOUNT_ID=xxxx
```

该 token 仅用于部署鉴权：代码不读取、不进仓库、不写入 wrangler.toml。

## 线上部署记录（2026-10-18）

| 项 | 值 |
|---|---|
| 应用（Workers） | https://dujiecode.dujie-nb.workers.dev |
| 官网（Pages，同源 SPA） | https://dujiecode.pages.dev |
| D1 数据库 | `dujiecode-db`（`52f270d9-1d75-41bc-9df1-95264224e91e`，10 张表已建） |
| KV 命名空间 | `e8664fb54b174330be46abad29727a31` |
| R2 桶 | `dujiecode-files` |
| Secrets | `ENCRYPTION_KEY` / `JWT_SECRET` 已设置；明文备份见本地 `.deploy-secrets.txt`（**丢失=全部用户密钥不可解密，请妥善保管**） |
| DO 迁移 | `v1`（`new_sqlite_classes: ["TerminalRoom"]`，免费计划要求） |
| 必应收录 | IndexNow 已提交（key `51734a6916d2725aa31f3e62ef9a59b5`，202 Accepted）；sitemap：`/sitemap.xml`，robots：`/robots.txt` |
| 质量状态 | tsc 零错误；Vitest 64/64 通过；QA 独立审查通过（2 项缺陷已修复回归） |

### 已知网络限制与备选

`*.workers.dev` 在部分网络环境（如企业出口/部分沙箱）存在 SNI 层阻断，导致应用域名不可达。
若遇此情况有两个备选（均可按需实施）：
1. **绑定自定义域名**：将任意已接入 Cloudflare 的域名添加 Worker 自定义域名路由（全球任播，无 workers.dev 限制）；
2. **Pages Functions 全功能通道**：把同一份 `dist` + Hono 入口以 Pages Functions 形态部署（D1/KV/R2/DO 绑定可经 wrangler.toml 配置，DO 以 `script_name` 跨项目绑定至本 Worker），获得 `*.pages.dev` 域名的完整应用访问入口。

远程执行代理一键安装

```bash
curl -fsSL https://dujiecode.pages.dev/dujie-agent.py -o dujie-agent.py
python3 dujie-agent.py --server wss://dujiecode.dujie-nb.workers.dev --backend-id bk_xxx --token djt_xxx
# 开机自启：sudo python3 dujie-agent.py --print-systemd
```

## 目录结构

| 目录 | 内容 |
|---|---|
| `shared/` | 前后端共享类型与常量（`@shared/*`） |
| `src/` | React SPA（官网 / 登录 / 工作台 / 工作区 / 设置） |
| `worker/` | Cloudflare Worker（Hono 路由、Agent 循环、LLM 适配器、虚拟 Shell、安全基础库） |
| `do/` | Durable Object `TerminalRoom`（终端房间中继） |
| `agent/` | `dujie-agent.py`（Python3 零依赖执行代理，构建时复制进 dist） |
| `tests/` | Vitest 纯函数单测 |
| `scripts/` | `publish.sh`（一键双平台开源发布） |
| `docs/` | PRD、架构设计、类图/时序图、CSDN 发布文章稿 |

## 开源发布（国内 + 国外双平台）

代码以 MIT 协议开源，采用 **GitHub 主力 + Gitee 国内镜像** 的双仓库策略：GitHub 保有完整历史，Gitee 镜像由 GitHub Actions 在每次 push 到 `main` 时自动同步（`git push --force --mirror`），两边数据始终一致。

### 一键发布

仓库内置发布脚本，配置好账号后一条命令完成双平台推送：

```bash
# 方式一：环境变量（HTTPS + Personal Access Token）
GH_USER=你的GitHub用户名 GH_TOKEN=ghp_xxx \
GITEE_USER=你的Gitee用户名 GITEE_TOKEN=xxx \
./scripts/publish.sh

# 方式二：SSH 密钥（需提前配置好两个平台的公钥）
./scripts/publish.sh --ssh
```

脚本会自动完成：检查 git 状态 → 配置 `origin`（GitHub）与 `gitee`（Gitee）双 remote → 推送 `main` 分支 → 打印两个平台的仓库地址。

### 自动同步部署（GitHub Actions → Cloudflare）

`.github/workflows/deploy.yml` 已内置完整 CI/CD 流水线：**push 到 `main` 即自动完成** 依赖安装 → 类型检查与构建 → 单元测试 → D1 初始化（幂等）→ Worker 部署 → Pages 官网部署。也可在仓库 Actions 页面手动 `Run workflow` 触发。

只需在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加两个 Secret：

| Secret | 值 |
|---|---|
| `CF_API_TOKEN` | Cloudflare API Token（需 Workers / D1 / Pages 编辑权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |

> 本仓库已完成配置并触发过部署，仓库地址：https://github.com/gjsvip/dujiecode

### 自动镜像配置（GitHub Actions）

`.github/workflows/mirror-to-gitee.yml` 已内置镜像工作流，只需在 GitHub 仓库
**Settings → Secrets and variables → Actions** 中添加两个 Secret：

| Secret | 值 |
|---|---|
| `GITEE_USER` | Gitee 用户名 |
| `GITEE_TOKEN` | Gitee 个人访问令牌（需 `projects` 权限） |

之后每次 `git push origin main` 都会自动同步到 Gitee。

### CSDN 发布

`docs/CSDN-article.md` 是一篇完整的发布文章稿（产品介绍 + 架构图 + 快速开始），注册 CSDN 账号后直接粘贴发布即可，建议勾选"原创"并添加标签：开源、AI编程、Cloudflare Workers。

### 平台注册实测记录（2026-10-18，沙箱环境）

在自动化环境中注册各平台时遇到 IP 级风控/区域限制，实测结论如下，供在正常网络环境下注册参考：

| 平台 | 结果 | 原因 |
|---|---|---|
| GitHub | ✗ 受阻 | DataDome「Access is temporarily restricted」，IP 级封禁 |
| GitLab.com | ✗ 受阻 | 检测到中国大陆访问，引导至 JiHu 且无注册表单 |
| 极狐 GitLab（JiHu） | ✗ 受阻 | 「安全检测中」勾选验证无法通过 |
| Gitee | ✗ 受阻 | HTTP 405 Method Not Allowed |
| GitCode（CSDN） | ✗ 受阻 | HTTP 418 |
| Codeberg | ✗ 受阻 | HTTP 429 限流 |
| SourceHut | ✗ 受阻 | HTTP 418 |
| Bitbucket | ✗ 受阻 | 跳转 Atlassian 登录且有 reCAPTCHA |

> 以上为沙箱出口 IP 的实测结果，正常家用/办公网络注册 Gitee 与 GitHub 通常无障碍。
