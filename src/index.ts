/**
 * dsh-router-loomy —— DSH 插件 host half。
 *
 * 1) 通过 cordis service `router.suppliers` 把 loomy 供应商工厂暴露给 dsh-router。
 *    service 值：`{ [supplierId]: (env) => SupplierModule }`。
 *
 *    聚合表由 dsh-router-core 统一 provide（空表），本插件只往里追加自己的工厂，
 *    不重复 provide（cordis 同一 service 只允许一个插件注册）。表可用后把 loomy
 *    挂进去并广播 `internal/service`，让 dsh-router 按 live 表增量重扫。
 *
 * 2) 往 dsh 的 webServer 注册「Loomy 客户端」状态页
 *    （`/router/api/loomy/client`，见 client-page.ts）。core 的供应商卡片不给插件
 *    留按钮位，这个页面就是「打开客户端 / 看登录态是否已加载」的落点。
 */
import { CLIENT_PAGE_PATH } from './api/constants.ts'
import factory, { currentSupplier } from './api/plugin.ts'
import { handleClientPage } from './client-page.ts'
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
  /** webServer 服务（core 用 `inject = ['webServer', 'llm']` 拿它挂路由）。 */
  webServer?: WebServerLike
  /** 广播内部服务变更，让 dsh-router 重扫 live 表。 */
  emit(event: string, ...args: unknown[]): void
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
}

/** webServer 服务的最小结构面（与 core `src/index.ts` 的 WebServer 一致）。 */
export interface WebServerLike {
  register: (route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }) => () => void
}

function log(ctx: ContextLike, msg: string): void {
  try {
    ctx.logger?.info?.(msg)
  } catch {
    // 日志失败绝不影响主流程
  }
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
      log(ctx, '[dsh-router-loomy] registered router.suppliers: loomy')
    }
    return () => {
      delete suppliers.loomy
    }
  })

  // 客户端状态页：拿不到 webServer 就静默跳过（只影响这个页面，不影响供应商本身；
  // generateLoginUrl 返回的链接此时会 404，但「打开客户端」已经直接执行过了）。
  ctx.inject(['webServer'], (sctx) => {
    // 注入回调里**绝不能让异常逃出去**：cordis 的加载期异常会升级成
    // fatal load failure 打挂整个 dsh（本工程在 http.ts 上已经踩过一次）。
    try {
      const c = sctx as ContextLike
      const server = (c.get?.('webServer') ?? c.webServer) as WebServerLike | undefined
      if (server === undefined || typeof server.register !== 'function') {
        log(ctx, '[dsh-router-loomy] 未取得 webServer 服务，跳过客户端状态页注册')
        return undefined
      }
      const off = server.register({
        kind: 'exact',
        path: CLIENT_PAGE_PATH,
        handler: (req, res) => handleClientPage(req, res, { supplier: currentSupplier, log: (msg) => log(ctx, msg) }),
      })
      log(ctx, `[dsh-router-loomy] 已注册客户端状态页 ${CLIENT_PAGE_PATH}`)
      return () => {
        off()
      }
    } catch (err) {
      log(ctx, `[dsh-router-loomy] 注册客户端状态页失败（不影响供应商本身）：${(err as Error).message}`)
      return undefined
    }
  })
}
