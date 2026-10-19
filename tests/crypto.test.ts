/**
 * worker/lib/core.ts 安全基础库单元测试（T14）。
 *
 * 覆盖：
 * - hashPassword / verifyPassword：PBKDF2-SHA256 哈希与校验（正确 / 错误密码 /
 *   随机盐 / 篡改拒绝 / 非法格式拒绝）；
 * - encryptSecret / decryptSecret：AES-256-GCM 信封加密往返、`v1:{iv}:{ct}` 格式
 *   断言、随机 IV、篡改密文拒绝、主密钥不匹配拒绝；
 * - signJwt / verifyJwt：HS256 签发验签往返、错误密钥拒绝、篡改载荷拒绝、
 *   alg 降级拒绝、过期拒绝、结构非法拒绝；
 * - sha256Hex：已知测试向量（RFC 4637 / FIPS-180 标准值）；
 * - 辅助函数：bytesToHex / hexToBytes / newId / httpError。
 *
 * 全部使用 Node 原生 WebCrypto（globalThis.crypto.subtle），无外部依赖。
 */
import { describe, expect, it } from 'vitest'
import {
  HttpError,
  bytesToHex,
  decryptSecret,
  encryptSecret,
  hashPassword,
  hexToBytes,
  httpError,
  isHttpError,
  isUniqueConstraintError,
  newId,
  sha256Hex,
  signJwt,
  verifyJwt,
  verifyPassword,
  type JwtPayload,
} from '../worker/lib/core'

/** 测试用 32 字节主密钥（64 个十六进制字符） */
const MASTER_KEY_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
/** 另一把不匹配的 32 字节主密钥 */
const MASTER_KEY_B = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0'
/** 测试用 JWT 签名密钥 */
const JWT_SECRET = 'unit-test-jwt-secret'

/**
 * 构造测试用 JWT 载荷（默认 1 小时后过期，可用 overrides 覆盖）。
 */
function makePayload(overrides: Partial<JwtPayload> = {}): JwtPayload {
  const now = Math.floor(Date.now() / 1000)
  return {
    sub: 'usr_seed000000000001',
    email: 'tester@example.com',
    jti: 'jti_seed0000000001',
    iat: now,
    exp: now + 3600,
    ...overrides,
  }
}

/**
 * 篡改密文：翻转密文首字节后以相同格式重新组装，
 * 保证仍是合法 base64，但 AES-GCM 认证必然失败。
 */
function tamperCiphertext(encrypted: string): string {
  const parts = encrypted.split(':')
  const iv = parts[1] as string
  const ct = parts[2] as string
  const bytes = Uint8Array.from(atob(ct), (ch) => ch.charCodeAt(0))
  bytes[0] ^= 0xff
  return `v1:${iv}:${btoa(String.fromCharCode(...bytes))}`
}

/* ------------------------------------------------------------------ */
/* 密码：PBKDF2-SHA256                                                 */
/* ------------------------------------------------------------------ */

describe('hashPassword / verifyPassword', () => {
  it('哈希输出符合 pbkdf2_sha256$100000$<saltHex>$<hashHex> 格式', async () => {
    const stored = await hashPassword('Correct-Horse-9!')
    const parts = stored.split('$')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('pbkdf2_sha256')
    expect(parts[1]).toBe('100000')
    // 盐 16 字节 → 32 个十六进制字符；派生密钥 32 字节 → 64 个十六进制字符
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/)
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('正确密码校验通过', async () => {
    const stored = await hashPassword('Correct-Horse-9!')
    await expect(verifyPassword('Correct-Horse-9!', stored)).resolves.toBe(true)
  })

  it('错误密码校验拒绝', async () => {
    const stored = await hashPassword('Correct-Horse-9!')
    await expect(verifyPassword('wrong-password', stored)).resolves.toBe(false)
  })

  it('相同密码两次哈希结果不同（随机盐防彩虹表）', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a).not.toBe(b)
    // 两次哈希都应能各自校验通过
    await expect(verifyPassword('same-password', a)).resolves.toBe(true)
    await expect(verifyPassword('same-password', b)).resolves.toBe(true)
  })

  it('篡改存储哈希中的派生值后校验拒绝', async () => {
    const stored = await hashPassword('Correct-Horse-9!')
    const parts = stored.split('$')
    const hashHex = parts[3] as string
    const flipped = `${hashHex[0] === '0' ? '1' : '0'}${hashHex.slice(1)}`
    await expect(verifyPassword('Correct-Horse-9!', [...parts.slice(0, 3), flipped].join('$'))).resolves.toBe(false)
  })

  it('格式非法的存储值一律拒绝且不抛出', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false)
    await expect(verifyPassword('x', 'md5$1$aabb$ccdd')).resolves.toBe(false)
    await expect(verifyPassword('x', 'pbkdf2_sha256$abc$aabb$ccdd')).resolves.toBe(false)
    await expect(verifyPassword('x', 'pbkdf2_sha256$100000$zz$ccdd')).resolves.toBe(false)
    await expect(verifyPassword('x', '')).resolves.toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* 密钥加密：AES-256-GCM 信封加密                                      */
/* ------------------------------------------------------------------ */

describe('encryptSecret / decryptSecret', () => {
  it('往返加解密返回原明文', async () => {
    const plain = 'sk-provider-api-key-苏7号'
    const encrypted = await encryptSecret(plain, MASTER_KEY_A)
    await expect(decryptSecret(encrypted, MASTER_KEY_A)).resolves.toBe(plain)
  })

  it('密文格式为 v1:{ivB64}:{ctB64} 且 IV 为 12 字节', async () => {
    const encrypted = await encryptSecret('hello', MASTER_KEY_A)
    const parts = encrypted.split(':')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe('v1')
    // base64 解码后 IV 应为 12 字节（AES-GCM 推荐长度）
    const iv = Uint8Array.from(atob(parts[1] as string), (ch) => ch.charCodeAt(0))
    expect(iv).toHaveLength(12)
    // 密文含 16 字节 GCM 认证标签，长度必大于纯明文
    const ct = Uint8Array.from(atob(parts[2] as string), (ch) => ch.charCodeAt(0))
    expect(ct.length).toBeGreaterThanOrEqual(16)
  })

  it('相同明文两次加密结果不同（每次随机 IV）', async () => {
    const a = await encryptSecret('same-plain', MASTER_KEY_A)
    const b = await encryptSecret('same-plain', MASTER_KEY_A)
    expect(a).not.toBe(b)
    await expect(decryptSecret(a, MASTER_KEY_A)).resolves.toBe('same-plain')
    await expect(decryptSecret(b, MASTER_KEY_A)).resolves.toBe('same-plain')
  })

  it('篡改密文后解密拒绝（GCM 认证失败，抛 HttpError 500）', async () => {
    const encrypted = await encryptSecret('sensitive-secret', MASTER_KEY_A)
    await expect(decryptSecret(tamperCiphertext(encrypted), MASTER_KEY_A)).rejects.toThrow(HttpError)
    await expect(decryptSecret(tamperCiphertext(encrypted), MASTER_KEY_A)).rejects.toThrow('解密失败')
  })

  it('主密钥不匹配时解密拒绝', async () => {
    const encrypted = await encryptSecret('sensitive-secret', MASTER_KEY_A)
    await expect(decryptSecret(encrypted, MASTER_KEY_B)).rejects.toThrow('解密失败')
  })

  it('主密钥长度非 32 字节时拒绝加密', async () => {
    await expect(encryptSecret('x', 'abcd')).rejects.toThrow('ENCRYPTION_KEY 必须为 32 字节')
  })

  it('密文结构非法时解密拒绝', async () => {
    await expect(decryptSecret('v1:only-two-parts', MASTER_KEY_A)).rejects.toThrow('密文格式非法')
    await expect(decryptSecret('v2:aWIjYWJj:aWIjYWJj', MASTER_KEY_A)).rejects.toThrow('密文格式非法')
    await expect(decryptSecret('', MASTER_KEY_A)).rejects.toThrow('密文格式非法')
  })
})

/* ------------------------------------------------------------------ */
/* JWT：HS256 签发 / 验签                                              */
/* ------------------------------------------------------------------ */

describe('signJwt / verifyJwt', () => {
  it('签发后验签返回相同载荷，且为标准三段结构', async () => {
    const payload = makePayload()
    const token = await signJwt(payload, JWT_SECRET)
    expect(token.split('.')).toHaveLength(3)
    const verified = await verifyJwt(token, JWT_SECRET)
    expect(verified).toEqual(payload)
  })

  it('头部 alg 固定为 HS256', async () => {
    const token = await signJwt(makePayload(), JWT_SECRET)
    const headerB64 = token.split('.')[0] as string
    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerB64))) as { alg?: string; typ?: string }
    expect(header.alg).toBe('HS256')
    expect(header.typ).toBe('JWT')
  })

  it('错误密钥验签拒绝', async () => {
    const token = await signJwt(makePayload(), 'another-secret')
    await expect(verifyJwt(token, JWT_SECRET)).rejects.toThrow('签名校验失败')
  })

  it('篡改载荷后验签拒绝（签名与载荷不一致）', async () => {
    const token = await signJwt(makePayload(), JWT_SECRET)
    const [headerB64, bodyB64, signatureB64] = token.split('.')
    const bodyBytes = base64UrlToBytes(bodyB64 as string)
    bodyBytes[0] ^= 0xff
    const tamperedBody = bytesToBase64Url(bodyBytes)
    await expect(verifyJwt(`${headerB64}.${tamperedBody}.${signatureB64}`, JWT_SECRET)).rejects.toThrow('签名校验失败')
  })

  it('alg 降级为 none 的伪造令牌拒绝（防降级攻击）', async () => {
    const token = await signJwt(makePayload(), JWT_SECRET)
    const bodyB64 = token.split('.')[1] as string
    const forgedHeader = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })))
    await expect(verifyJwt(`${forgedHeader}.${bodyB64}.sig`, JWT_SECRET)).rejects.toThrow('不支持的签名算法')
  })

  it('过期令牌拒绝', async () => {
    const payload = makePayload({ exp: Math.floor(Date.now() / 1000) - 10 })
    const token = await signJwt(payload, JWT_SECRET)
    await expect(verifyJwt(token, JWT_SECRET)).rejects.toThrow('会话已过期')
  })

  it('令牌结构非法（非三段 / 头部不可解析）时拒绝', async () => {
    await expect(verifyJwt('only-two-parts', JWT_SECRET)).rejects.toThrow('会话令牌格式非法')
    await expect(verifyJwt('a.b.c', JWT_SECRET)).rejects.toThrow('会话令牌格式非法')
  })

  it('不同 secret 签发的同一载荷签名不同', async () => {
    const payload = makePayload({ jti: 'fixed-jti', iat: 1700000000, exp: 1700003600 })
    const t1 = await signJwt(payload, 'secret-one')
    const t2 = await signJwt(payload, 'secret-two')
    expect(t1.split('.')[2]).not.toBe(t2.split('.')[2])
  })
})

/* ------------------------------------------------------------------ */
/* 摘要与辅助函数                                                      */
/* ------------------------------------------------------------------ */

describe('sha256Hex 已知向量', () => {
  it('sha256("abc") 匹配 FIPS 180 标准值', async () => {
    await expect(sha256Hex('abc')).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('sha256("") 匹配空输入标准值', async () => {
    await expect(sha256Hex('')).resolves.toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('sha256(中文) 可复算且对输入敏感', async () => {
    const a = await sha256Hex('渡劫code')
    const b = await sha256Hex('渡劫codf')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('辅助函数', () => {
  it('bytesToHex / hexToBytes 往返一致', () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xa5, 0xff])
    expect(bytesToHex(bytes)).toBe('000fa5ff')
    expect(Array.from(hexToBytes('000fa5ff'))).toEqual([0, 15, 165, 255])
  })

  it('hexToBytes 拒绝非法十六进制', () => {
    expect(() => hexToBytes('zz')).toThrow(HttpError)
    expect(() => hexToBytes('abc')).toThrow('十六进制字符串长度非法')
  })

  it('newId 生成前缀 + 16 位 base62 后缀且不重复', () => {
    const id = newId('usr_')
    expect(id.startsWith('usr_')).toBe(true)
    expect(id).toHaveLength(20)
    expect(id.slice(4)).toMatch(/^[0-9a-zA-Z]{16}$/)
    expect(newId('usr_')).not.toBe(id)
  })

  it('httpError / isHttpError / isUniqueConstraintError 语义正确', () => {
    try {
      httpError('TEST_CODE', '测试错误', 400)
      expect.unreachable('httpError 应当抛出')
    } catch (err) {
      expect(isHttpError(err)).toBe(true)
      if (isHttpError(err)) {
        expect(err.code).toBe('TEST_CODE')
        expect(err.status).toBe(400)
        expect(err.message).toBe('测试错误')
      }
    }
    expect(isHttpError(new Error('普通错误'))).toBe(false)
    expect(isUniqueConstraintError(new Error('UNIQUE constraint failed: users.email'))).toBe(true)
    expect(isUniqueConstraintError(new Error('other failure'))).toBe(false)
  })
})

/**
 * base64url 字符串 → 字节数组（测试内辅助，避免依赖被测模块私有函数）。
 */
function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.length % 4 === 0 ? padded : padded + '='.repeat(4 - (padded.length % 4)))
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
}

/**
 * 字节数组 → base64url 字符串（测试内辅助）。
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
