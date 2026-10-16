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
import { ClientApp, type LaunchResult } from './client-app.ts'
import { ModelCatalogService, type SessionProbe } from './models.ts'
import {
  AUTH_SESSION_FILE,
  AUTO_UID,
  CLIENT_EXE_ENV,
  CLIENT_PAGE_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_LOCATE_TTL_MS,
  DEFAULT_LOOMY_VERSION,
  DEFAULT_MODELS_TIMEOUT_MS,
  DEFAULT_MODELS_TTL_MS,
  DEFAULT_PUBLIC_DIR,
  DEFAULT_RUNNING_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_TRUNCATION_RETRIES,
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
import {
  aggregateSseToCompletion,
  extractFrameError,
  guardUpstreamStream,
  hasAssistantContent,
  stateFromFrameError,
  type GuardAction,
  type StreamStats,
  type StreamVerdict,
} from './api/sse.ts'
import type {
  AccountState,
  ChatOnceResult,
  ChatRequest,
  ModelInfo,
  SupplierEnv,
  SupplierStatusNow,
} from './contract.ts'
import type { LoomyClientSnapshot, LoomyModelInfo } from './types.ts'

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
  /** 客户端可执行文件显式路径（覆盖探测；默认读 LOOMY_CLIENT_EXE）。 */
  clientExe?: string
  /**
   * 客户端候选路径来源（默认 `clientCandidates()`：环境变量 → 用户目录 →
   * 公共目录 → 逐盘符布局）。
   *
   * 注入点主要是给测试用的：本机确实装了客户端时，真实候选列表会命中它，
   * 单测就没法构造「没装客户端」的场景。
   */
  clientCandidates?: () => string[]
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
  /** 客户端可执行文件定位 / 启动 / 运行探测（本机登录态的「源头」）。 */
  private readonly client: ClientApp
  /** 每个账号「最近一次观察到的状态」（只影响面板展示与后续请求的冷却依据）。 */
  private readonly health = new Map<string, Health>()

  /**
   * 「同一 (账号, 模型) 连续被上游截断」的计数。
   *
   * 截断时我们会扣住 `[DONE]` 逼核心按 TRANSPORT 重试，而重试会重发整段上下文
   * （实测动辄 10 万 prompt token，按积分计费）。所以连续截断到上限后就**不再逼
   * 重试**，改成补一个 `length` 收尾标记放行，让这一轮以「被长度截断」结束——
   * 至少界面能看出来，而不是无限烧积分。任一正常收尾都会把计数清零。
   */
  private readonly truncations = new Map<string, number>()
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
    this.client = new ClientApp({
      log: (msg) => this.log(msg),
      exeOverride: this.cfg.clientExe ?? process.env[CLIENT_EXE_ENV],
      candidates: this.cfg.clientCandidates,
      locateTtlMs: DEFAULT_LOCATE_TTL_MS,
      runningTtlMs: DEFAULT_RUNNING_TTL_MS,
    })
  }

  private log(msg: string): void {
    try {
      this.env.log(msg)
    } catch {
      // 日志失败绝不影响主流程
    }
  }

  /** 启动：预热模型目录与客户端状态（不阻塞加载；失败静默回退）。 */
  async start(): Promise<void> {
    // 客户端状态预热：定位与运行探测都带缓存，先跑一次让面板首次 status()
    // 就能显示「运行中/未运行」，而不是「状态未知」。
    if (this.client.locateExe() !== undefined) {
      void this.client.refreshRunning().catch(() => false)
    }
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
        // 本机登录态账号：把「客户端在不在跑」一并报出来 —— 这是用户最关心的
        // 「是否已加载」信号（登录态文件在、但客户端没开 = 会话可能已过期）。
        const running = this.client.runningNow()
        bits.push(running === true ? '客户端运行中' : running === false ? '客户端未运行' : '客户端状态未知')
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
    // 客户端运行态：走自己的 TTL 缓存（15s），status() 是同步的，这里只发起
    // 异步刷新、不等待 —— 面板轮询因此不会每次都去起 tasklist 进程。
    // 只有定位到可执行文件才值得探测（没装客户端时探了也没有意义）。
    if (this.client.locateExe() !== undefined) {
      void this.client.refreshRunning().catch(() => false)
    }
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
        accountUid === '' || accountUid === AUTO_UID
          ? `未找到 Loomy 登录态（期望 ${this.cfg.publicDir}\\<安装ID>\\userData\\${AUTH_SESSION_FILE}）—— 在面板点「添加链接」打开客户端登录，或访问客户端页手动填入会话串`
          : `unknown account ${JSON.stringify(accountUid)}`
      const state: AccountState = accountUid === '' || accountUid === AUTO_UID ? 'session_dead' : 'no_such_model'
      this.setHealth(accountUid, state, message)
      return { ok: false, state, message }
    }

    const bodyObj = this.prepareBody(req, modelId, lv)
    const body = JSON.stringify(bodyObj)
    const maxTokens = typeof bodyObj.max_tokens === 'number' ? bodyObj.max_tokens : undefined
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
      const key = `${resolved.uid}|${modelId}`
      const stream = guardUpstreamStream(response.body, {
        maxTokens,
        onLateFailure: (state, message) => {
          this.setHealth(resolved.uid, state, message)
          this.reportLateFailure(resolved.uid, modelId, state, message)
        },
        decide: (verdict: StreamVerdict): GuardAction => {
          if (verdict === 'ok') return 'pass'
          if (verdict === 'capped') return 'mark-length'
          // 截断：默认扣住 [DONE] 逼核心重试；连续截断到上限后改为标记放行
          return (this.truncations.get(key) ?? 0) >= MAX_TRUNCATION_RETRIES ? 'mark-length' : 'fail'
        },
        onVerdict: (verdict: StreamVerdict, stats: StreamStats): void => {
          if (verdict === 'ok') {
            this.truncations.delete(key)
            return
          }
          if (verdict === 'truncated') {
            const n = (this.truncations.get(key) ?? 0) + 1
            this.truncations.set(key, n)
            this.log(
              `loomy: 上游收尾异常（${verdict}，连续第 ${n} 次）${describeStreamStats(stats)}` +
                (n >= MAX_TRUNCATION_RETRIES ? ' —— 已达重试上限，本次不再触发重试' : ' —— 已扣住 [DONE]，交给核心重试'),
            )
            return
          }
          this.log(`loomy: 上游撞上 max_tokens 上限${describeStreamStats(stats)}`)
        },
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
   *
   * 返回**对象**而不是字符串：调用方要用 `max_tokens` 去区分「上游截断」与
   * 「撞上上限」（见 guardUpstreamStream）。
   */
  private prepareBody(req: ChatRequest, modelId: string, lv: string): Record<string, unknown> {
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
    return obj
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
    if (uid !== '' && uid !== AUTO_UID) return
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

  // ---------------------------------------------------------------------------
  // 差异化：打开客户端 / 自动获取登录态
  //
  // Loomy 的凭证不在网页里，而在**本机客户端**登录后落盘的 auth-session.json。
  // 所以本插件的「登录」= 启动客户端 + 等它写文件，而不是让用户去浏览器粘贴
  // 回调链接或会话串。这也解释了为什么 status() 把「客户端运行中」一起报出来。
  // ---------------------------------------------------------------------------

  /** 客户端 / 登录态快照（同步、廉价：只读缓存 + 少量 stat）。 */
  clientSnapshot(): LoomyClientSnapshot {
    const exe = this.client.locateExe()
    const file = this.registry.readSessionFile()
    const data = file?.data
    return {
      installed: exe !== undefined,
      exe,
      // 没定位到可执行文件 = 客户端不可能在运行，直接给 false 而不是「未知」；
      // 定位到但还没探测过才是 undefined（未知）。
      running: exe === undefined ? false : this.client.runningNow(),
      sessionLoaded: file !== undefined,
      sessionFile: file?.path,
      sessionMasked: file === undefined ? undefined : maskSession(file.data.session),
      nickname: file === undefined ? undefined : this.registry.localNickname(file.data),
      phone: typeof data?.phone === 'string' ? data.phone : undefined,
      userid: typeof data?.userid === 'string' ? data.userid : undefined,
      updatedAt: data?.updatedAt,
    }
  }

  /** 打开客户端（面板「打开客户端」）。 */
  async openClient(): Promise<LaunchResult> {
    const result = await this.client.launch()
    // 启动后立刻强制刷一次运行态，让下一次 status() 就显示「客户端运行中」
    if (result.ok) await this.client.refreshRunning(true).catch(() => false)
    return result
  }

  /**
   * 客户端状态页用：**强制**刷新运行态后返回快照。
   *
   * 与 clientSnapshot() 的区别是它会真起一次 tasklist —— 状态页是用户主动打开的
   * 低频页面，值得用一次进程查询换「点开就是实时状态」。
   */
  async refreshClientSnapshot(): Promise<LoomyClientSnapshot> {
    await this.client.refreshRunning(true).catch(() => false)
    return this.clientSnapshot()
  }

  /**
   * 生成登录链接。
   *
   * 本插件的「登录」就是打开本机客户端，所以这里**直接启动**（点一下
   * 「添加链接」= 客户端窗口弹出来），返回的链接指向客户端状态页，
   * 那里有完整的「是否已加载」信息与手填兜底。
   *
   * 启动失败也照样返回链接：状态页会说明失败原因并给出手动路径，
   * 不至于把用户堵死在「链接生成失败」上。
   */
  generateLoginUrl(): { ok: boolean; loginUrl: string } {
    void this.openClient().then(
      (r) => {
        if (!r.ok) this.log(`loomy: 打开客户端失败：${r.error ?? '未知原因'}`)
      },
      (err: unknown) => {
        this.log(`loomy: 打开客户端异常：${(err as Error).message}`)
      },
    )
    return { ok: true, loginUrl: CLIENT_PAGE_PATH }
  }

  /** 轮询式登录标记（核心只当能力位用，不调用）。 */
  pollLogin(): boolean {
    return true
  }

  /**
   * 完成登录。
   *
   * @param callbackUrl 核心传空串（轮询式）；非空时按「回调链接 / 裸会话串」
   *        解析并登记为面板 Key 账号（手填兜底路径）。
   */
  async completeLogin(callbackUrl: string): Promise<{ uid: string; nickname: string }> {
    const input = callbackUrl.trim()
    if (input !== '') {
      const session = extractSession(input)
      if (session === '') {
        throw new Error('未能从输入中解析出 Loomy 会话串（可直接粘贴 session 字段的值）')
      }
      const probe = await this.catalog.probe(session)
      if (!probe.ok && probe.status !== undefined && probe.status >= 400 && probe.status < 500) {
        throw new Error(`会话串校验失败（HTTP ${probe.status}）：${probe.message}`)
      }
      return this.registry.addKey({ name: '', apiKey: session })
    }

    // 轮询式：客户端已登录 → auth-session.json 就是凭证（force 绕过 5s 缓存）
    const file = this.registry.readSessionFile(true)
    if (file === undefined) {
      throw new Error(
        `未检测到登录态：请在 Loomy 客户端中完成登录后重试（期望文件 ${this.cfg.publicDir}\\<安装ID>\\userData\\${AUTH_SESSION_FILE}）`,
      )
    }
    // 新登录态不该被旧错误继续判死
    this.clearHealth(AUTO_UID)
    // 用新会话刷新模型目录（顺手验证它确实有效）
    await this.catalog.list(file.data.session, true).catch(() => undefined)
    return { uid: AUTO_UID, nickname: this.registry.localNickname(file.data) }
  }

  /**
   * 手动登记一个会话串（客户端状态页的兜底表单）。
   * 与 completeLogin(非空) 同一条路径，只是多一个可读的名字。
   */
  async adoptSession(input: { name?: string; session: string }): Promise<{ uid: string; nickname: string }> {
    const session = extractSession(input.session.trim())
    if (session === '') throw new Error('会话串不能为空')
    const probe = await this.catalog.probe(session)
    if (!probe.ok && probe.status !== undefined && probe.status >= 400 && probe.status < 500) {
      throw new Error(`会话串校验失败（HTTP ${probe.status}）：${probe.message}`)
    }
    const account = this.registry.addKey({ name: input.name ?? '', apiKey: session })
    await this.catalog.list(session, true).catch(() => undefined)
    return account
  }
}

/**
 * 从用户输入里取出会话串。
 *
 * 三种可能：裸会话串（`session` 字段的值）、带 query 的回调链接
 * （`?session=` / `?token=` / `?code=`）、以及带引号的 JSON 片段。
 * 取不到就返回空串，由调用方给出可读报错。
 */
export function extractSession(input: string): string {
  const raw = input.trim()
  if (raw === '') return ''
  // 1) 链接：优先从 query 里取
  const query = raw.match(/[?&](?:session|token|code)=([^&\s]+)/i)
  if (query?.[1] !== undefined && query[1] !== '') {
    return safeDecode(query[1])
  }
  // 2) JSON 片段：{"session":"..."}
  const json = raw.match(/"session"\s*:\s*"([^"]+)"/i)
  if (json?.[1] !== undefined && json[1] !== '') return json[1]
  // 3) 裸会话串：去掉包裹的引号 / 空白 / 常见前缀
  const bare = raw.replace(/^["'\s]+|["'\s]+$/g, '').replace(/^Bearer\s+/i, '')
  if (bare.includes('://') || bare.includes(' ')) return ''
  return bare
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
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

/** 把流末统计写成一行可读日志（排查「话没讲完」时用）。 */
function describeStreamStats(stats: StreamStats): string {
  const bits = [
    `finish_reason=${stats.sawFinishReason ? '有' : '无'}`,
    `正文=${stats.contentChars}字`,
    `推理=${stats.reasoningChars}字`,
    `工具调用=${stats.sawToolCall ? '有' : '无'}`,
  ]
  if (stats.completionTokens !== undefined) {
    bits.push(`completion=${stats.completionTokens}${stats.maxTokens !== undefined ? `/${stats.maxTokens}` : ''}`)
  }
  return `（${bits.join(' · ')}）`
}

/** 便于测试/外部构造：把 UpstreamHttpError 的语义说出来。 */
export function describeHttpError(err: unknown): string {
  if (err instanceof UpstreamHttpError) {
    return `HTTP ${err.status}: ${describeUpstreamBody(err.bodyText)}`
  }
  return err instanceof Error ? err.message : String(err)
}
