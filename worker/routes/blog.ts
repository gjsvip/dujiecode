/**
 * 博客互动 API（公开免鉴权，由 AUTH_EXEMPTIONS 白名单放行）。
 *
 * 能力：评论（树形回复）/ 点赞（文章+评论 toggle）/ 浏览量 / 批量统计 / 说说。
 * 数据存于独立 D1 库（BLOG_DB），三端静态站（CF Pages / GitHub Pages / Gitee Pages）
 * 共用同一 API，实现「国内发的评论国际站可见」的全球数据同步。
 *
 * 安全策略：
 * - 访客指纹 = sha256(CF-Connecting-IP + UA + 盐)，不存明文 IP；
 * - 发评论限流 2 条 / 分钟 / 指纹（KV 计数桶）；
 * - 字段长度与格式强校验，email 仅用于 Gravatar 头像（md5）不返回前端；
 * - 回复必须指向同文章已审核评论，防跨文章注入。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from '../types'

const blogRoutes = new Hono<AppEnv>()

/* ------------------------------------------------------------------ */
/* 常量                                                                 */
/* ------------------------------------------------------------------ */

const MAX_NICKNAME = 20
const MAX_CONTENT = 500
const MAX_WEBSITE = 200
const MAX_SLUG = 100
const COMMENT_RATE_LIMIT = 2
const COMMENT_RATE_TTL_SEC = 70

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_RE = /^https?:\/\/[^\s]+$/

interface CommentRow {
  id: number
  parent_id: number | null
  nickname: string
  email_md5: string
  website: string
  content: string
  created_at: string
}

interface CommentNode {
  id: number
  parentId: number | null
  nickname: string
  avatar: string
  website: string
  content: string
  createdAt: string
  likes: number
  replies: CommentNode[]
}

function fail(c: Context<AppEnv>, code: string, message: string, status: ContentfulStatusCode = 400) {
  return c.json({ code, message }, status)
}

/* ------------------------------------------------------------------ */
/* 访客指纹与 MD5                                                        */
/* ------------------------------------------------------------------ */

/** 访客指纹：IP + UA + 固定盐，sha256 hex（不存明文，限流与点赞去重共用） */
async function visitorHash(c: Context<AppEnv>): Promise<string> {
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? '0.0.0.0'
  const ua = c.req.header('User-Agent') ?? ''
  const salt = (c.env as unknown as { BLOG_SALT?: string }).BLOG_SALT ?? 'gjsvip-blog'
  const data = new TextEncoder().encode(`${ip}|${ua}|${salt}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * MD5（公有领域标准实现，Gravatar 头像需要）。
 * 输入按 UTF-8 编码后逐字节处理，非 ASCII 邮箱同样正确。
 */
function md5(input: string): string {
  function rotateLeft(x: number, n: number): number {
    return (x << n) | (x >>> (32 - n))
  }
  function addUnsigned(x: number, y: number): number {
    const x8 = x & 0x80000000
    const y8 = y & 0x80000000
    const x4 = x & 0x40000000
    const y4 = y & 0x40000000
    const result = (x & 0x3fffffff) + (y & 0x3fffffff)
    if (x4 & y4) return result ^ 0x80000000 ^ x8 ^ y8
    if (x4 | y4) {
      if (result & 0x40000000) return result ^ 0xc0000000 ^ x8 ^ y8
      return result ^ 0x40000000 ^ x8 ^ y8
    }
    return result ^ x8 ^ y8
  }
  function F(x: number, y: number, z: number): number {
    return (x & y) | (~x & z)
  }
  function G(x: number, y: number, z: number): number {
    return (x & z) | (y & ~z)
  }
  function H(x: number, y: number, z: number): number {
    return x ^ y ^ z
  }
  function I(x: number, y: number, z: number): number {
    return y ^ (x | ~z)
  }
  function FF(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac))
    return addUnsigned(rotateLeft(a, s), b)
  }
  function GG(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac))
    return addUnsigned(rotateLeft(a, s), b)
  }
  function HH(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac))
    return addUnsigned(rotateLeft(a, s), b)
  }
  function II(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac))
    return addUnsigned(rotateLeft(a, s), b)
  }
  function convertToWordArray(bytes: Uint8Array): number[] {
    const messageLength = bytes.length
    const numberOfWordsTemp1 = messageLength + 8
    const numberOfWordsTemp2 = (numberOfWordsTemp1 - (numberOfWordsTemp1 % 64)) / 64
    const numberOfWords = (numberOfWordsTemp2 + 1) * 16
    const wordArray: number[] = new Array(numberOfWords).fill(0)
    let byteCount = 0
    while (byteCount < messageLength) {
      const wordCount = (byteCount - (byteCount % 4)) / 4
      const bytePosition = (byteCount % 4) * 8
      wordArray[wordCount] = wordArray[wordCount] | (bytes[byteCount] << bytePosition)
      byteCount++
    }
    const wordCount = (byteCount - (byteCount % 4)) / 4
    const bytePosition = (byteCount % 4) * 8
    wordArray[wordCount] = wordArray[wordCount] | (0x80 << bytePosition)
    wordArray[numberOfWords - 2] = messageLength << 3
    wordArray[numberOfWords - 1] = messageLength >>> 29
    return wordArray
  }
  function wordToHex(value: number): string {
    let out = ''
    for (let count = 0; count <= 3; count++) {
      const byte = (value >>> (count * 8)) & 255
      out += ('0' + byte.toString(16)).slice(-2)
    }
    return out
  }

  const bytes = new TextEncoder().encode(input)
  const x = convertToWordArray(bytes)
  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476

  const S11 = 7, S12 = 12, S13 = 17, S14 = 22
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21

  for (let k = 0; k < x.length; k += 16) {
    const AA = a, BB = b, CC = c, DD = d
    a = FF(a, b, c, d, x[k + 0], S11, 0xd76aa478)
    d = FF(d, a, b, c, x[k + 1], S12, 0xe8c7b756)
    c = FF(c, d, a, b, x[k + 2], S13, 0x242070db)
    b = FF(b, c, d, a, x[k + 3], S14, 0xc1bdceee)
    a = FF(a, b, c, d, x[k + 4], S11, 0xf57c0faf)
    d = FF(d, a, b, c, x[k + 5], S12, 0x4787c62a)
    c = FF(c, d, a, b, x[k + 6], S13, 0xa8304613)
    b = FF(b, c, d, a, x[k + 7], S14, 0xfd469501)
    a = FF(a, b, c, d, x[k + 8], S11, 0x698098d8)
    d = FF(d, a, b, c, x[k + 9], S12, 0x8b44f7af)
    c = FF(c, d, a, b, x[k + 10], S13, 0xffff5bb1)
    b = FF(b, c, d, a, x[k + 11], S14, 0x895cd7be)
    a = FF(a, b, c, d, x[k + 12], S11, 0x6b901122)
    d = FF(d, a, b, c, x[k + 13], S12, 0xfd987193)
    c = FF(c, d, a, b, x[k + 14], S13, 0xa679438e)
    b = FF(b, c, d, a, x[k + 15], S14, 0x49b40821)
    a = GG(a, b, c, d, x[k + 1], S21, 0xf61e2562)
    d = GG(d, a, b, c, x[k + 6], S22, 0xc040b340)
    c = GG(c, d, a, b, x[k + 11], S23, 0x265e5a51)
    b = GG(b, c, d, a, x[k + 0], S24, 0xe9b6c7aa)
    a = GG(a, b, c, d, x[k + 5], S21, 0xd62f105d)
    d = GG(d, a, b, c, x[k + 10], S22, 0x02441453)
    c = GG(c, d, a, b, x[k + 15], S23, 0xd8a1e681)
    b = GG(b, c, d, a, x[k + 4], S24, 0xe7d3fbc8)
    a = GG(a, b, c, d, x[k + 9], S21, 0x21e1cde6)
    d = GG(d, a, b, c, x[k + 14], S22, 0xc33707d6)
    c = GG(c, d, a, b, x[k + 3], S23, 0xf4d50d87)
    b = GG(b, c, d, a, x[k + 8], S24, 0x455a14ed)
    a = GG(a, b, c, d, x[k + 13], S21, 0xa9e3e905)
    d = GG(d, a, b, c, x[k + 2], S22, 0xfcefa3f8)
    c = GG(c, d, a, b, x[k + 7], S23, 0x676f02d9)
    b = GG(b, c, d, a, x[k + 12], S24, 0x8d2a4c8a)
    a = HH(a, b, c, d, x[k + 5], S31, 0xfffa3942)
    d = HH(d, a, b, c, x[k + 8], S32, 0x8771f681)
    c = HH(c, d, a, b, x[k + 11], S33, 0x6d9d6122)
    b = HH(b, c, d, a, x[k + 14], S34, 0xfde5380c)
    a = HH(a, b, c, d, x[k + 1], S31, 0xa4beea44)
    d = HH(d, a, b, c, x[k + 4], S32, 0x4bdecfa9)
    c = HH(c, d, a, b, x[k + 7], S33, 0xf6bb4b60)
    b = HH(b, c, d, a, x[k + 10], S34, 0xbebfbc70)
    a = HH(a, b, c, d, x[k + 13], S31, 0x289b7ec6)
    d = HH(d, a, b, c, x[k + 0], S32, 0xeaa127fa)
    c = HH(c, d, a, b, x[k + 3], S33, 0xd4ef3085)
    b = HH(b, c, d, a, x[k + 6], S34, 0x04881d05)
    a = HH(a, b, c, d, x[k + 9], S31, 0xd9d4d039)
    d = HH(d, a, b, c, x[k + 12], S32, 0xe6db99e5)
    c = HH(c, d, a, b, x[k + 15], S33, 0x1fa27cf8)
    b = HH(b, c, d, a, x[k + 2], S34, 0xc4ac5665)
    a = II(a, b, c, d, x[k + 0], S41, 0xf4292244)
    d = II(d, a, b, c, x[k + 7], S42, 0x432aff97)
    c = II(c, d, a, b, x[k + 14], S43, 0xab9423a7)
    b = II(b, c, d, a, x[k + 5], S44, 0xfc93a039)
    a = II(a, b, c, d, x[k + 12], S41, 0x655b59c3)
    d = II(d, a, b, c, x[k + 3], S42, 0x8f0ccc92)
    c = II(c, d, a, b, x[k + 10], S43, 0xffeff47d)
    b = II(b, c, d, a, x[k + 1], S44, 0x85845dd1)
    a = II(a, b, c, d, x[k + 8], S41, 0x6fa87e4f)
    d = II(d, a, b, c, x[k + 15], S42, 0xfe2ce6e0)
    c = II(c, d, a, b, x[k + 6], S43, 0xa3014314)
    b = II(b, c, d, a, x[k + 13], S44, 0x4e0811a1)
    a = II(a, b, c, d, x[k + 4], S41, 0xf7537e82)
    d = II(d, a, b, c, x[k + 11], S42, 0xbd3af235)
    c = II(c, d, a, b, x[k + 2], S43, 0x2ad7d2bb)
    b = II(b, c, d, a, x[k + 9], S44, 0xeb86d391)
    a = addUnsigned(a, AA)
    b = addUnsigned(b, BB)
    c = addUnsigned(c, CC)
    d = addUnsigned(d, DD)
  }
  return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase()
}

/* ------------------------------------------------------------------ */
/* GET /api/blog/comments?slug=xxx — 评论树（已审核）                     */
/* ------------------------------------------------------------------ */

blogRoutes.get('/comments', async (c) => {
  const slug = (c.req.query('slug') ?? '').trim()
  if (slug === '' || slug.length > MAX_SLUG) {
    return fail(c, 'BAD_SLUG', '文章标识不合法')
  }
  const { results } = await c.env.BLOG_DB.prepare(
    `SELECT c.id, c.parent_id, c.nickname, c.email_md5, c.website, c.content, c.created_at,
            (SELECT COUNT(*) FROM likes l WHERE l.target_type='comment' AND l.target_id=CAST(c.id AS TEXT)) AS likes
     FROM comments c WHERE c.slug = ?1 AND c.status = 'approved' ORDER BY c.created_at ASC`,
  )
    .bind(slug)
    .all<CommentRow & { likes: number }>()

  const nodes = new Map<number, CommentNode>()
  const roots: CommentNode[] = []
  for (const row of results ?? []) {
    nodes.set(row.id, {
      id: row.id,
      parentId: row.parent_id,
      nickname: row.nickname,
      avatar: `https://gravatar.com/avatar/${row.email_md5}?d=identicon&s=80`,
      website: row.website,
      content: row.content,
      createdAt: row.created_at,
      likes: Number(row.likes ?? 0),
      replies: [],
    })
  }
  for (const node of nodes.values()) {
    if (node.parentId !== null && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.replies.push(node)
    } else {
      roots.push(node)
    }
  }
  return c.json({ code: 0, data: { comments: roots, total: nodes.size } })
})

/* ------------------------------------------------------------------ */
/* POST /api/blog/comments — 发表评论 / 回复                              */
/* ------------------------------------------------------------------ */

blogRoutes.post('/comments', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return fail(c, 'BAD_JSON', '请求体不是合法 JSON')
  }

  const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
  const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const website = typeof body.website === 'string' ? body.website.trim() : ''
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  const parentId =
    typeof body.parentId === 'number' && Number.isFinite(body.parentId) ? Math.floor(body.parentId) : null

  if (slug === '' || slug.length > MAX_SLUG) return fail(c, 'BAD_SLUG', '文章标识不合法')
  if (nickname === '' || nickname.length > MAX_NICKNAME) return fail(c, 'BAD_NICKNAME', `昵称需 1-${MAX_NICKNAME} 字`)
  // 邮箱选填：为空时放行（UI 承诺选填），非空才校验格式
  if (email !== '' && !EMAIL_RE.test(email)) return fail(c, 'BAD_EMAIL', '邮箱格式不正确')
  if (website !== '' && (website.length > MAX_WEBSITE || !URL_RE.test(website))) {
    return fail(c, 'BAD_WEBSITE', '网站需为 http(s) 链接')
  }
  if (content === '' || content.length > MAX_CONTENT) {
    return fail(c, 'BAD_CONTENT', `评论内容需 1-${MAX_CONTENT} 字`)
  }

  // 频率限制：同指纹每分钟最多 COMMENT_RATE_LIMIT 条
  const hash = await visitorHash(c)
  const bucket = Math.floor(Date.now() / 60000)
  const rlKey = `blog:rl:${hash}:${bucket}`
  const used = Number.parseInt((await c.env.KV.get(rlKey)) ?? '0', 10)
  if (used >= COMMENT_RATE_LIMIT) {
    return fail(c, 'RATE_LIMITED', '评论太频繁了，休息一分钟再来吧', 429)
  }

  // 回复必须指向同文章已审核评论
  if (parentId !== null) {
    const parent = await c.env.BLOG_DB.prepare(
      'SELECT id FROM comments WHERE id = ?1 AND slug = ?2 AND status = ?3',
    )
      .bind(parentId, slug, 'approved')
      .first<{ id: number }>()
    if (parent === null) return fail(c, 'BAD_PARENT', '回复的评论不存在或未审核')
  }

  await c.env.KV.put(rlKey, String(used + 1), { expirationTtl: COMMENT_RATE_TTL_SEC })
  // 空邮箱兜底：用「昵称:文章」派生稳定头像哈希，保证空邮箱用户也有 identicon 且不报错
  const emailMd5 = md5(email || `${nickname}:${slug}`)
  const result = await c.env.BLOG_DB.prepare(
    `INSERT INTO comments (slug, parent_id, nickname, email_md5, website, content, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'approved')`,
  )
    .bind(slug, parentId, nickname, emailMd5, website, content)
    .run()

  return c.json({ code: 0, data: { id: Number(result.meta.last_row_id) } }, 201)
})

/* ------------------------------------------------------------------ */
/* POST /api/blog/like — 文章/评论点赞（同指纹 toggle）                   */
/* ------------------------------------------------------------------ */

blogRoutes.post('/like', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return fail(c, 'BAD_JSON', '请求体不是合法 JSON')
  }
  // 契约归一化：前端可能发 {slug, visitor}（文章点赞）或 {comment_id, visitor}（评论点赞），
  // 同时保留原有 {type, id} 兼容形态
  let type: 'post' | 'comment' | null = null
  let id = ''
  if (typeof body.slug === 'string' && body.slug.trim() !== '') {
    type = 'post'
    id = body.slug.trim()
  } else if (body.comment_id !== undefined && body.comment_id !== null && String(body.comment_id).trim() !== '') {
    type = 'comment'
    id = String(body.comment_id).trim()
  } else if (body.type === 'post' || body.type === 'comment') {
    type = body.type
    id = typeof body.id === 'string' || typeof body.id === 'number' ? String(body.id).trim() : ''
  }
  if (type === null || id === '' || id.length > MAX_SLUG) {
    return fail(c, 'BAD_TARGET', '点赞目标不合法')
  }
  if (type === 'comment') {
    const exists = await c.env.BLOG_DB.prepare('SELECT id FROM comments WHERE id = ?1')
      .bind(Number(id))
      .first<{ id: number }>()
    if (exists === null) return fail(c, 'BAD_TARGET', '评论不存在')
  }

  const hash = await visitorHash(c)
  const existing = await c.env.BLOG_DB.prepare(
    'SELECT id FROM likes WHERE target_type = ?1 AND target_id = ?2 AND voter_hash = ?3',
  )
    .bind(type, id, hash)
    .first<{ id: number }>()

  if (existing !== null) {
    await c.env.BLOG_DB.prepare('DELETE FROM likes WHERE id = ?1').bind(existing.id).run()
  } else {
    await c.env.BLOG_DB.prepare(
      'INSERT INTO likes (target_type, target_id, voter_hash) VALUES (?1, ?2, ?3)',
    )
      .bind(type, id, hash)
      .run()
  }
  const count = await c.env.BLOG_DB.prepare(
    'SELECT COUNT(*) AS n FROM likes WHERE target_type = ?1 AND target_id = ?2',
  )
    .bind(type, id)
    .first<{ n: number }>()
  // 同时返回 likes 别名，兼容前端读取 d.likes 的旧契约
  const n = Number(count?.n ?? 0)
  return c.json({ code: 0, data: { liked: existing === null, count: n, likes: n } })
})

/* ------------------------------------------------------------------ */
/* POST /api/blog/view — 浏览量 +1                                        */
/* ------------------------------------------------------------------ */

blogRoutes.post('/view', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return fail(c, 'BAD_JSON', '请求体不是合法 JSON')
  }
  const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
  if (slug === '' || slug.length > MAX_SLUG) return fail(c, 'BAD_SLUG', '文章标识不合法')

  await c.env.BLOG_DB.prepare(
    `INSERT INTO views (slug, count, updated_at) VALUES (?1, 1, datetime('now'))
     ON CONFLICT(slug) DO UPDATE SET count = count + 1, updated_at = datetime('now')`,
  )
    .bind(slug)
    .run()
  const row = await c.env.BLOG_DB.prepare('SELECT count FROM views WHERE slug = ?1')
    .bind(slug)
    .first<{ count: number }>()
  return c.json({ code: 0, data: { views: Number(row?.count ?? 1) } })
})

/* ------------------------------------------------------------------ */
/* GET /api/blog/stats?slugs=a,b,c — 批量 views+likes                      */
/* ------------------------------------------------------------------ */

blogRoutes.get('/stats', async (c) => {
  const raw = c.req.query('slugs') ?? ''
  const slugs = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s.length <= MAX_SLUG)
    .slice(0, 50)
  // 返回数组结构 [{slug, views, likes, comments}]，与前端消费契约对齐
  const data: Array<{ slug: string; views: number; likes: number; comments: number }> = []
  for (const slug of slugs) {
    const v = await c.env.BLOG_DB.prepare('SELECT count FROM views WHERE slug = ?1')
      .bind(slug)
      .first<{ count: number }>()
    const l = await c.env.BLOG_DB.prepare(
      "SELECT COUNT(*) AS n FROM likes WHERE target_type='post' AND target_id = ?1",
    )
      .bind(slug)
      .first<{ n: number }>()
    const cm = await c.env.BLOG_DB.prepare(
      "SELECT COUNT(*) AS n FROM comments WHERE slug = ?1 AND status = 'approved'",
    )
      .bind(slug)
      .first<{ n: number }>()
    data.push({
      slug,
      views: Number(v?.count ?? 0),
      likes: Number(l?.n ?? 0),
      comments: Number(cm?.n ?? 0),
    })
  }
  return c.json({ code: 0, data })
})

/* ------------------------------------------------------------------ */
/* GET /api/blog/says — 说说列表                                          */
/* ------------------------------------------------------------------ */

blogRoutes.get('/says', async (c) => {
  const { results } = await c.env.BLOG_DB.prepare(
    "SELECT id, content, images, created_at FROM says WHERE status='approved' ORDER BY created_at DESC LIMIT 50",
  ).all<{ id: number; content: string; images: string; created_at: string }>()
  const list = (results ?? []).map((r) => ({
    id: r.id,
    content: r.content,
    images: r.images ? (JSON.parse(r.images) as string[]) : [],
    createdAt: r.created_at,
  }))
  return c.json({ code: 0, data: list })
})

export default blogRoutes
