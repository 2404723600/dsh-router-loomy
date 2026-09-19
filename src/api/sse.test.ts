/**
 * SSE 解析单测 —— 用上游实测帧形态（delta + usage 末帧 + [DONE]）当夹具。
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateSseToCompletion,
  extractFrameError,
  hasAssistantContent,
  parseSseFrames,
  stateFromFrameError,
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
  assert.equal(hasAssistantContent({ choices: [{ message: { reasoning_content: '想' } }] }), true)
  assert.equal(hasAssistantContent({ choices: [{ message: { content: '' } }] }), false)
  assert.equal(hasAssistantContent({}), false)
})
