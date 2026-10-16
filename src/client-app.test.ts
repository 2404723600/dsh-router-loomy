/**
 * 客户端定位 / 启动单测。
 *
 * 回归背景：客户端安装位置无法从注册表或配置里读到（2026-09-19 实测），
 * 只能靠候选路径探测，所以「候选顺序」「环境变量覆盖」「探不到时的行为」
 * 是这个模块最需要被钉住的三件事。
 *
 * 运行：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientApp, clientCandidates, driveRoots } from './client-app.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'loomy-client-'))
}

test('clientCandidates：环境变量覆盖排在最前，且各候选去重', () => {
  const list = clientCandidates({
    exeOverride: 'X:\\custom\\Loomy.exe',
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', PUBLIC: 'C:\\Users\\Public' },
    driveRoots: ['D:\\'],
  })
  assert.equal(list[0], 'X:\\custom\\Loomy.exe', '显式覆盖必须第一优先')
  assert.ok(list.includes(join('C:\\Users\\u\\AppData\\Local', 'Programs', 'Loomy', 'Loomy.exe')))
  assert.ok(list.includes(join('C:\\Users\\u\\AppData\\Roaming', 'Loomy', 'Loomy.exe')))
  assert.ok(list.includes(join('C:\\Users\\Public', 'Loomy', 'Loomy.exe')))
  // 实测安装位置：<盘符>:\loomy\Loomy.exe —— 盘符扫描必须覆盖到它
  assert.ok(list.includes(join('D:\\', 'loomy', 'Loomy.exe')))
  assert.equal(new Set(list).size, list.length, '候选不应重复')
})

test('clientCandidates：盘符扫描只来自注入的盘符（不依赖真实磁盘布局）', () => {
  const list = clientCandidates({ env: {}, driveRoots: ['Q:\\'] })
  assert.ok(list.some((p) => p.startsWith('Q:\\')), '注入的盘符应出现在候选里')
  assert.ok(!list.some((p) => p.startsWith('Z:\\')), '未注入的盘符不应出现')
})

test('driveRoots：非 Windows 返回空数组（其余平台不误报）', () => {
  const roots = driveRoots()
  if (process.platform === 'win32') {
    assert.ok(roots.length > 0, 'Windows 上至少应识别出系统盘')
    assert.ok(roots.every((r) => /^[A-Z]:\\$/.test(r)))
  } else {
    assert.deepEqual(roots, [])
  }
})

test('locateExe：命中第一个存在的候选，结果被缓存，force 可重新探测', () => {
  const dir = tempDir()
  const exe = join(dir, 'Loomy.exe')
  writeFileSync(exe, '')
  let candidates = [join(dir, 'nope', 'Loomy.exe'), exe]
  const app = new ClientApp({ log: () => {}, candidates: () => candidates, locateTtlMs: 60_000 })
  assert.equal(app.locateExe(), exe)
  // 缓存生效：候选列表变化不影响未过期的结果
  candidates = []
  assert.equal(app.locateExe(), exe, 'TTL 内应命中缓存')
  assert.equal(app.locateExe(true), undefined, 'force 应绕过缓存重新探测')
})

test('locateExe：全部候选都不存在时返回 undefined 且不抛', () => {
  const app = new ClientApp({ log: () => {}, candidates: () => ['C:\\definitely\\missing\\Loomy.exe'] })
  assert.equal(app.locateExe(), undefined)
})

test('launch：找不到可执行文件时返回 ok:false，不抛异常', async () => {
  const app = new ClientApp({
    log: () => {},
    candidates: () => ['C:\\definitely\\missing\\Loomy.exe'],
    probeRunning: () => Promise.resolve(false),
  })
  const result = await app.launch()
  assert.equal(result.ok, false)
  assert.ok((result.error ?? '').includes('未找到'), `错误信息应说明未找到，实际：${result.error ?? ''}`)
})

test('launch：客户端已在运行时返回 already，不重复启动', async () => {
  const app = new ClientApp({
    log: () => {},
    candidates: () => ['C:\\definitely\\missing\\Loomy.exe'],
    probeRunning: () => Promise.resolve(true),
  })
  const result = await app.launch()
  assert.equal(result.ok, true)
  assert.equal(result.already, true)
})

test('runningNow：探测前是 undefined（「未知」），探测后是布尔值', async () => {
  const app = new ClientApp({ log: () => {}, probeRunning: () => Promise.resolve(true), runningTtlMs: 60_000 })
  assert.equal(app.runningNow(), undefined)
  assert.equal(await app.refreshRunning(), true)
  assert.equal(app.runningNow(), true)
  // TTL 内走缓存，不再探测
  let calls = 0
  const app2 = new ClientApp({
    log: () => {},
    runningTtlMs: 60_000,
    probeRunning: () => {
      calls += 1
      return Promise.resolve(false)
    },
  })
  await app2.refreshRunning()
  await app2.refreshRunning()
  assert.equal(calls, 1, 'TTL 内不应重复探测')
})

test('refreshRunning：探测实现抛错时当「未运行」，不向外抛', async () => {
  const app = new ClientApp({
    log: () => {},
    probeRunning: () => Promise.reject(new Error('tasklist boom')),
  })
  assert.equal(await app.refreshRunning(), false)
})
