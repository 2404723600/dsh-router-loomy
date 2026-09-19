/**
 * 模型目录（模型清单解析与缓存）。
 *
 * 三级来源，按可信度顺序回退（任何一级成功即停）：
 *   1. 上游 `GET {baseUrl}/models` —— 权威、随平台更新；实测需 **同时** 带
 *      `Authorization: Bearer <session>` 与 `token: <session>`（只带 Bearer 会
 *      返回 `{"code":"100002","desc":"缺少 token"}`）。
 *   2. 本机 Loomy 客户端 `opencode.json` 的 `provider.imodel.models` —— 离线可用，
 *      与客户端实际下发的一致（含 context/output 限额、modalities、tool_call）。
 *   3. 内置兜底清单 `BUILTIN_MODELS`（常量，见 api/constants.ts）。
 *
 * 只有 `output_modalities` 含 `text` 的模型才进列表：Loomy 的 `doubao-seedream-5-lite`、
 * `qwen-image-3.0-pro` 输出的是**图片**，dsh-router 走的是 chat 通道，列出来只会让
 * 面板出现一个选了必失败的模型。
 */
import { buildTracingHeaders } from './api/headers.ts'
import { getJson } from './api/http.ts'
import { BUILTIN_MODELS, OPENCODE_CONFIG_FILE, USER_AGENT } from './api/constants.ts'
import type { LoomyModelInfo, ModelCatalog, UpstreamModel } from './types.ts'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface CatalogOptions {
  baseUrl: string
  loomyVersion: string
  /** Loomy 客户端公共数据根目录（含 <安装ID>/opencode/opencode.json）。 */
  publicDir: string
  /** /models 拉取超时。 */
  modelsTimeoutMs: number
  /** 内存缓存 TTL。 */
  modelsTtlMs: number
  log: (msg: string) => void
}

/** `/models` 探测结果。 */
export type SessionProbe =
  | { ok: true; count: number }
  | { ok: false; status?: number; message: string }

/** 判定 chat 模型所需的最小结构面（上游条目与本地条目都满足）。 */
interface ChatLike {
  type?: string
  capabilities?: { output_modalities?: string[] }
}

/** 是否可作为 chat 模型（输出里必须含 text）。 */
function isChatModel(model: ChatLike): boolean {
  if (model.type !== undefined && model.type !== '' && model.type !== 'chat' && model.type !== 'text') return false
  const outputs = model.capabilities?.output_modalities
  if (Array.isArray(outputs) && outputs.length > 0 && !outputs.includes('text')) return false
  return true
}

/** token 数 → K（core 的 context_length 单位是 K，见 core router/types.ts 与 traework 实现）。 */
function toK(tokens: number | undefined): number | undefined {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return undefined
  return Math.round(tokens / 1000)
}

/** 上游 /models 条目 → 插件模型元信息。 */
function fromUpstreamModel(m: UpstreamModel): LoomyModelInfo | undefined {
  const id = typeof m.id === 'string' ? m.id.trim() : ''
  if (id === '') return undefined
  const info: LoomyModelInfo = { id }
  if (typeof m.name === 'string' && m.name !== '') info.name = m.name
  const ctx = toK(m.context_length)
  if (ctx !== undefined) info.context_length = ctx
  if (typeof m.max_output_tokens === 'number') info.max_output_tokens = m.max_output_tokens
  if (Array.isArray(m.reasoning_efforts)) info.reasoning_efforts = m.reasoning_efforts
  if (typeof m.default_reasoning_effort === 'string') info.default_reasoning_effort = m.default_reasoning_effort
  if (typeof m.type === 'string') info.type = m.type
  if (m.capabilities?.vision === true) info.vision = true
  if (m.capabilities?.function_calling === true) info.function_calling = true
  return info
}

/** opencode.json 的 models 条目 → 插件模型元信息。 */
function fromOpencodeModel(id: string, raw: unknown): LoomyModelInfo | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const cfg = raw as Record<string, unknown>
  const info: LoomyModelInfo = { id }
  if (typeof cfg.name === 'string' && cfg.name !== '') info.name = cfg.name
  const limit = cfg.limit as Record<string, unknown> | undefined
  const ctx = toK(typeof limit?.context === 'number' ? limit.context : undefined)
  if (ctx !== undefined) info.context_length = ctx
  if (typeof limit?.output === 'number') info.max_output_tokens = limit.output
  const modalities = cfg.modalities as Record<string, unknown> | undefined
  const inputs = Array.isArray(modalities?.input) ? (modalities!.input as string[]) : []
  const outputs = Array.isArray(modalities?.output) ? (modalities!.output as string[]) : []
  if (inputs.includes('image')) info.vision = true
  if (outputs.length > 0 && !outputs.includes('text')) info.type = 'image'
  if (cfg.tool_call === true) info.function_calling = true
  return info
}

export class ModelCatalogService {
  private readonly opts: CatalogOptions
  private cache: ModelCatalog | undefined
  private inflight: Promise<ModelCatalog> | undefined
  /** 本机 opencode.json 的路径（首次解析成功后缓存，避免每次遍历目录）。 */
  private opencodePath: string | undefined

  constructor(opts: CatalogOptions) {
    this.opts = opts
  }

  /** 当前缓存快照（可能为 undefined）。 */
  snapshot(): ModelCatalog | undefined {
    return this.cache
  }

  /** 已知模型 id 集合（上游/本机/内置并集 + 面板自定义由调用方补充）。 */
  knownIds(custom: string[] = []): Set<string> {
    const set = new Set(custom)
    for (const m of this.cache?.models ?? BUILTIN_MODELS) set.add(m.id)
    return set
  }

  /**
   * 取模型清单：TTL 内直接返回缓存；force 或过期则重新解析。
   * 上游失败时回退本机/内置（不抛错，只在 note 里记原因，保证面板不空）。
   */
  async list(session: string | undefined, force = false): Promise<ModelCatalog> {
    const now = Date.now()
    if (!force && this.cache !== undefined && now - this.cache.fetchedAt <= this.opts.modelsTtlMs) {
      return this.cache
    }
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.resolve(session).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async resolve(session: string | undefined): Promise<ModelCatalog> {
    const failures: string[] = []
    if (session !== undefined && session !== '') {
      try {
        const models = await this.fetchUpstreamModels(session)
        if (models.length > 0) {
          this.cache = { models, source: 'upstream', fetchedAt: Date.now() }
          this.opts.log(`loomy: /models 拉取成功，${models.length} 个可路由模型`)
          return this.cache
        }
        failures.push('/models 返回空列表')
      } catch (err) {
        failures.push(`/models: ${(err as Error).message}`)
      }
    } else {
      failures.push('无可用会话串，跳过 /models')
    }

    const local = this.fromOpencode()
    if (local !== undefined) {
      this.cache = { ...local, fetchedAt: Date.now(), note: failures.join('；') }
      this.opts.log(`loomy: 回退本机 opencode.json，${local.models.length} 个可路由模型（${failures.join('；')}）`)
      return this.cache
    }

    const builtin = BUILTIN_MODELS.filter(isChatModel)
    this.cache = {
      models: builtin,
      source: 'builtin',
      fetchedAt: Date.now(),
      note: [...failures, '未找到本机 opencode.json'].join('；'),
    }
    this.opts.log(`loomy: 回退内置清单，${builtin.length} 个可路由模型`)
    return this.cache
  }

  /** 用给定会话串做一次轻量探测（GET /models），用于校验 Key 是否可用。 */
  async probe(session: string): Promise<SessionProbe> {
    try {
      const models = await this.fetchUpstreamModels(session)
      return { ok: true, count: models.length }
    } catch (err) {
      const e = err as { status?: number; message?: string }
      return { ok: false, status: e.status, message: e.message ?? String(err) }
    }
  }

  /** 拉取上游 /models（失败抛 UpstreamHttpError / 传输错误）。 */
  async fetchUpstreamModels(session: string): Promise<LoomyModelInfo[]> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/models`
    const payload = await getJson<Record<string, unknown>>({
      url,
      headers: {
        // 实测：两个头都必带（只带 Bearer → {"code":"100002","desc":"缺少 token"}）
        authorization: `Bearer ${session}`,
        token: session,
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...buildTracingHeaders({
          version: this.opts.loomyVersion,
          invokeOrigin: 'user',
          sessionAffinity: false,
        }),
      },
      headerTimeoutMs: this.opts.modelsTimeoutMs,
    })
    const raw = Array.isArray(payload.data)
      ? (payload.data as UpstreamModel[])
      : Array.isArray(payload.models)
        ? (payload.models as UpstreamModel[])
        : []
    const out: LoomyModelInfo[] = []
    for (const m of raw) {
      const info = fromUpstreamModel(m)
      if (info !== undefined && isChatModel(info)) out.push(info)
    }
    return out
  }

  /** 从本机 Loomy 客户端配置读取模型清单（找不到返回 undefined）。 */
  fromOpencode(): ModelCatalog | undefined {
    const path = this.locateOpencode()
    if (path === undefined) return undefined
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
      const providers = parsed.provider as Record<string, unknown> | undefined
      const imodel = providers?.imodel as Record<string, unknown> | undefined
      const models = imodel?.models as Record<string, unknown> | undefined
      if (models === undefined) return undefined
      const out: LoomyModelInfo[] = []
      for (const [id, raw] of Object.entries(models)) {
        const info = fromOpencodeModel(id, raw)
        if (info !== undefined && isChatModel(info)) out.push(info)
      }
      if (out.length === 0) return undefined
      return { models: out, source: 'opencode', fetchedAt: 0 }
    } catch (err) {
      this.opts.log(`loomy: 解析 opencode.json 失败：${(err as Error).message}`)
      return undefined
    }
  }

  /** 定位 opencode.json：`<publicDir>/<安装ID>/opencode/opencode.json`（取最新修改的一个）。 */
  private locateOpencode(): string | undefined {
    if (this.opencodePath !== undefined) {
      try {
        statSync(this.opencodePath)
        return this.opencodePath
      } catch {
        this.opencodePath = undefined
      }
    }
    let entries: string[]
    try {
      entries = readdirSync(this.opts.publicDir)
    } catch {
      return undefined
    }
    let best: string | undefined
    let bestTime = -1
    for (const entry of entries) {
      const candidate = join(this.opts.publicDir, entry, 'opencode', OPENCODE_CONFIG_FILE)
      try {
        const st = statSync(candidate)
        if (!st.isFile()) continue
        const time = st.mtimeMs
        if (time > bestTime) {
          bestTime = time
          best = candidate
        }
      } catch {
        // 该安装目录没有 opencode.json，继续
      }
    }
    this.opencodePath = best
    return best
  }
}
