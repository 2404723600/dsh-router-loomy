# dsh-router-loomy

把 **Loomy（讯飞 Loomy 办公助手云端通道）** 作为供应商接入 [dsh-router](https://www.npmjs.com/package/dsh-router-core)，
供 dsh 使用的插件。参照 `dsh-router-traework` 的同构范式编写。

- 上游通道对 OpenAI **Chat Completions 完全兼容**（单一端点 `POST {baseUrl}/chat/completions`，SSE 流式）；
- 鉴权为 `Authorization: Bearer <session>`，session 取自 Loomy 客户端
  `userData/auth-session.json` 的 `session` 字段；
- 插件只暴露差异化逻辑（`status` / `listModels` / `chatOnce` / `dispose` / `addApiKey` / `removeLink`），
  选号、冷却、换号、别名、模型启用状态、积分缓存等通用能力全部由 dsh-router 核心统一管理。

## 快速开始

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
  index.ts            插件 host half：把 factory 追加进 cordis `router.suppliers` 聚合表
  supplier.ts         独立入口（default 导出 factory，供目录投放用）
  provider.ts         LoomySupplier：会话/账号、模型目录、chatOnce 编排
  accounts.ts         账号（link）管理与 session 解析
  models.ts           模型目录拉取与内置回退清单
  contract.ts         结构镜像契约（不 import 宿主类型，离线可构建）
  types.ts            内部类型
  api/
    plugin.ts         供应商模块元信息（id/name/priority/icon/apiKeyHint）+ factory
    http.ts           请求构造与状态码 → AccountState 映射
    headers.ts        四个必带追踪头（traceparent / chatid / msgid / loomy-version）+ 会话亲和
    sse.ts            SSE 帧切分 / 错误嗅探 / 迟到失败上报 / 非流式聚合
    errors.ts         错误归一化
    constants.ts      常量（上游版本号、端点、默认模型等）
lib/                  构建产物（index.js / supplier.js / plugin-*.js chunk）
scripts/smoke.mjs     端到端冒烟脚本
docs/loomy-upstream.md 上游契约实测记录（鉴权头、SSE 帧形态、最小请求规格）
cordis.patch.yml      声明本包是 DSH bundle（insert dsh-router-loomy 进插件图）
```

## 装配到 dsh profile

插件通过 profile 的 `package.json` 的 `dsh.profile.bundles` 挂载，与 `dsh-router-traework` 同构。
以 `web` profile（`C:\Users\Administrator\.dsh\profiles\web`）为例：

1. 把插件放进 profile 的 `node_modules`。二选一：
   - **本地目录（开发调试推荐）**：在 profile 目录执行
     ```powershell
     npm install "<本工程绝对路径>"
     ```
   - **手动投放**：在 profile 目录执行
     ```powershell
     cmd /c mklink /J "node_modules\dsh-router-loomy" "<本工程绝对路径>"
     ```
2. 在 profile 的 `package.json` 里注册包与 bundle：
   ```json
   {
     "dependencies": { "dsh-router-loomy": "file:<本工程绝对路径>" },
     "dsh": {
       "profile": {
         "bundles": [
           "dsh-router-loomy"
         ]
       }
     }
   }
   ```
   `dsh-router-traework` 与 `dsh-router-core` 必须在 bundles 中存在；本插件与它们的先后顺序无关
   （核心用 `ctx.inject` 延迟注入，等 `router.suppliers` 就绪后再追加）。
3. 重启 dsh（或重新加载 profile）。启动日志出现
   `[dsh-router-loomy] registered router.suppliers: loomy` 即装配成功。
4. 在 dsh-router 面板的 Loomy 供应商卡片里粘贴登录态会话串（`auth-session.json` 的 `session` 字段）。

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

## 许可

MIT
