# 渡劫code（DujieCode）：开源 Web 版 AI 编程工作台 — 从 0 到 1 的架构与实践

> 发布平台建议：CSDN 博客（原创）
> 建议标签：开源、AI编程、Cloudflare Workers、React、TypeScript、Vite、全栈开发
> 建议分类：人工智能 / 云计算 / 前端
> 建议封面关键词：IDE、代码、AI、Cloudflare 极简渐变背景

---

## 引言：为什么写渡劫code

AI 编程工具正在从"补全几行代码"进化到"自主完成工程任务"。参考开源 Android 应用 AiCode（github.com/jieapi/aicode）的思路，我用 Cloudflare 全家桶（Workers + D1 + KV + R2 + Durable Objects）实现了一个**纯 Web 端的 AI 编程工作台**——**渡劫code（DujieCode）**。

它不只是一个聊天框，而是一个完整的云端开发环境：

- **浏览器即 IDE**：Monaco 编辑器 + 虚拟文件系统（VFS）+ 虚拟 Shell + xterm 终端
- **Agent 工具调用循环**：AI 自主调用工具读写代码、执行命令、跑测试，最多 25 轮自主迭代
- **远程真实执行**：一行命令在你的机器上跑 Python3 零依赖代理，AI 生成的代码可以在你的真实环境里编译运行
- **三协议 LLM 归一化**：OpenAI / Anthropic / Gemini 三种 API 统一为内部 SSE 事件流，前端只对接一种格式
- **企业级安全**：PBKDF2 密码哈希、AES-256-GCM 信封加密 API Key、JWT HttpOnly Cookie、19 条危险命令拦截规则、审批门

项目已 MIT 协议开源，本地 git 仓库 54 个受控文件，64 个单元测试全部通过。

---

## 一、功能架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    浏览器 SPA (React 18)                      │
│  官网落地页 / 登录注册 / 工作台 / 工作区(编辑器+Shell+终端)      │
└──────────────────────────┬──────────────────────────────────┘
                           │ SSE (九类事件) + REST
┌──────────────────────────▼──────────────────────────────────┐
│              Cloudflare Worker (Hono 框架)                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ 认证模块  │ │ LLM适配器 │ │ Agent循环 │ │  VFS + 虚拟Shell  │ │
│  │PBKDF2/JWT│ │三协议归一 │ │25轮上限   │ │16条命令/19危险规则│ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────────────┐ │
│  │ 审批门    │ │ 遥测审计  │ │  D1(元数据) / KV(会话) / R2(内容)│ │
│  └──────────┘ └──────────┘ └──────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           │ WSS + JSON 行协议
┌──────────────────────────▼──────────────────────────────────┐
│        Durable Object (TerminalRoom) 终端房间中继              │
└──────────────────────────┬──────────────────────────────────┘
                           │ 外网 WSS (自实现 RFC6455 客户端)
┌──────────────────────────▼──────────────────────────────────┐
│            dujie-agent.py (Python3 零依赖)                    │
│        本地真实执行代理：编译 / 测试 / 文件 / 进程              │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、核心技术设计

### 2.1 三协议 LLM 流式适配器

不同厂商的流式 API 格式差异巨大（OpenAI 的 delta、Anthropic 的 content_block、Gemini 的 parts）。渡劫code 在 Worker 侧做了一层**归一化适配器**，把三种协议统一转换为内部九类 SSE 事件：

| 内部事件 | 含义 |
|---|---|
| `text` | 模型文本增量 |
| `tool_call` | 工具调用开始 |
| `tool_result` | 工具执行结果 |
| `file_write` | 文件写入 |
| `file_delete` | 文件删除 |
| `command` | Shell 命令执行 |
| `approval_required` | 触发审批门 |
| `done` | 本轮结束 |
| `error` | 错误 |

前端只需要订阅一种事件流，切换模型供应商零成本。

### 2.2 Agent 工具调用循环

Agent 循环是本项目的心脏：

```
while (轮次 < 25) {
  1. 调用 LLM（流式）
  2. 解析 tool_call → 执行工具（VFS 读写 / Shell / 测试）
  3. 危险命令 → 拦截并请求用户审批
  4. 工具结果回灌上下文 → 继续循环
}
```

25 轮上限是工程上的权衡：足够完成绝大多数工程任务，同时防止失控循环烧 token。

### 2.3 VFS：D1 元数据 + R2 内容

浏览器里的"项目文件"不能只存在内存中。渡劫code 的虚拟文件系统采用**双存储策略**：

- **D1**：文件树元数据（路径、大小、MIME、版本、父目录）——结构化查询
- **R2**：文件内容 blob——大文件友好、成本低

写入 = D1 记元数据 + R2 存内容；读取 = 先查元数据再取内容。删除走软删除标记，保留历史版本。

### 2.4 远程执行：零依赖 Python 代理

要在用户真实机器上执行 AI 生成的代码，需要一个执行代理。难点是：**不依赖任何第三方包**。`dujie-agent.py` 用 Python3 标准库自实现了：

- RFC6455 WebSocket 客户端（含握手、帧编解码、心跳线程）
- 系统服务安装（`--print-systemd` 输出 unit 文件）
- JSON 行协议与 DO 中继通信

安装只要一行：

```bash
curl -fsSL https://dujiecode.pages.dev/dujie-agent.py -o dujie-agent.py
python3 dujie-agent.py --server wss://<your-worker>.workers.dev --backend-id bk_xxx --token djt_xxx
```

### 2.5 安全设计

| 威胁 | 防护 |
|---|---|
| 密码泄露 | PBKDF2-SHA256（10 万次迭代）加盐哈希 |
| API Key 泄露 | AES-256-GCM 信封加密，格式 `v1:{iv}:{ct}`，密钥只在服务端 |
| 会话劫持 | JWT HS256，HttpOnly + Secure + SameSite Cookie |
| 危险命令 | 19 条规则（`rm -rf /`、`> /etc/`、`kill -9`、fork 炸弹等）正则匹配 |
| AI 误操作 | 审批门：危险操作必须用户点击确认才执行 |
| 注入攻击 | VFS 路径规范化，拒绝 `..` 逃逸 |

---

## 三、快速开始

### 3.1 克隆与本地开发

```bash
git clone https://github.com/<your-name>/dujiecode.git
cd dujiecode
pnpm install
cp .dev.vars.example .dev.vars   # 填入 JWT_SECRET 等
pnpm dev                          # 启动 Vite + wrangler dev
```

### 3.2 部署到 Cloudflare

```bash
# 1. 创建 D1 / KV / R2（wrangler.toml 已声明资源结构）
npx wrangler d1 create dujiecode-db
npx wrangler kv namespace create KV
npx wrangler r2 bucket create dujiecode-files

# 2. 回填 resource id 到 wrangler.toml

# 3. 一键部署 Worker + Pages
pnpm build
npx wrangler deploy
npx wrangler pages deploy dist --project-name=dujiecode

# 4. 初始化数据库
npx wrangler d1 execute dujiecode-db --file=worker/schema.sql --remote
```

### 3.3 测试

```bash
pnpm test        # Vitest，64 个用例（密码学 + 虚拟 Shell 全量）
```

---

## 四、工程实践中的关键决策

1. **为什么选 Cloudflare 而不是传统 VPS？** 全球边缘延迟 < 50ms、D1/KV/R2 免运维、DO 提供有状态 WebSocket、免费额度足够个人与中小团队。代价是接受平台 API 约束（如免费计划 DO 必须声明 `new_sqlite_classes`）。

2. **为什么前端用 zustand 而不是 Redux？** 项目状态域清晰（auth / chat / files / terminal 四个 store），zustand 样板代码减少 60%，且天然支持 TypeScript 严格模式。

3. **为什么虚拟 Shell 只实现 16 条命令？** 白名单解释器比真 Shell 安全一个数量级——任何未列出的命令直接拒绝，从机制上消灭注入面。

4. **测试策略**：只对**纯函数**（密码学原语、命令解析）做单元测试，SSE 流与 DO 中继走集成验证——避免 mock 测试的虚假安全感。

---

## 五、已知限制与后续计划

- 免费计划 DO 单实例 128MB 内存，多房间并发需升级
- VFS 暂无冲突合并（last-write-wins）
- 计划支持：MCP 协议插件市场、WebContainer 本地沙箱、团队协作实时编辑

---

## 六、结语

渡劫code 是一次"AI 编程工具全栈化"的实验：把 IDE、AI Agent、远程执行、安全审计全部塞进 Cloudflare 边缘。MIT 协议开源，欢迎 Issue 与 PR。

**仓库**：GitHub（主力）+ Gitee（国内镜像，GitHub Actions 自动同步）

如果这篇文章对你有启发，点个赞再走~ 评论区聊聊你的 AI 编程工作流。
