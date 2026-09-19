/**
 * 追踪头单测 —— 四个必带头的形态与可复用性。
 * 运行：npm test（node --test，Node 24 原生跑 .ts）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTracingHeaders,
  isTraceparent,
  newChatId,
  newMsgId,
  newSessionAffinity,
  newTraceparent,
} from './headers.ts'

/** 头取值（Record 索引在 noUncheckedIndexedAccess 下是可能 undefined，这里统一兜底成空串）。 */
const get = (headers: Record<string, string>, key: string): string => headers[key] ?? ''

test('traceparent 符合 W3C 格式 00-<32hex>-<16hex>-01', () => {
  for (let i = 0; i < 50; i += 1) {
    const value = newTraceparent()
    assert.ok(isTraceparent(value), value)
    assert.equal(value.length, 55)
  }
})

test('isTraceparent 拒绝错误形态', () => {
  assert.equal(isTraceparent(''), false)
  assert.equal(isTraceparent('00-abc-def-01'), false)
  assert.equal(isTraceparent(newTraceparent().replace('00-', '01-')), false)
})

test('chatid / msgid 前缀正确且互不相同', () => {
  assert.match(newChatId(), /^chat-[0-9a-f-]{36}$/)
  assert.match(newMsgId(), /^msg-[0-9a-f-]{36}$/)
  assert.notEqual(newChatId(), newChatId())
})

test('session affinity 形如 ses_<21 位 base62>', () => {
  assert.match(newSessionAffinity(), /^ses_[0-9a-zA-Z]{21}$/)
})

test('buildTracingHeaders 必带四头，affinity 可选', () => {
  const withAffinity = buildTracingHeaders({ version: '0.9.36', invokeOrigin: 'user', sessionAffinity: true })
  assert.ok(isTraceparent(get(withAffinity, 'traceparent')))
  assert.match(get(withAffinity, 'chatid'), /^chat-/)
  assert.match(get(withAffinity, 'msgid'), /^msg-/)
  assert.equal(get(withAffinity, 'loomy-version'), '0.9.36')
  assert.equal(get(withAffinity, 'invokeorigin'), 'user')
  assert.match(get(withAffinity, 'x-session-affinity'), /^ses_/)

  const without = buildTracingHeaders({ version: '0.9.36', invokeOrigin: 'system', sessionAffinity: false })
  assert.equal(without['x-session-affinity'], undefined)
  assert.equal(get(without, 'invokeorigin'), 'system')
})

test('buildTracingHeaders 支持复用已有 id', () => {
  const headers = buildTracingHeaders({
    version: '0.9.36',
    invokeOrigin: 'user',
    sessionAffinity: false,
    chatId: 'chat-fixed',
    msgId: 'msg-fixed',
  })
  assert.equal(headers.chatid, 'chat-fixed')
  assert.equal(headers.msgid, 'msg-fixed')
})
