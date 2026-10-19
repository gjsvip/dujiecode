/**
 * 安全与数据基础库（架构文档 §3.4 #31）。
 * 全部基于 Workers 原生 WebCrypto（crypto.subtle），零外部依赖：
 * - PBKDF2-SHA256 密码哈希 / 校验（10 万次迭代 + 16 字节随机盐）；
 * - AES-256-GCM 信封加密 / 解密（主密钥 hex，密文格式 `v1:{ivB64}:{ctB64}`）；
 * - JWT HS256 签发 / 验签（alg 校验 + 常数时间签名比较 + exp 校验）；
 * - D1 助手 dbFirst / dbAll / dbRun 与统一错误抛出 httpError。
 */

/* ------------------------------------------------------------------ */
/* 统一错误                                                           */
/* ------------------------------------------------------------------ */

/** 统一 HTTP 错误：入口中间件据此渲染 `{code, message, details?}`（§5.1） */
export class HttpError extends Error {
  /** 机器可读错误码（§5.1 错误码表） */
  readonly code: string
  /** HTTP 状态码 */
  readonly status: number
  /** 可选补充信息（前端按需展示） */
  readonly details?: unknown

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** 抛出统一 HTTP 错误（返回类型 never，便于编译器收窄控制流） */
export function httpError(code: string, message: string, status: number, details?: unknown): never {
  throw new HttpError(code, message, status, details)
}

/** 判断未知异常是否为 HttpError（入口中间件与路由 catch 共用） */
export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError
}

/** 判断是否为 D1 唯一约束冲突（归一化为 409 EMAIL_TAKEN / NAME_TAKEN） */
export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /unique constraint failed/i.test(err.message)
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                           */
/* ------------------------------------------------------------------ */

/** PBKDF2 算法标识（password_hash 首段） */
export const PBKDF2_ALGORITHM = 'pbkdf2_sha256'
/** PBKDF2 迭代次数（PRD 要求 ≥ 10 万） */
export const PBKDF2_ITERATIONS = 100000
/** PBKDF2 盐长度（字节） */
const PBKDF2_SALT_BYTES = 16
/** PBKDF2 派生密钥长度（位） */
const PBKDF2_KEY_BITS = 256
/** AES-GCM IV 长度（字节，WebCrypto 推荐 12） */
const AES_IV_BYTES = 12
/** AES-256 主密钥长度（字节） */
const AES_KEY_BYTES = 32
/** 新实体 ID 的随机后缀长度（base62 字符） */
const ID_RANDOM_CHARS = 16
/** base62 字符表（ID 后缀用） */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

const encoder = new TextEncoder()

/**
 * UTF-8 编码为字节数组。
 * 各运行时（workers-types / node / DOM）的 TextEncoder.encode 返回类型存在
 * `Uint8Array` 泛型参数差异，统一复制为 `Uint8Array<ArrayBuffer>` 以满足 WebCrypto
 * 的 BufferSource 约束（BufferSource 要求视图的 buffer 精确为 ArrayBuffer）。
 */
function utf8Bytes(input: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(input))
}

/** 取 WebCrypto SubtleCrypto；运行时不支持时抛 500 */
function subtleCrypto(): SubtleCrypto {
  const webcrypto = globalThis.crypto
  if (!webcrypto || !webcrypto.subtle) {
    throw httpError('INTERNAL', '当前运行时不支持 WebCrypto', 500)
  }
  return webcrypto.subtle
}

/** 生成加密安全随机字节 */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

/** 字节数组 → 小写十六进制串 */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/** 十六进制串 → 字节数组（长度或字符非法时抛 500） */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) {
    throw httpError('INTERNAL', '十六进制字符串长度非法', 500)
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw httpError('INTERNAL', '十六进制字符串包含非法字符', 500)
    }
    bytes[i] = byte
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  // 分块转换，避免展开运算符超出参数上限（大密文场景）
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = padded.length % 4
  return base64ToBytes(remainder === 0 ? padded : padded + '='.repeat(4 - remainder))
}

/** 常数时间字符串比较（防时序侧信道；长度不同直接返回 false） */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/* ------------------------------------------------------------------ */
/* 密码：PBKDF2-SHA256                                                */
/* ------------------------------------------------------------------ */

async function derivePbkdf2(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtleCrypto().importKey('raw', utf8Bytes(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtleCrypto().deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    PBKDF2_KEY_BITS,
  )
  return new Uint8Array(bits)
}

/**
 * 哈希密码。
 * 存储格式：`pbkdf2_sha256$100000$<saltHex>$<hashHex>`（schema.sql users.password_hash）。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PBKDF2_SALT_BYTES)
  const hash = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS)
  return [PBKDF2_ALGORITHM, String(PBKDF2_ITERATIONS), bytesToHex(salt), bytesToHex(hash)].join('$')
}

/** 校验密码与存储哈希是否匹配（格式非法 / 算法不符均返回 false，不抛出） */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4) {
    return false
  }
  const algorithm = parts[0]
  const iterationsRaw = parts[1]
  const saltHex = parts[2]
  const hashHex = parts[3]
  if (algorithm !== PBKDF2_ALGORITHM || iterationsRaw === undefined || saltHex === undefined || hashHex === undefined) {
    return false
  }
  const iterations = Number.parseInt(iterationsRaw, 10)
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false
  }
  let salt: Uint8Array<ArrayBuffer>
  try {
    salt = hexToBytes(saltHex)
  } catch {
    return false
  }
  const derived = await derivePbkdf2(password, salt, iterations)
  return timingSafeEqual(bytesToHex(derived), hashHex)
}

/* ------------------------------------------------------------------ */
/* 密钥加密：AES-256-GCM 信封加密                                     */
/* ------------------------------------------------------------------ */

async function importAesKey(keyBytes: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
  return subtleCrypto().importKey('raw', keyBytes, 'AES-GCM', false, usages)
}

/** 校验并解析主密钥（ENCRYPTION_KEY secret，32 字节 hex） */
function loadMasterKey(masterKeyHex: string): Uint8Array<ArrayBuffer> {
  const keyBytes = hexToBytes(masterKeyHex.trim())
  if (keyBytes.length !== AES_KEY_BYTES) {
    throw httpError('INTERNAL', 'ENCRYPTION_KEY 必须为 32 字节（64 个十六进制字符）', 500)
  }
  return keyBytes
}

/**
 * 加密明文密钥。
 * 输出格式 `v1:{ivB64}:{ctB64}`（schema.sql providers.api_key_enc）；
 * ct 为 AES-256-GCM 密文（含认证标签），每次随机 12 字节 IV。
 */
export async function encryptSecret(plain: string, masterKeyHex: string): Promise<string> {
  const key = await importAesKey(loadMasterKey(masterKeyHex), ['encrypt'])
  const iv = randomBytes(AES_IV_BYTES)
  const ciphertext = await subtleCrypto().encrypt({ name: 'AES-GCM', iv }, key, utf8Bytes(plain))
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`
}

/** 解密 `v1:{ivB64}:{ctB64}` 密文；主密钥不匹配或数据损坏抛 500 */
export async function decryptSecret(encrypted: string, masterKeyHex: string): Promise<string> {
  const parts = encrypted.split(':')
  if (parts.length !== 3 || parts[0] !== 'v1' || parts[1] === undefined || parts[2] === undefined) {
    throw httpError('INTERNAL', '密文格式非法', 500)
  }
  const key = await importAesKey(loadMasterKey(masterKeyHex), ['decrypt'])
  try {
    const plain = await subtleCrypto().decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(parts[1]) },
      key,
      base64ToBytes(parts[2]),
    )
    return new TextDecoder().decode(plain)
  } catch {
    throw httpError('INTERNAL', '解密失败：主密钥不匹配或数据已损坏', 500)
  }
}

/* ------------------------------------------------------------------ */
/* JWT：HS256 签发 / 验签                                             */
/* ------------------------------------------------------------------ */

/** JWT 载荷（会话：sub=userId，jti 为 KV session:{jti} 键后缀） */
export interface JwtPayload {
  sub: string
  email: string
  jti: string
  /** 签发时间（Unix 秒） */
  iat: number
  /** 过期时间（Unix 秒） */
  exp: number
}

/** KV 会话记录值（§4.3 `session:{jti}`，TTL 7 天；删除即登出 / 吊销） */
export interface SessionRecord {
  userId: string
  email: string
  createdAt: string
  /** 过期时间（Unix 秒，与 JWT exp 一致） */
  exp: number
}

async function hmacSha256(message: string, secret: string): Promise<string> {
  const key = await subtleCrypto().importKey(
    'raw',
    utf8Bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await subtleCrypto().sign('HMAC', key, utf8Bytes(message))
  return base64UrlEncode(new Uint8Array(signature))
}

/** 签发 HS256 JWT（header 固定 {alg:'HS256', typ:'JWT'}） */
export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const header = base64UrlEncode(utf8Bytes(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = base64UrlEncode(utf8Bytes(JSON.stringify(payload)))
  const signature = await hmacSha256(`${header}.${body}`, secret)
  return `${header}.${body}.${signature}`
}

/**
 * 验签并解析 JWT：校验三段结构、alg 必须为 HS256（防降级攻击）、
 * 常数时间比较签名、exp 未过期。任何失败均抛 401 UNAUTHORIZED。
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] === undefined || parts[1] === undefined || parts[2] === undefined) {
    throw httpError('UNAUTHORIZED', '会话令牌格式非法', 401)
  }
  const headerB64 = parts[0]
  const payloadB64 = parts[1]
  const signatureB64 = parts[2]

  let header: { alg?: unknown }
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64))) as { alg?: unknown }
  } catch {
    throw httpError('UNAUTHORIZED', '会话令牌格式非法', 401)
  }
  if (header.alg !== 'HS256') {
    throw httpError('UNAUTHORIZED', '不支持的签名算法', 401)
  }

  const expected = await hmacSha256(`${headerB64}.${payloadB64}`, secret)
  if (!timingSafeEqual(expected, signatureB64)) {
    throw httpError('UNAUTHORIZED', '会话令牌签名校验失败', 401)
  }

  let payload: JwtPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as JwtPayload
  } catch {
    throw httpError('UNAUTHORIZED', '会话令牌格式非法', 401)
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw httpError('UNAUTHORIZED', '会话已过期，请重新登录', 401)
  }
  return payload
}

/* ------------------------------------------------------------------ */
/* 摘要 / ID / 时间                                                   */
/* ------------------------------------------------------------------ */

/** SHA-256 十六进制摘要（小写）；用于 agent token 哈希等不可逆场景 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await subtleCrypto().digest('SHA-256', utf8Bytes(input))
  return bytesToHex(new Uint8Array(digest))
}

/**
 * 生成实体 ID：`{prefix}` + 16 位 base62 随机后缀（§11 ID 规范）。
 * 例：newId('usr_') → 'usr_3fK9mQ2xR7tB8nWp'（共 20 字符）。
 */
export function newId(prefix: string): string {
  const bytes = randomBytes(ID_RANDOM_CHARS)
  let suffix = ''
  for (const byte of bytes) {
    suffix += ID_ALPHABET[byte % ID_ALPHABET.length]
  }
  return prefix + suffix
}

/** 当前 UTC 时间的 ISO 8601 字符串（§11 时间约定） */
export function nowIso(): string {
  return new Date().toISOString()
}

/* ------------------------------------------------------------------ */
/* D1 数据访问助手                                                    */
/* ------------------------------------------------------------------ */

/** 查询单行，无结果返回 null */
export async function dbFirst<T>(
  db: D1Database,
  sql: string,
  args: readonly unknown[] = [],
): Promise<T | null> {
  const row = await db.prepare(sql).bind(...args).first<T>()
  return row ?? null
}

/** 查询多行 */
export async function dbAll<T>(db: D1Database, sql: string, args: readonly unknown[] = []): Promise<T[]> {
  const result = await db.prepare(sql).bind(...args).all<T>()
  return result.results ?? []
}

/** 执行写操作（INSERT / UPDATE / DELETE），返回 D1 执行结果（含 meta） */
export async function dbRun(
  db: D1Database,
  sql: string,
  args: readonly unknown[] = [],
): Promise<D1Result> {
  return db.prepare(sql).bind(...args).run()
}
