/**
 * 供应商**能力面**单测 —— 钉住「核心前端会走哪条添加链接的路」。
 *
 * 回归背景：core 的 `SupplierDetail.tsx` 里
 *   `canApiKey = hasCap('addApiKey')`，而 `startLogin()` 一旦 canApiKey 为真就
 *   直接弹「填名字 + API key」表单并 return —— `generateLoginUrl` 分支永远不会执行。
 * 所以「打开客户端登录」能不能用，完全取决于**有没有暴露 addApiKey**。
 * 这条耦合不看代码根本看不出来，必须有测试守着。
 *
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractSession } from '../provider.ts'
import { createSupplier, moduleFor, priority } from './plugin.ts'
import { PRIORITY } from './constants.ts'
import type { SupplierEnv } from '../contract.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'loomy-plugin-'))
}

function fakeEnv(dataDir: string): SupplierEnv {
  return {
    dataDir,
    log: () => {},
    store: {
      get: () => ({ alias: '', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback' as const, credits: {} }),
    },
    credentials: {
      list: () => [],
      get: () => undefined,
      save: () => {},
      remove: () => false,
    },
  }
}

/** 造一个「没装客户端、没有登录态」的隔离环境（不会碰真实磁盘/网络）。 */
function isolatedModule(): ReturnType<typeof moduleFor> {
  const dir = tempDir()
  const supplier = createSupplier(fakeEnv(dir), {
    publicDir: dir,
    // 本机确实装了客户端，真实候选列表会命中它 —— 显式给空候选才是隔离的
    clientCandidates: () => [],
  })
  return moduleFor(supplier)
}

test('能力面：不暴露 addApiKey（否则核心前端不会走 generateLoginUrl）', () => {
  const mod = isolatedModule()
  assert.equal(
    'addApiKey' in mod,
    false,
    '暴露 addApiKey 会让核心渲染「粘贴 API key」弹窗，打开客户端登录这条路在 UI 上就死了',
  )
})

test('能力面：暴露登录三件套 generateLoginUrl / pollLogin / completeLogin', () => {
  const mod = isolatedModule()
  assert.equal(typeof mod.generateLoginUrl, 'function')
  assert.equal(typeof mod.pollLogin, 'function')
  assert.equal(typeof mod.completeLogin, 'function')
  assert.equal(mod.pollLogin?.(), true, 'pollLogin 是能力位，核心据此隐藏「粘贴回调链接」步骤')
  assert.equal(typeof mod.removeLink, 'function', '删除面板添加的连接仍应保留')
})

test('generateLoginUrl：返回指向客户端状态页的相对路径（不写死端口）', () => {
  const mod = isolatedModule()
  const result = mod.generateLoginUrl?.()
  assert.equal(typeof result, 'object')
  const url = (result as { ok: boolean; loginUrl: string }).loginUrl
  assert.equal(url.startsWith('/'), true, '必须是相对路径，端口由前端按同源解析')
  assert.equal(url.includes('://'), false)
})

test('priority：与 constants.PRIORITY 同源（曾硬编码 0 导致与 opencode 抢位）', () => {
  assert.equal(priority, PRIORITY)
  assert.equal(isolatedModule().priority, PRIORITY)
})

test('status：没有登录态时账号列表为空（不伪造占位账号 —— 伪号会被账号池选中并冷却 uid）', () => {
  const status = isolatedModule().status()
  assert.equal(status.id, 'loomy')
  assert.deepEqual(status.accounts, [])
})

test('completeLogin：轮询式（空串）拿不到登录态文件时报可读错误', async () => {
  const mod = isolatedModule()
  await assert.rejects(
    () => Promise.resolve(mod.completeLogin?.('') ?? Promise.reject(new Error('missing'))),
    (err: Error) => {
      assert.ok(err.message.includes('未检测到登录态'), `实际：${err.message}`)
      return true
    },
  )
})

test('extractSession：裸串 / 回调链接 / JSON 片段都能取到会话串', () => {
  assert.equal(extractSession('abc123def456'), 'abc123def456')
  assert.equal(extractSession('Bearer abc123def456'), 'abc123def456')
  assert.equal(extractSession('"abc123def456"'), 'abc123def456')
  assert.equal(extractSession('http://127.0.0.1:18080/authorize?session=xyz%2B1'), 'xyz+1')
  assert.equal(extractSession('http://127.0.0.1:18080/authorize?token=tk1&x=2'), 'tk1')
  assert.equal(extractSession('{"session":"s1"}'), 's1')
  assert.equal(extractSession(''), '')
  assert.equal(extractSession('http://127.0.0.1:18080/authorize?other=1'), '', '认不出就返回空串，由调用方报错')
})

test('clientSnapshot：登录态文件在时报告已加载与脱敏串', () => {
  const dir = tempDir()
  // 真实布局：<publicDir>/<安装ID>/userData/auth-session.json
  const userData = join(dir, 'e7d3e769f3f5', 'userData')
  mkdirSync(userData, { recursive: true })
  const sessionFile = join(userData, 'auth-session.json')
  writeFileSync(
    sessionFile,
    JSON.stringify({ session: '2ddff6a1b2c3e606', phone: '132****3519', updatedAt: '2026-09-21T14:03:00Z' }),
  )
  const exe = join(dir, 'Loomy.exe')
  writeFileSync(exe, '')
  const supplier = createSupplier(fakeEnv(dir), { publicDir: dir, clientCandidates: () => [exe] })
  const snap = supplier.clientSnapshot()
  assert.equal(snap.installed, true)
  assert.equal(snap.exe, exe)
  assert.equal(snap.sessionLoaded, true)
  assert.equal(snap.sessionMasked, '2ddf****e606')
  assert.equal(snap.nickname, '本机客户端 · 132****3519')
  assert.equal(snap.sessionFile, sessionFile)
})

test('clientSnapshot：没装客户端时 running 报 false（而不是「未知」）', () => {
  const dir = tempDir()
  const supplier = createSupplier(fakeEnv(dir), { publicDir: dir, clientCandidates: () => [] })
  const snap = supplier.clientSnapshot()
  assert.equal(snap.installed, false)
  assert.equal(snap.running, false)
  assert.equal(snap.sessionLoaded, false)
})
