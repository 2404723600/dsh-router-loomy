/**
 * 账号与会话解析。
 *
 * 两类账号来源：
 *
 *   1. **本机登录态文件**（uid = `local-session`，不可删除）
 *      `<publicDir>/<安装ID>/userData/auth-session.json` 的 `session` 字段，
 *      即客户端启动时读取的登录态。插件按文件 mtime/TTL 重新读取：用户在客户端
 *      重新登录后，无需重启 dsh 也能拿到新的会话串。
 *   2. **面板手填 Key**（uid = `key-1`、`key-2`…，存 core CredentialStore）
 *      给「本机没装客户端 / 想用另一个账号」的场景；凭证是不透明 blob，
 *      由插件自己解释（`{ name, apiKey, createdAt }`）。
 *
 * 会话串同时是 `Authorization: Bearer <session>` 的取值，**属敏感凭据**：
 * 只落 core 凭证存储，日志里只出现脱敏前缀。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AUTH_SESSION_FILE, AUTO_UID, KEY_UID_PREFIX } from './api/constants.ts'
import type { CredentialStoreLike } from './contract.ts'
import type { LoomyKeyAccount, LoomySessionFile, ResolvedSession } from './types.ts'

export interface AccountEntry {
  uid: string
  nickname: string
  source: 'file' | 'key'
  /** file 来源时的绝对路径。 */
  file?: string
}

export interface AccountsOptions {
  /** 供应商 id（凭证存储的命名空间）。 */
  supplierId: string
  /** Loomy 客户端公共数据根目录。 */
  publicDir: string
  credentials: CredentialStoreLike
  log: (msg: string) => void
  /** 会话文件重新读取的最小间隔（避免面板轮询把磁盘打热）。 */
  sessionTtlMs: number
}

/** 会话脱敏展示（日志/报错用）。 */
export function maskSession(session: string): string {
  if (session.length <= 8) return '****'
  return `${session.slice(0, 4)}****${session.slice(-4)}`
}

export class AccountRegistry {
  private readonly opts: AccountsOptions
  private fileCache: { path: string; data: LoomySessionFile; at: number } | undefined
  /** 定位到的安装目录（缓存，避免每次 listdir）。 */
  private userDataDir: string | undefined

  constructor(opts: AccountsOptions) {
    this.opts = opts
  }

  /** 本机登录态文件路径（找不到返回 undefined）。 */
  locateSessionFile(): string | undefined {
    if (this.userDataDir !== undefined) {
      const candidate = join(this.userDataDir, AUTH_SESSION_FILE)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        this.userDataDir = undefined
      }
    }
    let entries: string[]
    try {
      entries = readdirSync(this.opts.publicDir)
    } catch {
      return undefined
    }
    const found: Array<{ dir: string; path: string; time: number }> = []
    for (const entry of entries) {
      const dir = join(this.opts.publicDir, entry, 'userData')
      const path = join(dir, AUTH_SESSION_FILE)
      try {
        const st = statSync(path)
        if (!st.isFile()) continue
        found.push({ dir, path, time: st.mtimeMs })
      } catch {
        // 该安装目录没有登录态文件
      }
    }
    found.sort((a, b) => b.time - a.time)
    const best = found[0]
    if (best === undefined) return undefined
    this.userDataDir = best.dir
    return best.path
  }

  /** 读取本机登录态（带 TTL 缓存；文件读坏时返回上一次成功值）。 */
  readSessionFile(force = false): { path: string; data: LoomySessionFile } | undefined {
    const now = Date.now()
    if (!force && this.fileCache !== undefined && now - this.fileCache.at <= this.opts.sessionTtlMs) {
      return { path: this.fileCache.path, data: this.fileCache.data }
    }
    const path = this.locateSessionFile()
    if (path === undefined) return undefined
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LoomySessionFile
      if (typeof parsed.session !== 'string' || parsed.session.trim() === '') {
        this.opts.log(`loomy: 登录态文件缺少 session 字段：${path}`)
        return undefined
      }
      this.fileCache = { path, data: parsed, at: now }
      return { path, data: parsed }
    } catch (err) {
      this.opts.log(`loomy: 登录态文件读取失败（${path}）：${(err as Error).message}`)
      return this.fileCache === undefined ? undefined : { path: this.fileCache.path, data: this.fileCache.data }
    }
  }

  /** 本机登录态账号的展示名（含脱敏手机号，便于多账号辨认）。 */
  private localNickname(data: LoomySessionFile): string {
    const phone = typeof data.phone === 'string' && data.phone !== '' ? data.phone : ''
    return phone !== '' ? `本机客户端 · ${phone}` : '本机客户端'
  }

  /** 面板添加的 Key 账号（按 uid 排序，保证面板顺序稳定）。 */
  keyEntries(): Array<{ uid: string; blob: LoomyKeyAccount }> {
    const out: Array<{ uid: string; blob: LoomyKeyAccount }> = []
    for (const uid of this.opts.credentials.list(this.opts.supplierId)) {
      if (!uid.startsWith(KEY_UID_PREFIX)) continue
      const blob = this.opts.credentials.get<LoomyKeyAccount>(this.opts.supplierId, uid)
      if (blob === undefined || typeof blob.apiKey !== 'string' || blob.apiKey.trim() === '') continue
      out.push({ uid, blob })
    }
    out.sort((a, b) => a.uid.localeCompare(b.uid, undefined, { numeric: true }))
    return out
  }

  /** 账号列表：本机登录态在前，其后是面板 Key。 */
  list(): AccountEntry[] {
    const out: AccountEntry[] = []
    const file = this.readSessionFile()
    if (file !== undefined) {
      out.push({ uid: AUTO_UID, nickname: this.localNickname(file.data), source: 'file', file: file.path })
    }
    for (const { uid, blob } of this.keyEntries()) {
      out.push({ uid, nickname: blob.name !== '' ? blob.name : `Loomy Key ${uid.slice(KEY_UID_PREFIX.length)}`, source: 'key' })
    }
    return out
  }

  /** 解析某个 uid 对应的会话串。 */
  resolve(uid: string): ResolvedSession | undefined {
    if (uid === '' || uid === AUTO_UID) {
      const file = this.readSessionFile()
      if (file === undefined) return undefined
      return {
        session: file.data.session.trim(),
        uid: AUTO_UID,
        nickname: this.localNickname(file.data),
        source: 'file',
        file: file.path,
      }
    }
    const blob = this.opts.credentials.get<LoomyKeyAccount>(this.opts.supplierId, uid)
    if (blob === undefined || typeof blob.apiKey !== 'string' || blob.apiKey.trim() === '') return undefined
    return {
      session: blob.apiKey.trim(),
      uid,
      nickname: blob.name !== '' ? blob.name : `Loomy Key ${uid.slice(KEY_UID_PREFIX.length)}`,
      source: 'key',
    }
  }

  /** 判断某个 uid 是否已被占用。 */
  has(uid: string): boolean {
    if (uid === AUTO_UID) return this.readSessionFile() !== undefined
    return this.opts.credentials.get<LoomyKeyAccount>(this.opts.supplierId, uid) !== undefined
  }

  /** 添加一个面板 Key 账号（uid 自动分配）。 */
  addKey(input: { name: string; apiKey: string }): { uid: string; nickname: string } {
    const apiKey = input.apiKey.trim()
    // 同一会话串不重复入库：重复添加只会在面板产生一个永远抢不到请求的账号
    for (const { uid, blob } of this.keyEntries()) {
      if (blob.apiKey.trim() === apiKey) throw new Error(`该会话串已存在于账号 ${uid}，无需重复添加`)
    }
    let index = 1
    while (this.has(`${KEY_UID_PREFIX}${index}`)) index += 1
    const uid = `${KEY_UID_PREFIX}${index}`
    const nickname = input.name.trim() !== '' ? input.name.trim() : `Loomy Key ${index}`
    const blob: LoomyKeyAccount = { name: nickname, apiKey, createdAt: Date.now() }
    this.opts.credentials.save(this.opts.supplierId, uid, blob)
    return { uid, nickname }
  }

  /** 删除一个面板 Key 账号（本机登录态账号不可删除）。 */
  remove(uid: string): boolean {
    if (uid === AUTO_UID || !uid.startsWith(KEY_UID_PREFIX)) return false
    if (this.opts.credentials.get(this.opts.supplierId, uid) === undefined) return false
    this.opts.credentials.remove(this.opts.supplierId, uid)
    return true
  }
}
