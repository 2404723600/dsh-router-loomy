/**
 * 上游 HTTP 传输层：JSON 调用 + SSE 流式调用（headers 超时独立于流式体）。
 *
 * 超时语义（对齐客户端 opencode.json 的 options.timeout / chunkTimeout 双超时）：
 *   - headerTimeoutMs：仅约束「响应头到达」；头一到就清掉定时器，
 *     长回答的流式体不会被整体超时切断（客户端靠 chunkTimeout 兜底，此处不实现）。
 *   - 调用方传入的 signal 会与内部超时联动（dsh-router 取消时一并中止上游请求）。
 */
import { UpstreamHttpError } from './errors.ts'

export interface RequestOptions {
  url: string
  method?: string
  headers: Record<string, string>
  body?: string
  headerTimeoutMs?: number
  signal?: AbortSignal
}

/** 发起请求并返回 Response（响应头已到达）。 */
async function request(options: RequestOptions): Promise<Response> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutMs = options.headerTimeoutMs && options.headerTimeoutMs > 0 ? options.headerTimeoutMs : 0
  if (timeoutMs) {
    timer = setTimeout(() => controller.abort(), timeoutMs)
  }
  try {
    return await fetch(options.url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      redirect: 'follow',
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', onAbort)
  }
}

/** 读取文本并在非 2xx 时抛 UpstreamHttpError。 */
async function assertOk(response: Response): Promise<void> {
  if (response.ok) return
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  // 注意：text() 抛错时 body 可能仍被内部 reader 锁住，此时 cancel() 返回的是
  // 「已拒绝的 Promise」而非同步抛出 —— 不 await 就接不住，会变成
  // unhandledRejection 直接打挂宿主进程（dsh 启动期 fatal load failure）。
  // 另外锁定态下 cancel() 必然拒绝，先判 locked 避免制造无谓的拒绝。
  try {
    const body = response.body
    if (body !== null && !body.locked) await body.cancel()
  } catch {
    // 忽略取消失败：这里只为尽早释放连接，失败不影响错误上报
  }
  throw new UpstreamHttpError(response.status, text)
}

/** POST JSON 并解析 JSON 响应。 */
export async function postJson<T>(options: RequestOptions): Promise<T> {
  const response = await request({
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
  })
  await assertOk(response)
  const text = await response.text()
  if (!text.trim()) return {} as T
  return JSON.parse(text) as T
}

/** GET JSON。 */
export async function getJson<T>(options: RequestOptions): Promise<T> {
  const response = await request({ ...options, method: 'GET' })
  await assertOk(response)
  const text = await response.text()
  if (!text.trim()) return {} as T
  return JSON.parse(text) as T
}

/** 响应类型判定：是否 SSE（上游按 stream 参数返回 text/event-stream）。 */
export function isEventStream(response: Response): boolean {
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  return type.includes('text/event-stream')
}

/** 暴露原始 request：非流式对话需要「先看 content-type 再决定怎么解析」。 */
export async function sendRequest(options: RequestOptions): Promise<Response> {
  return request(options)
}

/** 暴露 assertOk：非 2xx 抛 UpstreamHttpError（含响应体原文，供错误分类）。 */
export async function assertResponseOk(response: Response): Promise<void> {
  await assertOk(response)
}

export interface StreamResult {
  /** 流式响应体。 */
  stream: ReadableStream<Uint8Array>
  /** 上游状态码（200）。 */
  status: number
}

/**
 * POST 并返回 SSE 流（非 2xx 抛 UpstreamHttpError）。
 *
 * 注意：上游在 stream=true 时即便出错也可能先回 200 再在流内报错，
 *      此处只保证「建立阶段」的错误被正确分类；流内错误由 provider 层按
 *      env.onLateFailure 上报。
 */
export async function postEventStream(options: RequestOptions): Promise<StreamResult> {
  const response = await request({
    ...options,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream, */*',
      ...options.headers,
    },
  })
  await assertOk(response)
  if (!response.body) throw new UpstreamHttpError(response.status, '', 'upstream returned empty body')
  return { stream: response.body, status: response.status }
}

/** 把 Web ReadableStream 收集为字符串（非流式调用与探测用）。 */
export async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let out = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) out += decoder.decode(value, { stream: true })
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 忽略
    }
  }
  out += decoder.decode()
  return out
}
