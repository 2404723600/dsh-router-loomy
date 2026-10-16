/**
 * Loomy 上游 SSE 处理：帧切分 / 错误嗅探 / 非流式聚合。
 *
 * Loomy 上游 `/chat/completions` 的流式响应是**纯 SSE 且已是 OpenAI 形态**
 * （`data: {...}` 帧以空行分隔，末帧后跟 `data: [DONE]`；无 `event:` / `id:`
 * 行、无心跳注释，见 docs/loomy-upstream.md 实测记录）。因此：
 *
 * - 流式：**直接透传**上游字节（不做协议转换，也不需要重新序列化）；
 *   额外的动作只有两个：用 `sniffLateFailure` 顺路嗅探「迟到失败」，
 *   以及用 `guardUpstreamStream` 校验收尾完整性（见该函数注释）。
 * - 非流式：上游给的是单个 JSON，原样交回；但若网关忽略 `stream:false`
 *   仍返回 SSE，则用 `aggregateSseToCompletion` 把帧聚合成一个
 *   `chat.completion` 对象（核心对非流式只认 JSON 体）。
 */
import type { AccountState } from '../contract.ts'

/** 一条 SSE data 帧。 */
export interface SseFrame {
  /** 原始 data 载荷（已去掉 `data:` 前缀与首尾空白）。 */
  data: string
  /** 解析成功的 JSON 载荷；`[DONE]` 或非 JSON 时为 undefined。 */
  json?: Record<string, unknown>
  /** 是否为收尾帧 `data: [DONE]`。 */
  done: boolean
}

/** 把一段 SSE 文本切成帧（容忍 \r\n 与多行 data）。 */
export function parseSseFrames(text: string): SseFrame[] {
  const out: SseFrame[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (block.trim() === '') continue
    const datas: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) datas.push(line.slice(5).trimStart())
      // 其余字段（event:/id:/retry:/注释）本上游不产出，忽略即可
    }
    if (datas.length === 0) continue
    const data = datas.join('\n')
    const frame: SseFrame = { data, done: data === '[DONE]' }
    if (!frame.done) {
      try {
        const parsed: unknown = JSON.parse(data)
        if (typeof parsed === 'object' && parsed !== null) frame.json = parsed as Record<string, unknown>
      } catch {
        // 非 JSON 帧（理论上不出现）：保留 data 原文，交给上层判错
      }
    }
    out.push(frame)
  }
  return out
}

/** 从任意一帧 JSON 里提取上游错误对象（网关报错时形如 `{"error":{...}}` 或 `{"code":"100002","desc":"..."}`）。 */
export function extractFrameError(json: Record<string, unknown>): { code: string; message: string } | undefined {
  const err = json.error
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>
    const code = typeof e.code === 'number' || typeof e.code === 'string' ? String(e.code) : ''
    const msg = typeof e.message === 'string' ? e.message : ''
    return { code, message: msg !== '' ? msg : 'upstream error frame' }
  }
  // 讯飞网关的错误形态：{ code, desc }（code 为字符串数字，非 200 才算错）
  if (typeof json.code === 'string' && json.code !== '' && json.code !== '0' && json.code !== '200') {
    const desc = typeof json.desc === 'string' ? json.desc : typeof json.message === 'string' ? json.message : ''
    return { code: json.code, message: desc !== '' ? desc : `upstream code ${json.code}` }
  }
  return undefined
}

/** 上游错误对象 → 契约语义状态（与 http.ts 的 stateFromStatus 同源，用于流中途失败）。 */
export function stateFromFrameError(code: string, message: string): AccountState {
  const m = `${code} ${message}`.toLowerCase()
  if (code === '429' || m.includes('rate limit') || m.includes('too many')) return 'rate_limit'
  if (code === '401' || code === '403' || code === '100002' || m.includes('token') || m.includes('unauthor') || m.includes('登录')) return 'session_dead'
  if (m.includes('积分') || m.includes('points') || m.includes('quota') || m.includes('balance') || m.includes('余额') || m.includes('额度')) return 'quota'
  if (code === '404') return 'unavailable'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// 流完整性守卫
// ---------------------------------------------------------------------------

/** 上游收尾形态。 */
export type StreamVerdict = 'ok' | 'capped' | 'truncated'

/** 收尾处置：原样放行 / 补一个 length 终止标记 / 扣住 [DONE] 逼核心重试。 */
export type GuardAction = 'pass' | 'mark-length' | 'fail'

/** 守卫在流末统计出的事实（供决策与日志）。 */
export interface StreamStats {
  /** 上游有没有给出非空 finish_reason。 */
  sawFinishReason: boolean
  /** 正文累计字符数。 */
  contentChars: number
  /** 推理累计字符数。 */
  reasoningChars: number
  /** 有没有出现工具调用分片。 */
  sawToolCall: boolean
  /** 上游自报的 completion_tokens（**含推理**）。 */
  completionTokens?: number
  /** 本次下发给上游的 max_tokens。 */
  maxTokens?: number
}

export interface GuardOptions {
  /** 本次下发给上游的 max_tokens，用于区分「撞上限」与「上游断流」。 */
  maxTokens?: number
  /** 流内错误帧（迟到失败）：上报核心，坏账号不会继续被轮转选中。 */
  onLateFailure?: (state: AccountState, message: string) => void
  /** 收尾处置决策；默认 ok→pass、capped→mark-length、truncated→fail。 */
  decide?: (verdict: StreamVerdict, stats: StreamStats) => GuardAction
  /** 判定结果回调（日志 / 计数）。 */
  onVerdict?: (verdict: StreamVerdict, stats: StreamStats) => void
}

/** 默认处置：截断一律扣住 [DONE]，交给核心按 TRANSPORT 重试。 */
export function defaultGuardAction(verdict: StreamVerdict): GuardAction {
  if (verdict === 'ok') return 'pass'
  if (verdict === 'capped') return 'mark-length'
  return 'fail'
}

/**
 * 判定收尾形态。
 *
 * 判据来自实测（2026-10-16）：
 *   - 正常完成**一定**带 `finish_reason`（`stop` / `tool_calls`）；
 *   - 上游截断时仍会发 `data: [DONE]`，**只是不给 `finish_reason`**；
 *   - 撞 max_tokens 时同样不给 `finish_reason`，末帧是 `choices:[] + usage`，
 *     故用 `completion_tokens >= maxTokens` 把「撞上限」摘出来单独处置。
 *
 * 另补一条：给了 `finish_reason` 但**只有推理、没有正文也没有工具调用**，
 * 对 agent 来说同样是「没产出可用回答」，归入截断。
 */
export function verdictOf(stats: StreamStats): StreamVerdict {
  if (!stats.sawFinishReason) {
    const capped =
      stats.maxTokens !== undefined &&
      stats.maxTokens > 0 &&
      stats.completionTokens !== undefined &&
      stats.completionTokens >= stats.maxTokens
    return capped ? 'capped' : 'truncated'
  }
  if (stats.contentChars === 0 && !stats.sawToolCall && stats.reasoningChars > 0) return 'truncated'
  return 'ok'
}

/** 补齐 length 终止标记的合成帧（核心 mapFinishReason('length') → max-tokens）。 */
const LENGTH_FRAME = new TextEncoder().encode(
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`,
)
const DONE_FRAME = new TextEncoder().encode('data: [DONE]')
/** 输出侧保留的尾部字节数：够覆盖 `data: [DONE]` 被切在两个 chunk 之间的情形。 */
const OUT_CARRY = 32

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  const last = hay.length - needle.length
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * 流式透传 + 迟到失败嗅探 + **收尾完整性守卫**。
 *
 * 为什么需要收尾校验：上游（讯飞网关）会在生成没结束时就发 `[DONE]`，
 * 只是不给 `finish_reason`。core 的适配器在 `[DONE]` 处若没见到
 * `finish_reason` 就默认按 `stop` 收尾，于是**截断被当成正常完成**——
 * 表现是「助手说要做却什么都没做，本轮就结束了」，且不报任何错。
 * 唯一能发现这件事的地方就是这里（插件是唯一和上游对话的一方）。
 *
 * 处置手段是**扣住 `[DONE]` 不放**：core 见流结束却没有 `[DONE]`，会抛
 * `SSE payload stream ended without [DONE]`（码 `TRANSPORT`），而 TRANSPORT
 * 在 dsh-llm 的可重试白名单里，于是这一轮被自动重试而不是静默截断。
 *
 * 正常路径**字节级原样透传**（仅尾部保留 ≤32 字节再吐，用于识别跨 chunk 的
 * `[DONE]`）；只有判定异常时才会改写收尾。
 */
export function guardUpstreamStream(
  stream: ReadableStream<Uint8Array>,
  options: GuardOptions = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const stats: StreamStats = {
    sawFinishReason: false,
    contentChars: 0,
    reasoningChars: 0,
    sawToolCall: false,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  }
  let buffer = ''
  let reported = false
  let carry: Uint8Array = new Uint8Array(0)
  let held: Uint8Array | undefined
  let holding = false

  const inspect = (text: string): void => {
    buffer += text
    // 只处理**完整帧**（以空行结束），残留片段留到下一块
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      if (!block.startsWith('data:')) continue
      const data = block.slice(5).trimStart().trim()
      if (data === '' || data === '[DONE]') continue
      let json: Record<string, unknown>
      try {
        json = JSON.parse(data) as Record<string, unknown>
      } catch {
        // 半截 JSON / 非 JSON：忽略（透传路径不做协议校验）
        continue
      }
      if (!reported) {
        const err = extractFrameError(json)
        if (err !== undefined) {
          reported = true
          options.onLateFailure?.(
            stateFromFrameError(err.code, err.message),
            `upstream mid-stream error: ${err.message}`,
          )
        }
      }
      const usage = json.usage
      if (typeof usage === 'object' && usage !== null) {
        const ct = (usage as Record<string, unknown>).completion_tokens
        // usage 可能拆在多帧里，取最大值（核心同口径）
        if (typeof ct === 'number' && ct > (stats.completionTokens ?? -1)) stats.completionTokens = ct
      }
      const choices = json.choices
      if (!Array.isArray(choices)) continue
      for (const choice of choices as Array<Record<string, unknown>>) {
        // 空串 = 「还没结束」，不能当成终止（与核心同口径）
        if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
          stats.sawFinishReason = true
        }
        const delta = choice.delta as Record<string, unknown> | undefined
        if (delta === undefined) continue
        if (typeof delta.content === 'string') stats.contentChars += delta.content.length
        if (typeof delta.reasoning_content === 'string') stats.reasoningChars += delta.reasoning_content.length
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) stats.sawToolCall = true
      }
    }
  }

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        try {
          inspect(decoder.decode(chunk, { stream: true }))
        } catch {
          // 嗅探失败绝不影响透传
        }

        if (holding) {
          held = concatBytes(held ?? new Uint8Array(0), chunk)
          return
        }
        // 尾部留 OUT_CARRY 字节不出，等下一块 —— 否则 `data: [DONE]` 跨 chunk
        // 时会被前半段先吐出去，之后就扣不住了。
        const merged = concatBytes(carry, chunk)
        const at = indexOfBytes(merged, DONE_FRAME)
        if (at >= 0) {
          if (at > 0) controller.enqueue(merged.subarray(0, at))
          held = merged.subarray(at)
          holding = true
          carry = new Uint8Array(0)
          return
        }
        const keep = Math.min(OUT_CARRY, merged.length)
        const emitLen = merged.length - keep
        if (emitLen > 0) controller.enqueue(merged.subarray(0, emitLen))
        carry = merged.subarray(emitLen)
      },
      flush(controller) {
        const verdict = verdictOf(stats)
        let action: GuardAction
        try {
          action = options.decide?.(verdict, stats) ?? defaultGuardAction(verdict)
        } catch {
          action = defaultGuardAction(verdict)
        }
        try {
          options.onVerdict?.(verdict, stats)
        } catch {
          // 回调失败不影响收尾
        }

        // 上游压根没发 [DONE]：把残留字节原样吐出去，核心会按「缺 [DONE]」自己报错
        if (!holding && carry.length > 0) controller.enqueue(carry)
        if (action === 'pass') {
          if (held !== undefined) controller.enqueue(held)
          return
        }
        if (action === 'mark-length') {
          controller.enqueue(LENGTH_FRAME)
          if (held !== undefined) controller.enqueue(held)
          return
        }
        // fail：扣住 [DONE] 不放，逼核心抛 TRANSPORT → dsh 自动重试
      },
    }),
  )
}

interface DeltaAcc {
  content: string
  reasoning: string
  toolCalls: Map<number, { id: string; name: string; args: string }>
}

/**
 * 把 SSE 帧聚合成一个 OpenAI 非流式 `chat.completion` 对象。
 *
 * 仅在「请求 stream=false 但网关仍回 SSE」时使用（正常路径上游直接回 JSON）。
 * 聚合规则按 OpenAI 流式语义：`content`/`reasoning_content` 顺序拼接，
 * `tool_calls` 按 index 合并并对 `function.arguments` 做分片拼接。
 */
export function aggregateSseToCompletion(text: string): Record<string, unknown> {
  let id = ''
  let model = ''
  let created = 0
  let finishReason: string | null = null
  let usage: Record<string, unknown> | undefined
  const acc: DeltaAcc = { content: '', reasoning: '', toolCalls: new Map() }

  for (const frame of parseSseFrames(text)) {
    if (frame.done || frame.json === undefined) continue
    const json = frame.json
    if (typeof json.id === 'string' && id === '') id = json.id
    if (typeof json.model === 'string' && json.model !== '') model = json.model
    if (typeof json.created === 'number') created = json.created
    if (typeof json.usage === 'object' && json.usage !== null) usage = json.usage as Record<string, unknown>
    const choices = json.choices
    if (!Array.isArray(choices) || choices.length === 0) continue
    const choice = choices[0] as Record<string, unknown>
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
    const delta = choice.delta as Record<string, unknown> | undefined
    if (delta === undefined) continue
    if (typeof delta.content === 'string') acc.content += delta.content
    if (typeof delta.reasoning_content === 'string') acc.reasoning += delta.reasoning_content
    const tcs = delta.tool_calls
    if (Array.isArray(tcs)) {
      for (const tc of tcs as Array<Record<string, unknown>>) {
        const idx = typeof tc.index === 'number' ? tc.index : acc.toolCalls.size
        const cur = acc.toolCalls.get(idx) ?? { id: '', name: '', args: '' }
        if (typeof tc.id === 'string' && tc.id !== '') cur.id = tc.id
        const fn = tc.function as Record<string, unknown> | undefined
        if (fn !== undefined) {
          if (typeof fn.name === 'string' && fn.name !== '') cur.name = fn.name
          if (typeof fn.arguments === 'string') cur.args += fn.arguments
        }
        acc.toolCalls.set(idx, cur)
      }
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content: acc.content }
  if (acc.reasoning !== '') message.reasoning_content = acc.reasoning
  if (acc.toolCalls.size > 0) {
    message.tool_calls = [...acc.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, v]) => ({ index, id: v.id, type: 'function', function: { name: v.name, arguments: v.args } }))
  }

  const out: Record<string, unknown> = {
    id: id !== '' ? id : `chatcmpl-loomy-${Date.now()}`,
    object: 'chat.completion',
    created: created !== 0 ? created : Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? 'stop' }],
  }
  if (usage !== undefined) out.usage = usage
  return out
}

/** 非流式响应体是否「有实质内容」（空响应视为失败，让核心换号/换模型回退）。 */
export function hasAssistantContent(body: Record<string, unknown>): boolean {
  const choices = body.choices
  if (!Array.isArray(choices) || choices.length === 0) return false
  const msg = (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined
  if (msg === undefined) return false
  if (typeof msg.content === 'string' && msg.content.length > 0) return true
  // 注意：**只有 reasoning_content 不算有效回答**。上游截断时常常只吐推理、
  // 正文为空，若把推理当内容，这种残缺响应会被当成成功，用户看到的就是
  // 「话没讲完却没有任何报错」。（流式路径的同类判定见 verdictOf。）
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true
  return false
}
