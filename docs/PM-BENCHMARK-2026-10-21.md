# 友链网络扩散式竞品研究报告

> 作者：许清楚（Xu，产品经理） ｜ 日期：2026-10-21 ｜ 版本：v1.0
> 任务来源：CEO 授权「吸收百家之长补自己之短」
> 研究路径：安之鱼博客（https://blog.anheyu.com/）→ 其友链（一级）→ 大佬们的友链（二级）→ 站长生态
> 样本量：1 个种子站 + 10 个一级站点 + 16 个二级站点，共抽取到 **1,337 条去重外链**，人工精选 26 个站点拆解

---

## 0. 执行摘要（CEO 一分钟版）

1. **我们的短板不是技术，是「挂出去的能力」**。圈子里的站早就把「友链页」当成产品做：卡片化 + 响应时间监控 + 一键复制申请模板 + 失联友链黑名单 + 十年之约/开往两大流量联盟徽标。我们的 `/friends` 目前只是静态列表。
2. **改名「渡劫博客」必须同步到模板层**：`<title>`、description、OG、RSS title、sitemap、友链申请卡片的 name 字段全部还是「渡劫小站」（线上实测确认）。
3. **发现两个自家 Bug（P0，今天就能修）**
   - **软 404**：任何不存在的路径都返回 `200 + text/html`（例：`https://www.520691.xyz/assets/avatar.png` → `content-type: text/html`），搜索引擎会收录一堆空壳页。
   - **sitemap 串了三个域名**：`https://www.520691.xyz/sitemap.xml` 里同时塞了 `gjsvip.github.io/blog/*` 的 URL，且所有 `lastmod` 全写成同一天（无参考价值），RSS link 用的是相对路径 `href="rss.xml"`。
4. **加入「开往」的最低门槛是 10 篇原创**（或 20 篇文章），我们目前 **4 篇**——这是接下来 4 周唯一必须盯的创作 KPI。
5. **评论不要换 Twikoo**。官方 Twikoo 现在确实支持 CF Workers + D1（比我们更成熟），但我们自建 D1 的方案 + 文章「CF D1 自建评论」已经构成差异化内容资产；正确动作是补短板（管理后台、垃圾评论、导出），不是推翻重写。

---

## 1. 友链网络图谱

### 1.1 扩散路径说明

- **种子**：https://blog.anheyu.com/ —— 注意到一个关键事实：**安之鱼已经不再是 Hexo 站了**。线上 `<meta name="keywords">` 明确写着 `博客,Next.js,HeroUI,React,TypeScript`，友链数据来自自建 REST API（`GET /api/public/links` 返回 JSON，`/api/links` 需 Token）。他从「主题作者」进化成了「全栈产品 owning 后端」，这条路径和我们「静态博客 + Cloudflare Worker 自建 API」的方向高度一致，**是圈子里最值得我们抄的样本之一**。
- **一级**：安之鱼友链 API 返回 **10 条**（含他自己），已全部展开。
- **二级**：逐个爬取一级站点自己的友链页（`/link/` `/links/` `/friends/` `/addlink/` 等变体），命中 6 个有效友链页，累计抽取 1,337 条外链，按「跨站出现次数」排序得到圈层权重。

### 1.2 一级站点（来自安之鱼友链 API，10/10 全部拿到）

| # | 站点名 | URL | 一句话定位 | 技术栈（实测） | 亮点功能 |
|---|---|---|---|---|---|
| 1 | **安知鱼** | https://blog.anheyu.com/ | 前端与生活，安之鱼主题作者的站 | **Next.js + HeroUI + React + TypeScript**（已从 Hexo 迁移） | Shift 快捷键面板（K/A/D/S/R/H/L/P/I）、JSON-LD（WebSite + SearchAction）、PWA manifest、自建后端 API 矩阵（`/api/public/links`、`/api/public/comments`、`/api/pro/knowledge/search` 知识库搜索、moments 说说、文章导入导出）、友链在线表单申请（自动建 `新增/修改` 工单） |
| 2 | **轻笑Chuckle** | https://www.qcqx.cn/ | 建站折腾 + 生活 | Hexo 5.4.1 + Waline + **Algolia** | 友链卡片**实时显示响应时间**（3584ms / ERR / `>=10s`）、按年分组（2022[65] / 2023[67]…）、「友链最后更新时间」标注、快速申请模板（默认 / Butterfly 两种格式）、朋友圈 / 统计 / 空间 / 协议 / 留言板 |
| 3 | **清羽飞扬（刘神）** | https://blog.liushen.fun/ | 建站教程 + 项目分享 + 随笔 | **Astro v7.1.3** + Twikoo/Artalk + PWA + 自建 **Umami** 统计 | **子域工具矩阵**（最值得抄）：相册 `xc.`、音乐 `music.`、代码片段 `gist.`、说说 `mm.`、图床 `img.liiiu.cn`、CDN `cdn.`、状态页 `status.`、每日热榜 `hot.`、盘搜 `so.`、白板 `draw.`、思维导图 `xmind.`、封面生成 `cover.`；独立「友链申请」页（Flow 三步 + Requirements 说明） |
| 4 | **冰火之砺** | https://blog.marice.top/ | 技术 + 人间烟火 | Hexo 7.2.0 + Butterfly + Twikoo + Algolia + PWA | 多「频道」入口（流媒体/应用/冰块聚能刷）、装备页、相册集、广播文档（瞬间）、随机访问、友链风险免责声明、失联友链「盼君归」 |
| 5 | **June's Blog** | https://blog.june-pj.cn/ | 「遇事不决，可问春风」 | Hexo 6.0.0 + Twikoo + Algolia | **互链规则写得最规范**：建站半年以上 + 原创 20 篇以上 + 每 3 小时抓一次 RSS + 长期失联移除；评论区「一键填充申请模板」按钮；失联友链专门区块 |
| 6 | **未知之旅** | https://blog.xenosp.cn/ | 在未知中成长 | Hexo 6.3.0 + 安之鱼主题 + Twikoo + Algolia + 51la 统计 | 友链按标签分组（框架/推荐博客/生活/技术/**失效链接**）、项目页、知识库、装备、小目标、DNS 隧道页 |
| 7 | **haohang's Blog** | https://www.shimmerl.top/ | 一位把生活切片都记下来的博主 | **Halo 2.26.1**（Java）+ Artalk | `Ctrl+K` 命令面板搜索、「随机访问」按钮、29 位朋友计数、外部链接离开提示（合规友好）、友链免责声明页 |
| 8 | **Chenli（二月初二）** | https://chenliss.cn/ | 记录与分享生活 | Hexo 6.3.0 + Stellar + **Giscus** | 极简 + 本地搜索（无第三方依赖） |
| 9 | **青桔气球** | https://blog.qjqq.cn/ | 网络安全与科技生活 | Next.js（抓取期间间歇性 DNS 失败，SSL/域名体系在调整中） | 围绕 HTTPS 证书自动续期的工具类内容（和我们 CF 方向接近） |
| 10 | **狼林鱼池** | https://blog.jiyu134.top/ | 随笔 | 不可达（返回空响应，nginx） | ⚠️ 说明：**友链圈里有 10%~20% 的站是死的**，这就是「失联检测」功能的价值来源 |

> **一句话结论**：一级 10 站中 **Hexo 5 家、Next.js 2 家、Astro 1 家、Halo 1 家、不可达 1 家**——Hexo/Butterfly 仍是绝对主流。搜索：**Algolia 4 家**（qcqx / marice / june / xenosp）、本地索引 1 家、自建搜索 API 1 家；评论：**Twikoo 4 家**、Waline / Giscus / Artalk 各 1 家，安之鱼用自建评论 API。
>
> 两个值得注意的信号：①**Algolia 是这个圈子的事实搜索标准，但它是唯一需要第三方 SaaS 的一环**——我们照 §3.1 走本地索引更契合 Cloudflare 全栈定位；②**越来越多头部作者正在离开 Hexo**（安之鱼 → Next.js、刘神 → Astro、小康 → Next.js 系）——我们「手写纯静态站」并不落伍，反而和这条迁移曲线同向。

### 1.3 二级站点（从大佬们的友链页挖出来，精选 16 个）

| # | 站点名 | URL | 定位 | 技术栈 | 亮点/值得抄的点 |
|---|---|---|---|---|---|
| 1 | **张洪Heo** | https://blog.zhheo.com/ | 分享设计与科技（圈子第一流量） | Hexo 8.1.2 + **Twikoo** + **Algolia** + 不蒜子 + PWA | 设计感最强：APlayer、相册、打赏、暗黑、RSS、OG 齐全；被 **8 个不同站点**收录（圈层中心度最高） |
| 2 | **Akilarの糖果屋** | https://akilar.top/ | Hexo Butterfly 生态元老 | Hexo 6.2.0 + Twikoo + Algolia + PWA | 「源计划-方舟：友链卡片」——友链做成产品化卡片;友链示例模板 + 站点关键词标注 |
| 3 | **小康博客 DreamyTZK** | https://www.antmoe.com/ | 收藏回忆 + 技术 | 阿里 ESA 加速（页面含 Next.js 特征） | 内容沉淀型：被 5 站收录；长期高频更新才是护城河 |
| 4 | **云游君** | https://www.yunyoujun.cn | 有趣的人 / Valaxy 作者 | **Valaxy 1.1.0**（自研 SSG）+ Waline + JSON-LD | 友链页**每次刷新随机排序**（公平曝光）；「神隐友链」区（叙事情怀）；已不支持评论区申请，改为专用申请页 |
| 5 | **杜老师说** | https://dusays.com | 师者传道解惑 | Hexo 系 | 极简内容站：JSON-LD + 说说 + RSS；被 3 站收录 |
| 6 | **贰猹的小窝** | https://noionion.top/ | 心得 + 学习记录 | Hexo 5.3.0 + Algolia | 友链规则写得松弛友好：「HTTP/HTTPS 均可，不强制小绿锁，但只有 IP 或带端口的不收」；支持邮件申请 |
| 7 | **山岳库博** | https://kmar.top/ | 二刺螈开发学习 | Hexo + Twikoo + PWA | 被 6 站收录；暗黑 + PWA + RSS 的轻量组合 |
| 8 | **小冰博客** | https://zfe.space/ | 「做个有梦想的人」 | Hexo 5.0.0 + Valine + Algolia，**153 篇文章** | **友链朋友圈（Friend Circle）**实体页；RSSHub 自建 route；打赏；被 4 站收录 |
| 9 | **s1rius' space** | https://blog.s1rius.space/ | 网络安全 / CTF | Hexo 8.1.2 + Algolia + APlayer | 友链要求最细（站点健康、反向链的互惠校验、黑名单）；工具箱导航（CyberChef/反代/revshell） |
| 10 | **小嘉的部落格** | https://blog.imzjw.cn/ | 爱折腾的 Java 开发 | Hexo 7.1.1 + Twikoo/Valine + Algolia | 「先加本站再申请」+ 拒绝 Freenom 免费域名 + 文章量 30+；被 3 站收录 |
| 11 | **风记星辰** | https://www.thyuu.com/ | 热爱你来过的每度温暖 | **WordPress 7.1.3** | 友链卡片显示「第 83 号恒星/该星球距离检测中」+ 有无 RSS 标注；WordPress 主题自带表单式友链申请页（可上传头像信息） |
| 12 | **ichika（星记）** | https://ichika.cc | Hello,gamer! | **Nuxt 4** | 说说 + OG + RSS；被 4 站收录；Nuxt 也是 CF Pages 友好栈 |
| 13 | **Fomalhaut🥝** | https://www.fomal.cc/ | 个人博客 | 静态 + Twikoo 系 | 被 5 站收录（高权重节点） |
| 14 | **HiPeach** | https://blog.opeach.cn | 「妙不可言」 | 静态 + Twikoo 系 | 被 4 站收录 |
| 15 | **葱苓sama** | https://blog.ciraos.top | DARE & DO | 静态 + Twikoo 系 | 被 4 站收录 |
| 16 | **Lete乐特** | https://www.imlete.cn/ | 人生只有一次 | Vercel 部署（轻量 SPA） | 被 3 站收录；Vercel 路线在国内访问不稳定，反面教材 |

### 1.4 圈层权重榜（谁被最多大佬收录 → 优先申请 targets）

统计所有一级/二级友链页的交叉引用次数（排除框架官网）：

| 排名 | 站点 | URL | 被引用次数（跨站） | 备注 |
|---|---|---|---|---|
| 1 | Hexo 官网 | https://hexo.io/ | 22（7 站） | 生态事实标准 |
| 2 | Butterfly 主题 | https://butterfly.js.org/ | 17（6 站） | 最主流 Hexo 主题 |
| 3 | **张洪Heo** | https://blog.zhheo.com/ | **16（8 站）** | ⭐ 最高优先级申请目标 |
| 4 | **Leonus** | https://blog.leonus.cn/ | **14（7 站）** | ⭐ 高优先级（抓取期间 DNS 抖动，明日复查） |
| 5 | **安知鱼** | https://blog.anheyu.com/ | 14（7 站） | ⭐ 我们有天然话题（都做 Cloudflare 全栈） |
| 6 | **Akilarの糖果屋** | https://akilar.top/ | 13（7 站） | ⭐ 高优先级 |
| 7 | **贰猹的小窝** | https://noionion.top/ | 12（6 站） | ⭐ 门槛低、可邮件申请 |
| 8 | **小康博客** | https://www.antmoe.com/ | 12（5 站） | ⭐ |
| 9 | 山岳库博 | https://kmar.top/ | 11（6 站） | ⭐ |
| 10 | June's Blog | https://blog.june-pj.cn/ | 10（5 站） | ⭐ 门槛：原创 20 篇（暂不够） |
| 11 | yyyzyyyz.cn | https://www.yyyzyyyz.cn/ | 11（5 站） | 第二批 target |
| 12 | Fomalhaut🥝 | https://www.fomal.cc/ | 9（5 站） | 第二批 target |
| 13 | 小N博客 | https://www.nesxc.com/ | 8（4 站） | 第二批 target |
| 14 | ichika | https://ichika.cc | 8（4 站） | 第二批 target |
| 15 | HiPeach | https://blog.opeach.cn | 8（4 站） | 第二批 target |

> 计算口径：同一 URL 在多少个不同站点的友链页出现，以及总出现次数；框架官网/社交平台已剔除。样本 = 6 个一级友链页 + 若干二级友链页，合计 1,337 条去重外链。

**申请优先级建议（分三批）**：
- **第一批（本周，门槛友好）**：贰猹 noionion、Akilar、shimmerl(haohang)、imzjw(小嘉)、xenosp(未知之旅)、s1rius
- **第二批（14 天后，文章到 8~10 篇时）**：张洪Heo、小康、山岳库博 kmar、ichika、HiPeach、Fomalhaut
- **第三批（文章 20 篇 + 加入开往之后）**：刘神 liushen、June、轻笑 qcqx、安知鱼（权重最高但门槛也最高）

### 1.5 友链申请条件实测汇总（决定我们的「自荐材料」怎么写）

| 博主 | 先加本站 | 文章数门槛 | 域名/协议要求 | 其他硬性要求 | 申请入口 |
|---|---|---|---|---|---|
| **June** | ✅ 必须 | 原创 ≥20 篇、建站 ≥半年 | 国内可访问；免费域名看质量 | 提供 RSS（**每 3 小时被抓一次**）；长期失联移除 | 评论区（一键填充模板） |
| **s1rius** | ✅ 必须 | ≥10 篇、建站 ≥3 个月 | 优先付费独立域名 | 只收技术类；拒绝商业站；昵称/邮箱/站点需填完整 | 评论区（固定 4 字段模板） |
| **小嘉 imzjw** | ✅ 必须 | ≥30 篇、域名 ≥3 个月 | 拒绝 Freenom 免费域名 | 拒绝涉政黄赌/资源站/商业站 | 评论区 + 留言 |
| **刘神 liushen** | ✅ 互惠说明 | 建议 ≥15 篇 | HTTPS；证书异常即下架 | 连续一周不可访问 → 暂时下架；需提供稳定图片直链 | 独立 `/addlink/` 页 + 评论区 |
| **风记星辰 thyuu** | — | 原创 ≥10 篇 | HTTPS | 表单提交邮箱（用于头像） | 页面表单 |
| **贰猹 noionion** | 优先（加了处理更快） | 只要还在更新 | **HTTP 也可**（不强制小绿锁）；拒绝纯 IP / 带端口 | 拒绝广告 | 留言 / 邮件 noionion@outlook.com |
| **轻笑 qcqx** | — | **建议原创 >6 篇**（最宽松） | — | — | 评论区 + 快速申请模板 |
| **云游君 yunyoujun** | — | — | — | **必须能用 RSS**（他放 feedly 订阅），已不支持评论区申请 | 专用申请页 |
| **安知鱼** | — | — | — | 在线表单（新增/修改工单） | `/link/#apply` 表单 |

**给我们的三条硬约束**：
1. 必须在申请**之前**先把对方加进我们的 `/friends` 页（绝大多数要求「先加后审」，博主要肉眼验证）。
2. **必须提供可用 RSS**：`https://www.520691.xyz/rss.xml`（线上已存在，✅）。圈子里的「友链朋友圈」靠 RSS 抓取，没有 RSS = 拿不到这份额外曝光。
3. 门槛中位数 ≈ **原创 15 篇**。我们目前 4 篇 → 短期内应该主攻「门槛 <10 篇」的博主（贰猹、轻笑、风记、s1rius），不要一上来就去敲 demanding 的 June/刘神，被拒后很难二次申请。

### 1.6 两个流量联盟（不为链接，只为真实访客）

| 项目 | URL | 加入需求（实测） | 我们能过吗 | 价值 |
|---|---|---|---|---|
| **开往 Travellings** | https://www.travellings.cn/ （文档 https://www.travellings.cn/docs/join） | ①建站 ≥2 个月（按第一篇文章算）②**20 篇文章 或 10 篇原创**③半年内必须有更新④**强制 HTTPS**（推荐 HSTS）⑤站内需明显位置放置 `https://www.travellings.cn/go.html`⑥优先自费域名；`eu.org`/`github.io` 审核加严⑦AI 生成内容必须标注且不计入原创 | ❌ 当前 4 篇。<br>✅ 补到 **10 篇原创**后即达标 | 1k+ 成员站点互相随机跳转 → **真实访客分发**，不是虚荣指标 |
| **十年之约**（非营利博客联盟） | https://www.foreverblog.cn/ | 先读《十年公约》，公约页底部提交；核心约定「博客十年不关，一直写」 | ✅ 立即可申请（无硬性篇数门槛） | **1,961 个成员博客、126,743 篇文章、607,072 次虫洞送达**；加入后可放成员徽标（黑色/浅色两版 HTML 现成），文章进全站「最新文章」流 → 被抓取到的机会极高 |

> **CEO 决策点**：十年之约今天就能加（零门槛、零成本），建议今晚就提交；开往等第 10 篇原创落地后立即提交。

---

## 2. 值得抄的功能 Top 12

> 排序 = ROI（价值 ÷ 实现成本）从高到低；难度低 = 1 天内可上线（含移动端），中 = 3~5 天，高 = 1~2 周。
> 「我们现状」基于 2026-10-21 线上实测 https://www.520691.xyz/ 与 posts.json（文章 4 篇）。

| 排名 | 功能 | 我们现状 | 标杆 | 难度 | 抄袭建议（抄到什么程度） | ROI |
|---|---|---|---|---|---|---|
| **1** | **友链页产品化**：卡片化 + 头像/状态点 + 响应时间 + 失联分组 + 一键复制申请模板 | ❌ 有 `/friends` 但信息单薄 | 轻笑 qcqx、安知鱼、s1rius、June | **低** | ①每卡加 `name/link/avatar/descr` 四字段 + 点击「申请互链」复制 YAML 模板；②加"失联友链"折叠区（黑灰底色 + 期待重逢文案）；③卡片右下角显示「响应 xxx ms」（Worker cron 每日巡检写进 JSON）| ★★★★★ |
| **2** | **接入流量联盟**：十年之约成员 + 开往按钮 + 页脚徽标 | ❌ 无 | foreverblog / travellings | **低** | ①立刻申请十年之约，拿到后把官方给的 `<a><img>` 徽标放页脚；②`/friends` 页首屏放「随机逛一个十年之约博客」按钮（直接 href 到 `foreverblog.cn/go.html`）；③达 10 篇原创后加开往 `go.html` 到导航栏 | ★★★★★ |
| **3** | **JSON-LD 结构化数据**：WebSite+SearchAction、文章 BlogPosting、BreadcrumbList | ❌ **完全没有**（实测 `<head>` 无 `ld+json`）| 安之鱼（已验证）、云游君、ichika | **低** | 首页注入 `WebSite + SearchAction`（照抄安之鱼这段 JSON，只改 name/url/模板）；每篇文章生成 `BlogPosting`（headline/datePublished/dateModified/author/image/wordCount）；面包屑用 `BreadcrumbList`。约 60 行 JS 模板字符串 | ★★★★★ |
| **4** | **补全 OG / Twitter 卡片 + 文章级 canonical/og:image** | ⚠️ 有 og:title/desc/type/url + canonical，**缺 og:image、twitter:*、site_name、locale** | 全圈子标配 | **低** | 每篇文章自动注入：`og:image` 用 1200×630 生成图（我们已有 Worker，可写个 `/api/og?title=xxx` 用 SVG→PNG，或直接静态放一张带 emoji cover 的图）；`twitter:card=summary_large_image`；首屏 `og:site_name=渡劫博客` | ★★★★☆ |
| **5** | **修 SEO 基础设施**：sitemap 拆分 + 真实 lastmod + 软 404 修正 | ⚠️ 有但**不合格** | 全圈子 | **低** | ①`www` 的 sitemap 只放 `www` 的 URL；`gjsvip.github.io` 单独一份；用 **Sitemap Index**（`sitemap.xml` → `sitemap-blog.xml` + `sitemap-ghmirror.xml`）；②`lastmod` 换成文章真实发布/修订日期（现在全写成同一天 = 等于没有）；③GitHub Pages 镜像页全部加 `<link rel="canonical" href="https://www.520691.xyz/posts/xxx">`；④**修软 404**：SPA 回退时对未知路径返回 `404` 状态码（现在 `/assets/avatar.png` 都返回 200+HTML，会被搜索引擎判为低质量软 404） | ★★★★★ |
| **6** | **页脚「信任组件」**：建站天数 / 文章数 / 最后更新 / 十年之约徽标 / 随机访问 | ⚠️ 部分有 | 冰火之砺 marice、thyuu、Haohang | **低** | 一行式：`©2024-2026 渡劫博客 · 已运行 XXX 天 · 4 篇文章 · 最后更新 2026-10-22 · [十年之约] [开往] [随机一篇]`。用 posts.json + 一个起始日期即可算出 | ★★★★☆ |
| **7** | **Ctrl+K 升级为全文搜索**（Pagefind 本地索引） | ⚠️ 有 Ctrl+K，但只索引标题/摘要/标签 | Pagefind 方案见 §3.1 | **中** | 先把 `posts.json` 扩展出一个 `full.json`（正文去标签后文本，4 篇约 30KB，50 篇也才 400KB，可 gzip 分块懒加载）；≥50 篇时切 **Pagefind**（`npx pagefind --site dist --force-language zh`，必须放构建最后一步） | ★★★★☆ |
| **8** | **文章元数据条**：字数 / 阅读时长 / 最后更新时间 / 点赞+浏览合并显示 | ⚠️ 有点赞/浏览量，缺字数与阅读时长 | 全圈子 | **低** | 渲染时 `字数 = 正文去标签长度`，`阅读时长 = Math.ceil(字数/400)` 分钟；日期区分「发布于 / 更新于」（更新字段对 SEO 新鲜度有正向作用） | ★★★☆☆ |
| **9** | **「随机一篇」+ 外部随机入口** | ❌ 无 | 安知鱼（Shift+R）、shimmerl、marice、云游君 | **低** | 内部：随机跳一篇文章（提升停留深度、降低跳出率）；外部：`/friends` 页放「随机去下一个独立博客」→ foreverblog 虫洞 / 开往。成本不到 20 行代码，对爬虫的内链网络也友好 | ★★★★☆ |
| **10** | **PWA**（manifest + SW 离线缓存） | ❌ 无（无 manifest link） | 安知鱼、heo、akilar、marice、kmar、s1rius 均有 | **中** | 加 `manifest.webmanifest`（name=渡劫博客、icons、theme_color）+ 一个 20 行的 SW 缓存 `index.html/style.css/blog.js/posts.json`。CF Pages 天然支持。**先做 manifest（半天），SW 可后置** | ★★★☆☆ |
| **11** | **友链朋友圈**（抓所有友链 RSS，聚合最新文章） | ❌ 无 | 小冰 zfe、轻笑、marice、xenosp、June（3 小时抓一次） | **中~高** | 我们有 Worker+D1 的全栈能力，做这个比 Hexo 圈的人容易得多：`cron */180 * * * *` → 抓 feeds 表 → 写 D1 → `/friends` 页瀑布流展示。**但建议放到「友链数 ≥15 且文章 ≥10 篇」之后**，现在做是给别人的站导流量 | ★★☆☆☆（现在） / ★★★★☆（3 个月后） |
| **12** | **订阅体系**：RSS 引导页 + 邮件订阅（Worker + D1） | ⚠️ 有 RSS，无订阅页/邮件 | 刘神（订阅本站）、轻笑（RSS+Sitemap 双入口） | **中** | ①`/subscribe` 页（RSS 地址、Follow 按钮、邮件输入框）；②Worker 加 `/api/subscribe` 写 D1 + Cron 发新文通知（CF Workers **不能直连 SMTP**，需走 SendGrid / MailChannels / Resend API——这点 Twikoo 也踩了同样的坑） | ★★★☆☆ |

**候选（暂不排期，先记下来）**：打赏/赞赏（圈子里人人都有，但我们暂无流量，收益极低）；APlayer 音乐；相册集；吐槽/说说已有；「装备/我做过的项目」展示页（Xenosp 的我的装备、刘神的设备页——成本极低、人格感强，建议选一个做）。

---

## 3. 技术架构启发

### 3.1 静态搜索：本地索引 vs 第三方（结论：我们走「本地」，≥50 篇再上 Pagefind）

| 方案 | 圈子采用情况 | 优点 | 缺点 | 是否适合我们 |
|---|---|---|---|---|
| **Algolia** | 事实标准：张洪Heo、Akilar、June、贰猘、xenosp、s1rius、imzjw、qcqx 全在用 | 体验最好（拼音/错字容错）、零运维 | 需 Node 构建推 index（`hexo-algoliasearch`）、免费额度有上限、依赖第三方、**国内访问速度一般**、我们这种手写站接入成本最高 | ❌ 不建议 |
| **Pagefind**（静态索引） | 新锐：eallion.com、wiloon.com 等现代静态站在用 | 构建后跑一条命令；**Rust 实现 + WASM**，索引分片按需加载（单次搜索只拉几十~几百 KB）；**支持中文分词**（`--force-language zh`，需 extended 版，默认 `npx pagefind` 即带）；零后端、零费用、可离线 | 必须在**每次构建后**重新跑索引（漏跑 = 新文章搜不到）；局限：索引是公开静态资源，登录可见内容不能进索引 | ✅ **推荐（≥50 篇时）** |
| **Fuse.js / 本地 JSON 索引** | 我们现在的方式；陈YF/Stellar 主题的 local_search 同路线 | 零依赖、完全可控、和 CF 栈最搭 | 全文索引体积随篇数线性增长；无分词（中文子串匹配质量差） | ✅ **现在就用**（补全文 + 简单分词） |
| Meilisearch / Typesense | 几乎没人在用 | 强 | 要跑服务，违背我们「零 VPS」原则 | ❌ |

**具体落地**：
1. 立刻：把 `posts.json` 扩展为「标题 + 摘要 + 标签 + 正文纯文本」的 `search-index.json`，实测 4 篇约 30 KB；按 50 篇估算也不到 500 KB，gzip 后 ~120 KB，可接受。中文检索做 **bigram 切词**（把「cloudflare 部署」切成 `cloudflare`、`部`、`部署` 等二元组）即可大幅好于现在的子串匹配。
2. 50 篇以后：CI 里加一步 `npx pagefind --site dist --force-language zh`（**必须放在所有 HTML 生成之后**），UI 沿用现有 Ctrl+K 面板改写即可。
3. 永远别忘：JSON-LD 里的 `SearchAction` 指向 `https://www.520691.xyz/search?q={search_term_string}`（照抄安之鱼），让 Google 能在搜索结果里直接出现站内搜索框。

### 3.2 评论系统对比：Twikoo / Waline / Giscus vs 我们的自建 D1

| 方案 | 代表站 | 优点 | 缺点 |
|---|---|---|---|
| **Twikoo** | 圈子里 >50%：Heo、Akilar、June、xenosp、marice、kmar、imzjw | 后台管理、邮件通知、图片编辑、导出导入、腾讯云 Lighthouse 一键部署；**2026 年官方已支持 Cloudflare Workers + D1**（需 `nodejs_compat`，据实测：D1 模式首次请求自动建表、评论读写 + DOMPurify + IP 属地 + 管理员登录均正常；**直连 SMTP 在 Workers 上不可用**，需走 SendGrid/MailChannels API） | 引入他人后端；Workers + D1 版本仍有一些兼容性限制（早期版 ip2region、axios 等需打包替换） |
| **Waline** | 轻笑 qcqx、云游君 | UI 好看、Markdown 支持好 | 传统上需 Node 服务 + SQLite/MySQL（或 Vercel 绑定 LeanCloud），运维比 Twikoo 重 |
| **Giscus** | chenliss | 零后端（GitHub Discussions）、天然反垃圾 | **要求访客有 GitHub 账号** → 国内留言转化率极低；评论区数据不在自己手里 |
| **我们：自建 CF Worker + D1** | 只有我们 😎 | ①域名可控 `dujiecone.520691.xyz`，**国内可达**（Workers 自定义域 + CF 全球节点）②数据与账号体系统一（和渡劫code 共用 CF 账号）③三端站共用一套评论④**内容资产**：《CF D1 + Worker 自建评论》这篇文章已发布，是这个圈子里的稀缺话题 | 缺：管理后台、垃圾评论过滤、邮件通知、备份导出、审核队列 |

**决策：保留自建，补齐 4 件东西（成本 3~5 天）**
1. **管理入口**：一个 `ADMIN_TOKEN` 保护的 `/api/admin/comments`（列表/删除/隐藏），前端做个密码登录后即可操作的简单页（不需要完整后台 UI）。
2. **反垃圾**：Cloudflare **Turnstile**（免费、国内可过）+ 关键词黑名单 + 同一 IP 频率限制（D1 里记 ip + 时间戳即可，或用 KV）。
3. **通知**：Workers 不能直连 SMTP → 用 **Resend 或 SendGrid HTTPS API**（Twikoo 官方也说这是唯一可行路径）。
4. **备份**：每周 Cron 导出全表 JSON 到 R2（`dujie-comments/2026-10-21.json`），10 行代码，杜绝「D1 误删 = 评论全没」。

> **额外收益**：把这套评论后端整理成开源项目 `dujie-comment`（写进 README 里「为什么不用 Twikoo」），它本身就是**友链申请的敲门砖**——「我给你带了一个可以一键部署到 CF 的评论系统」比「你好，能换个友链吗」有用 10 倍。

### 3.3 SEO 具体做法（照着改逐条勾）

**A. JSON-LD（我们现在 0，安之鱼有，必须抄）**

```html
<!-- 首页：WebSite + SearchAction（sitelinks 搜索框） -->
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"WebSite","name":"渡劫博客",
 "description":"渡劫code —— Web 版 AI 编程工作台 + Cloudflare 全栈技术博客",
 "url":"https://www.520691.xyz",
 "potentialAction":{"@type":"SearchAction",
   "target":{"@type":"EntryPoint","urlTemplate":"https://www.520691.xyz/search?q={search_term_string}"},
   "query-input":"required name=search_term_string"}}
</script>

<!-- 每篇文章：BlogPosting -->
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BlogPosting","headline":"标题",
 "datePublished":"2026-10-22","dateModified":"2026-10-22",
 "author":{"@type":"Person","name":"gjsvip"},
 "publisher":{"@type":"Organization","name":"渡劫博客"},
 "image":"https://www.520691.xyz/assets/og/xxx.png",
 "mainEntityOfPage":"https://www.520691.xyz/posts/xxx"}
</script>

<!-- 面包屑 BreadcrumbList：首页 > 文章  -->
```

**B. OG / Twitter**（缺：`og:image`、`og:site_name`、`og:locale`、`twitter:card/summary_large_image`）
- og:image 建议做一个 `/api/og?title=&date=` 的 Worker 路由，返回 1200×630 PNG；没有 Worker 图片能力时，退化方案：为每篇文静态生成一张。

**C. canonical**
- 主域 `https://www.520691.xyz/...`；
- `blog.520691.xyz` 与 `gjsvip.github.io/blog/*` 的每个页面必须 `canonical` 指向 `www`（现在是重复内容风险）；
- URL 统一用「无尾斜杠」一种形式，别两种都 200。

**D. sitemap 组织**
```
https://www.520691.xyz/sitemap.xml          ← Sitemap Index（根，robots.txt 指向它）
   ├─ https://www.520691.xyz/sitemap-blog.xml    （只含 www 的 URL，含真实 lastmod）
   └─ https://gjsvip.github.io/blog/sitemap-mirror.xml（镜像站自己的）
```
- 每个主机自己的 `robots.txt` 只写自己的 Sitemap 行（现在 www 的 robots 指向自己的 sitemap ✅）。
- `lastmod` = 文章真实 `date`（要包含 `dateModified` 语义），不要全写同一天。

**E. 其它**：每篇文章底部放「相关文章 3 篇」内链；`<html lang="zh-CN">`；图片加 `alt` 和 `loading="lazy"`；所有外链 `rel="noopener"`；修复软 404（见 §2-5）。

---

## 4. 8 篇文章选题清单（4 周排期）

> 定位锚：「渡劫code（Web 版 AI 编程工作台）+ 静态博客 + Cloudflare 全栈」。每篇都同时满足：**搜索关键词真实存在** / **我们能拿出一线实测数据** / **能给渡劫code 导流**。
> 目标：**先把站加到 10 篇原创以上**（解锁开往 + 大部分友链门槛），再谈质量曲线。

| # | 标题 | 一句话定位 | 目标关键词 | 大纲要点 | 内链/转化钩子 |
|---|---|---|---|---|---|
| 1 | **《Cloudflare D1 + Worker 自建评论系统：表设计、接口契约与反垃圾三件套》** | 把已发布的 D1 评论文章升级为「可复用的完整设计方案」 | `cloudflare d1 评论系统`、`cloudflare workers 自建评论`、`twikoo 替代方案` | ①为什么不用 Twikoo/Waline/Giscus（真实对比表）②D1 表结构（comments/paths/likes，含索引设计）③REST 契约：`GET /api/comments?slug=`、`POST`、`DELETE` 的鉴权 ④Turnstile + 黑名单 + KV 限流 ⑤Cron 导出到 R2 做备份 ⑥开源仓库 link | 直接推 `dujie-comment` 开源 → 天然友链素材 |
| 2 | **《纯静态博客怎么做全文搜索：Pagefind / Fuse / Algolia 三种方案实测》** | 我们在做的选择题，就是这个圈子里所有人都在做的选择题 | `静态博客 全文搜索`、`pagefind 中文分词`、`静态站 algolia 替代` | ①三方案成本/体积/中文分词能力对比表 ②Pagefind：`--force-language zh` 的坑、为什么必须放在构建最后一步 ③体积实测数据（我们自己的 index JSON 多大、gzip 后多大）④Ctrl+K 面板接法 ⑤什么时候该从 Fuse 切到 Pagefind | 引导到站内 Ctrl+K 体验；可发给 Akilar/Heo 做申请话题 |
| 3 | **《一次 push 三端上线：GitHub Actions 同步 GitHub Pages / Gitee / Cloudflare Pages 全记录》** | 把三端同步的工程细节讲透，附可用 workflow | `github actions 同步 gitee`、`cloudflare pages github actions`、`静态博客 多端部署` | ①为什么要三个备份站（国内可达性 vs CF 速度）②workflow 完整 YAML（含 secrets 清单）③Gitee Pages 需手动点「更新」的现实 & 绕法 ④镜像站 canonical 处理 ⑤踩坑： Assets 路径、`.nojekyll`、缓存失效 | 引流到 GitHub 仓库 star |
| 4 | **《浏览器里写代码：渡劫code 的架构拆解（对话式编程 + Monaco + 虚拟 Shell + 远程执行）》** | 主打产品发布 + 技术深度，是我们最有差异度的一篇 | `网页版 ai ide`、`monaco editor 云端 ide`、`browser ide 架构` | ①为什么不做一个 Electron/客户端 ②对话式编程如何落到文件 diff ③Monaco 选型与体积治理（worker/Vite 分包）④虚拟 Shell 的指令解析与 UI ⑤远程执行后端的沙箱边界与安全限制 ⑥成本：全部跑在 CF Workers/Pages/D1/KV/R2 | 首屏 → https://dujiecone.520691.xyz 试用 |
| 5 | **《Cloudflare 免费套餐能撑多大一个博客？Workers/Pages/D1/KV/R2 配额实测》** | 搜索量稳定、收藏率高，长期给站带来长尾 | `cloudflare 免费额度`、`cloudflare d1 配额`、`cloudflare workers 免费额度` | ①五大服务的免费额度表（逐项列 vs 我们的真实用量）②什么时候会开始扣钱 ③D1 行数/查询耗时实测 ④国内访问路径（workers 自定义域 vs workers.dev）⑤把超限风险做软降级（比如请求直接失败而非产生费用） | 引出「我们这套站每月成本 0 元」 |
| 6 | **《静态博客 SEO 全链路：JSON-LD / OG / canonical / sitemap / IndexNow 一次做对》** | 把本次 SEO 落地过程写成教程，边做边发 | `静态博客 seo`、`json-ld 博客 sitemap`、`google search console 提交 静态站` | ①结构化数据三件套模板（可直接抄）②OG 图 1200×630 生成方案 ③canonical 与镜像站的处理 ④sitemap index 组织 ⑤IndexNow 批量提交脚本（我们已跑过 IndexNow，202/200 实证）⑥GSC/Bing/百度各入口与周期（实测差异：百度 1~4 周、IndexNow 1~3 天） | 文末附上我们的 sitemap / robots 作样板 |
| 7 | **《友链不是摆设：用 Cloudflare Cron 做友链健康巡检》** | 把「抄袭的功能」变成自己的原创内容与工具 | `友链 检测`、`cloudflare cron triggers`、`friend link 失效检测` | ①为什么圈子里 ~10~20% 的友链是死的（实测数据：轻笑博客 192 张友链卡中有 **23 张 ERR 不可达、51 张响应超 10 秒**，亚健康率 38.5%；我们抽样的一级 10 站中也有 1 站已打不开）②Cron + D1 建表 `friend_links(url,last_ok,latency)` ③每 6 小时 fetch HEAD 记录 latency/失败次数 ④失联自动折叠 + 恢复自动上线 ⑤顺手抓 RSS 做「友链朋友圈」 | 提供免费 API → 友链互换敲门砖 |
| 8 | **《一个 CF 账号撑起 IDE + API + 博客：域名规划与 DNS 治理实践》** | 总结我们的多子域体系，面向「一个人管一堆服务」的开发者 | `cloudflare 多服务 域名规划`、`cloudflare dns 子域名`、`workers 路由 绑定` | ①域名地图（主域/别名/GH Pages 镜像/Worker API）②Workers 自定义域 vs Routes 的取舍 ③CORS 跨域调用 API 的正确姿势 ④三端同源的取舍（为什么不做同源代理）⑤备份与回滚：一次配错影响几个服务 | 画一张架构图 → 社媒易传播 |

**备选（第 9、10 篇）**：
9. 《独立博客怎么拿第一批流量：十年之约 / 开往 / 个站商店 加入实录》—— 直接给同行抄作业，天然适合被友链转发。
10. 《我把 RSS 做成了流量引擎：自建友链朋友圈的 37 天》—— 承接第 7 篇的数据。

**排期建议**：每周 2 篇，第 1~5 篇优先（第 4 篇发完即可开始批量申请第一批友链；第 10 篇落地后申请开往）。

---

## 5. 友链申请模板

> 使用说明：
> 1. **申请前先把对方加到我们的 `/friends` 页**（80% 的博主会肉眼验证，不加必拒）；
> 2. 群里优先用「评论区版」，90% 的站只接受评论/留言申请；只有提供表单/邮箱的站才用「邮件版」；
> 3. 一次性给全 `name/link/avatar/descr/siteshot(可选)/rss` 五字段，能显著加快通过（博主最烦来回问）；
> 4. 头像直链请先用浏览器确认返回的是图片而不是 HTML（我们自己刚在 avatar 路径上踩了这个坑）。

### 5.1 变体 A：评论区 / 留言板版（默认）

```markdown
你好呀，我是「渡劫博客」的站长 gjsvip（渡劫）。

已经在贵站看了几篇文章（尤其喜欢 xxx 那篇），学到不少，想和你换个友链。
贵站的链接我已经先加好了，随时可以来查：https://www.520691.xyz/friends

- name: 渡劫博客
- link: https://www.520691.xyz
- avatar: https://www.520691.xyz/assets/avatar.png
- descr: 一个人折腾的 Web 版 AI 编程工作台（渡劫code）+ Cloudflare 全栈技术博客
- rss: https://www.520691.xyz/rss.xml

不方便的话完全没关系，直接忽略这条就好，祝站点越写越好 🌱
```

**更简短的「一句话版」（评论区允许、实在怕打扰时用）**：

```markdown
你好，渡劫博客（https://www.520691.xyz）已先添加贵站，想互换友链方便的话回加即可，不方便忽略就好～
name: 渡劫博客 / link: https://www.520691.xyz / descr: Web 版 AI 编程工作台 + Cloudflare 全栈博客 / rss: https://www.520691.xyz/rss.xml
```

### 5.2 变体 B：邮件 / 表单版（给刘神、贰猹这类明确接受邮件的站）

```
主题：友链申请｜渡劫博客（https://www.520691.xyz）

你好，我是 gjsvip（渡劫），一个人做「渡劫code」——一个打开网页就能写代码的 Web 版 AI 编程工作台，
顺手用 Cloudflare 全栈搭了个人博客「渡劫博客」，记录 Cloudflare Workers / D1 / Pages 和 AI 编程工作台的实战笔记。

看你博客很久了，特别是 [某篇文章名] 那篇对我启发很大。
如果你愿意交换友链，我这里的信息如下（贵站链接我已经先加好：https://www.520691.xyz/friends）：

  站点名称：渡劫博客
  站点地址：https://www.520691.xyz
  站点简介：Web 版 AI 编程工作台（渡劫code）+ Cloudflare 全栈技术博客，记录 Workers / D1 / Pages 与 AI 编程的踩坑实录
  站点头像：https://www.520691.xyz/assets/avatar.png
  订阅地址：https://www.520691.xyz/rss.xml

如果暂时不方便交换也没关系，打扰了。祝顺利，期待你的更新 🙌

gjsvip / 渡劫
https://www.520691.xyz
```

**配套：我们 `/friends` 页要公开展示自己的卡片（供别人复制）**

```yaml
- name: 渡劫博客
  link: https://www.520691.xyz
  avatar: https://www.520691.xyz/assets/avatar.png
  descr: 渡劫code —— Web 版 AI 编程工作台 + Cloudflare 全栈技术博客
  siteshot: https://www.520691.xyz/assets/siteshot.png   # 建议补一张 1200×630 截图，圈子已普遍要求
  rss: https://www.520691.xyz/rss.xml
```

---

## 6. SEO 收录执行清单

### 6.1 搜索引擎入口 + 我们的地址（逐条打勾）

| 渠道 | 后台入口 | 验证方式 | 要提交的地址 | 预期周期 |
|---|---|---|---|---|
| **Google Search Console** | https://search.google.com/search-console | DNS TXT（域名资源，一次覆盖所有子域，推荐）或 HTML 文件 | `https://www.520691.xyz/sitemap.xml` | 1~7 天 |
| **Bing Webmaster Tools** | https://www.bing.com/webmasters | IndexNow key 文件已部署在各站根目录（key `31cc0198701c4fe594f4064e87007b54`）或 DNS TXT | `https://www.520691.xyz/sitemap.xml` | 1~3 天（IndexNow 已通，最快） |
| **百度搜索资源平台** | https://ziyuan.baidu.com | HTML 验证文件（下载后放到站根目录）+ 建议同时做「普通收录」手动推送 | `https://www.520691.xyz/sitemap.xml` | 1~4 周（不认 IndexNow） |
| **360 搜索站长** | https://zhanzhang.so.com | HTML 验证文件 | 同上 | 1~3 周 |
| **搜狗站长** | https://zhanzhang.sogou.com | HTML 验证文件 | 同上 | 1~3 周 |
| **神马/头条搜索** | https://zhanzhang.toutiao.com | HTML 验证 / API 推送 | 同上 | 1~3 周 |
| **IndexNow 批量推送** | https://www.indexnow.org/ + `/scripts/` 已有脚本 | — | 每次发文后重跑一次（覆盖 Bing/Yandex/Seznam/Naver） | 1~3 天 |

**我们的站点与 sitemap 地址清单（建议每个都单独验证一遍）**

| 主机 | sitemap | robots | 说明 |
|---|---|---|---|
| https://www.520691.xyz | `/sitemap.xml`（另有 `/sitemap.txt`） | `/robots.txt` ✅ 已含 Sitemap 行 | **主域，canonical 目标** |
| https://blog.520691.xyz | `/sitemap.xml` ✅ 可达 | 建议加 | 别名，每个页面 canonical → www |
| https://gjsvip.github.io/blog/ | `/blog/sitemap.xml` ✅ 可达 | GitHub Pages 默认 | 国内可达镜像，**必须 canonical → www** |
| https://dujiecone.520691.xyz | Worker API 主域 | — | 评论区 API，不建议给爬虫，robots 里 `Disallow: /api/` |
| https://gjsvip-blog.pages.dev 等 CF 镜像 | 待补 | 建议 robots 里 `Disallow: /` 或直接 canonical | 避免重复内容 |

### 6.2 页面级优化清单（逐条勾选）

```
[ ] ★ P0  修软 404：未知路径返回 HTTP 404 + 404 页面（现在 /assets/avatar.png 也返回 200 + text/html）
[ ] ★ P0  全站改名「渡劫小站」→「渡劫博客」：title / description / OG title / RSS title / manifest / 友链模板 name / 页脚
[ ] ★ P0  sitemap：①拆出 Sitemap Index ②lastmod 换成文章真实日期 ③www 的 sitemap 移除 gjsvip.github.io 的 URL
[ ] ★ P0  镜像站 canonical：blog.520691.xyz 与 gjsvip.github.io/blog/* 全站 <link rel="canonical" href="https://www.520691.xyz/...">
[ ] ★ P0  RSS link 改绝对地址：href="rss.xml" → href="https://www.520691.xyz/rss.xml"
[ ]   JSON-LD：首页 WebSite + SearchAction；每篇文章 BlogPosting；面包屑 BreadcrumbList
[ ]   OG：补 og:image（1200×630）、og:site_name、og:locale、twitter:card=summary_large_image
[ ]   <html lang="zh-CN"> + 每个页面唯一且含关键词的 <title>（≤60 字）
[ ]   robots.txt：Disallow: /api/ 与 CF Pages 预览/镜像域
[ ]   每篇文章底部「相关文章 3 篇」内链 + 标签页/归档页互链
[ ]   img 全部加 alt + loading="lazy"；外链 rel="noopener"
[ ]   页脚信任组件：建站天数 / 文章数 / 最后更新 / 十年之约徽标
[ ]   /friends 页：卡片化展示 + 一键复制申请模板 + 失联折叠区
[ ]   manifest.webmanifest（name=渡劫博客）+ 主题色
[ ]   订阅页 /subscribe + RSS 按钮（顶栏或页脚常驻）
[ ]   文章元信息：字数 / 阅读时长 / 更新于
[ ]   发文后例行：跑一次 IndexNow 脚本；GSC「网址检查」手动请求编入索引（急用时）
```

---

## 7. 建议排期（给 CEO 的决策表）

| 时间窗 | 动作 | 负责人建议 | 完成判定 |
|---|---|---|---|
| **本周（Day 1-3）** | ①改名全量替换 ②修软 404 ③sitemap 拆分 + lastmod ④RSS 绝对地址 ⑤首页注入 JSON-LD | 前端/工程师 | GSC 抓取无 404 页面；Rich Results Test 通过 WebSite/BlogPosting |
| **本周（Day 4-7）** | ①十年之约提交申请 ②`/friends` 卡片化 + 申请模板复制 ③页脚信任组件 ④发第 1、2 篇文章 | PM + 工程师 | `/friends` 有 8+ 张卡（含我们自己的卡片模板） |
| **第 2 周** | ①第一批友链申请（6~8 家，逐个先加后申）②第 3、4 篇文章 ③og:image 生成方案 ④GSC/Bing/百度/360/搜狗全部验证完成 | PM | 至少 3 个站回链 |
| **第 3-4 周** | ①文章达 10 篇原创 → 提交「开往」 ②第二批友链申请（Heo/小康/Akilar/ichika 等）③Workers 评论补齐：管理入口 + Turnstile + R2 备份 | PM + 工程师 | 开往通过；评论后台可完成列表 / 隐藏 / 删除，并自动备份到 R2 |
| **第 2 个月** | ①Ctrl+K 全文索引 ②PWA ③友链朋友圈（≥15 个友链时启动）④ `dujie-comment` 开源 | 工程师 | 友链朋友圈上线，每 3 小时抓一次 RSS |

---

## 附录 A：本次研究发现的自家问题清单（可直接转给工程师）

| 严重级 | 问题 | 证据 | 建议修法 |
|---|---|---|---|
| P0 | **软 404**：任意路径返回 200 + HTML | `https://www.520691.xyz/assets/avatar.png` → `HTTP/2 200, content-type: text/html` | CF Pages 上 SPA fallback 应对未知路径返回 404；或改 `_redirects` + 404.html 并正确 set status |
| P0 | **站名未改**：CEO 已指示改「渡劫博客」，线上仍为「渡劫小站」 | `<title>渡劫小站 · 独立开发者的技术自留地</title>`、`<link rel="alternate" title="渡劫小站 RSS">` | 全局替换 title/description/RSS title/manifest，并连带改友链模板 name 字段 |
| P0 | **sitemap 跨域 + lastmod 全同** | `sitemap.xml` 内含 `https://gjsvip.github.io/blog/*`；所有 `<lastmod>2026-10-22</lastmod>` | Sitemap Index 拆分 + 用文章真实 date |
| P1 | RSS link 用相对路径 | `<link rel="alternate" ... href="rss.xml">` | 改绝对 URL |
| P1 | 无 JSON-LD | 首页 head 无 `application/ld+json` | 加 WebSite+SearchAction / BlogPosting |
| P1 | 缺 og:image / twitter:card | head 只有 og:title/desc/type/url | 生成 1200×630 OG 图并注入 |
| P2 | 头像/截图直链缺失 | `/assets/avatar.png` 返回 HTML | 提供真实 PNG 头像与 1200×630 siteshot，供友链申请使用 |

## 附录 B：研究方法与数据可靠性说明

- 所有技术栈判断来自**页面原始 HTML**：`<meta name="generator">`、CDN/资源特征串、自有 API 路径（例：安之鱼通过渲染 Next.js 的 `/api/public/links` 直接拿到友链 JSON，比解析页面更可靠）。
- 每位站点的「亮点」来自首页/友链页/关于页的实际 DOM 文本，不含推测；对无法访问的站点（如 blog.leonus.cn 抓取期间 DNS 失败、blog.jiyu134.top 返回空）已在表中标注，不假装了解。
- 圈层权重 = 某 URL 在多少个不同站点的友链页出现 + 总出现次数，纯客观计数。
- 竞品周边信息（Twikoo CF Workers 支持情况、Pagefind 中文分词参数）已交叉核对官方文档与 2026 年实测博客，重要结论均标注了来源。
