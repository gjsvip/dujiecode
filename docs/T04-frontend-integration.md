# T04 前端集成契约（博客仓库）

| 项 | 值 |
|---|---|
| 文档 ID | T04-frontend-integration |
| 对应设计 | `docs/ARCH-T04-COMMENT-ADMIN-2026-10-21.md`（Worker 侧实现，本仓库 dujiecode） |
| 落地仓库 | 博客仓库（gitee dujie_nb_admin/blog，CF Pages https://www.520691.xyz） |
| API 基址 | `https://dujiecone.520691.xyz` |

> 本文件是博客侧前端改动的**唯一契约**：`assets/blog.js`、`admin/index.html` 按本文实现。
> 灰度开关以后端 KV 为唯一事实源，前端只读 config——即使前端晚于 Worker 上线，也不影响后端灰度。

## 1. GET /api/blog/config（公开，无鉴权）

- 响应头：`Cache-Control: public, max-age=60`。
- 响应体：

```json
{ "code": 0, "data": {
  "turnstile": { "enabled": false, "siteKey": "", "failOpen": true },
  "moderation": { "enabled": false },
  "notify": { "enabled": true }
} }
```

| 字段 | 前端用途 |
|---|---|
| `turnstile.enabled` | 是否加载 Turnstile widget 并在提交时带 token |
| `turnstile.siteKey` | widget sitekey（后端注入，**不硬编码在 blog.js**，轮换免发版） |
| `moderation.enabled` | `true` 时提交成功提示「已提交，待审核后展示」 |
| `notify.enabled` | 仅展示用（前端无行为差异） |

**降级**：config 请求失败/超时 → 按「全关」保守处理（不渲染 widget、评论走旧流程），
可用 localStorage 5 分钟缓存减少请求（见 §3.1）。

## 2. POST /api/blog/comments（公开）

请求体新增字段：`turnstileToken?: string`（≤2048，widget callback 取得）。
响应：`201 { "code": 0, "data": { "id": 42, "status": "approved" } }`
（`status` 为新增字段，旧前端读 `id` 不受影响）。

错误码（前端需处理）：

| HTTP | code | 前端动作 |
|---|---|---|
| 400 | `TURNSTILE_TOKEN_MISSING` | `turnstile.reset()`，提示「请完成人机校验」 |
| 403 | `TURNSTILE_FAILED` | `turnstile.reset()`，提示「人机校验未通过，请重试」 |
| 503 | `TURNSTILE_UNAVAILABLE` | 提示「校验服务暂不可用，请稍后重试」（fail_open=0 时出现） |
| 403 | `BANNED` | 提示「评论被拒绝，如有疑问请联系博主」 |
| 429 | `RATE_LIMITED` | 提示「评论太频繁了，休息一分钟再来吧」 |
| 400 | `BAD_JSON`/`BAD_SLUG`/`BAD_NICKNAME`/`BAD_EMAIL`/`BAD_WEBSITE`/`BAD_CONTENT`/`BAD_PARENT` | 表单校验提示（既有） |

## 3. assets/blog.js 集成片段

### 3.1 config 读取（启动一次 + 5 分钟 localStorage 缓存）

```js
var CONFIG_CACHE_KEY = 'dujie-blog-config';
var CONFIG_TTL_MS = 5 * 60 * 1000;
var blogConfig = null; // { turnstile:{enabled,siteKey,failOpen}, moderation:{enabled}, notify:{enabled} }

function loadBlogConfig() {
  var cached = null;
  try {
    var raw = localStorage.getItem(CONFIG_CACHE_KEY);
    if (raw) {
      var obj = JSON.parse(raw);
      if (obj && obj.at && Date.now() - obj.at < CONFIG_TTL_MS) cached = obj.data;
    }
  } catch (e) {}
  if (cached) return Promise.resolve(cached);
  return fetch(API_BASE + '/api/blog/config')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.code === 0 && j.data) {
        try { localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ at: Date.now(), data: j.data })); } catch (e) {}
      }
      return j.data;
    })
    .catch(function () { return null; }); // 失败按「全关」保守降级
}
```

### 3.2 Turnstile widget 渲染（显式 render，受控取 token）

```js
var turnstileToken = '';
var turnstileWidgetId = null;

function initTurnstile(cfg) {
  if (!cfg || !cfg.turnstile.enabled || !cfg.turnstile.siteKey) return Promise.resolve();
  var slot = document.getElementById('cf-turnstile-slot');
  if (!slot) return Promise.resolve();
  var s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  s.async = true; s.defer = true;
  document.head.appendChild(s);
  return new Promise(function (res) { s.onload = res; s.onerror = res; }) // 生产加超时兜底
    .then(function () {
      if (!window.turnstile) return; // 脚本加载失败：按未开启处理（后端 fail-open 兜底）
      turnstileWidgetId = window.turnstile.render('#cf-turnstile-slot', {
        sitekey: cfg.turnstile.siteKey,
        callback: function (t) { turnstileToken = t; },
        'expired-callback': function () { turnstileToken = ''; }, // token 300s TTL，过期清空
        'error-callback': function () { turnstileToken = ''; }
      });
    });
}

function resetTurnstile() {
  if (turnstileWidgetId !== null && window.turnstile) {
    try { window.turnstile.reset(turnstileWidgetId); } catch (e) {}
  }
  turnstileToken = '';
}
```

### 3.3 提交（带 token + pending 提示 + 403 重置重试）

```js
// 提交主体评论与回复均走此模式；body 增加 turnstileToken
api('/api/blog/comments', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug: slug, nickname: nick, email: mail, content: content, parentId: pid, turnstileToken: turnstileToken })
}).then(function (d) {
  if (d && d.status === 'pending') {
    toast('已提交，待审核后展示', 'ok');       // moderation 开启
  } else {
    toast('评论发布成功', 'ok');
  }
  resetTurnstile();                            // 提交后重置 widget，允许继续发下一条
  loadComments();
}).catch(function (err) {
  if (err.code === 'TURNSTILE_FAILED' || err.code === 'TURNSTILE_TOKEN_MISSING') {
    resetTurnstile();                          // reset 后允许重试
    toast('请重新完成人机校验', 'err');
  } else {
    toast(err.message || '发布失败', 'err');
  }
});
```

> 注：`api()` 助手在 HTTP 非 2xx 时抛错，需把 `code` 带到 error 对象上（改造现有
> `api()`：`throw Object.assign(new Error(j.message || '接口错误'), { code: j.code, status: r.status })`）。

### 3.4 评论区 DOM 约定

- widget 挂载点：`<div id="cf-turnstile-slot"></div>`（放在 `#comment-form` 提交按钮上方，
  `moderation`/turnstile 关闭时该容器保持空、不占位异常）；
- pending 提示：`.comment-pending-hint`（样式见博客仓库 style.css 增量）。

## 4. admin/index.html 契约（管理密码页）

- 令牌存储：`sessionStorage['dujie-admin-token']`（仅会话内存，不落 localStorage）；
- 所有请求带头：`X-Admin-Token: <token>`；
- 消费端点（8 个，基址 `https://dujiecone.520691.xyz/api/blog/admin`）：

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| ① | GET | `/comments?slug&status&q&page&page_size` | 列表：`items[{id,parentId,slug,nickname,emailMasked,website,content,status,createdAt,ipHash,likes,replyCount}]` + `total/page/page_size` |
| ② | POST | `/comments/:id/approve` | 审核通过（`{id,status:'approved',notified}`） |
| ③ | POST | `/comments/:id/hide` | 隐藏（`{id,status:'hidden'}`） |
| ④ | DELETE | `/comments/:id` | 硬删除（`{id,deleted,childrenPromoted}`） |
| ⑤ | POST | `/comments/:id/ban` | 拉黑，body `{scope:'email'|'ip'|'both',reason?}` → `{id,bans:[{banType,banValue,created}]}` |
| ⑥ | GET | `/bans?page&page_size` | 黑名单：`items[{id,banType,banValueMasked,reason,createdAt}]` |
| ⑦ | DELETE | `/bans/:id` | 解黑（`{id,unbanned}`） |
| ⑧ | GET | `/stats` | 驾驶舱：`{approved,pending,hidden,bans,lastBackupAt}` |

- 错误码：`401 ADMIN_UNAUTHORIZED`（跳回密码页）、`429 ADMIN_RATE_LIMITED`（5 分钟锁定提示）、
  `404 COMMENT_NOT_FOUND`/`BAN_NOT_FOUND`、`400 BAD_STATUS`/`BAD_PAGE`/`BAD_SCOPE`/`BAD_ID`/`NO_IP`；
- 移动端可用（博主可能手机操作）：按钮 ≥44px 触控、表格改卡片列表、视口 `width=device-width`；
- 缓存：`admin/index.html` 配 `Cache-Control: no-cache`（见博客仓库 `_headers`）。

## 5. CSP 注意

博客站当前无 CSP 响应头/meta，Turnstile 脚本可直接加载；若后续添加 CSP，需放行
`script-src https://challenges.cloudflare.com`。
