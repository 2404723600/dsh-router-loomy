/**
 * 上游错误的 state 映射与报文摘要。
 *
 * 映射表直接对齐 dsh-router-core `src/suppliers/http-state.ts::stateFromHttpStatus`：
 *   429 → rate_limit     401/403 → session_dead   404 → unavailable
 *   402 → quota          其它 4xx → bad_request   5xx → unknown
 * 网络层异常（fetch 失败 / 超时中断）→ transport。
 */
import type { AccountState } from '../contract.ts'

/** 带状态的 HTTP 错误。 */
export class UpstreamHttpError extends Error {
  readonly status: number
  readonly bodyText: string

  constructor(status: number, bodyText: string, message?: string) {
    super(message ?? `upstream responded ${status}`)
    this.name = 'UpstreamHttpError'
    this.status = status
    this.bodyText = bodyText
  }
}

/** HTTP 状态码 → 账号状态（与 core stateFromHttpStatus 保持一致）。 */
export function stateFromStatus(status: number): AccountState {
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'session_dead'
  if (status === 404) return 'unavailable'
  if (status === 402) return 'quota'
  if (status >= 400 && status < 500) return 'bad_request'
  if (status >= 500) return 'unknown'
  return 'unknown'
}

/** 网络层异常 → transport（fetch rejected / 超时 / 流中断）。 */
export function isTransportError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  if (name === 'AbortError' || name === 'TimeoutError') return true
  const message = String((err as { message?: string }).message ?? '')
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|terminated|network/i.test(message)
}

/** 从上游报文里抽取可读错误文案（Loomy 网关失败时形如 {"code":"100002","desc":"缺少 token"}）。 */
export function describeUpstreamBody(text: string, limit = 400): string {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      const candidates = [
        obj.message,
        obj.desc,
        obj.description,
        obj.error,
        obj.msg,
        obj.code,
      ]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, limit)
        if (candidate && typeof candidate === 'object') {
          const nested = (candidate as Record<string, unknown>).message
          if (typeof nested === 'string' && nested.trim()) return nested.trim().slice(0, limit)
        }
      }
    }
  } catch {
    // 非 JSON，按纯文本处理
  }
  return raw.replace(/\s+/g, ' ').slice(0, limit)
}

/** 把任意异常整理成「状态 + 文案」。 */
export function toStateAndMessage(err: unknown): { state: AccountState; message: string } {
  if (err instanceof UpstreamHttpError) {
    const detail = describeUpstreamBody(err.bodyText)
    return {
      state: stateFromStatus(err.status),
      message: detail ? `HTTP ${err.status}: ${detail}` : `HTTP ${err.status}`,
    }
  }
  if (isTransportError(err)) {
    return { state: 'transport', message: err instanceof Error ? err.message : String(err) }
  }
  return { state: 'unknown', message: err instanceof Error ? err.message : String(err) }
}
