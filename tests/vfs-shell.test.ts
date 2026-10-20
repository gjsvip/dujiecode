/**
 * worker/vfs/shell.ts 虚拟 Shell 单元测试（T14）。
 *
 * 覆盖：
 * - tokenize：单/双引号、反斜杠转义、连续空白、空引号、未闭合引号；
 * - 路径纯函数：normalizePath / r2KeyFor / joinNormalized 语义与越界拒绝；
 * - 白名单命令语义（内存 D1 + R2 mock，不引 miniflare）：pwd / help / clear /
 *   echo / ls / cat / mkdir / touch / rm / cp / mv / grep / find / head / tail / wc；
 * - 非白名单命令一律拒绝（退出码 127）。
 */
import { describe, expect, it } from 'vitest'
// D1Database / R2Bucket 等直接使用 @cloudflare/workers-types 提供的全局环境类型，
// 避免显式 import 产生模块副本与 worker/types.ts 的全局类型不兼容。
import {
  VfsPathError,
  VirtualShell,
  byteLength,
  guessMime,
  joinNormalized,
  normalizePath,
  r2KeyFor,
  tokenize,
  wildcardMatch,
  type ShellResult,
  type VfsFileRow,
} from '../worker/vfs/shell'
import type { Env } from '../worker/types'

/** 测试工作区 ID */
const WS = 'ws_test000000000001'

/* ------------------------------------------------------------------ */
/* 最小 IO mock（内存 D1 + 内存 R2）                                    */
/* ------------------------------------------------------------------ */

/** 内存 R2 mock：仅实现 VirtualShell 用到的 get / put / delete */
class MockR2 {
  readonly store = new Map<string, string>()

  async get(key: string): Promise<{ text: () => Promise<string>; body: string; httpMetadata: { contentType: string } } | null> {
    const value = this.store.get(key)
    if (value === undefined) {
      return null
    }
    return { text: async () => value, body: value, httpMetadata: { contentType: 'text/plain' } }
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

/**
 * 内存 D1 mock：按 SQL 文本特征分派到内存 rows 表。
 * 覆盖 shell.ts 全部查询模式（SELECT/INSERT/UPDATE/DELETE）。
 */
class MockD1 {
  readonly rows: VfsFileRow[] = []

  prepare(sql: string): MockStatement {
    return new MockStatement(this, sql)
  }
}

class MockStatement {
  private args: unknown[] = []

  constructor(
    private readonly db: MockD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): MockStatement {
    this.args = args
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.dispatch<T | null>()
  }

  async all<T>(): Promise<D1Result<T>> {
    return { results: this.dispatch<T[]>(), success: true, meta: {} } as unknown as D1Result<T>
  }

  async run(): Promise<D1Result> {
    return this.dispatch<D1Result>()
  }

  /** 按 SQL 前缀分派（长模式在前，避免前缀误匹配） */
  private dispatch<T>(): T {
    const sql = this.sql
    const rows = this.db.rows

    if (sql.startsWith('SELECT * FROM files WHERE workspace_id = ? AND parent_id = ? AND name = ?')) {
      const [ws, parent, name] = this.args
      const row = rows.find((r) => r.workspace_id === ws && r.parent_id === parent && r.name === name)
      return (row ?? null) as T
    }
    if (sql.startsWith('SELECT * FROM files WHERE workspace_id = ? AND parent_id = ?')) {
      const [ws, parent] = this.args
      return rows.filter((r) => r.workspace_id === ws && r.parent_id === parent) as T
    }
    if (sql.startsWith('SELECT * FROM files WHERE workspace_id = ? AND type = ?')) {
      const [ws, type] = this.args
      return rows.filter((r) => r.workspace_id === ws && r.type === type) as T
    }
    if (sql.startsWith('SELECT * FROM files WHERE workspace_id = ?')) {
      const [ws] = this.args
      return rows.filter((r) => r.workspace_id === ws) as T
    }
    if (sql.startsWith('INSERT INTO files')) {
      const [id, ws, parent, name, type, size, mime, r2Key, createdAt, updatedAt] = this.args
      rows.push({
        id: id as string,
        workspace_id: ws as string,
        parent_id: parent as string,
        name: name as string,
        type: type as 'file' | 'dir',
        size: size as number,
        mime: mime as string,
        r2_key: r2Key as string | null,
        created_at: createdAt as string,
        updated_at: updatedAt as string,
      })
      return { success: true, meta: {} } as unknown as T
    }
    if (sql.startsWith('DELETE FROM files')) {
      const ws = this.args[0] as string
      const ids = new Set(this.args.slice(1) as string[])
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]
        if (row !== undefined && row.workspace_id === ws && ids.has(row.id)) {
          rows.splice(i, 1)
        }
      }
      return { success: true, meta: {} } as unknown as T
    }
    if (sql.startsWith('UPDATE files SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?')) {
      const [parent, name, , id] = this.args
      const row = rows.find((r) => r.id === id)
      if (row) {
        row.parent_id = parent as string
        row.name = name as string
      }
      return { success: true, meta: {} } as unknown as T
    }
    if (sql.startsWith('UPDATE files SET r2_key = ?, updated_at = ? WHERE id = ?')) {
      const [r2Key, , id] = this.args
      const row = rows.find((r) => r.id === id)
      if (row) {
        row.r2_key = r2Key as string
      }
      return { success: true, meta: {} } as unknown as T
    }
    if (sql.startsWith('UPDATE files SET updated_at = ? WHERE id = ?')) {
      const [, id] = this.args
      const row = rows.find((r) => r.id === id)
      if (row) {
        row.updated_at = new Date().toISOString()
      }
      return { success: true, meta: {} } as unknown as T
    }
    throw new Error(`MockD1 未覆盖的 SQL: ${sql}`)
  }
}

/** 组装测试 Env（未使用绑定给空桩，Shell 不会触达） */
function createEnv(): { env: Env; db: MockD1; r2: MockR2 } {
  const db = new MockD1()
  const r2 = new MockR2()
  const env = {
    DB: db as unknown as D1Database,
    BLOG_DB: {} as D1Database,
    KV: {} as KVNamespace,
    R2: r2 as unknown as R2Bucket,
    TERMINAL_ROOM: {} as DurableObjectNamespace,
    ASSETS: {} as Fetcher,
    ENCRYPTION_KEY: '',
    JWT_SECRET: '',
  } satisfies Env
  return { env, db, r2 }
}

let seedSeq = 0

/** 生成一行 files 元数据 */
function makeRow(
  parentId: string,
  name: string,
  type: 'file' | 'dir',
  size = 0,
  mime = '',
  r2Key: string | null = null,
): VfsFileRow {
  seedSeq += 1
  const now = new Date().toISOString()
  return {
    id: `fil_seed${String(seedSeq).padStart(4, '0')}`,
    workspace_id: WS,
    parent_id: parentId,
    name,
    type,
    size,
    mime,
    r2_key: r2Key,
    created_at: now,
    updated_at: now,
  }
}

/** 预置一个文件（自动补建缺失父目录，并写入 R2 内容） */
function seedFile(db: MockD1, r2: MockR2, path: string, content: string): void {
  const segments = path.split('/')
  const name = segments.pop() as string
  let parentId = ''
  for (const segment of segments) {
    const existing = db.rows.find((r) => r.parent_id === parentId && r.name === segment && r.type === 'dir')
    if (existing) {
      parentId = existing.id
      continue
    }
    const dir = makeRow(parentId, segment, 'dir')
    db.rows.push(dir)
    parentId = dir.id
  }
  db.rows.push(makeRow(parentId, name, 'file', content.length, guessMime(name), r2KeyFor(WS, path)))
  r2.store.set(r2KeyFor(WS, path), content)
}

/* ------------------------------------------------------------------ */
/* 纯解析函数                                                          */
/* ------------------------------------------------------------------ */

describe('tokenize', () => {
  it('单引号内为完全字面量（含双引号不转义）', () => {
    expect(tokenize("echo 'a \"b\" c'")).toEqual(['echo', 'a "b" c'])
  })

  it('双引号内支持 \" \\ $ ` 转义，其余原样保留', () => {
    expect(tokenize('echo "a\\"b\\\\c\\$d\\`e"')).toEqual(['echo', 'a"b\\c$d`e'])
    expect(tokenize('echo "a#b!c"')).toEqual(['echo', 'a#b!c'])
  })

  it('反斜杠转义下一个字符（含空白与引号）', () => {
    expect(tokenize('echo a\\ b')).toEqual(['echo', 'a b'])
    expect(tokenize('echo \\"quoted\\"')).toEqual(['echo', '"quoted"'])
  })

  it('连续空白（空格/制表符）视为单个分隔符', () => {
    expect(tokenize('ls    a\t\tb')).toEqual(['ls', 'a', 'b'])
  })

  it('空引号产生空参数', () => {
    expect(tokenize("echo '' \"\" x")).toEqual(['echo', '', '', 'x'])
  })

  it('未闭合引号宽容按行尾结束', () => {
    expect(tokenize("echo 'abc")).toEqual(['echo', 'abc'])
    expect(tokenize('echo "abc')).toEqual(['echo', 'abc'])
  })

  it('相邻引号与普通字符拼接为同一 token', () => {
    expect(tokenize('echo a"b c"d')).toEqual(['echo', 'ab cd'])
  })

  it('空行与纯空白返回空数组', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   \t ')).toEqual([])
  })
})

describe('路径纯函数', () => {
  it('normalizePath 折叠前导斜杠、. 段与 .. 段', () => {
    expect(normalizePath('')).toBe('')
    expect(normalizePath('/')).toBe('')
    expect(normalizePath('  /a/b/  ')).toBe('a/b')
    expect(normalizePath('a/./b/../c')).toBe('a/c')
    expect(normalizePath('a/b/../..')).toBe('')
  })

  it('normalizePath 对越界路径抛 VfsPathError', () => {
    expect(() => normalizePath('../etc/passwd')).toThrow(VfsPathError)
    expect(() => normalizePath('a/../../b')).toThrow(VfsPathError)
  })

  it('r2KeyFor 生成 ws/{workspaceId}/{path}', () => {
    expect(r2KeyFor(WS, 'src/index.ts')).toBe(`ws/${WS}/src/index.ts`)
    expect(r2KeyFor(WS, '')).toBe(`ws/${WS}/`)
  })

  it('joinNormalized 空段退化语义', () => {
    expect(joinNormalized('', 'a')).toBe('a')
    expect(joinNormalized('a', '')).toBe('a')
    expect(joinNormalized('a', 'b')).toBe('a/b')
  })

  it('wildcardMatch 仅支持 * 与 ? 且大小写不敏感', () => {
    expect(wildcardMatch('*.ts', 'index.TS')).toBe(true)
    expect(wildcardMatch('a?c', 'abc')).toBe(true)
    expect(wildcardMatch('a?c', 'ac')).toBe(false)
  })

  it('byteLength 与 guessMime 语义正确', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('渡劫')).toBe(6)
    expect(guessMime('a.json')).toBe('application/json')
    expect(guessMime('a.unknown')).toBe('application/octet-stream')
    expect(guessMime('Makefile')).toBe('application/octet-stream')
  })
})

/* ------------------------------------------------------------------ */
/* 白名单命令语义                                                      */
/* ------------------------------------------------------------------ */

describe('VirtualShell 白名单命令', () => {
  it('pwd / clear / help 行为正确', async () => {
    const { env } = createEnv()
    const shell = new VirtualShell(env)
    await expect(shell.execute('pwd', WS)).resolves.toEqual({ output: '/\n', exitCode: 0 })
    await expect(shell.execute('clear', WS)).resolves.toEqual({ output: '', exitCode: 0, clear: true })
    const help = await shell.execute('help', WS)
    expect(help.exitCode).toBe(0)
    expect(help.output).toContain('ls')
    expect(help.output).toContain('wc')
  })

  it('echo 拼接参数，-n 抑制末尾换行', async () => {
    const { env } = createEnv()
    const shell = new VirtualShell(env)
    await expect(shell.execute('echo hello world', WS)).resolves.toEqual({ output: 'hello world\n', exitCode: 0 })
    await expect(shell.execute('echo -n no-newline', WS)).resolves.toEqual({ output: 'no-newline', exitCode: 0 })
    await expect(shell.execute('echo', WS)).resolves.toEqual({ output: '\n', exitCode: 0 })
  })

  it('mkdir 创建目录，ls 列出内容且目录带 / 后缀', async () => {
    const { env, db } = createEnv()
    const shell = new VirtualShell(env)
    await expect(shell.execute('mkdir src', WS)).resolves.toMatchObject({ output: '', exitCode: 0 })
    await expect(shell.execute('ls', WS)).resolves.toEqual({ output: 'src/\n', exitCode: 0 })
    expect(db.rows.filter((r) => r.name === 'src')).toHaveLength(1)
  })

  it('mkdir 重复创建报错；无 -p 时父目录缺失报错', async () => {
    const { env } = createEnv()
    const shell = new VirtualShell(env)
    await shell.execute('mkdir src', WS)
    const dup = await shell.execute('mkdir src', WS)
    expect(dup.exitCode).toBe(1)
    expect(dup.output).toContain('文件或目录已存在')
    const missing = await shell.execute('mkdir a/b', WS)
    expect(missing.exitCode).toBe(1)
    expect(missing.output).toContain('父目录不存在')
  })

  it('mkdir -p 自动补齐多级父目录', async () => {
    const { env } = createEnv()
    const shell = new VirtualShell(env)
    await expect(shell.execute('mkdir -p a/b/c', WS)).resolves.toMatchObject({ exitCode: 0 })
    await expect(shell.execute('ls a', WS)).resolves.toEqual({ output: 'b/\n', exitCode: 0 })
    await expect(shell.execute('ls a/b', WS)).resolves.toEqual({ output: 'c/\n', exitCode: 0 })
  })

  it('touch 创建空文件并可 cat（空内容）', async () => {
    const { env } = createEnv()
    const shell = new VirtualShell(env)
    await expect(shell.execute('touch a.txt', WS)).resolves.toMatchObject({ exitCode: 0 })
    await expect(shell.execute('cat a.txt', WS)).resolves.toEqual({ output: '', exitCode: 0 })
    await expect(shell.execute('ls', WS)).resolves.toEqual({ output: 'a.txt\n', exitCode: 0 })
  })

  it('cat 输出预置文件内容；对不存在文件与目录报退出码 1', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'src/app.ts', 'const a = 1\nneedle here\nconst b = 2\n')
    const shell = new VirtualShell(env)
    await expect(shell.execute('cat src/app.ts', WS)).resolves.toEqual({
      output: 'const a = 1\nneedle here\nconst b = 2\n',
      exitCode: 0,
    })
    const missing = await shell.execute('cat nope.txt', WS)
    expect(missing.exitCode).toBe(1)
    expect(missing.output).toContain('不存在该文件或目录')
    const dir = await shell.execute('cat src', WS)
    expect(dir.exitCode).toBe(1)
    expect(dir.output).toContain('不是常规文件')
  })

  it('grep 命中返回 路径:行号: 内容，未命中返回退出码 1', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'src/app.ts', 'const a = 1\nneedle here\nconst b = 2\n')
    const shell = new VirtualShell(env)
    const hit = await shell.execute('grep needle', WS)
    expect(hit.exitCode).toBe(0)
    expect(hit.output).toBe('src/app.ts:2: needle here\n')
    const miss = await shell.execute('grep zzz-not-found', WS)
    expect(miss).toEqual({ output: '', exitCode: 1 })
    const ignoreCase = await shell.execute('grep -i NEEDLE src/app.ts', WS)
    expect(ignoreCase.exitCode).toBe(0)
    expect(ignoreCase.output).toBe('src/app.ts:2: needle here\n')
  })

  it('wc 统计行数 / 字符数', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'src/app.ts', 'const a = 1\nneedle here\nconst b = 2\n')
    const shell = new VirtualShell(env)
    const lines = await shell.execute('wc -l src/app.ts', WS)
    expect(lines.exitCode).toBe(0)
    expect(lines.output).toBe('3 src/app.ts\n')
    const chars = await shell.execute('wc -c src/app.ts', WS)
    expect(chars.output).toBe('36 src/app.ts\n')
  })

  it('head / tail 默认取 10 行并支持 -n', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'src/app.ts', 'const a = 1\nneedle here\nconst b = 2\n')
    const shell = new VirtualShell(env)
    await expect(shell.execute('head -n 2 src/app.ts', WS)).resolves.toEqual({
      output: 'const a = 1\nneedle here\n',
      exitCode: 0,
    })
    await expect(shell.execute('tail -n 2 src/app.ts', WS)).resolves.toEqual({
      output: 'needle here\nconst b = 2\n',
      exitCode: 0,
    })
    // 行数不足 -n 时取全部
    await expect(shell.execute('head -n 100 src/app.ts', WS)).resolves.toMatchObject({
      output: 'const a = 1\nneedle here\nconst b = 2\n',
      exitCode: 0,
    })
  })

  it('find 列目录树，支持 -name 与 -type 过滤', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'src/app.ts', 'hello\n')
    const shell = new VirtualShell(env)
    await expect(shell.execute('find src', WS)).resolves.toEqual({ output: 'src\nsrc/app.ts\n', exitCode: 0 })
    await expect(shell.execute('find -name *.ts', WS)).resolves.toEqual({ output: 'src/app.ts\n', exitCode: 0 })
    await expect(shell.execute('find -type d', WS)).resolves.toEqual({ output: 'src\n', exitCode: 0 })
  })

  it('rm 删除文件（同步清 R2）；目录无 -r 拒绝；-r 递归删除', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'src/app.ts', 'hello\n')
    seedFile(db, r2, 'top.txt', 'top\n')
    const shell = new VirtualShell(env)

    const noRecursive = await shell.execute('rm src', WS)
    expect(noRecursive.exitCode).toBe(1)
    expect(noRecursive.output).toContain('是一个目录')

    const missing = await shell.execute('rm nope.txt', WS)
    expect(missing.exitCode).toBe(1)
    expect(missing.output).toContain('不存在该文件或目录')

    await expect(shell.execute('rm top.txt', WS)).resolves.toMatchObject({ output: '', exitCode: 0 })
    expect(r2.store.has(r2KeyFor(WS, 'top.txt'))).toBe(false)
    expect(db.rows.some((r) => r.name === 'top.txt')).toBe(false)

    await expect(shell.execute('rm -r src', WS)).resolves.toMatchObject({ output: '', exitCode: 0 })
    expect(r2.store.has(r2KeyFor(WS, 'src/app.ts'))).toBe(false)
    expect(db.rows).toHaveLength(0)
    await expect(shell.execute('ls', WS)).resolves.toEqual({ output: '', exitCode: 0 })
  })

  it('rm -f 静默删除不存在的路径', async () => {
    const { env } = createEnv()
    const shell = new VirtualShell(env)
    await expect(shell.execute('rm -f nope.txt', WS)).resolves.toMatchObject({ output: '', exitCode: 0 })
  })

  it('mv 重命名文件并迁移 R2 对象', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'a.txt', 'hello\n')
    const shell = new VirtualShell(env)
    await expect(shell.execute('mv a.txt b.txt', WS)).resolves.toMatchObject({ exitCode: 0 })
    expect(db.rows[0]?.name).toBe('b.txt')
    expect(r2.store.has(r2KeyFor(WS, 'b.txt'))).toBe(true)
    expect(r2.store.has(r2KeyFor(WS, 'a.txt'))).toBe(false)
    await expect(shell.execute('cat b.txt', WS)).resolves.toMatchObject({ output: 'hello\n', exitCode: 0 })
  })

  it('mv 到已存在目标拒绝；目标不存在时报错', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'a.txt', 'hello\n')
    seedFile(db, r2, 'b.txt', 'world\n')
    const shell = new VirtualShell(env)
    const conflict = await shell.execute('mv a.txt b.txt', WS)
    expect(conflict.exitCode).toBe(1)
    expect(conflict.output).toContain('目标已存在')
    const missing = await shell.execute('mv nope.txt c.txt', WS)
    expect(missing.exitCode).toBe(1)
    expect(missing.output).toContain('不存在该文件或目录')
  })

  it('cp 复制文件内容到新路径', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'a.txt', 'hello\n')
    const shell = new VirtualShell(env)
    await expect(shell.execute('cp a.txt b.txt', WS)).resolves.toMatchObject({ exitCode: 0 })
    expect(r2.store.get(r2KeyFor(WS, 'b.txt'))).toBe('hello\n')
    await expect(shell.execute('cat b.txt', WS)).resolves.toMatchObject({ output: 'hello\n', exitCode: 0 })
    expect(db.rows.filter((r) => r.name === 'b.txt')).toHaveLength(1)
  })

  it('cp -r 递归复制目录树', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'src/app.ts', 'hello\n')
    const shell = new VirtualShell(env)
    await expect(shell.execute('cp -r src src2', WS)).resolves.toMatchObject({ exitCode: 0 })
    await expect(shell.execute('ls src2', WS)).resolves.toEqual({ output: 'app.ts\n', exitCode: 0 })
    expect(r2.store.has(r2KeyFor(WS, 'src2/app.ts'))).toBe(true)
  })

  it('cp 目录缺少 -r 拒绝；参数不足拒绝', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'src/app.ts', 'hello\n')
    const shell = new VirtualShell(env)
    const noRecursive = await shell.execute('cp src src2', WS)
    expect(noRecursive.exitCode).toBe(1)
    expect(noRecursive.output).toContain('是一个目录')
    const usage = await shell.execute('cp only-one', WS)
    expect(usage.exitCode).toBe(1)
    expect(usage.output).toContain('用法')
  })

  it('ls 多个目标时带目录头，文件目标仅输出自身名称', async () => {
    const { env, db, r2 } = createEnv()
    seedFile(db, r2, 'src/app.ts', 'hello\n')
    seedFile(db, r2, 'readme.md', 'readme\n')
    const shell = new VirtualShell(env)
    const result = await shell.execute('ls src readme.md', WS)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('src:\n')
    expect(result.output).toContain('app.ts\n')
    expect(result.output).toContain('readme.md:\n')
  })

  it('空命令返回空输出与退出码 0', async () => {
    const { env } = createEnv()
    const shell = new VirtualShell(env)
    await expect(shell.execute('', WS)).resolves.toEqual({ output: '', exitCode: 0 })
    await expect(shell.execute('   ', WS)).resolves.toEqual({ output: '', exitCode: 0 })
  })
})

describe('非白名单命令拒绝', () => {
  it('白名单外命令返回退出码 127 与提示', async () => {
    const { env } = createEnv()
    const shell = new VirtualShell(env)
    const result = await shell.execute('git status', WS)
    expect(result.exitCode).toBe(127)
    expect(result.output).toContain('不支持的命令: git')
    expect(result.output).toContain('不在白名单')
  })

  it('shell 元字符（管道/重定向）不会被解析执行', async () => {
    const { env } = createEnv()
    const shell = new VirtualShell(env)
    // tokenize 不支持管道解析：`|` 作为普通字符进入 echo 参数，不会真正执行 tee
    const piped = await shell.execute('echo hi | tee f.txt', WS)
    expect(piped.exitCode).toBe(0)
    expect(piped.output).toBe('hi | tee f.txt\n')
    // sudo 不在白名单，整体拒绝
    const sudo = await shell.execute('sudo rm -rf /', WS)
    expect(sudo.exitCode).toBe(127)
    expect(sudo.output).toContain('不支持的命令: sudo')
  })
})
