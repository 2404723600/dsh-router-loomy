/**
 * loomy 供应商插件入口 —— 把 Loomy 云端通道包装成符合契约的 SupplierModule。
 *
 * 作为 dsh-router 的外部供应商：通过 `router.suppliers` service 把 factory 暴露给
 * dsh-router 加载。选号/冷却/换号/别名/模型启用状态/积分缓存等通用能力全部由
 * dsh-router 核心统一管（env 注入），这里只暴露差异化方法：
 *   status / listModels / chatOnce / dispose / addApiKey / removeLink
 */
import { LoomySupplier, type LoomyConfig } from '../provider.ts'
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
export const priority = 0
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

/** 面板「添加 API key」弹窗里的输入提示。 */
export const apiKeyHint = '粘贴 Loomy 登录态会话串（userData/auth-session.json 的 session 字段）'

let instance: LoomySupplier | undefined

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
  const current = instance
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
    addApiKey: (input: { name: string; apiKey: string }) => current.addApiKey(input),
    removeLink: (uid: string): Promise<boolean> => current.removeLink(uid),
  }
}

/** 便于上层（测试 / 其它插件）覆盖默认配置后构造实例。 */
export function createSupplier(env: SupplierEnv, overrides: Partial<LoomyConfig> = {}): LoomySupplier {
  return new LoomySupplier(env, overrides)
}
