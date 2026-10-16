/**
 * Loomy 客户端（Electron 桌面端）的**定位 / 启动 / 运行探测**。
 *
 * 为什么是「探测」而不是写死路径：客户端安装位置由安装器决定，注册表里既没有
 * App Paths、也没有卸载项、也没有记录安装路径的配置文件（2026-09-19 实测），
 * 本机实际装在 `D:\loomy\Loomy.exe`。所以按优先级逐个候选路径 stat：
 *
 *   `LOOMY_CLIENT_EXE` 覆盖 → `%LOCALAPPDATA%` → `%APPDATA%` → 公共目录 →
 *   逐个盘符的常见布局（`<盘>:\loomy`、`<盘>:\Program Files\Loomy` …）
 *
 * 盘符扫描放在最后：前几档命中就不扫盘，正常机器上只是一两次 stat。
 *
 * 与 `contract.ts` 同思路，本模块**不依赖任何宿主类型**，可离线构建/测试。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CLIENT_EXE_ENV,
  CLIENT_EXE_NAME,
  DEFAULT_LOCATE_TTL_MS,
  DEFAULT_RUNNING_TTL_MS,
  TASKLIST_TIMEOUT_MS,
} from './api/constants.ts'

/** 相对**盘符根**的候选布局。 */
const DRIVE_LAYOUTS: readonly (readonly string[])[] = [
  ['loomy', CLIENT_EXE_NAME],
  ['Loomy', CLIENT_EXE_NAME],
  ['Program Files', 'Loomy', CLIENT_EXE_NAME],
  ['Program Files (x86)', 'Loomy', CLIENT_EXE_NAME],
]

export interface ClientCandidatesInput {
  /** 显式指定的可执行文件（最高优先级）。 */
  exeOverride?: string
  /** 环境变量来源（默认 `process.env`；测试可注入）。 */
  env?: Record<string, string | undefined>
  /** 盘符根列表（默认探测 A:–Z:；测试可注入，避免依赖真实磁盘布局）。 */
  driveRoots?: readonly string[]
}

/** 本机存在的盘符根（`C:\` 形式）。非 Windows 返回空数组。 */
export function driveRoots(): string[] {
  if (process.platform !== 'win32') return []
  const out: string[] = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (existsSync(root)) out.push(root)
    } catch {
      // 光驱/未就绪的盘符：跳过
    }
  }
  return out
}

/** 候选可执行文件路径（按优先级、已去重）。纯函数，便于测试。 */
export function clientCandidates(input: ClientCandidatesInput = {}): string[] {
  const env = input.env ?? process.env
  const out: string[] = []
  const push = (path: string | undefined): void => {
    if (path !== undefined && path !== '' && !out.includes(path)) out.push(path)
  }

  push(input.exeOverride)

  const local = env.LOCALAPPDATA
  if (local !== undefined && local !== '') {
    // Electron 安装器常见布局：用户级 Programs\<App> 或 %LOCALAPPDATA%\<App>
    push(join(local, 'Programs', 'Loomy', CLIENT_EXE_NAME))
    push(join(local, 'Loomy', CLIENT_EXE_NAME))
  }
  const roaming = env.APPDATA
  if (roaming !== undefined && roaming !== '') push(join(roaming, 'Loomy', CLIENT_EXE_NAME))

  // 公共数据目录：Loomy 把 <安装ID>/userData 放这儿，安装目录有时与之同源
  const publicRoot = env.PUBLIC ?? 'C:\\Users\\Public'
  push(join(publicRoot, 'Loomy', CLIENT_EXE_NAME))

  for (const root of input.driveRoots ?? driveRoots()) {
    for (const layout of DRIVE_LAYOUTS) push(join(root, ...layout))
  }
  return out
}

export interface ClientAppOptions {
  log: (msg: string) => void
  /** 显式可执行文件（来自 `LOOMY_CLIENT_EXE`）。 */
  exeOverride?: string
  /** 候选列表来源（测试注入；默认 `clientCandidates()`）。 */
  candidates?: () => string[]
  /** 运行探测实现（测试注入；默认 tasklist）。 */
  probeRunning?: () => Promise<boolean>
  locateTtlMs?: number
  runningTtlMs?: number
}

export interface LaunchResult {
  ok: boolean
  /** 客户端本来就在运行，没有重复启动。 */
  already?: boolean
  exe?: string
  error?: string
}

/** 用 tasklist 查客户端进程是否存在（只读查询，失败当「未运行」）。 */
function probeRunningByTasklist(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    try {
      execFile(
        'tasklist',
        ['/FI', `IMAGENAME eq ${CLIENT_EXE_NAME}`, '/NH', '/FO', 'CSV'],
        { timeout: TASKLIST_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          // 无匹配时 tasklist 退出码仍是 0，只是输出一句提示；只有真出错才走 err
          if (err !== null) {
            resolve(false)
            return
          }
          resolve(stdout.toLowerCase().includes(CLIENT_EXE_NAME.toLowerCase()))
        },
      )
    } catch {
      resolve(false)
    }
  })
}

export class ClientApp {
  private readonly opts: ClientAppOptions
  private readonly locateTtlMs: number
  private readonly runningTtlMs: number
  private exeCache: { exe: string | undefined; at: number } | undefined
  private running = false
  /** 0 = 还没探测过（`runningNow()` 据此区分「未知」与「未运行」）。 */
  private runningAt = 0
  private probing = false

  constructor(opts: ClientAppOptions) {
    this.opts = opts
    this.locateTtlMs = opts.locateTtlMs ?? DEFAULT_LOCATE_TTL_MS
    this.runningTtlMs = opts.runningTtlMs ?? DEFAULT_RUNNING_TTL_MS
  }

  private log(msg: string): void {
    try {
      this.opts.log(msg)
    } catch {
      // 日志失败绝不影响主流程
    }
  }

  /** 定位客户端可执行文件（带 TTL 缓存；未找到也缓存，避免反复扫盘）。 */
  locateExe(force = false): string | undefined {
    const now = Date.now()
    if (!force && this.exeCache !== undefined && now - this.exeCache.at <= this.locateTtlMs) {
      return this.exeCache.exe
    }
    const list = this.opts.candidates?.() ?? clientCandidates({ exeOverride: this.opts.exeOverride })
    let found: string | undefined
    for (const candidate of list) {
      try {
        if (statSync(candidate).isFile()) {
          found = candidate
          break
        }
      } catch {
        // 该候选不存在：继续下一个
      }
    }
    this.exeCache = { exe: found, at: now }
    if (found === undefined) {
      this.log(`loomy: 未找到客户端可执行文件（已试 ${list.length} 个候选路径），可用 ${CLIENT_EXE_ENV} 指定`)
    }
    return found
  }

  /** 最近一次运行探测结果（同步读取；`undefined` = 还没探测过）。 */
  runningNow(): boolean | undefined {
    return this.runningAt === 0 ? undefined : this.running
  }

  /**
   * 刷新「客户端是否在运行」。
   *
   * status() 契约要求同步且廉价，所以这里只做**异步刷新 + 缓存**：
   * status() 读 `runningNow()`，由它按 TTL 更新。
   */
  async refreshRunning(force = false): Promise<boolean> {
    const now = Date.now()
    if (!force && this.runningAt !== 0 && now - this.runningAt <= this.runningTtlMs) {
      return this.running
    }
    if (this.probing) return this.running
    this.probing = true
    try {
      const probe = this.opts.probeRunning ?? probeRunningByTasklist
      this.running = await probe()
    } catch (err) {
      this.running = false
      this.log(`loomy: 客户端运行探测失败：${(err as Error).message}`)
    } finally {
      this.probing = false
      this.runningAt = Date.now()
    }
    return this.running
  }

  /** 启动客户端（已在运行则不重复启动）。 */
  async launch(): Promise<LaunchResult> {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Loomy 客户端目前只有 Windows 版，当前平台不支持自动启动' }
    }
    if (await this.refreshRunning(true)) {
      return { ok: true, already: true, exe: this.locateExe() }
    }
    const exe = this.locateExe(true)
    if (exe === undefined) {
      return {
        ok: false,
        error: `未找到 Loomy 客户端（${CLIENT_EXE_NAME}）。可用环境变量 ${CLIENT_EXE_ENV} 指定完整路径后重试`,
      }
    }
    try {
      const child = spawn(exe, [], { cwd: dirname(exe), detached: true, stdio: 'ignore' })
      // spawn 的失败是**异步**的 'error' 事件：不挂监听就会变成 unhandled
      // 'error' 直接打挂宿主进程（与 api/http.ts 里 cancel() 的坑同源）。
      child.on('error', (err) => {
        this.log(`loomy: 启动客户端失败：${err.message}`)
      })
      child.unref()
    } catch (err) {
      return { ok: false, error: `启动失败：${(err as Error).message}`, exe }
    }
    this.log(`loomy: 已启动客户端 ${exe}`)
    return { ok: true, exe }
  }
}
