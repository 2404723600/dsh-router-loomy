# dsh-router-loomy

[![npm version](https://img.shields.io/npm/v/dsh-router-loomy.svg)](https://www.npmjs.com/package/dsh-router-loomy)
[![npm downloads](https://img.shields.io/npm/dm/dsh-router-loomy.svg)](https://www.npmjs.com/package/dsh-router-loomy)
[![license](https://img.shields.io/npm/l/dsh-router-loomy.svg)](./LICENSE)

把 **Loomy（讯飞 Loomy 办公助手云端通道）** 作为供应商接入 [dsh-router](https://www.npmjs.com/package/dsh-router-core)，
供 dsh 使用的插件。参照 `dsh-router-traework` 的同构范式编写。

- 上游通道对 OpenAI **Chat Completions 完全兼容**（单一端点 `POST {baseUrl}/chat/completions`，SSE 流式）；
- 鉴权为 `Authorization: Bearer <session>`，session **自动取自本机 Loomy 客户端**登录后落盘的
  `userData/auth-session.json`，无需手动粘贴；
- 插件只暴露差异化逻辑（`status` / `listModels` / `chatOnce` / `dispose` /
  `generateLoginUrl` / `pollLogin` / `completeLogin` / `removeLink`），
  选号、冷却、换号、别名、模型启用状态、积分缓存等通用能力全部由 dsh-router 核心统一管理。

## 安装

```powershell
npm install dsh-router-loomy
```

`@deepseek-ai/cordis` 与 `cordis` 是 peerDependencies，由 dsh 宿主注入，无需手动安装。
装好后按 [装配到 dsh profile](#装配到-dsh-profile) 把本包注册进 bundle。

## 快速开始（本地开发）

在克隆后的仓库里：

```powershell
# 1) 安装依赖（peerDependencies 由 dsh 宿主注入，本工程不落地）
npm install

# 2) 干净构建：先删 lib/ 再 tsdown 打包
npm run build

# 3) 类型检查 + 单元测试
npm run typecheck
npm test

# 4) 端到端冒烟（真实调用上游：listModels + 最小 chatOnce，含一次非流式与一次流式）
npm run smoke
```

## 目录结构

```
src/
  index.ts            插件 host half：追加 router.suppliers 工厂 + 注册客户端状态页路由
  supplier.ts         独立入口（default 导出 factory，供目录投放用）
  provider.ts         LoomySupplier：会话/账号、模型目录、chatOnce 编排、打开客户端
  accounts.ts         账号（link）管理与 session 解析
  client-app.ts       客户端可执行文件定位 / 启动 / 运行探测
  client-page.ts      「Loomy 客户端」状态页（自带 CSRF 令牌）
  models.ts           模型目录拉取与内置回退清单
  contract.ts         结构镜像契约（不 import 宿主类型，离线可构建）
  types.ts            内部类型
  api/
    plugin.ts         供应商模块元信息（id/name/priority/icon/apiKeyHint）+ factory + 能力面
    http.ts           请求构造与状态码 → AccountState 映射
    headers.ts        四个必带追踪头（traceparent / chatid / msgid / loomy-version）+ 会话亲和
    sse.ts            SSE 帧切分 / 错误嗅探 / 迟到失败上报 / 收尾完整性守卫 / 非流式聚合
    errors.ts         错误归一化
    constants.ts      常量（上游版本号、端点、默认模型、客户端定位等）
lib/                  构建产物（index.js / supplier.js / plugin-*.js chunk）
scripts/smoke.mjs     端到端冒烟脚本
docs/loomy-upstream.md 上游契约实测记录（鉴权头、SSE 帧形态、最小请求规格）
cordis.patch.yml      声明本包是 DSH bundle（insert dsh-router-loomy 进插件图）
```

## 打开客户端 / 自动获取登录态

Loomy 的凭证**不在网页里**，而在本机客户端登录后落盘的
`<publicDir>/<安装ID>/userData/auth-session.json`。所以本插件的「登录」= 启动客户端 +
等它写文件，而不是让你去浏览器复制回调链接或粘贴会话串。

面板上的操作路径：

1. 在 dsh-router 面板的 Loomy 卡片点 **「添加链接」** → 插件立即启动本机 Loomy 客户端，
   并给出一个指向「客户端状态页」的链接；
2. 在弹出的客户端窗口里登录；
3. 回到面板点 **「完成添加」** → 插件读取 `auth-session.json` 并登记账号，完成。

平时（客户端已登录过）**不需要任何操作**：插件每次读状态时都会自动扫描登录态文件，
面板上会直接出现账号 `本机客户端 · 132****3519`，状态列还会带出「客户端运行中 / 未运行」。

### 客户端状态页

`http://127.0.0.1:<面板端口>/router/api/loomy/client`

显示客户端可执行文件路径、是否在运行、登录态是否已加载、脱敏会话串与登录时间，
并提供「打开客户端」按钮。自动识别不可用时（客户端装在探测不到的位置），
也可以在这个页面手动填入会话串作为兜底。

> 该页面由 host half 注册，需要 `webServer` 服务（正常 dsh 环境都有）。
> 变更类操作带进程级 CSRF 令牌，第三方网页无法构造合法请求。

### 客户端定位

安装位置由安装器决定，注册表里既没有 App Paths 也没有卸载项（实测），
所以按优先级逐个探测：`LOOMY_CLIENT_EXE` 环境变量 → `%LOCALAPPDATA%` →
`%APPDATA%` → 公共目录 → 逐个盘符的 `\loomy`、`\Program Files\Loomy` 等布局。

探测不到时，用环境变量指定完整路径后重启 dsh：

```powershell
$env:LOOMY_CLIENT_EXE = "D:\loomy\Loomy.exe"
```

## 装配到 dsh profile

插件通过 profile 的 `package.json` 的 `dsh.profile.bundles` 挂载，与 `dsh-router-traework` 同构。
以 `web` profile（`C:\Users\Administrator\.dsh\profiles\web`）为例：

1. 在 profile 目录安装本插件，二选一：
   - **从 npm 安装（推荐）**
     ```powershell
     npm install dsh-router-loomy
     ```
   - **本地目录（开发调试）**
     ```powershell
     npm install "<本工程绝对路径>"
     ```
     或直接投放软链：
     ```powershell
     cmd /c mklink /J "node_modules\dsh-router-loomy" "<本工程绝对路径>"
     ```
2. 在 profile 的 `package.json` 里注册包与 bundle：
   ```json
   {
     "dependencies": { "dsh-router-loomy": "^0.2.0" },
     "dsh": {
       "profile": {
         "bundles": [
           "dsh-router-loomy"
         ]
       }
     }
   }
   ```
   本地开发时依赖可写成 `"file:<本工程绝对路径>"`。
   `dsh-router-traework` 与 `dsh-router-core` 必须在 bundles 中存在；本插件与它们的先后顺序无关
   （核心用 `ctx.inject` 延迟注入，等 `router.suppliers` 就绪后再追加）。
3. 重启 dsh（或重新加载 profile）。启动日志出现
   `[dsh-router-loomy] registered router.suppliers: loomy` 即装配成功。
4. 到面板的 Loomy 卡片点「添加链接」，按 [打开客户端 / 自动获取登录态](#打开客户端--自动获取登录态)
   的流程走一遍即可 —— 客户端已登录过的话，这一步会自动完成。

## 上游契约

详见 [docs/loomy-upstream.md](docs/loomy-upstream.md)。要点：

| 项 | 取值 |
| --- | --- |
| 端点 | `POST https://loomyad.xunfei.cn/api/v1/chat/completions` |
| 鉴权 | `Authorization: Bearer <session>` |
| 必带头 | `traceparent`（缺失会挂死）、`chatid`、`msgid`、`loomy-version`、`invokeorigin` |
| 可选头 | `x-session-affinity`（会话亲和）；子调用可带 `x-parent-session-id` |
| 响应 | `200` + `text/event-stream`，`data: chat.completion.chunk` 帧 + `data: [DONE]` |
| 末帧 usage | `{prompt_tokens, completion_tokens, total_tokens, ..., points_consumed}`（`points_consumed` 为平台积分字段） |
| 注意 | 响应帧内 `model` 可能与请求不一致（网关改写），解析以帧内为准 |

### 上游会「静默截断」，插件做收尾校验

实测（2026-10-16）：上游**会在生成没结束时就发 `data: [DONE]`，只是不给
`finish_reason`**；有时甚至只吐 `reasoning_content`、正文一个字都没有。

这件事在别处是发现不了的：`[DONE]` 到了，流就算「正常结束」，而 dsh-router 核心
在 `[DONE]` 处若没见到 `finish_reason` 就默认按 `stop` 收尾，于是**截断被当成
正常完成** —— 表现出来就是「助手说接下来要做 X，然后什么都没做，本轮就结束了」，
而且不报任何错。

所以插件在流式路径上加了一道收尾校验（`guardUpstreamStream`）：

| 收尾形态 | 判定 | 处置 |
| --- | --- | --- |
| 有 `finish_reason`、有正文或工具调用 | `ok` | 原样放行（**字节级零改动**） |
| 没有 `finish_reason`，且 `completion_tokens < max_tokens` | `truncated` | **扣住 `[DONE]`**，核心按 `TRANSPORT` 报错 → dsh 自动重试 |
| 没有 `finish_reason`，但 `completion_tokens >= max_tokens` | `capped` | 补一帧 `finish_reason:"length"` 放行（重试也没用） |
| 有 `finish_reason`，但只有推理、没有正文也没有工具调用 | `truncated` | 同 `truncated` |

⚠️ **重试会重发整段上下文**（实测动辄 10 万 prompt token，按积分计费），所以同一
(账号, 模型) **连续截断 2 次后就不再逼重试**，改为补 `length` 标记放行 —— 至少界面
能看出「被长度截断」，而不是无限烧积分。任一正常收尾都会清零该计数。

## 发布（维护者）

`prepack` 会自动触发构建，直接发布即可。注意两点：

- 本机默认 registry 若被设为镜像站（如 npmmirror），需显式指定官方源；
- 账号开启 2FA 时，需使用带 **2FA 豁免**（bypass 2FA）且具备 **Read and write** 权限的
  Granular Access Token，否则 `npm publish` 会返回 `E403`。

```powershell
npm publish --registry https://registry.npmjs.org/
```

## 从 0.1.x 升级

0.2.0 起**不再暴露 `addApiKey` 能力**，面板的「添加链接」从「粘贴会话串」改为
「打开客户端登录」。

原因是 dsh-router 核心前端有短路：`canApiKey = hasCap('addApiKey')`，
而 `startLogin()` 一旦发现该能力为真就直接弹「填名字 + API Key」表单并返回，
`generateLoginUrl` 分支永远不会执行 —— 也就是说，只要暴露 `addApiKey`，
「打开客户端登录」这条路在 UI 上就是死的。手填会话串的兜底因此挪到了
[客户端状态页](#客户端状态页)。

已添加的 `key-N` 账号不受影响，仍可正常使用与删除。

另外 0.2.0 起对流式响应做**收尾校验**：上游截断（发了 `[DONE]` 却不给
`finish_reason`）时不再静默当成正常完成，而是触发一次自动重试，详见
[上游会「静默截断」](#上游会静默截断插件做收尾校验)。

## 许可

MIT
