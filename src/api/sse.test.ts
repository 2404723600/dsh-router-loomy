/**
 * SSE 解析单测 —— 用上游实测帧形态（delta + usage 末帧 + [DONE]）当夹具。
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateSseToCompletion,
  extractFrameError,
  guardUpstreamStream,
  hasAssistantContent,
  parseSseFrames,
  stateFromFrameError,
  verdictOf,
  type SseFrame,
} from './sse.ts'

/** 测试里统一用「宽松 JSON」形态读聚合结果（产物是 Record<string, unknown>）。 */
type Json = Record<string, unknown>

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

/** 取 choices[0]（noUncheckedIndexedAccess 下需显式兜底）。 */
const firstChoice = (out: Json): Json => (out.choices as Json[])[0] as Json

/** 取 choices[0].message。 */
const messageOf = (out: Json): Json => firstChoice(out).message as Json

/** 取 choices[0].message.tool_calls[0]。 */
const firstToolCall = (out: Json): Json => (messageOf(out).tool_calls as Json[])[0] as Json

/** 取帧内 JSON（已解析的帧才有）。 */
const jsonOf = (f: SseFrame): Json => f.json as Json

/** three-frame stream: reasoning delta → content delta → usage/finish 帧 → [DONE] */
const SAMPLE =
  frame({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: 'deepseek-v4-flash-0731', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '想' }, finish_reason: null }] }) +
  frame({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: 'deepseek-v4-flash-0731', choices: [{ index: 0, delta: { content: '收到' }, finish_reason: null }] }) +
  frame({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'deepseek-v4-flash-0731',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 88, completion_tokens: 9, total_tokens: 97, points_consumed: 1 },
  }) +
  'data: [DONE]\n\n'

test('parseSseFrames 跳过 [DONE] 并解析 JSON 帧', () => {
  const frames = parseSseFrames(SAMPLE)
  assert.equal(frames.length, 4)
  assert.equal(frames[frames.length - 1]?.done, true)
  assert.equal(jsonOf(frames[0] as SseFrame).model, 'deepseek-v4-flash-0731')
})

test('aggregateSseToCompletion 聚合 content / reasoning / usage', () => {
  const out = aggregateSseToCompletion(SAMPLE)
  assert.equal(out.object, 'chat.completion')
  assert.equal(out.model, 'deepseek-v4-flash-0731')
  const choice = firstChoice(out)
  const message = messageOf(out)
  assert.equal(message.content, '收到')
  assert.equal(message.reasoning_content, '想')
  assert.equal(choice.finish_reason, 'stop')
  assert.equal((out.usage as Json).points_consumed, 1)
})

test('aggregateSseToCompletion 合并分片 tool_calls', () => {
  const text =
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"cmd"' } }] }, finish_reason: null }] }) +
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }, finish_reason: 'tool_calls' }] }) +
    'data: [DONE]\n\n'
  const out = aggregateSseToCompletion(text)
  const call = firstToolCall(out)
  assert.equal(call.id, 'call_1')
  assert.equal((call.function as Json).name, 'bash')
  assert.equal((call.function as Json).arguments, '{"cmd":"ls"}')
  assert.equal(firstChoice(out).finish_reason, 'tool_calls')
})

test('extractFrameError 识别上游 code/desc 错误帧', () => {
  const err = extractFrameError({ code: '100002', desc: '缺少 token' })
  assert.deepEqual(err, { code: '100002', message: '缺少 token' })
  assert.equal(extractFrameError({ choices: [] }), undefined)
})

test('stateFromFrameError 把鉴权类错误映射为 session_dead', () => {
  assert.equal(stateFromFrameError('100002', '缺少 token'), 'session_dead')
  assert.equal(stateFromFrameError('401', 'unauthorized'), 'session_dead')
  assert.equal(stateFromFrameError('429', 'too many requests'), 'rate_limit')
  assert.equal(stateFromFrameError('9999', 'whatever'), 'unknown')
})

test('hasAssistantContent 判定空响应', () => {
  assert.equal(hasAssistantContent({ choices: [{ message: { content: 'hi' } }] }), true)
  assert.equal(hasAssistantContent({ choices: [{ message: { content: '' } }] }), false)
  assert.equal(hasAssistantContent({}), false)
})

test('hasAssistantContent 不把「只有推理」当有效回答', () => {
  // 上游截断时常常只吐 reasoning_content、正文为空；若把推理当内容，
  // 这种残缺响应会被当成成功（用户看到「话没讲完却没有任何报错」）。
  assert.equal(hasAssistantContent({ choices: [{ message: { reasoning_content: '想了一堆' } }] }), false)
  assert.equal(
    hasAssistantContent({ choices: [{ message: { reasoning_content: '想', tool_calls: [{ id: 'c1' }] } }] }),
    true,
  )
})

// ---------------------------------------------------------------------------
// 流完整性守卫
// ---------------------------------------------------------------------------

/** 把流读完成字符串。 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += dec.decode(value, { stream: true })
  }
  return out + dec.decode()
}

/** 造一个按 chunkSize 切块的上游流。 */
function upstream(text: string, chunkSize = 1 << 20): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

const CONTENT_FRAME = frame({ choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] })
const REASONING_FRAME = frame({ choices: [{ index: 0, delta: { reasoning_content: '想' }, finish_reason: null }] })
const STOP_FRAME = frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
const DONE = 'data: [DONE]\n\n'

test('verdictOf：正常收尾判 ok', () => {
  assert.equal(verdictOf({ sawFinishReason: true, contentChars: 10, reasoningChars: 3, sawToolCall: false }), 'ok')
})

test('verdictOf：没有 finish_reason 判截断，撞上限则判 capped', () => {
  const base = { sawFinishReason: false, contentChars: 0, reasoningChars: 27644, sawToolCall: false }
  assert.equal(verdictOf(base), 'truncated')
  assert.equal(verdictOf({ ...base, maxTokens: 32000, completionTokens: 300 }), 'truncated')
  assert.equal(verdictOf({ ...base, maxTokens: 300, completionTokens: 300 }), 'capped')
})

test('verdictOf：只有推理、没有正文也没有工具调用 → 截断', () => {
  assert.equal(verdictOf({ sawFinishReason: true, contentChars: 0, reasoningChars: 500, sawToolCall: false }), 'truncated')
  assert.equal(verdictOf({ sawFinishReason: true, contentChars: 0, reasoningChars: 500, sawToolCall: true }), 'ok')
})

test('guardUpstreamStream：正常流字节原样透传，判定 ok', async () => {
  const source = REASONING_FRAME + CONTENT_FRAME + STOP_FRAME + DONE
  const verdicts: string[] = []
  const out = await drain(
    guardUpstreamStream(upstream(source), { onVerdict: (v) => verdicts.push(v) }),
  )
  assert.equal(out, source)
  assert.deepEqual(verdicts, ['ok'])
})

test('guardUpstreamStream：跨 chunk 的 [DONE] 也能扣住（截断时不吐 [DONE]）', async () => {
  // 上游截断：有推理和正文，但始终没有 finish_reason
  const source = REASONING_FRAME + CONTENT_FRAME + DONE
  const verdicts: string[] = []
  // 每 7 字节切一刀，保证 `data: [DONE]` 被切开
  const out = await drain(guardUpstreamStream(upstream(source, 7), { onVerdict: (v) => verdicts.push(v) }))
  assert.deepEqual(verdicts, ['truncated'])
  assert.equal(out.includes('[DONE]'), false, '截断时必须扣住 [DONE]，核心才会按 TRANSPORT 重试')
  // 正文本身要原样透传（截断前的内容仍然可见）
  assert.equal(out.includes('你好'), true)
})

test('guardUpstreamStream：decide 返回 mark-length 时补一个 length 终止帧', async () => {
  const source = REASONING_FRAME + CONTENT_FRAME + DONE
  const out = await drain(
    guardUpstreamStream(upstream(source), { decide: () => 'mark-length' as const }),
  )
  assert.equal(out.includes('"finish_reason":"length"'), true)
  assert.equal(out.includes('[DONE]'), true)
  assert.equal(out.endsWith(DONE), true)
})

test('guardUpstreamStream：撞 max_tokens 默认补 length 而不是逼重试', async () => {
  const source =
    REASONING_FRAME +
    frame({ choices: [], usage: { prompt_tokens: 47, completion_tokens: 300, reasoning_tokens: 300 } }) +
    DONE
  const out = await drain(guardUpstreamStream(upstream(source), { maxTokens: 300 }))
  assert.equal(out.includes('"finish_reason":"length"'), true)
  assert.equal(out.includes('[DONE]'), true)
})

test('guardUpstreamStream：上游压根没发 [DONE] 时字节原样透传', async () => {
  const source = REASONING_FRAME + CONTENT_FRAME
  const out = await drain(guardUpstreamStream(upstream(source, 5)))
  assert.equal(out, source)
})

test('guardUpstreamStream：流内错误帧仍然触发迟到失败上报', async () => {
  const source = frame({ code: '100002', desc: '缺少 token' }) + DONE
  const seen: Array<[string, string]> = []
  await drain(guardUpstreamStream(upstream(source), { onLateFailure: (state, message) => seen.push([state, message]) }))
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.[0], 'session_dead')
  assert.match(seen[0]?.[1] ?? '', /mid-stream error/)
})
