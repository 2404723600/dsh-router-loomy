/**
 * dsh-router-loomy —— DSH 插件 host half。
 *
 * 通过 cordis service `router.suppliers` 把 loomy 供应商工厂暴露给 dsh-router。
 * service 值：`{ [supplierId]: (env) => SupplierModule }`。
 *
 * 聚合表由 dsh-router-core 统一 provide（空表），本插件只往里追加自己的工厂，不重复
 * provide（cordis 同一 service 只允许一个插件注册）。表可用后把 loomy 挂进去并广播
 * `internal/service`，让 dsh-router 按 live 表增量重扫。
 */
import factory from './api/plugin.ts'
import type { SupplierEnv, SupplierModule } from './contract.ts'

export const name = 'dsh-router-loomy'

/** 暴露给 dsh-router 的供应商工厂表。 */
export interface RouterSuppliersService {
  [supplierId: string]: (env: SupplierEnv) => SupplierModule
}

/**
 * cordis Context 的**结构镜像**（只声明本插件用到的那几个成员）。
 *
 * 为什么不 import '@deepseek-ai/cordis'：它是 dsh 宿主注入的 peer 依赖，
 * 本工程安装时不落地（离线可 typecheck / 构建），直接 import 会解析失败；
 * 且运行时 cordis 按结构调用插件，不依赖任何类型身份——与 contract.ts 同思路。
 */
export interface ContextLike {
  /** 延迟注入：所列服务就绪后才回调（回调返回值作为清理函数）。 */
  inject(services: string[], callback: (ctx: ContextLike) => void | (() => void)): void
  /** 服务查找（cordis v4 的 Context#get）。 */
  get?: (key: string) => unknown
  /** 旧式服务挂载点兜底（部分版本把服务挂在 ctx.<name>）。 */
  router?: { suppliers?: RouterSuppliersService }
  /** 广播内部服务变更，让 dsh-router 重扫 live 表。 */
  emit(event: string, ...args: unknown[]): void
  logger?: { info?: (msg: string) => void }
}

export function apply(ctx: ContextLike): void {
  // 等核心把聚合表 provide 出来后再追加（顺序无关：inject 延迟到服务可用才触发）。
  ctx.inject(['router.suppliers'], (sctx) => {
    const c = sctx as ContextLike & { router?: { suppliers?: RouterSuppliersService } }
    const suppliers = (c.get?.('router.suppliers') ?? c.router?.suppliers) as RouterSuppliersService | undefined
    if (!suppliers) return undefined
    if (!suppliers.loomy) {
      suppliers.loomy = factory
      ctx.emit('internal/service', 'router.suppliers', suppliers)
      ctx.logger?.info?.('[dsh-router-loomy] registered router.suppliers: loomy')
    }
    return () => {
      delete suppliers.loomy
    }
  })
}
