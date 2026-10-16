/**
 * loomy 供应商插件入口 —— 把 Loomy 云端通道包装成符合契约的 SupplierModule。
 *
 * 作为 dsh-router 的外部供应商：通过 `router.suppliers` service 把 factory 暴露给
 * dsh-router 加载。选号/冷却/换号/别名/模型启用状态/积分缓存等通用能力全部由
 * dsh-router 核心统一管（env 注入），这里只暴露差异化方法：
 *   status / listModels / chatOnce / dispose
 *   generateLoginUrl / pollLogin / completeLogin（打开本机客户端登录，自动取会话）
 *   removeLink
 */
import { LoomySupplier, type LoomyConfig } from '../provider.ts'
import { PRIORITY } from './constants.ts'
import type {
  ChatOnceResult,
  ChatRequest,
  ModelInfo,
  SupplierEnv,
  SupplierModule,
  SupplierStatusNow,
} from '../contract.ts'

export const id = 'loomy'
export const name = 'Loomy'
/**
 * 路由优先级：**与 constants.PRIORITY 同源**。
 *
 * 这里曾经硬编码 0，而 constants.ts 写的是 10（免费直连 0 之后、nvidia 20 之前）——
 * 结果 Loomy 与 opencode 抢同一个排序位。core `router/index.ts` 有
 * `suppliers.sort((a, b) => a.priority - b.priority)`，值必须只有一处来源。
 */
export const priority = PRIORITY
/**
 * 面板图标：内联 SVG（Loomy 品牌色胶囊 + 对话气泡），
 * 用 data URI 是为了不依赖外网资源、也不往包里塞二进制。
 */
export const icon =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" fill="none">' +
      '<rect width="28" height="28" rx="8" fill="#3D5AFE"/>' +
      '<path d="M8 10.5A3.5 3.5 0 0 1 11.5 7h5A3.5 3.5 0 0 1 20 10.5v3.4a3.5 3.5 0 0 1-3.5 3.5h-1.2l-3.1 2.9a.6.6 0 0 1-1-.44V17.4A3.5 3.5 0 0 1 8 13.9z" fill="#fff"/>' +
      '<circle cx="12" cy="12.2" r="1.1" fill="#3D5AFE"/>' +
      '<circle cx="15" cy="12.2" r="1.1" fill="#3D5AFE"/>' +
      '<circle cx="18" cy="12.2" r="1.1" fill="#3D5AFE"/>' +
      '</svg>',
  )

/**
 * 面板「添加 API key」弹窗提示。
 *
 * 注意：本插件**不再暴露 addApiKey 能力**（见 moduleFor 的说明），核心因此不会
 * 渲染这个弹窗；文案保留是为了外部/测试构造场景，同时把「一般不用手填」说清楚。
 */
export const apiKeyHint = '粘贴 Loomy 登录态会话串（本机客户端已登录时会自动识别，一般无需手填）'

let instance: LoomySupplier | undefined

/** 当前供应商实例（宿主半的状态页路由读取用；核心尚未构造时 undefined）。 */
export function currentSupplier(): LoomySupplier | undefined {
  return instance
}

/**
 * 由实例构造对外契约面 —— **「暴露哪些能力」的唯一真相**。
 *
 * 抽成纯函数是为了让测试能直接断言能力面（factory 带模块级单例，测试里调用
 * 会连带触发真实网络预热）。
 *
 * 为什么**刻意不暴露 addApiKey**：核心前端 `SupplierDetail.tsx` 里
 * `canApiKey = hasCap('addApiKey')`，而 `startLogin()` 一旦发现 canApiKey 就
 * 直接弹「填名字 + API key」表单并 return，`generateLoginUrl` 分支永远不会执行。
 * 也就是说 —— 只要暴露 addApiKey，「打开客户端登录」这条路在 UI 上就是死的。
 * 手填会话串的兜底改由插件自己的客户端状态页提供（client-page.ts）。
 */
export function moduleFor(current: LoomySupplier): SupplierModule {
  return {
    id,
    name,
    priority,
    icon,
    apiKeyHint,
    status: (): SupplierStatusNow => current.status(),
    listModels: (force?: boolean): ModelInfo[] | Promise<ModelInfo[]> => current.listModels(force),
    chatOnce: (uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult> => current.chatOnce(uid, lv, req),
    dispose: (): void => current.dispose(),
    // ---- 登录三件套：点「添加链接」= 打开本机客户端 ----
    generateLoginUrl: () => current.generateLoginUrl(),
    pollLogin: (): boolean => current.pollLogin(),
    completeLogin: (callbackUrl: string) => current.completeLogin(callbackUrl),
    removeLink: (uid: string): Promise<boolean> => current.removeLink(uid),
  }
}

/** factory：dsh-router 调用它构造实例（env 注入 store/credentials）。 */
export default function factory(env: SupplierEnv): SupplierModule {
  if (instance === undefined) {
    // env 整个传进去：插件在**调用时**才读 env.onLateFailure（核心是先跑 factory
    // 再挂这个回调的，构造时读必是 undefined）。
    instance = new LoomySupplier(env)
    // 加载即预热：拉一次模型目录（失败静默回退本机/内置，不阻断加载）
    void instance.start().catch((err: unknown) => {
      env.log(`loomy start: ${(err as Error).message}`)
    })
  }
  return moduleFor(instance)
}

/** 便于上层（测试 / 其它插件）覆盖默认配置后构造实例。 */
export function createSupplier(env: SupplierEnv, overrides: Partial<LoomyConfig> = {}): LoomySupplier {
  return new LoomySupplier(env, overrides)
}
