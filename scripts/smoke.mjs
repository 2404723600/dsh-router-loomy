/**
 * 端到端冒烟脚本（不依赖 dsh 运行时，直接驱动构建产物）：
 *
 *   node scripts/smoke.mjs [dataDir]
 *
 * 覆盖三件事（对应 dsh-router 加载插件后最关键的调用路径）：
 *   1) status()               —— 面板状态：账号/会话解析是否可用
 *   2) listModels()           —— GET /models 拉取模型目录（失败会回退本机/内置）
 *   3) chatOnce()  非流式 + 流式 —— 最小真实对话调用（含追踪头注入）
 *
 * env 用最小内存桩替掉 dsh-router 核心的 store/credentials，
 * 会话串仍取自本机 Loomy 客户端登录态文件（不发往除上游外的任何地方）。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSupplier } from '../lib/supplier.js'

const dataDir = process.argv[2] ?? join(tmpdir(), 'dsh-router-loomy-smoke')
const logs = []
const env = {
  dataDir,
  log: (msg) => {
    logs.push(msg)
    console.log(`  [log] ${msg}`)
  },
  store: {
    // 最小结构面：无别名、无禁用、无自定义模型
    get: () => ({ alias: '', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback', credits: {} }),
    getCredits: () => -1,
  },
  credentials: {
    list: () => [],
    get: () => undefined,
    save: () => {},
    remove: () => true,
  },
}

const MODEL = process.env.SMOKE_MODEL ?? 'deepseek-v4-flash-0731'
let failed = 0
const step = (name) => console.log(`\n=== ${name} ===`)
const check = (ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${detail}`)
  if (!ok) failed += 1
}

const supplier = createSupplier(env)

step('1) status()')
const status = supplier.status()
console.log(JSON.stringify(status, null, 2))
check(status.id === 'loomy' && status.accounts.length > 0, `accounts=${status.accounts.length}`)

step('2) listModels()')
const models = await supplier.listModels(true)
console.log(`模型数：${models.length}`)
console.log(models.slice(0, 6).map((m) => `  - ${m.id} (context_length=${m.context_length ?? '?'}K)`).join('\n'))
check(models.length > 0, `listModels 返回 ${models.length} 个模型`)
check(models.some((m) => m.id === MODEL), `清单内含 ${MODEL}`)

step('3) chatOnce() 非流式')
const baseBody = {
  messages: [{ role: 'user', content: '只回复两个字：收到' }],
  max_tokens: 64,
}
const plain = await supplier.chatOnce('local-session', 'auto', {
  rawBody: JSON.stringify(baseBody),
  stream: false,
  model: MODEL,
})
if (plain.ok === false) {
  console.log(JSON.stringify(plain))
  check(false, `非流式 chatOnce 失败：${plain.state} / ${plain.message}`)
} else {
  const parsed = JSON.parse(plain.body)
  const text = parsed.choices?.[0]?.message?.content ?? ''
  console.log(`status=${plain.status} model=${parsed.model ?? '?'} content=${JSON.stringify(text)}`)
  check(plain.status === 200 && text.length > 0, '非流式返回含助手正文')
}

step('4) chatOnce() 流式')
const streamed = await supplier.chatOnce('local-session', 'auto', {
  rawBody: JSON.stringify({ ...baseBody, stream: true }),
  stream: true,
  model: MODEL,
})
if (streamed.ok === false) {
  console.log(JSON.stringify(streamed))
  check(false, `流式 chatOnce 失败：${streamed.state} / ${streamed.message}`)
} else if (streamed.stream === undefined) {
  check(false, '未拿到流式响应体')
} else {
  const text = await new Response(streamed.stream).text()
  const frames = text.split('\n\n').filter((f) => f.startsWith('data:'))
  const done = text.includes('data: [DONE]')
  const hasDelta = text.includes('"delta"')
  const usageFrame = frames.find((f) => f.includes('"usage"'))
  console.log(`帧数=${frames.length} 含delta=${hasDelta} 含[DONE]=${done}`)
  if (usageFrame) {
    const usage = JSON.parse(usageFrame.slice(5)).usage
    console.log(`usage=${JSON.stringify(usage)}`)
  }
  check(frames.length > 0 && hasDelta && done, 'SSE 帧结构完整（delta + [DONE]）')
}

step('结果')
console.log(failed === 0 ? 'SMOKE PASS' : `SMOKE FAIL（${failed} 项）`)
console.log(`日志行数：${logs.length}`)
process.exit(failed === 0 ? 0 : 1)
