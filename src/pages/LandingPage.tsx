/**
 * 官网落地页（架构文档 §3.3 #19 / §12-D1：复用 SPA 路由 /，与 Workers 同源发布）。
 *
 * 门面页面，视觉标准"能发布"：
 * Hero（一句话介绍 + CTA）→ 特性（对标 AiCode 差异化）→ 双终端示意 →
 * 架构简图（纯 HTML/CSS 绘制）→ 快速开始（3 步，含一键安装命令）→ FAQ → 页脚。
 * 全中文，响应式，深色 IDE 主题与 §6.4 色板严格一致。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

/* ------------------------------------------------------------------ */
/* 常量                                                                 */
/* ------------------------------------------------------------------ */

/** 一键安装命令（§8.1：Pages 与 Workers 同源发布，publicDir=agent 复制进 dist 根） */
const INSTALL_COMMAND =
  'curl -fsSL https://dujie_cone.520691.xyz/dujie-agent.py -o dujie-agent.py'
/** 代理运行命令（§8.1；token 在设置页创建后端时仅展示一次） */
const RUN_COMMAND =
  'python3 dujie-agent.py --server wss://dujie_cone.520691.xyz --backend-id bk_你的后端ID --token djt_你的令牌'

/**
 * 工作台入口基址（§12-D2）：
 * 静态镜像站（GitHub Pages 等）构建时经 VITE_APP_URL 指向主域绝对地址；
 * 默认空串 = 同源 SPA 路由（Cloudflare 同源部署时）。
 */
const APP_URL: string = (import.meta.env.VITE_APP_URL ?? '').replace(/\/+$/, '')

/** 访问入口总表（主域 dujie_cone.520691.xyz + 多端部署 + 双源码托管，§12-D2） */
const MIRROR_LINKS: readonly {
  label: string
  url: string
  region: '主域' | '国内' | '海外' | '源码'
  note: string
  primary?: boolean
}[] = [
  {
    label: '渡劫code 主域',
    url: 'https://dujie_cone.520691.xyz',
    region: '主域',
    note: '官网唯一主入口，Cloudflare 自定义域名，国内外可达，工作台完整功能',
    primary: true,
  },
  {
    label: '个人官网',
    url: 'https://www.520691.xyz',
    region: '主域',
    note: 'gjsvip 小开发者主页：项目介绍与友链导航',
  },
  {
    label: '渡劫手记博客',
    url: 'https://blog.520691.xyz',
    region: '主域',
    note: '开发手记、三端同步架构实录',
  },
  {
    label: 'GitHub Pages 镜像',
    url: 'https://gjsvip.github.io',
    region: '国内',
    note: 'GitHub Pages 官网镜像，国内直连稳定',
  },
  {
    label: 'Gitee 仓库',
    url: 'https://gitee.com/dujie_nb_admin/dujiecode',
    region: '国内',
    note: '国内代码托管（GitHub 自动镜像）；Gitee Pages 实名后启用',
  },
  {
    label: 'GitHub 仓库',
    url: 'https://github.com/gjsvip/dujiecode',
    region: '源码',
    note: '主仓库，push 即自动部署全部端',
  },
]

/** 顶部导航锚点 */
const NAV_LINKS: readonly { href: string; label: string }[] = [
  { href: '#features', label: '特性' },
  { href: '#terminal', label: '双终端' },
  { href: '#architecture', label: '架构' },
  { href: '#mirrors', label: '访问入口' },
  { href: '#quickstart', label: '快速开始' },
  { href: '#faq', label: '常见问题' },
]

/** 特性区（对标 AiCode 的差异化卖点） */
const FEATURES: readonly { icon: string; title: string; desc: string }[] = [
  {
    icon: 'cloud',
    title: '零安装，打开即用',
    desc: '纯 Web 应用，部署于 Cloudflare Workers。不装环境、不配工具链，浏览器就是你的 IDE。',
  },
  {
    icon: 'folder',
    title: '云端工作区',
    desc: '文件树 + Monaco 编辑器（VS Code 内核）多标签编辑，文件内容持久化于 R2，刷新不丢。',
  },
  {
    icon: 'terminal',
    title: '双模终端',
    desc: '内置虚拟 Shell（16 条白名单命令，数据落 D1 + R2 零风险）；也可连接自有 Linux 服务器跑真实 Shell。',
  },
  {
    icon: 'swap',
    title: '模型中立',
    desc: 'OpenAI / Anthropic / Gemini 三协议适配，自带 API Key 随时切换，不被任何一家供应商绑定。',
  },
  {
    icon: 'shield',
    title: '危险命令审批',
    desc: '19 条危险规则实时匹配，命中即挂起等待人工审批；支持"总是允许"放行名单，全程审计留痕。',
  },
  {
    icon: 'lock',
    title: '静态加密存储',
    desc: 'API Key 与 agent token 经 AES-256-GCM 信封加密，密码 PBKDF2 10 万次迭代加盐哈希。',
  },
]

/** 快速开始三步（§8.1） */
const QUICK_START_STEPS: readonly {
  step: string
  title: string
  desc: string
  command?: string
  action?: 'login'
  note?: string
}[] = [
  {
    step: '1',
    title: '注册账号',
    desc: '使用邮箱注册（密码 8–72 位，需含字母与数字），30 秒进入工作台。',
    action: 'login',
  },
  {
    step: '2',
    title: '下载执行代理',
    desc: '在你的 Linux 服务器上执行一键安装命令。代理为 Python3 单文件、标准库零依赖。',
    command: INSTALL_COMMAND,
  },
  {
    step: '3',
    title: '连接执行后端',
    desc: '在「设置 → 执行后端」创建后端，将返回的 backend-id 与 token 填入运行（token 仅展示一次）。',
    command: RUN_COMMAND,
    note: '可选：python3 dujie-agent.py --print-systemd 可输出开机自启的 systemd unit。',
  },
]

/** 常见问题 */
const FAQS: readonly { q: string; a: string }[] = [
  {
    q: '我的文件和 API Key 存放在哪里？',
    a: '文件内容存于 Cloudflare R2，目录树 / 会话 / 审批 / 审计等元数据存于 D1，会话与限流计数存于 KV，全部资源按账号隔离。API Key 与 agent token 以 AES-256-GCM 信封加密后静态存储，日志不输出任何密钥。',
  },
  {
    q: '支持哪些 AI 模型？',
    a: '内置 OpenAI 兼容 / Anthropic / Gemini 三协议适配器。在「设置 → 供应商」添加你自己的 API Key 即可使用，模型中立、随时切换，平台不绑定任何供应商。',
  },
  {
    q: '虚拟 Shell 和远程执行后端有什么区别？',
    a: '虚拟 Shell 是内置沙箱，支持 16 条白名单命令（pwd/ls/cat/echo/mkdir/rm/grep 等），数据落 D1 + R2，零风险；远程后端通过一行 Python 代理连接你自己的 Linux 服务器，运行真实 Shell 与完整工具链，适合构建、测试与部署。',
  },
  {
    q: '危险命令如何拦截？',
    a: '内置 19 条危险规则（rm -rf、git push -f、sudo、dd、mkfs 等）。AI 调用命中即挂起并推送审批卡片：批准后继续执行，拒绝则将原因回传模型；手动终端执行危险命令会被直接拒绝并记入审计日志。',
  },
  {
    q: '断网或代理重启会丢失会话吗？',
    a: '不会。代理采用指数退避重连（1s → 30s 封顶），已启动的 shell 进程在服务器侧保留，重连即恢复输出；浏览器侧断线也会自动重连同一房间。',
  },
  {
    q: '如何部署到自己账户？',
    a: '仓库自带 wrangler 配置：完成 wrangler d1 / kv / r2 初始化并写入 schema.sql 后，执行 npm run build && npm run deploy 即可上线；npm run pages 将同一份 dist 发布到 Pages，官网与 SPA 同源。',
  },
]

/* ------------------------------------------------------------------ */
/* 图标（统一线性风格，24 视口）                                          */
/* ------------------------------------------------------------------ */

const ICON_PATHS: Record<string, string> = {
  cloud:
    'M17.5 19H7a4 4 0 0 1-.6-7.98A6 6 0 0 1 18 9.6a4.5 4.5 0 0 1-.5 9.4z',
  folder:
    'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10z',
  terminal:
    'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13z M8 9.5l2.5 2.5L8 14.5 M12.5 14.5H16',
  swap: 'M4 8h13l-3.5-3.5 M20 16H7l3.5 3.5',
  shield:
    'M12 3l7 2.8v5.4c0 4.3-2.9 8.2-7 9.8-4.1-1.6-7-5.5-7-9.8V5.8L12 3z M9.5 12l1.8 1.8L15 10',
  lock: 'M6.5 10.5V8a5.5 5.5 0 0 1 11 0v2.5 M5.5 10.5h13a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V11.5a1 1 0 0 1 1-1z',
  server: 'M4 5h16v5.5H4z M4 13.5h16V19H4z M8 7.75h.01 M8 16.25h.01',
  file: 'M6.5 3.5h7L18 8v12.5h-11.5V3.5z M13.5 3.5V8H18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  copy: 'M9 9h10v11H9V9z M5 15V4h10',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M4 12h15 M13.5 6.5 19.5 12l-6 5.5',
  chevron: 'M6 9.5l6 6 6-6',
  external: 'M14 4.5h5.5V10 M19.5 4.5 10 14 M18 14v5.5H4.5V6H10',
  alert: 'M12 3.5 21.5 20h-19L12 3.5z M12 10v4.5 M12 17.5h.01',
  key: 'M14.5 3.5a5.5 5.5 0 1 1-5.2 7.3L7 13v3H4.5v3H2.5v-3.8l7-7A5.5 5.5 0 0 1 14.5 3.5z',
}

/** 线性图标组件 */
function Icon({ name, className = 'h-5 w-5' }: { name: string; className?: string }): ReactNode {
  const path = ICON_PATHS[name] ?? ''
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}

/** 品牌标识：渡劫（雷霆）紫方形标 */
function LogoMark({ className = 'h-7 w-7' }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#7c6cf0" />
      <path d="M18 4 9 17h5.5L13 28 23 13h-6l1-9z" fill="#ffffff" />
    </svg>
  )
}

/** 类名拼接小工具 */
function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------ */
/* 国内外分流（§12-D2）                                                  */
/* ------------------------------------------------------------------ */

/** /api/region 响应（Worker 侧免鉴权端点） */
interface RegionInfo {
  country: string
  cnMirror: string
  appUrl: string
}

/**
 * 访客地域探测：仅 Cloudflare 同源副本（Worker / 带 API 的部署）可用。
 * 静态镜像站无此接口时返回 null，页面静默降级为静态镜像列表。
 */
function useRegionHint(): RegionInfo | null {
  const [info, setInfo] = useState<RegionInfo | null>(null)
  useEffect(() => {
    let alive = true
    fetch('/api/region', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? (res.json() as Promise<RegionInfo>) : null))
      .then((data) => {
        if (alive && data !== null && typeof data.country === 'string') {
          setInfo(data)
        }
      })
      .catch(() => {
        // 静态镜像（GitHub Pages 等）：无 /api/region，忽略
      })
    return () => {
      alive = false
    }
  }, [])
  return info
}

/** 国内访客顶部提示条（仅探测到 country=CN 时展示） */
function RegionBanner({ info }: { info: RegionInfo }): ReactNode {
  if (info.country !== 'CN') {
    return null
  }
  return (
    <div className="border-b border-accent/40 bg-accent/10">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-xs text-text">
        <Icon name="alert" className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span>检测到您位于国内网络，推荐访问国内镜像以获得更佳速度：</span>
        <a
          href={info.cnMirror}
          className="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {info.cnMirror.replace(/^https?:\/\//, '')}
        </a>
      </div>
    </div>
  )
}

/**
 * 工作台 CTA：配置了 APP_URL（静态镜像构建）时用绝对链接指向 Worker；
 * 否则走同源 SPA 路由。
 */
function AppCta({
  children,
  className,
}: {
  children: ReactNode
  className: string
}): ReactNode {
  if (APP_URL !== '') {
    return (
      <a href={`${APP_URL}/login`} className={className}>
        {children}
      </a>
    )
  }
  return (
    <Link to="/login" className={className}>
      {children}
    </Link>
  )
}

/* ------------------------------------------------------------------ */
/* 页面片段                                                             */
/* ------------------------------------------------------------------ */

/** 顶部导航（sticky + 毛玻璃；≤768px 折叠为下拉菜单） */
function SiteHeader(): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5">
          <LogoMark className="h-8 w-8" />
          <span className="text-[15px] font-semibold tracking-wide">渡劫code</span>
        </Link>

        {/* 桌面导航 */}
        <nav className="hidden items-center gap-6 md:flex" aria-label="页面导航">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-dim transition-colors hover:text-text"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <AppCta className="btn btn-primary btn-sm">进入工作台</AppCta>

          {/* 移动端汉堡（≤768px） */}
          <button
            type="button"
            className="btn btn-ghost btn-sm touch-target md:hidden"
            aria-label="展开导航菜单"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              {menuOpen ? <path d="M6 6l12 12 M18 6L6 18" /> : <path d="M4 6.5h16 M4 12h16 M4 17.5h16" />}
            </svg>
          </button>
        </div>
      </div>

      {/* 移动端下拉菜单 */}
      {menuOpen && (
        <nav
          className="border-t border-border bg-panel/95 px-4 py-2 backdrop-blur-md md:hidden"
          aria-label="页面导航（移动端）"
        >
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="flex min-h-[44px] items-center border-b border-border/60 text-sm text-dim transition-colors last:border-b-0 hover:text-text"
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </a>
          ))}
        </nav>
      )}
    </header>
  )
}

/** Hero 区：一句话介绍 + CTA + 产品示意图 */
function Hero(): ReactNode {
  return (
    <section className="relative overflow-hidden">
      {/* 背景：渡劫紫光晕 + 细网格 */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 h-[34rem] w-[70rem] -translate-x-1/2 rounded-full bg-accent/20 blur-[130px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#232a3d33_1px,transparent_1px),linear-gradient(to_bottom,#232a3d33_1px,transparent_1px)] bg-[length:56px_56px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-16 text-center lg:pt-24">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="chip">Cloudflare Workers 部署</span>
          <span className="chip">模型中立</span>
          <span className="chip">代理零依赖</span>
        </div>

        <h1 className="mt-6 text-4xl font-bold leading-tight tracking-wide sm:text-5xl lg:text-6xl">
          浏览器里的
          <span className="bg-gradient-to-r from-accent to-[#b3a6ff] bg-clip-text text-transparent">
            AI 编程工作台
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-dim sm:text-lg">
          对话式编程、Monaco 编辑器、虚拟 Shell 与远程执行后端融为一体。打开网页即用，无需安装任何环境——让每一次开发，都像一次渡劫般顺畅。
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <AppCta className="btn btn-primary btn-lg">
            免费开始使用
            <Icon name="arrow" className="h-4 w-4" />
          </AppCta>
          <a href="#quickstart" className="btn btn-outline btn-lg">
            查看快速开始
          </a>
        </div>

        <p className="mt-6 text-xs text-dim">
          主域直达 · 多端镜像备份 · 数据按账号隔离
        </p>

        <ProductPreview />
      </div>
    </section>
  )
}

/** Hero 产品示意图（纯 HTML/CSS 绘制的应用 mock） */
function ProductPreview(): ReactNode {
  const tree: { icon: string; label: string; indent: boolean; active?: boolean }[] = [
    { icon: 'folder', label: 'src', indent: false },
    { icon: 'file', label: 'index.ts', indent: true, active: true },
    { icon: 'folder', label: 'components', indent: false },
    { icon: 'file', label: 'README.md', indent: false },
    { icon: 'file', label: 'package.json', indent: false },
  ]
  return (
    <div className="mx-auto mt-14 max-w-4xl">
      <div className="card overflow-hidden text-left shadow-panel">
        {/* 窗口栏 */}
        <div className="flex items-center gap-2 border-b border-border bg-panel px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-err/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-warn/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-ok/70" />
          <span className="ml-2 font-mono text-[11px] text-dim">dujiecode — 工作区 demo</span>
          <span className="chip ml-auto">虚拟 Shell</span>
        </div>

        <div className="grid md:grid-cols-[210px_1fr]">
          {/* 文件树 */}
          <div className="hidden border-r border-border p-3 md:block">
            {tree.map((node) => (
              <div
                key={node.label}
                className={cx(
                  'flex items-center gap-1.5 rounded-md px-2 py-1.5 font-mono text-[11px]',
                  node.indent && 'pl-5',
                  node.active ? 'bg-accent/15 text-accent' : 'text-dim',
                )}
              >
                <Icon name={node.icon} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{node.label}</span>
              </div>
            ))}
          </div>

          {/* 对话 + 终端 */}
          <div className="space-y-3 p-4">
            {/* 用户消息 */}
            <div className="flex justify-end">
              <p className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent/20 px-3.5 py-2 text-xs leading-relaxed text-text">
                帮我加一个 /healthz 健康检查接口，并验证它能跑通
              </p>
            </div>

            {/* 工具步骤卡片 */}
            <div className="card bg-bg p-3">
              <div className="flex items-center gap-2">
                <span className="grid h-5 w-5 place-items-center rounded bg-accent/15 text-accent">
                  <Icon name="terminal" className="h-3 w-3" />
                </span>
                <span className="font-mono text-[11px] text-text">run_command</span>
                <span className="chip ml-auto border-ok/40 text-ok">exit 0 · 42ms</span>
              </div>
              <p className="mt-2 font-mono text-[11px] text-dim">curl -s http://localhost:8787/healthz</p>
              <p className="mt-1 font-mono text-[11px] text-ok">{'{ "ok": true }'}</p>
            </div>

            {/* 助手回复 */}
            <p className="text-xs leading-relaxed text-dim">
              已在 <span className="font-mono text-text">src/index.ts</span> 添加健康检查路由并验证通过。需要我继续补充单元测试吗？
            </p>

            {/* 远程代理连接条 */}
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
              <span className="truncate font-mono text-[11px] text-dim">
                python3 dujie-agent.py --server wss://…
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-ok">已连接 build-server</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 特性区（对标 AiCode 的差异化） */
function Features(): ReactNode {
  return (
    <section id="features" className="scroll-mt-20 border-t border-border/60 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-bold tracking-wide sm:text-3xl">为「渡劫」而生的编程工作台</h2>
          <p className="mt-4 text-sm leading-relaxed text-dim sm:text-base">
            不是又一个在线编辑器——对话、文件、终端与执行后端在同一个云端工作区里协同，安全与可控贯穿每一步。
          </p>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="card p-5 transition-colors hover:border-accent/50">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-accent/15 text-accent">
                <Icon name={feature.icon} />
              </span>
              <h3 className="mt-4 text-[15px] font-semibold">{feature.title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-dim sm:text-[13px]">{feature.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/** 双终端示意：虚拟 Shell vs 远程执行后端 */
function DualTerminal(): ReactNode {
  return (
    <section id="terminal" className="scroll-mt-20 border-t border-border/60 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-bold tracking-wide sm:text-3xl">双模终端，按需切换</h2>
          <p className="mt-4 text-sm leading-relaxed text-dim sm:text-base">
            轻量操作用内置虚拟 Shell，真实构建与部署连接你自己的服务器——两种模式共享同一套审批与审计体系。
          </p>
        </div>

        <div className="mt-12 grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr]">
          {/* 虚拟 Shell */}
          <div className="card flex flex-col p-5">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/15 text-accent">
                <Icon name="terminal" className="h-4 w-4" />
              </span>
              <h3 className="text-[15px] font-semibold">虚拟 Shell（内置）</h3>
              <span className="chip ml-auto border-ok/40 text-ok">零风险沙箱</span>
            </div>
            <ul className="mt-4 space-y-2 text-[13px] leading-relaxed text-dim">
              <li>· 16 条白名单命令：pwd / ls / cat / echo / mkdir / rm / grep / find …</li>
              <li>· 数据落 D1 + R2，与文件树实时联动</li>
              <li>· 无外部依赖，断网也可在云端沙箱内操作</li>
            </ul>
            <div className="mt-4 flex-1 rounded-lg border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed">
              <p>
                <span className="text-accent">$</span> <span className="text-text">ls</span>
              </p>
              <p className="text-dim">src/  components/  README.md</p>
              <p className="mt-2">
                <span className="text-accent">$</span> <span className="text-text">echo "hello dujie" &gt; a.txt</span>
              </p>
              <p className="mt-2">
                <span className="text-accent">$</span> <span className="text-text">cat a.txt</span>
              </p>
              <p className="text-dim">hello dujie</p>
              <p className="mt-2">
                <span className="text-accent">$</span> <span className="text-text">rm -rf /</span>
              </p>
              <p className="text-err">拒绝：非白名单命令 / 命中危险规则</p>
            </div>
          </div>

          {/* 中部分隔 */}
          <div className="flex items-center justify-center py-2 lg:px-1 lg:py-0">
            <span className="chip bg-elev">或</span>
          </div>

          {/* 远程执行后端 */}
          <div className="card flex flex-col p-5">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/15 text-accent">
                <Icon name="server" className="h-4 w-4" />
              </span>
              <h3 className="text-[15px] font-semibold">远程执行后端</h3>
              <span className="chip ml-auto">自有服务器</span>
            </div>
            <ul className="mt-4 space-y-2 text-[13px] leading-relaxed text-dim">
              <li>· 一行 Python3 代理（零依赖）主动外连，无需暴露服务器端口</li>
              <li>· 真实 Shell / 文件系统 / 完整构建工具链</li>
              <li>· WSS + JSON 行协议，断线退避重连，shell 进程保留</li>
            </ul>
            <div className="mt-4 flex-1 rounded-lg border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed">
              <p>
                <span className="text-accent">$</span> <span className="text-text">python3 dujie-agent.py --server wss://…</span>
              </p>
              <p className="text-ok">[hello] hostname=build-server platform=Linux-5.15</p>
              <p className="text-dim">[spawn] /bin/bash (80x24) 已连接</p>
              <p className="mt-2">
                <span className="text-accent">$</span> <span className="text-text">uname -a</span>
              </p>
              <p className="text-dim">Linux build-server 5.15.0-91-generic x86_64</p>
              <p className="mt-2">
                <span className="text-accent">$</span> <span className="text-text">npm run build</span>
              </p>
              <p className="text-dim">built in 3.2s ✓</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/** 架构简图盒 */
function DiagramBox({ title, desc }: { title: string; desc: string }): ReactNode {
  return (
    <div className="rounded-lg border border-border/70 bg-bg px-3 py-2">
      <p className="text-xs font-medium text-text">{title}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-dim">{desc}</p>
    </div>
  )
}

/** 架构简图列 */
function DiagramColumn({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="card flex flex-col gap-2 p-3">
      <p className="text-xs font-semibold tracking-wide text-text">{title}</p>
      {children}
    </div>
  )
}

/** 架构简图连接箭头（桌面横向 / 移动纵向） */
function DiagramArrow({ lines }: { lines: string[] }): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-2 text-center lg:px-1 lg:py-0">
      <span aria-hidden className="text-dim lg:hidden">
        ↓
      </span>
      <span aria-hidden className="hidden text-dim lg:inline">
        →
      </span>
      {lines.map((line) => (
        <span key={line} className="font-mono text-[10px] leading-tight text-dim">
          {line}
        </span>
      ))}
    </div>
  )
}

/** 架构简图（纯 HTML/CSS 绘制，对应 §1.1 架构图） */
function Architecture(): ReactNode {
  return (
    <section id="architecture" className="scroll-mt-20 border-t border-border/60 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-bold tracking-wide sm:text-3xl">架构一览</h2>
          <p className="mt-4 text-sm leading-relaxed text-dim sm:text-base">
            浏览器 ⇄ Cloudflare（Worker + Durable Object）⇄ 你的服务器，全链路 HTTPS / WSS，无长连接私钥。
          </p>
        </div>

        <div className="mt-12 grid gap-2 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <DiagramColumn title="浏览器 SPA">
            <DiagramBox title="React 18 + Tailwind" desc="Monaco 编辑器 · xterm.js 终端 · zustand 状态" />
            <DiagramBox title="零安装" desc="官网与工作台同源，打开即用" />
          </DiagramColumn>

          <DiagramArrow lines={['HTTPS /api/*', 'JSON + SSE', 'WSS /terminal/connect']} />

          <DiagramColumn title="Cloudflare">
            <DiagramBox title="Worker（Hono）" desc="认证 · 限流 · LLM 流式代理 · Agent 循环" />
            <DiagramBox title="Durable Object：TerminalRoom" desc="浏览器 ⇄ 代理 房间中继（exec / spawn / data）" />
            <DiagramBox title="D1 · R2 · KV" desc="元数据 · 文件内容 · 会话 / 限流 / 审批" />
          </DiagramColumn>

          <DiagramArrow lines={['WSS', '/api/agent/connect', '+ agent token']} />

          <DiagramColumn title="用户 Linux 服务器">
            <DiagramBox title="dujie-agent.py" desc="Python3 单文件 · 标准库零依赖 · 主动外连" />
            <DiagramBox title="真实 Shell / 文件 / 工具链" desc="构建、测试、部署都在你的机器上执行" />
          </DiagramColumn>
        </div>

        <p className="mx-auto mt-6 max-w-3xl text-center text-[11px] leading-relaxed text-dim">
          Worker ⇄ AI 供应商：HTTPS 流式（OpenAI / Anthropic / Gemini 三协议适配，归一化为 SSE）；
          Worker ⇄ DO：内部 fetch 中继 exec 请求；任一端断线自动重连，房间按 backendId 寻址不变。
        </p>
      </div>
    </section>
  )
}

/** 复制按钮（剪贴板不可用时静默降级） */
function CopyButton({ text, label = '复制' }: { text: string; label?: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // 浏览器不支持剪贴板 API 时忽略，用户仍可手动选择复制
    }
  }
  return (
    <button type="button" className="btn btn-outline btn-sm shrink-0" onClick={() => void onCopy()}>
      <Icon name={copied ? 'check' : 'copy'} className="h-3.5 w-3.5" />
      {copied ? '已复制' : label}
    </button>
  )
}

/** 快速开始（3 步，含一键安装命令，§8.1） */
function QuickStart(): ReactNode {
  return (
    <section id="quickstart" className="scroll-mt-20 border-t border-border/60 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-bold tracking-wide sm:text-3xl">三步开始渡劫</h2>
          <p className="mt-4 text-sm leading-relaxed text-dim sm:text-base">
            从注册到连接你自己的服务器，全程不超过一分钟。
          </p>
        </div>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {QUICK_START_STEPS.map((item) => (
            <div key={item.step} className="card flex flex-col p-5">
              <div className="flex items-center gap-2.5">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-[13px] font-bold text-white">
                  {item.step}
                </span>
                <h3 className="text-[15px] font-semibold">{item.title}</h3>
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-dim">{item.desc}</p>

              {item.action === 'login' && (
                <AppCta className="btn btn-primary btn-sm mt-4 self-start">
                  前往注册
                  <Icon name="arrow" className="h-3.5 w-3.5" />
                </AppCta>
              )}

              {item.command && (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-bg p-3">
                  <code className="flex-1 break-all font-mono text-[11px] leading-relaxed text-text">
                    {item.command}
                  </code>
                  <CopyButton text={item.command} />
                </div>
              )}

              {item.note && (
                <p className="mt-2 text-[11px] leading-relaxed text-dim">{item.note}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/** 访问入口（主域 + 多端部署，§12-D2）：统一入口导航，不做强制跳转 */
function MirrorSection(): ReactNode {
  const regionStyle: Record<'主域' | '国内' | '海外' | '源码', string> = {
    主域: 'border-accent/50 text-accent',
    国内: 'border-ok/40 text-ok',
    海外: 'border-accent/40 text-accent',
    源码: 'border-border text-dim',
  }
  return (
    <section id="mirrors" className="scroll-mt-20 border-t border-border/60 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-bold tracking-wide sm:text-3xl">访问入口</h2>
          <p className="mt-4 text-sm leading-relaxed text-dim sm:text-base">
            一个主域、多端部署：<span className="font-medium text-text">dujie_cone.520691.xyz</span> 为渡劫code
            唯一主入口（Cloudflare 自定义域名、国内外可达、工作台完整功能），
            个人官网与博客同域协作，源码双托管（GitHub 主库 + Gitee 国内镜像）自动同步。
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {MIRROR_LINKS.map((mirror) => (
            <a
              key={mirror.url}
              href={mirror.url}
              target="_blank"
              rel="noreferrer noopener"
              className={cx(
                'card flex items-start gap-3 p-5 transition-colors hover:border-accent/50',
                mirror.primary && 'border-accent/50',
              )}
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
                <Icon name={mirror.region === '源码' ? 'file' : 'cloud'} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold text-text">{mirror.label}</span>
                  <span className={cx('chip', regionStyle[mirror.region])}>{mirror.region}</span>
                  {mirror.primary && <span className="chip border-ok/40 text-ok">推荐</span>}
                </span>
                <span className="mt-2 block break-all font-mono text-[11px] leading-relaxed text-dim">
                  {mirror.url.replace(/^https?:\/\//, '')}
                </span>
                <span className="mt-1.5 block text-xs leading-relaxed text-dim">{mirror.note}</span>
              </span>
              <Icon name="external" className="mt-1 h-4 w-4 shrink-0 text-dim" />
            </a>
          ))}
        </div>

        <p className="mx-auto mt-6 max-w-3xl text-center text-[11px] leading-relaxed text-dim">
          个人官网{' '}
          <a
            href="https://www.520691.xyz/"
            className="text-accent underline decoration-accent/40 underline-offset-2"
          >
            www.520691.xyz
          </a>
          {' '}与博客{' '}
          <a
            href="https://blog.520691.xyz/"
            className="text-accent underline decoration-accent/40 underline-offset-2"
          >
            blog.520691.xyz
          </a>
          {' '}同属 520691.xyz 域名体系；所有入口内容同源同步，push 一次全部更新。
        </p>
      </div>
    </section>
  )
}

/** 常见问题 */
function Faq(): ReactNode {
  return (
    <section id="faq" className="scroll-mt-20 border-t border-border/60 py-20">
      <div className="mx-auto max-w-3xl px-4">
        <div className="text-center">
          <h2 className="text-2xl font-bold tracking-wide sm:text-3xl">常见问题</h2>
        </div>
        <div className="mt-10 space-y-3">
          {FAQS.map((item) => (
            <details key={item.q} className="card group px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium text-text">
                {item.q}
                <span
                  aria-hidden
                  className="shrink-0 text-lg leading-none text-dim transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 text-[13px] leading-relaxed text-dim">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

/** 页脚 */
function SiteFooter(): ReactNode {
  const columns: readonly { title: string; items: readonly { label: string; href: string; external?: boolean }[] }[] = [
    {
      title: '产品',
      items: [
        { label: '特性', href: '#features' },
        { label: '双终端', href: '#terminal' },
        { label: '快速开始', href: '#quickstart' },
        { label: '常见问题', href: '#faq' },
      ],
    },
    {
      title: '协议',
      items: [
        { label: '/api/* REST + SSE', href: '#architecture' },
        { label: 'WSS 终端中继', href: '#architecture' },
        { label: 'agent JSON 行协议', href: '#architecture' },
      ],
    },
    {
      title: '安全',
      items: [
        { label: 'PBKDF2 密码哈希', href: '#faq' },
        { label: 'AES-256-GCM 信封加密', href: '#faq' },
        { label: '危险命令审批', href: '#faq' },
      ],
    },
  ]
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <Link to="/" className="inline-flex items-center gap-2.5">
              <LogoMark className="h-7 w-7" />
              <span className="text-[15px] font-semibold tracking-wide">渡劫code</span>
            </Link>
            <p className="mt-4 max-w-xs text-xs leading-relaxed text-dim">
              Web 版 AI 编程工作台：对话式编程、云端工作区、双模终端与危险命令审批，部署于 Cloudflare Workers。
            </p>
            <span className="chip mt-4">DujieCode · v1.0</span>
          </div>
          {columns.map((column) => (
            <div key={column.title}>
              <p className="text-xs font-semibold text-text">{column.title}</p>
              <ul className="mt-4 space-y-2.5">
                {column.items.map((item) => (
                  <li key={item.label}>
                    <a
                      href={item.href}
                      className="inline-flex items-center gap-1 text-xs text-dim transition-colors hover:text-text"
                    >
                      {item.label}
                      {item.external && <Icon name="external" className="h-3 w-3" />}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 border-t border-border/60 pt-6 text-center text-[11px] text-dim">
          © 2026 渡劫code DujieCode · 官网与 SPA 同源发布（Cloudflare Workers + Pages）
        </div>
      </div>
    </footer>
  )
}

/** 官网落地页（§6.1 /） */
export default function LandingPage(): ReactNode {
  const region = useRegionHint()
  return (
    <div className="min-h-screen bg-bg font-sans text-text">
      {region !== null && <RegionBanner info={region} />}
      <SiteHeader />
      <main>
        <Hero />
        <Features />
        <DualTerminal />
        <Architecture />
        <MirrorSection />
        <QuickStart />
        <Faq />
      </main>
      <SiteFooter />
    </div>
  )
}
