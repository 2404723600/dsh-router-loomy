/**
 * 追踪头构造 —— Loomy 上游 `/chat/completions` 的四个必带头。
 *
 * 实测结论（docs/loomy-upstream.md §3）：
 *   traceparent   W3C Trace Context，格式严格 `00-<32hex>-<16hex>-01`；**缺失会挂死**
 *   chatid        会话标识（客户端 = Loomy 会话 id；插件按请求生成）
 *   msgid         消息标识（客户端 = 助手消息 id；插件按请求生成）
 *   loomy-version 客户端版本，实测 `0.9.36`
 *   invokeorigin  'user'（用户主动）/ 'system'（系统子调用）
 *   x-session-affinity 可选，客户端每次调用都带、取值各不相同（上游会话亲和）
 */
import { randomBytes, randomUUID } from 'node:crypto'

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** n 字节随机数的十六进制串。 */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/** W3C traceparent：`00-<32hex trace-id>-<16hex span-id>-01`。 */
export function newTraceparent(flags = '01'): string {
  return `00-${randomHex(16)}-${randomHex(8)}-${flags}`
}

/** traceparent 格式校验（测试与自检用）。 */
export function isTraceparent(value: string): boolean {
  return /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)
}

/** 会话 id：`chat-<uuid>`。 */
export function newChatId(): string {
  return `chat-${randomUUID()}`
}

/** 消息 id：`msg-<uuid>`。 */
export function newMsgId(): string {
  return `msg-${randomUUID()}`
}

/** 指定长度的 base62 随机串（模拟客户端的 ses_ 取值形态）。 */
export function randomAlnum(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += ALNUM[bytes[i]! % ALNUM.length]
  return out
}

/** 上游会话亲和值：`ses_<21 位 base62>`。 */
export function newSessionAffinity(): string {
  return `ses_${randomAlnum(21)}`
}

export interface TracingHeaderInput {
  /** loomy-version 取值。 */
  version: string
  /** 是否附带 x-session-affinity（默认 true，模拟客户端行为）。 */
  sessionAffinity: boolean
  /** 请求来源标记：'user' | 'system'。 */
  invokeOrigin: string
  /** 复用已生成的 id（便于把同一请求的头复用到探测调用上）。 */
  chatId?: string
  msgId?: string
}

/** 组装一次请求的追踪头（不含 Authorization）。 */
export function buildTracingHeaders(input: TracingHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    traceparent: newTraceparent(),
    chatid: input.chatId ?? newChatId(),
    msgid: input.msgId ?? newMsgId(),
    'loomy-version': input.version,
    invokeorigin: input.invokeOrigin,
  }
  if (input.sessionAffinity) headers['x-session-affinity'] = newSessionAffinity()
  return headers
}
