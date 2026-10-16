/**
 * 宿主半接线单测 —— 验证 `apply(ctx)` 的两个注入点。
 *
 * 为什么需要这层测试：`ctx.inject(['webServer'], …)` 这段代码在真实 dsh 里才跑得到，
 * 而本机 profile 装的是 npm 上的已发布版本（不是本工作目录），所以「构建一下就能验」
 * 在这里并不成立。用一个**假的 cordis ctx** 把接线钉住：
 *   - 供应商工厂确实被追加进 router.suppliers 并广播 internal/service；
 *   - 客户端状态页确实以 `kind: 'exact'` 注册到 webServer，路径正确、处理器可用；
 *   - webServer 缺失 / register 抛错时**不能把异常逃出去**（加载期异常会升级成
 *     dsh 的 fatal load failure，本工程在 http.ts 上踩过一次）。
 *
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, type ContextLike } from './index.ts'
import { CLIENT_PAGE_PATH } from './api/constants.ts'

interface RouteLike {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

interface Harness {
  ctx: ContextLike
  events: Array<{ event: string; args: unknown[] }>
  logLines: string[]
  routes: RouteLike[]
  cleanups: Array<() => void>
}

function harness(services: Record<string, unknown>): Harness {
  const events: Harness['events'] = []
  const logLines: string[] = []
  const routes: RouteLike[] = []
  const cleanups: Harness['cleanups'] = []
  const ctx: ContextLike = {
    inject(names, callback) {
      // 模拟 cordis 的延迟注入：所列服务都就绪才回调
      if (!names.every((name) => name in services)) return
      const sub = { get: (key: string) => services[key], ...services } as unknown as ContextLike
      const cleanup = callback(sub)
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    get: (key: string) => services[key],
    emit: (event: string, ...args: unknown[]) => {
      events.push({ event, args })
    },
    logger: { info: (msg: string) => logLines.push(msg) },
    ...(services as Partial<ContextLike>),
  }
  void routes
  return { ctx, events, logLines, routes, cleanups }
}

/** 造一个最小 req/res（状态页只用到 url/method/setHeader/end）。 */
function fakeReqRes(): { req: unknown; res: { statusCode: number; headers: Record<string, string>; body: string } } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value
    },
    end(chunk?: string) {
      res.body = chunk ?? ''
    },
  }
  return { req: { url: CLIENT_PAGE_PATH, method: 'GET' }, res }
}

test('apply：把 loomy 工厂追加进 router.suppliers 并广播 internal/service', () => {
  const suppliers: Record<string, unknown> = {}
  const h = harness({ 'router.suppliers': suppliers })
  apply(h.ctx)
  assert.equal(typeof suppliers.loomy, 'function', '应把 factory 挂进聚合表')
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0]?.event, 'internal/service')
  assert.equal(h.events[0]?.args[0], 'router.suppliers')
})

test('apply：表里已有 loomy 时不覆盖、不重复广播', () => {
  const existing = () => {
    throw new Error('不应被覆盖')
  }
  const suppliers: Record<string, unknown> = { loomy: existing }
  const h = harness({ 'router.suppliers': suppliers })
  apply(h.ctx)
  assert.equal(suppliers.loomy, existing)
  assert.equal(h.events.length, 0)
})

test('apply：注册客户端状态页路由（exact + 正确路径）', () => {
  const routes: RouteLike[] = []
  let unregistered = false
  const h = harness({
    'router.suppliers': {},
    webServer: {
      register: (route: RouteLike) => {
        routes.push(route)
        return () => {
          unregistered = true
        }
      },
    },
  })
  apply(h.ctx)
  assert.equal(routes.length, 1)
  assert.equal(routes[0]?.kind, 'exact')
  assert.equal(routes[0]?.path, CLIENT_PAGE_PATH)
  assert.ok(h.logLines.some((l) => l.includes('已注册客户端状态页')))
  // 卸载钩子应调用 register 返回的注销函数
  for (const cleanup of h.cleanups) cleanup()
  assert.equal(unregistered, true)
})

test('apply：路由处理器可用，且未构造供应商时给出可读提示而不是抛错', async () => {
  const routes: RouteLike[] = []
  const h = harness({
    'router.suppliers': {},
    webServer: { register: (route: RouteLike) => void routes.push(route) },
  })
  apply(h.ctx)
  const { req, res } = fakeReqRes()
  await routes[0]?.handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  assert.ok(res.body.includes('<!DOCTYPE html>'))
  assert.ok(res.body.includes('供应商尚未加载'), '测试环境没有供应商实例，应走这条分支')
})

test('apply：profile 里没有 webServer 时什么都不做，且不抛异常', () => {
  // cordis 的 inject 只在服务就绪时才回调，所以这条路径下回调根本不会跑
  const h = harness({ 'router.suppliers': {} })
  assert.doesNotThrow(() => {
    apply(h.ctx)
  })
  assert.ok(
    !h.logLines.some((l) => l.includes('客户端状态页')),
    `不应有任何客户端状态页相关日志，实际：${h.logLines.join(' | ')}`,
  )
})

test('apply：webServer 存在但结构不对时跳过注册并记日志', () => {
  const h = harness({ 'router.suppliers': {}, webServer: {} })
  assert.doesNotThrow(() => {
    apply(h.ctx)
  })
  assert.ok(h.logLines.some((l) => l.includes('跳过客户端状态页注册')), `实际日志：${h.logLines.join(' | ')}`)
})

test('apply：webServer.register 抛错时被吞掉（加载期异常会打挂 dsh）', () => {
  const h = harness({
    'router.suppliers': {},
    webServer: {
      register: () => {
        throw new Error('register boom')
      },
    },
  })
  assert.doesNotThrow(() => {
    apply(h.ctx)
  })
  assert.ok(h.logLines.some((l) => l.includes('注册客户端状态页失败')))
})
