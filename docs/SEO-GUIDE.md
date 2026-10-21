# 收录与 SEO 指南 — 520691.xyz 域名体系

> 生成时间：2026-10-20 ｜ 账号：345 CF 账号（3450211748@qq.com，<345 账号 ID>）

## 一、域名全景（全部已上线）

| 站点 | 域名 | 用途 |
|---|---|---|
| 渡劫code 主域 | https://dujiecone.520691.xyz | Cloudflare Worker + D1/KV/R2 |
| 个人官网 | https://www.520691.xyz | Cloudflare Pages（gjsvip-homepage） |
| 博客 | https://www.520691.xyz | Cloudflare Pages（gjsvip-blog） |
| Pages 镜像 | https://dujiecode-9ka.pages.dev | 渡劫code 备用 |
| 官网镜像 | https://gjsvip-homepage.pages.dev | 官网备用 |
| 博客镜像 | https://gjsvip-blog.pages.dev | 博客备用 |
| GitHub Pages | https://gjsvip.github.io | 国内可达镜像（/blog/ 为博客） |

## 二、已自动完成的收录动作

1. **IndexNow 全量提交**（HTTP 202/200，共 7 个主机 17 个 URL）— Bing / Yandex / Seznam / Naver 已接收，通常 1-3 天收录
   - Key：`31cc0198701c4fe594f4064e87007b54`（全部 7 主机根目录均有验证文件）
2. **sitemap.xml + robots.txt**：全部 7 主机已部署，互相关联
3. **Google sitemap ping**：已发出（沙箱出口不通，以 Search Console 为准）

## 三、待手工操作（按推荐顺序）

### 1. Bing Webmaster Tools（最重要，IndexNow 已通）
1. 登录 https://www.bing.com/webmasters
2. 「添加站点」→ 选「Import from Google Search Console」或手动添加上述 7 个域名
3. 验证方式推荐 **IndexNow key 验证**（key 已在各站根目录）或 DNS TXT
4. 每个站点提交 sitemap：`https://<域名>/sitemap.xml`

### 2. Google Search Console
1. 登录 https://search.google.com/search-console
2. 「添加资源」→ 域名资源（DNS TXT 验证）或网址前缀（HTML 文件验证）
3. 每个站点提交 `https://<域名>/sitemap.xml`
4. 可用「网址检查」工具手动请求编入索引

### 3. 百度搜索资源平台
1. 登录 https://ziyuan.baidu.com
2. 「用户中心」→「站点管理」→ 添加网站（选 HTTPS 协议）
3. 下载验证文件（如 `baidu_verify_xxxx.html`）**发我**，我放到各站根目录完成验证
4. 验证后提交 sitemap：`https://<域名>/sitemap.xml`
5. 注意：百度不认 IndexNow，收录周期 1-4 周

### 4. Gitee Pages 国内镜像恢复（唯一剩余部署项）
1. 打开 https://gitee.com/dujie_nb_admin/dujiecode
2. 右上角「管理」→「服务」→「Gitee Pages」
3. 选择分支 **gh-pages**（已由 GitHub Actions 自动同步）
4. 点击「更新」→ 等待 1-2 分钟
5. 访问 https://dujie_nb_admin.gitee.io/dujiecode/ 验证

### 5. 可选：360 / 搜狗 / 头条搜索
- 360：https://zhanzhang.so.com （同百度流程，验证文件可发我放置）
- 搜狗：https://zhanzhang.sogou.com
- 头条：https://zhanzhang.toutiao.com

## 四、日常维护

- 每次 push 到 GitHub → Actions 自动部署 CF（Worker/Pages）+ 同步 Gitee + 更新 GitHub Pages 镜像
- 新页面/文章上线后无需手动提交：在 sitemap.xml 中登记即可被周期抓取；急用可再跑一次 IndexNow（脚本见 `scripts/` 或联系 CEO）
- IndexNow key 文件已随站部署，换 key 需同步替换 7 主机根目录文件

## 五、Secrets 配置清单（GitHub 仓库）

| 仓库 | Secret | 值 |
|---|---|---|
| gjsvip/dujiecode | CF_API_TOKEN | <账号级 API 令牌（值见仓库 Secrets CF_API_TOKEN）> |
| gjsvip/dujiecode | CLOUDFLARE_ACCOUNT_ID | <345 账号 ID> |
| gjsvip/blog | 同上两项 | 同上 |
| gjsvip/homepage | 同上两项 | 同上 |

> CF 令牌说明：`cfat_` 账号级令牌负责 Pages/Worker/D1 部署；`cfut_` 用户级令牌（Zone.DNS Read）备用；DNS 写入与 Workers 域名绑定使用 Global API Key（仅本地 CLI 使用，勿入仓库）。
