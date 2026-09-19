/**
 * Loomy 供应商实现 —— 把 Loomy 客户端使用的云端 OpenAI 兼容通道包成契约里的
 * `SupplierModule`。
 *
 * 职责边界（与 traework 同构）：**只做差异化的事**——
 *   会话解析、追踪头注入、上游调用、错误语义化、迟到失败上报、Key 账号管理。
 * 选号 / 冷却 / 禁用 / 换号 / 别名 / 模型启用状态 / 模型缓存 全是 dsh-router
 * 核心的活，插件不重复实现。
 */
import { maskSession, AccountRegistry } from './accounts.ts'
import { ModelCatalogService, type SessionProbe } from './models.ts'
import {
  DEFAULT_BASE_URL,
  DEFAULT_LOOMY_VERSION,
  DEFAULT_MODELS_TIMEOUT_MS,
  DEFAULT_MODELS_TTL_MS,
  DEFAULT_PUBLIC_DIR,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  PRIORITY,
  SUPPLIER_ID,
  SUPPLIER_NAME,
  USER_AGENT,
} from './api/constants.ts'
import { describeUpstreamBody, stateFromStatus, toStateAndMessage, UpstreamHttpError } from './api/errors.ts'
import { buildTracingHeaders } from './api/headers.ts'
import {
  assertResponseOk,
  isEventStream,
  readAllText,
  sendRequest,
} from './api/http.ts'
import { aggregateSseToCompletion, extractFrameError, hasAssistantContent, sniffLateFailure, stateFromFrameError } from './api/sse.ts'
import type {
  AccountState,
  ChatOnceResult,
  ChatRequest,
  ModelInfo,
  SupplierEnv,
  SupplierStatusNow,
} from './contract.ts'
import type { LoomyModelInfo } from './types.ts'

/** 插件可配置项（默认值全部来自实测，见 docs/loomy-upstream.md）。 */
export interface LoomyConfig {
  /** 上游 OpenAI 兼容 base（客户端 opencode.json provider.imodel.options.baseURL）。 */
  baseUrl: string
  /** 追踪头 loomy-version。 */
  loomyVersion: string
  /** invokeorigin：插件作为用户主动调用填 'user'。 */
  invokeOrigin: string
  /** 对话请求的「响应头到达」超时。 */
  timeoutMs: number
  /** /models 拉取超时。 */
  modelsTimeoutMs: number
  /** 模型目录内存缓存 TTL。 */
  modelsTtlMs: number
  /** Loomy 客户端公共数据根目录。 */
  publicDir: string
  /** 登录态文件重新读取间隔。 */
  sessionTtlMs: number
  /** 请求体未指定 max_tokens 时的默认值（与客户端实测值一致）。 */
  defaultMaxTokens: number
  /** 兜底默认模型（面板选 auto 时使用）。 */
  defaultModel: string
  /** 是否附带 x-session-affinity（模拟客户端行为，默认 true）。 */
  sessionAffinity: boolean
}

export const DEFAULT_CONFIG: Omit<LoomyConfig, 'publicDir'> = {
  baseUrl: DEFAULT_BASE_URL,
  loomyVersion: DEFAULT_LOOMY_VERSION,
  invokeOrigin: 'user',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  modelsTimeoutMs: DEFAULT_MODELS_TIMEOUT_MS,
  modelsTtlMs: DEFAULT_MODELS_TTL_MS,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  defaultMaxTokens: 32_000,
  defaultModel: 'deepseek-v4-flash-0731',
  sessionAffinity: true,
}

interface Health {
  state: AccountState
  message?: string
  at: number
}

export class LoomySupplier {
  readonly id = SUPPLIER_ID
  readonly name = SUPPLIER_NAME
  readonly priority = PRIORITY

  private readonly env: SupplierEnv
  private readonly cfg: LoomyConfig
  private readonly catalog: ModelCatalogService
  private readonly registry: AccountRegistry
  /** 每个账号「最近一次观察到的状态」（只影响面板展示与后续请求的冷却依据）。 */
  private readonly health = new Map<string, Health>()
  /** 最近一次上游 usage（面板展示 points_consumed，上游按积分计费）。 */
  private lastUsage: { points: number; model: string; at: number } | undefined
  /** 上一次后台健康探测时间（避免面板轮询打爆上游）。 */
  private probedAt = 0
  private probing = false

  constructor(env: SupplierEnv, overrides: Partial<LoomyConfig> = {}) {
    this.env = env
    this.cfg = { publicDir: DEFAULT_PUBLIC_DIR, ...DEFAULT_CONFIG, ...overrides }
    this.catalog = new ModelCatalogService({
      baseUrl: this.cfg.baseUrl,
      loomyVersion: this.cfg.loomyVersion,
      publicDir: this.cfg.publicDir,
      modelsTimeoutMs: this.cfg.modelsTimeoutMs,
      modelsTtlMs: this.cfg.modelsTtlMs,
      log: (msg) => this.log(msg),
    })
    this.registry = new AccountRegistry({
      supplierId: this.id,
      publicDir: this.cfg.publicDir,
      credentials: env.credentials,
      log: (msg) => this.log(msg),
      sessionTtlMs: this.cfg.sessionTtlMs,
    })
  }

  private log(msg: string): void {
    try {
      this.env.log(msg)
    } catch {
      // 日志失败绝不影响主流程
    }
  }

  /** 启动：预热模型目录（不阻塞加载；失败静默回退）。 */
  async start(): Promise<void> {
    const session = this.registry.resolve('')?.session
    await this.catalog.list(session)
  }

  dispose(): void {
    // 无后台定时器 / 无长连接需要清理（探测是触发式的）
  }

  // ---------------------------------------------------------------------------
  // 面板状态
  // ---------------------------------------------------------------------------

  status(): SupplierStatusNow {
    this.touchProbe()
    const accounts = this.registry.list().map((entry) => {
      const h = this.health.get(entry.uid)
      const resolved = this.registry.resolve(entry.uid)
      const bits: string[] = []
      if (resolved !== undefined) {
        bits.push(`会话 ${maskSession(resolved.session)}`)
        if (entry.source === 'file' && entry.file !== undefined) bits.push(entry.file)
        else bits.push('面板添加')
      } else {
        bits.push('会话缺失')
      }
      if (entry.uid === '' || entry.source === 'file') {
        if (this.lastUsage !== undefined) {
          bits.push(`最近一次调用消耗 ${this.lastUsage.points} 积分（${this.lastUsage.model}）`)
        }
      }
      return {
        uid: entry.uid,
        nickname: entry.nickname,
        // Loomy 无公开的积分查询端点：**报 -1（未知）**，不能报 0——
        // 0 是真值「用完了」，核心会把它当成一次有效读数写进缓存。
        credits: -1,
        state: h?.state ?? ('ok' as AccountState),
        message: h?.message !== undefined ? `${h.message}（${bits.join(' · ')}）` : bits.join(' · '),
      }
    })
    return { id: this.id, name: this.name, accounts }
  }

  /**
   * 触发式健康探测：`/models` 是最轻的可鉴权端点，既刷新模型目录又顺带验证
   * 会话串是否还有效（401/403 = session_dead）。TTL 内不重复发。
   */
  private touchProbe(): void {
    const now = Date.now()
    if (this.probing || now - this.probedAt < this.cfg.modelsTtlMs) return
    const entries = this.registry.list()
    if (entries.length === 0) return
    this.probedAt = now
    this.probing = true
    void this.probeAll(entries.map((e) => e.uid)).finally(() => {
      this.probing = false
    })
  }

  private async probeAll(uids: string[]): Promise<void> {
    for (const uid of uids) {
      const resolved = this.registry.resolve(uid)
      if (resolved === undefined) {
        this.setHealth(uid, 'session_dead', '会话缺失（请启动 Loomy 客户端登录，或在面板添加 Key）')
        continue
      }
      let result: SessionProbe
      try {
        result = await this.catalog.probe(resolved.session)
      } catch (err) {
        // probe 自身不抛：这里只防御实现变更
        this.log(`loomy: 会话探测异常：${(err as Error).message}`)
        continue
      }
      if (result.ok) {
        this.clearHealth(uid)
        continue
      }
      const state: AccountState = result.status !== undefined ? stateFromStatus(result.status) : 'transport'
      this.setHealth(uid, state, `会话校验失败：${result.message}`)
    }
  }

  private setHealth(uid: string, state: AccountState, message: string): void {
    this.health.set(uid, { state, message, at: Date.now() })
  }

  private clearHealth(uid: string): void {
    this.health.delete(uid)
  }

  // ---------------------------------------------------------------------------
  // 模型
  // ---------------------------------------------------------------------------

  async listModels(force = false): Promise<ModelInfo[]> {
    const entries = this.registry.list()
    // 优先用本机登录态拉上游清单；没有登录态时用第一个面板 Key
    const uid = entries.find((e) => e.source === 'file')?.uid ?? entries[0]?.uid ?? ''
    const session = this.registry.resolve(uid)?.session
    const catalog = await this.catalog.list(session, force)
    const disabled = new Set(this.store().disabled)
    return catalog.models.filter((m) => !disabled.has(m.id)).map((m) => this.toModelInfo(m))
  }

  /** core 只认 `{ id, context_length }`，其余字段是插件内部用。 */
  private toModelInfo(m: LoomyModelInfo): ModelInfo {
    const out: ModelInfo = { id: m.id }
    if (m.context_length !== undefined) out.context_length = m.context_length
    return out
  }

  private store(): { alias: string; disabled: string[]; custom: string[] } {
    try {
      const cfg = this.env.store.get(this.id)
      return { alias: cfg.alias, disabled: cfg.disabled ?? [], custom: cfg.custom ?? [] }
    } catch {
      return { alias: '', disabled: [], custom: [] }
    }
  }

  /** 已知模型 id（目录快照 + 面板自定义 + 内置）。 */
  private knownIds(): Set<string> {
    const set = this.catalog.knownIds(this.store().custom)
    return set
  }

  /** 把核心传来的模型名解析成上游模型 id（剥别名前缀 / 大小写归一 / auto 兜底）。 */
  private resolveModelId(model: string): string | undefined {
    let base = model.trim()
    // 模型全名可能是 `<alias>/<id>`；id 自身不含斜杠，故取首个 '/' 之后的部分
    const slash = base.indexOf('/')
    if (slash >= 0) base = base.slice(slash + 1)
    // 兼容双写前缀 `loomy/loomy/xxx`
    const second = base.indexOf('/')
    if (second >= 0) base = base.slice(second + 1)
    const known = this.knownIds()
    if (base === '' || base === 'auto') {
      if (known.has(this.cfg.defaultModel)) return this.cfg.defaultModel
      const first = [...known][0]
      return first
    }
    if (known.has(base)) return base
    const lower = base.toLowerCase()
    for (const id of known) {
      if (id.toLowerCase() === lower) return id
    }
    return undefined
  }

  // ---------------------------------------------------------------------------
  // 对话
  // ---------------------------------------------------------------------------

  /**
   * 对**单个账号**调一次上游。选号/冷却/禁用/换号是核心的活，这里只负责
   * 会话解析 + 追踪头注入 + 协议调用 + 失败语义化。
   */
  async chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult> {
    const accountUid = uid === '' ? '' : uid
    const modelId = this.resolveModelId(req.model)
    if (modelId === undefined) {
      // 不是本供应商的模型：交给下一个供应商（绝不能记在账号头上）
      return { ok: false, state: 'no_such_model', message: `unknown model ${JSON.stringify(req.model)}` }
    }
    if (this.store().disabled.includes(modelId)) {
      return { ok: false, state: 'no_such_model', message: `model ${JSON.stringify(modelId)} is disabled` }
    }

    const resolved = this.registry.resolve(accountUid)
    if (resolved === undefined) {
      const message =
        accountUid === '' || accountUid === 'local-session'
          ? `未找到 Loomy 登录态文件（期望 ${this.cfg.publicDir}\\<安装ID>\\userData\\auth-session.json），请在面板为本供应商添加会话串 Key`
          : `unknown account ${JSON.stringify(accountUid)}`
      const state: AccountState = accountUid === '' || accountUid === 'local-session' ? 'session_dead' : 'no_such_model'
      this.setHealth(accountUid, state, message)
      return { ok: false, state, message }
    }

    const body = this.prepareBody(req, modelId, lv)
    const headers = this.buildHeaders(resolved.session)
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`

    let response: Response
    try {
      response = await sendRequest({
        url,
        method: 'POST',
        headers,
        body,
        headerTimeoutMs: this.cfg.timeoutMs,
      })
      await assertResponseOk(response)
    } catch (err) {
      const { state, message } = toStateAndMessage(err)
      this.setHealth(resolved.uid, state, message)
      return { ok: false, state, message }
    }

    // 会话有效：清掉之前的失败记录（新登录态/新 Key 不该被旧错误继续判死）
    this.clearHealth(resolved.uid)
    this.noteSessionRefresh(resolved.uid)

    if (requestedStream(req) && isEventStream(response)) {
      if (response.body === null) {
        return { ok: false, state: 'transport', message: 'loomy upstream: empty stream body' }
      }
      const stream = sniffLateFailure(response.body, (state, message) => {
        this.setHealth(resolved.uid, state, message)
        this.reportLateFailure(resolved.uid, modelId, state, message)
      })
      return { ok: true, stream }
    }

    // 非流式：上游正常回单个 JSON；若网关忽略 stream=false 仍回 SSE，则聚合。
    let text = ''
    try {
      text = response.body === null ? '' : await readAllText(response.body)
    } catch (err) {
      const { state, message } = toStateAndMessage(err)
      this.setHealth(resolved.uid, state, message)
      return { ok: false, state, message }
    }

    if (isEventStream(response)) {
      const aggregated = aggregateSseToCompletion(text)
      if (!hasAssistantContent(aggregated)) {
        const message = 'upstream returned empty response (aggregated SSE)'
        this.setHealth(resolved.uid, 'unknown', message)
        return { ok: false, state: 'unknown', message }
      }
      return { ok: true, status: 200, body: JSON.stringify(aggregated) }
    }

    let parsed: Record<string, unknown>
    try {
      parsed = text.trim() === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    } catch {
      const message = `upstream returned non-JSON body: ${describeUpstreamBody(text)}`
      this.setHealth(resolved.uid, 'unknown', message)
      return { ok: false, state: 'unknown', message }
    }
    const frameError = extractFrameError(parsed)
    if (frameError !== undefined) {
      const state = stateFromFrameError(frameError.code, frameError.message)
      const message = `upstream error: ${frameError.message}`
      this.setHealth(resolved.uid, state, message)
      return { ok: false, state, message }
    }
    if (!hasAssistantContent(parsed)) {
      const message = 'upstream returned empty response'
      this.setHealth(resolved.uid, 'unknown', message)
      return { ok: false, state: 'unknown', message }
    }
    this.noteUsage(parsed, modelId)
    return { ok: true, status: 200, body: text }
  }

  /**
   * 请求体改写：只动插件必须动的字段，其余原样透传（含 messages / tools / 采样参数）。
   *
   *   - `model` 换成本供应商解析出的上游 id
   *   - `max_tokens` 缺省时补默认值（客户端实测为 32000）
   *   - 非流式路径强制 `stream:false` 并去掉 `stream_options`（否则拿不到单体 JSON）
   *   - `lv` 有具体档位且模型声明支持时写入 `reasoning_effort`
   */
  private prepareBody(req: ChatRequest, modelId: string, lv: string): string {
    let obj: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(req.rawBody)
      obj = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      obj = {}
    }
    obj.model = modelId
    if (typeof obj.max_tokens !== 'number') obj.max_tokens = this.cfg.defaultMaxTokens
    if (req.stream) {
      obj.stream = true
      if (typeof obj.stream_options !== 'object' || obj.stream_options === null) {
        obj.stream_options = { include_usage: true }
      }
    } else {
      obj.stream = false
      delete obj.stream_options
    }
    const catalog = this.catalog.snapshot()
    const info = catalog?.models.find((m) => m.id === modelId)
    const lvNormalized = lv.trim().toLowerCase()
    if (lvNormalized !== '' && lvNormalized !== 'auto' && lvNormalized !== 'off' && lvNormalized !== 'none') {
      if (info?.reasoning_efforts?.includes(lvNormalized) === true) obj.reasoning_effort = lvNormalized
      // 模型未声明 reasoning_efforts 时不硬塞：上游对未知参数可能直接 400
    } else {
      delete obj.reasoning_effort
    }
    return JSON.stringify(obj)
  }

  /**
   * 构造请求头：鉴权 + 四个必带追踪头。
   * `traceparent` 缺失会让上游连接挂死（实测结论），故每次请求都新生成。
   */
  private buildHeaders(session: string): Record<string, string> {
    return {
      authorization: `Bearer ${session}`,
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json, */*',
      'user-agent': USER_AGENT,
      ...buildTracingHeaders({
        version: this.cfg.loomyVersion,
        invokeOrigin: this.cfg.invokeOrigin,
        sessionAffinity: this.cfg.sessionAffinity,
      }),
    }
  }

  /** 会话文件本体发生变化（客户端重新登录）时清空健康记录。 */
  private noteSessionRefresh(uid: string): void {
    if (uid !== '' && uid !== 'local-session') return
    const h = this.health.get(uid)
    if (h !== undefined && h.state === 'session_dead') this.clearHealth(uid)
  }

  /** 迟到失败上报（核心实现 = pool.noteFailure，作用于**后续**请求）。 */
  private reportLateFailure(uid: string, modelId: string, state: AccountState, message: string): void {
    // 调用时才读：核心是先跑 factory 再挂这个回调的
    const hook = this.env.onLateFailure
    if (hook === undefined) {
      this.log(`loomy: late failure (${state}) on ${modelId}: ${message}`)
      return
    }
    try {
      hook(uid, modelId, state, message)
    } catch (err) {
      this.log(`loomy: onLateFailure threw: ${(err as Error).message}`)
    }
  }

  /** 记录 usage（顺带把 points_consumed 拿出来给面板看）。 */
  private noteUsage(body: Record<string, unknown>, modelId: string): void {
    const usage = body.usage as Record<string, unknown> | undefined
    const points = usage?.points_consumed
    if (typeof points === 'number') {
      this.lastUsage = { points, model: modelId, at: Date.now() }
    }
  }

  // ---------------------------------------------------------------------------
  // 差异化：面板 Key 账号
  // ---------------------------------------------------------------------------

  /**
   * 面板「添加 API key」：填名字 + Loomy 会话串。
   * 先探测一次（GET /models），401/403 等确定性鉴权失败直接拒绝——让用户当场
   * 知道串填错了，而不是等第一次对话才发现。
   */
  async addApiKey(input: { name: string; apiKey: string }): Promise<{ ok: boolean; error?: string; account?: { uid: string; nickname: string } }> {
    const apiKey = input.apiKey.trim()
    if (apiKey === '') return { ok: false, error: '会话串不能为空' }
    const probe = await this.catalog.probe(apiKey)
    if (!probe.ok && probe.status !== undefined && probe.status >= 400 && probe.status < 500) {
      return { ok: false, error: `会话串校验失败（HTTP ${probe.status}）：${probe.message}` }
    }
    if (!probe.ok) {
      this.log(`loomy: 添加 Key 时无法完成探测（${probe.message}），先接受该凭证`)
    }
    try {
      const account = this.registry.addKey({ name: input.name, apiKey })
      // 用新 Key 刷新一次模型目录（若原目录是内置兜底，这里能升到上游权威列表）
      await this.catalog.list(apiKey, true).catch(() => undefined)
      return { ok: true, account }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /** 面板移除链接：只允许删面板添加的 Key，本机登录态账号不动。 */
  async removeLink(uid: string): Promise<boolean> {
    const removed = this.registry.remove(uid)
    if (removed) this.clearHealth(uid)
    return removed
  }
}

/** 客户端是否请求了流式（核心的 req.stream 为准，body 仅作兜底）。 */
function requestedStream(req: ChatRequest): boolean {
  if (req.stream) return true
  try {
    const body = JSON.parse(req.rawBody) as Record<string, unknown>
    return body.stream === true
  } catch {
    return false
  }
}

/** 便于测试/外部构造：把 UpstreamHttpError 的语义说出来。 */
export function describeHttpError(err: unknown): string {
  if (err instanceof UpstreamHttpError) {
    return `HTTP ${err.status}: ${describeUpstreamBody(err.bodyText)}`
  }
  return err instanceof Error ? err.message : String(err)
}
