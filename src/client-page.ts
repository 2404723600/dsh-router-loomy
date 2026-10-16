/**
 * 「Loomy 客户端」状态页 —— 挂在 `/router/api/loomy/client`。
 *
 * 为什么要有这个页面：
 *   1. 核心的供应商卡片是 core 自己的 React 应用，**不给插件留按钮位**；
 *      插件能影响的只有能力位（capabilities）。所以「打开客户端」这个动作
 *      借 `generateLoginUrl` 暴露 —— 核心把它渲染成一个链接，这里就是链接的落点。
 *   2. 用户要的「显示是否已加载」需要一处能放完整信息的地方：客户端安装路径、
 *      是否在运行、登录态是否已加载、会话脱敏串、登录时间。
 *   3. 兜底：客户端装在探测不到的位置时，还能手填会话串（原 addApiKey 的能力，
 *      因为能力位冲突被挪到了这里，见 api/plugin.ts 的 moduleFor 注释）。
 *
 * 安全：`/router/api/*` 是**同源无鉴权**的（core 的约定），所以任何网页都能
 * 发 GET/POST 过来。查看页面本身无所谓，但「启动进程」「写入凭证」必须防 CSRF ——
 * 用每次进程启动时随机生成的令牌：令牌只出现在页面 HTML 里，跨源读不到，
 * 于是第三方页面无法构造合法请求。
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLIENT_PAGE_PATH } from './api/constants.ts'
import type { LoomySupplier } from './provider.ts'
import type { LoomyClientSnapshot } from './types.ts'

export interface ClientPageDeps {
  /** 取当前供应商实例（核心尚未构造时 undefined）。 */
  supplier: () => LoomySupplier | undefined
  log: (msg: string) => void
}

/** 进程级 CSRF 令牌（重启即换）。 */
const TOKEN = randomBytes(16).toString('hex')

interface Notice {
  kind: 'ok' | 'warn' | 'bad'
  text: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function readBody(req: IncomingMessage, limit = 64 << 10): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        resolve('')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', () => {
      resolve('')
    })
  })
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(html)
}

/** 时间展示：接受 ISO 串或毫秒时间戳。 */
function formatTime(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toLocaleString()
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toLocaleString()
    return value
  }
  return '—'
}

function renderPage(snapshot: LoomyClientSnapshot | undefined, notice: Notice | undefined, error: string): string {
  const banner =
    notice === undefined
      ? ''
      : `<div class="banner banner-${notice.kind}">${escapeHtml(notice.text)}</div>`

  if (snapshot === undefined) {
    return shell(
      `${banner}
      <div class="card">
        <p class="muted">供应商尚未加载：dsh 还没构造 loomy 供应商实例（重启 dsh 后再试）。</p>
      </div>`,
    )
  }

  const runningText =
    snapshot.running === true ? '运行中' : snapshot.running === false ? '未运行' : '未知（尚未探测）'

  const rows = [
    ['客户端程序', snapshot.installed ? `<span class="pill pill-ok">已找到</span>` : `<span class="pill pill-no">未找到</span>`],
    ['可执行文件', snapshot.exe ?? '<span class="muted">—</span>'],
    ['运行状态', escapeHtml(runningText)],
    ['登录态', snapshot.sessionLoaded ? '<span class="pill pill-ok">已加载</span>' : '<span class="pill pill-no">未检测到</span>'],
    ['账号', snapshot.nickname ?? '<span class="muted">—</span>'],
    ['会话串', snapshot.sessionMasked ?? '<span class="muted">—</span>'],
    ['登录时间', formatTime(snapshot.updatedAt)],
    ['登录态文件', snapshot.sessionFile ?? '<span class="muted">—</span>'],
  ]
  const table = rows
    .map(
      ([label, value]) =>
        `<tr><th>${escapeHtml(label ?? '')}</th><td>${value ?? ''}</td></tr>`,
    )
    .join('')

  const exeHint = snapshot.installed
    ? ''
    : `<p class="hint">没找到客户端可执行文件。若它装在非常规位置，可设置环境变量
       <code>LOOMY_CLIENT_EXE</code> 指向完整路径后重启 dsh。</p>`

  return shell(`${banner}
    ${error === '' ? '' : `<div class="banner banner-bad">${escapeHtml(error)}</div>`}
    <div class="card">
      <div class="card-head">
        <h2>状态</h2>
        <div class="actions">
          <a class="btn btn-primary" href="${CLIENT_PAGE_PATH}?action=open&amp;t=${TOKEN}">打开客户端</a>
          <a class="btn" href="${CLIENT_PAGE_PATH}">刷新</a>
        </div>
      </div>
      <table class="kv">${table}</table>
      ${exeHint}
      <p class="hint">「登录态」读的是客户端登录后落盘的
        <code>auth-session.json</code>；在客户端里重新登录后，这里会自动更新（缓存 5 秒）。</p>
    </div>

    <div class="card">
      <h2>手动填入会话串（兜底）</h2>
      <p class="muted">仅在自动识别不可用时使用：从客户端数据目录的
        <code>userData/auth-session.json</code> 里复制 <code>session</code> 字段的值粘贴到这里，
        它会被存成一个独立的连接（不影响自动识别的本机账号）。</p>
      <form method="post" action="${CLIENT_PAGE_PATH}">
        <input type="hidden" name="action" value="session" />
        <input type="hidden" name="t" value="${TOKEN}" />
        <label class="field">名字（可选）<input type="text" name="name" placeholder="如 备用账号" /></label>
        <label class="field">会话串<textarea name="session" rows="3" placeholder="粘贴 session 字段的值"></textarea></label>
        <button class="btn btn-primary" type="submit">保存为账号</button>
      </form>
    </div>`)
}

function shell(body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Loomy 客户端 · dsh-router</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; background: #f6f7f9; color: #1f2430;
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 0; }
  .sub { color: #6b7280; margin: 0 0 20px; font-size: 13px; }
  .sub a { color: #3d5afe; text-decoration: none; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
    padding: 16px 18px; margin-bottom: 16px; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .actions { display: flex; gap: 8px; }
  table.kv { width: 100%; border-collapse: collapse; }
  table.kv th { text-align: left; font-weight: 500; color: #6b7280; width: 112px;
    padding: 6px 12px 6px 0; vertical-align: top; }
  table.kv td { padding: 6px 0; word-break: break-all; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .pill-ok { background: #e7f7ee; color: #12794a; }
  .pill-no { background: #fdeaea; color: #b42318; }
  .muted { color: #6b7280; }
  .hint { color: #6b7280; font-size: 12.5px; margin: 10px 0 0; }
  code { background: #f1f2f5; border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
  .btn { display: inline-block; padding: 6px 14px; border-radius: 8px; border: 1px solid #d6d9e0;
    background: #fff; color: #1f2430; text-decoration: none; font-size: 13px; cursor: pointer; }
  .btn-primary { background: #3d5afe; border-color: #3d5afe; color: #fff; }
  .banner { border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; }
  .banner-ok { background: #e7f7ee; color: #12794a; }
  .banner-warn { background: #fff6e5; color: #8a5a00; }
  .banner-bad { background: #fdeaea; color: #b42318; }
  form { margin-top: 12px; }
  .field { display: block; margin-bottom: 12px; font-size: 13px; color: #4b5563; }
  .field input, .field textarea { display: block; width: 100%; margin-top: 4px; padding: 8px 10px;
    border: 1px solid #d6d9e0; border-radius: 8px; font: inherit; background: #fff; color: inherit; }
  button.btn { font: inherit; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Loomy 客户端</h1>
  <p class="sub">dsh-router · loomy 供应商 &nbsp;·&nbsp; <a href="/">返回面板</a></p>
  ${body}
</div>
</body>
</html>`
}

/** 路由处理器（宿主半注册；见 src/index.ts）。 */
export async function handleClientPage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ClientPageDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? CLIENT_PAGE_PATH, 'http://127.0.0.1')
    let action = url.searchParams.get('action') ?? ''
    let token = url.searchParams.get('t') ?? ''
    let session = ''
    let name = ''

    if (req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req))
      action = body.get('action') ?? action
      token = body.get('t') ?? token
      session = body.get('session') ?? ''
      name = body.get('name') ?? ''
    }

    const supplier = deps.supplier()
    let notice: Notice | undefined
    let error = ''

    // 变更类动作（启动进程 / 写凭证）必须带对令牌
    if (action !== '' && token !== TOKEN) {
      notice = { kind: 'bad', text: '操作令牌不匹配（页面可能已过期，请刷新后重试）' }
    } else if (action === 'open') {
      if (supplier === undefined) {
        notice = { kind: 'warn', text: '供应商尚未加载，无法启动客户端' }
      } else {
        const result = await supplier.openClient()
        notice = result.ok
          ? {
              kind: 'ok',
              text: result.already === true ? '客户端已经在运行' : `已启动客户端：${result.exe ?? ''}`,
            }
          : { kind: 'bad', text: result.error ?? '启动失败' }
      }
    } else if (action === 'session') {
      if (supplier === undefined) {
        notice = { kind: 'warn', text: '供应商尚未加载，无法保存会话串' }
      } else {
        try {
          const account = await supplier.adoptSession({ name, session })
          notice = { kind: 'ok', text: `已保存账号 ${account.nickname}（${account.uid}）` }
        } catch (err) {
          error = (err as Error).message
        }
      }
    }

    let snapshot: LoomyClientSnapshot | undefined
    if (supplier === undefined) {
      deps.log('loomy: 客户端状态页被访问，但供应商实例尚未构造')
    } else {
      snapshot = await supplier.refreshClientSnapshot()
    }
    sendHtml(res, 200, renderPage(snapshot, notice, error))
  } catch (err) {
    // 状态页出错绝不能把异常抛回 web server（那会变成 500 且日志难查）
    deps.log(`loomy: 客户端状态页异常：${(err as Error).message}`)
    try {
      sendHtml(res, 200, shell(`<div class="banner banner-bad">${escapeHtml((err as Error).message)}</div>`))
    } catch {
      // 响应已发出：忽略
    }
  }
}
