/**
 * 供应商契约 —— dsh-router core `src/suppliers/contract.ts` + `src/router/types.ts`
 * 的**结构镜像**（字段与方法签名对齐，不含运行时代码）。
 *
 * 为什么镜像而不是 import core 的类型：
 *   - core 源码内的相对路径（'../../suppliers/contract.ts'）在插件被安装到
 *     node_modules 之后并不存在，直接 import 会解析失败；
 *   - dsh-router 核心按**结构**消费插件（loader.wrapModule 只做方法名/返回值判定 +
 *     AccountPool 装饰），运行时不依赖任何类型身份；
 *   - 镜像让本工程零外部依赖即可 tsc/构建，也便于对照升级。
 *
 * 契约同步点（core 有改动时同理补齐）：
 *   - SupplierEnv：dataDir / log / store / credentials / onLateFailure?
 *   - SupplierModule：id / name / priority? / icon? / apiKeyHint? / status / listModels
 *     / chatOnce / dispose / removeLink? / addApiKey?
 *   - AccountState 全集与 chatOnce 三种返回形态
 */

/** 账号语义状态（core AccountState 全集）。 */
export type AccountState =
  | 'ok'
  | 'rate_limit'
  | 'quota'
  | 'session_dead'
  | 'unavailable'
  | 'unknown'
  | 'transport'
  | 'no_such_model'
  | 'bad_request'
  | 'disabled'

/** status() 上报的单个账号「当前」状态（冷却/禁用/错误累计由核心叠加）。 */
export interface SupplierAccountNow {
  uid: string
  nickname: string
  /** 剩余积分/额度；拿不到真值报 -1（CREDITS_UNKNOWN），**不可**用 0 冒充未知。 */
  credits: number
  state: AccountState
  /** 可选的补充说明（面板展示）。 */
  message?: string
}

/** status() 返回值。 */
export interface SupplierStatusNow {
  id: string
  name: string
  accounts: SupplierAccountNow[]
}

/** 路由器给插件的请求（model 已是剥掉 alias 后的裸模型 id）。 */
export interface ChatRequest {
  /** 原始请求体（OpenAI 风格 JSON 字符串），插件可解析后改写再透传。 */
  rawBody: string
  /** 是否流式。 */
  stream: boolean
  /** 已剥 alias 的裸模型 id。 */
  model: string
  /** 推理档位（'auto' / 'low' / ... 语义由供应商自定义）。 */
  lv?: string
}

/** 模型元信息。注意：context_length 单位是 **K**（core 约定，插件统一换算）。 */
export interface ModelInfo {
  id: string
  context_length?: number
}

/** chatOnce 结果：成功流式 / 成功非流式 / 失败三态。 */
export type ChatOnceResult =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: true; status: number; body: string }
  | { ok: false; state: AccountState; message: string }

/**
 * 通用供应商配置存储（core SupplierConfigStore 的最小结构面）。
 *
 * 通用能力（别名 / 模型启用状态 / 自定义模型 / 连接池顺序与策略 / 积分缓存）
 * 均由核心持有，插件只**读**自己关心的字段——本插件不写配置（无连接池策略
 * 需求），故写方法一律不声明。
 */
export interface SupplierConfigLike {
  /** 展示前缀；空串 = 用供应商 id（核心 getAlias 的默认值）。 */
  alias: string
  /** 被禁用的模型 id（面板可切换）。 */
  disabled: string[]
  /** 面板手动添加的自定义模型 id。 */
  custom: string[]
  poolOrder: string[]
  poolStrategy: 'fallback' | 'round-robin'
  /** 积分缓存：uid → 剩余额度（-1 = 还没拿到过）。Loomy 无积分接口，用不上。 */
  credits: Record<string, number>
}

export interface SupplierConfigStoreLike {
  get(supplierId: string): SupplierConfigLike
  /** 读积分缓存；没缓存过返回 -1（core 提供，插件报 -1 时会回落到它）。 */
  getCredits?(supplierId: string, uid: string): number
}

/** 通用凭证存储（core CredentialStore，SQLite；插件只当不透明 blob 用）。 */
export interface CredentialStoreLike {
  list(supplierId: string): string[]
  get<T = unknown>(supplierId: string, uid: string): T | undefined
  save(supplierId: string, uid: string, data: unknown): void
  remove(supplierId: string, uid: string): boolean | void
}

/**
 * 插件运行环境（core loader / 外部 service 注入）。
 *
 * ⚠️ `onLateFailure` 是核心在 **factory 返回之后** 才挂上来的：插件必须**在调用时**
 * 读它（不要在构造时把它存进局部变量），否则永远是 undefined ——
 * 流式响应已提交后才发现的上游错误就上报不回账号池。
 */
export interface SupplierEnv {
  dataDir: string
  log: (msg: string) => void
  store: SupplierConfigStoreLike
  credentials: CredentialStoreLike
  onLateFailure?: (uid: string, model: string, state: AccountState, message: string) => void
}

/**
 * 供应商模块（插件对外暴露的契约面）。
 *
 * `getAlias` **不在此列**：它是核心的通用能力，由 loader 在 wrapModule 里统一
 * 提供（`getAlias: () => env.store.get(instance.id).alias || instance.id`，
 * 见 core `src/suppliers/loader.ts`）。插件再实现一遍是死代码，且会与用户可在
 * 面板修改的前缀打架——别名归核心与用户，不归插件。
 */
export interface SupplierModule {
  readonly id: string
  readonly name: string
  readonly priority?: number
  readonly icon?: string
  readonly apiKeyHint?: string
  /** 报账号「现在状态」；冷却/禁用/错误累计由核心叠加（本方法必须同步、廉价）。 */
  status(): SupplierStatusNow
  listModels(force?: boolean): Promise<ModelInfo[]> | ModelInfo[]
  /**
   * 对**单个账号**调一次上游（选号/回退/健康判定都是核心的活）。
   * @param uid 账号 uid（无账号供应商传空串）
   * @param lv  推理档位提示（'auto' 为默认）
   */
  chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult>
  dispose(): void
  /** 差异化：删除一个面板添加的 Key 账号（凭证清理归插件）。 */
  removeLink?(uid: string): Promise<boolean>
  /** 差异化：面板添加 API key 账号（弹窗填名字 + Key）。 */
  addApiKey?(input: { name: string; apiKey: string }): Promise<{ ok: boolean; error?: string; account?: { uid: string; nickname: string } }>
}

/** 供应商工厂（模块 default 导出）。 */
export type SupplierFactory = (env: SupplierEnv) => SupplierModule
