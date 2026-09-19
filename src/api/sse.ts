/**
 * Loomy 上游 SSE 处理：帧切分 / 错误嗅探 / 非流式聚合。
 *
 * Loomy 上游 `/chat/completions` 的流式响应是**纯 SSE 且已是 OpenAI 形态**
 * （`data: {...}` 帧以空行分隔，末帧后跟 `data: [DONE]`；无 `event:` / `id:`
 * 行、无心跳注释，见 docs/loomy-upstream.md 实测记录）。因此：
 *
 * - 流式：**直接透传**上游字节（不做协议转换，也不需要重新序列化）；
 *   唯一的额外动作是用 `sniffLateFailure` 顺路嗅探「迟到失败」。
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

/**
 * 流式透传 + 迟到失败嗅探。
 *
 * 响应头一旦写出就绑死（HTTP 语义）：流中途才发现「这个号/这把 Key 坏了」时
 * 这次请求救不回来，但必须通过 `env.onLateFailure` 上报核心，否则坏账号会继续
 * 留在池里被轮转选中，每次都白撞同一个错误（traework 的实测教训：3 个号里 2 个
 * 被拒，round-robin 下 2/3 请求直接失败）。
 *
 * 嗅探**不改变字节流**：上游给什么就往下游传什么，只顺路看一眼错误帧。
 */
export function sniffLateFailure(
  stream: ReadableStream<Uint8Array>,
  onError: (state: AccountState, message: string) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ''
  let reported = false
  const inspect = (text: string): void => {
    if (reported) return
    buffer += text
    // 只处理**完整帧**（以空行结束），残留片段留到下一块
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      if (!block.startsWith('data:')) continue
      const data = block.slice(5).trimStart().trim()
      if (data === '' || data === '[DONE]') continue
      try {
        const json = JSON.parse(data) as Record<string, unknown>
        const err = extractFrameError(json)
        if (err !== undefined) {
          reported = true
          onError(stateFromFrameError(err.code, err.message), `upstream mid-stream error: ${err.message}`)
          return
        }
      } catch {
        // 半截 JSON / 非 JSON：忽略（透传路径不做协议校验）
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
        controller.enqueue(chunk)
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
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) return true
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true
  return false
}
