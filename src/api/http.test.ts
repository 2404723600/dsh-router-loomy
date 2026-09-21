/**
 * HTTP 传输层单测 —— 重点是 assertOk 的错误路径。
 *
 * 回归背景（dsh 启动期 fatal load failure）：
 *   `response.body?.cancel()` 返回的是 Promise。当非 2xx 响应体的 text() 读取失败时，
 *   body 仍被内部 reader 锁住，此时 cancel() 给出的是「已拒绝的 Promise」而不是同步抛出。
 *   只包一层 try/catch 而不 await，这个拒绝就无人接管 → 升级为 unhandledRejection
 *   → 直接打挂宿主进程：
 *     TypeError [ERR_INVALID_STATE]: Invalid state: ReadableStream is locked
 *   运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertResponseOk } from './http.ts'
import { UpstreamHttpError } from './errors.ts'

/** 造一个「非 2xx 且 body 读取会失败」的 Response（复现上游连接中断的形态）。 */
function failingBodyResponse(status: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('stream boom'))
    },
  })
  return new Response(stream, { status })
}

test('assertResponseOk 非 2xx 且 body 读取失败时不泄漏 unhandledRejection', async () => {
  const leaked: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    leaked.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const response = failingBodyResponse(500)
    await assert.rejects(() => assertResponseOk(response), UpstreamHttpError)
    // 排空队列，让潜在的未处理拒绝有机会浮出来
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(leaked.length, 0, `不应有未处理的 rejection，实际：${String(leaked[0])}`)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('assertResponseOk 非 2xx 时抛出带状态码与报文原文的 UpstreamHttpError', async () => {
  const response = new Response('{"code":"100002","desc":"缺少 token"}', {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
  let caught: unknown = null
  try {
    await assertResponseOk(response)
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof UpstreamHttpError)
  assert.equal(caught.status, 401)
  assert.match(caught.bodyText, /缺少 token/)
})

test('assertResponseOk 2xx 时直接返回', async () => {
  await assertResponseOk(new Response('{}', { status: 200 }))
})
