# Loomy 上游通道契约（实测记录）

本文件记录 `dsh-router-loomy` 实现所依据的上游契约。取证方式：**只读**——用 Loomy 客户端
内置的 LLM 调试反向代理（启动前设 `LOOMY_LLM_DEBUG_PROXY=1`、
`LOOMY_LLM_DEBUG_PROXY_LOG=<路径>`、`LOOMY_LLM_DEBUG_PROXY_LOG_SECRETS=1`）导出真实
请求/响应，无需注入证书、不改动客户端源码。**注意：本文件不记录任何真实凭据。**

## 1. 端点与鉴权

| 项 | 取值 |
| --- | --- |
| method | `POST` |
| URL | `https://loomyad.xunfei.cn/api/v1/chat/completions` |
| 鉴权 | `authorization: Bearer <session>`（session 来自 `userData/auth-session.json`） |
| content-type | `application/json` |
| user-agent | `opencode/1.14.22 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13` |

实测 3 组请求全部命中同一端点，未出现 `/models`、`/messages`、`/images/generations` 等其它端点；
LLM 端点只用 `Authorization`，不含 `token:` 头（平台其它接口才用 `token` 头）。

## 2. 必带追踪头

| 头 | 形态 | 说明 |
| --- | --- | --- |
| `traceparent` | `00-<32hex>-<16hex>-01` | **缺失会导致上游连接挂死**，必须自带 |
| `chatid` | `chat-<uuid>` | 会话标识，同一会话的多条请求相同 |
| `msgid` | `msg-<uuid>` | 消息标识；同一条助手消息的请求/收尾复用同一值 |
| `loomy-version` | `0.9.36` | 客户端版本号 |
| `invokeorigin` | `user` / `system` | 用户主动调用填 `user`，后台子调用（记忆提取/标题生成）填 `system` |
| `x-session-affinity` | `ses_<21 位 base62>` | 可选，会话亲和，每次调用可不同 |
| `x-parent-session-id` | `ses_<...>` | 仅子调用出现，指向父会话 |

插件侧实现见 `src/api/headers.ts`（`buildTracingHeaders`），单测覆盖形态与可复用性。

## 3. 请求体

顶层键：`model`、`max_tokens`、`messages`、`tools`、`tool_choice`、`stream`、`stream_options`。

```json
{
  "model": "deepseek-v4-flash-0731",
  "max_tokens": 32000,
  "messages": [
    { "role": "system", "content": "……" },
    { "role": "user", "content": [{ "type": "text", "text": "……" }] }
  ],
  "tools": [{ "type": "function", "function": { "name": "bash", "description": "……", "parameters": {} } }],
  "tool_choice": "auto",
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

- `messages[].content` 允许**字符串**或 **parts 数组**（`[{type:"text", text}]`）两种形态；
- `tools` 为 OpenAI 标准 `function` 数组；`tool_choice` 实测为 `auto`；
- 流式需 `stream: true`，并要求 `stream_options.include_usage: true` 才会在末帧返回 `usage`。

## 4. 响应

状态码 `200`，响应头 `content-type: text/event-stream`（`server: xunfei`，`transfer-encoding: chunked`）。

帧形态为**纯 SSE**：无 `event:` / `id:` 行、无心跳注释，帧以空行分隔。

```
data: {"id":"<uuid>","object":"chat.completion.chunk","created":<ts>,"model":"<model>","choices":[{"index":0,"delta":{...},"finish_reason":null}]}

...（N 帧）

data: {...,"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}],"usage":{...}}

data: [DONE]
```

- `delta` 键形态：`{role, reasoning_content}`（思维链）、`{role, content}`（正文）、`{role}`（收尾帧）；
- 末帧 `usage` 结构：
  `{prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details:{cached_tokens}, completion_tokens_details:{reasoning_tokens}, points_consumed}`；
  **`points_consumed` 是 Loomy 平台积分字段，非 OpenAI 标准**；
- `tools` 被真实触发时预期出现 `tool_calls` 帧（`finish_reason: "tool_calls"`），插件已按 index 合并分片；
- **响应帧内 `model` 可能与请求体不一致**（实测请求 `deepseek-v4-flash-0731`、某些子调用响应回 `qwen3.5-flash`，
  疑似网关按小模型路由/改写）。插件解析以帧内 `model` 为准，不做一致性校验。

## 5. 最小可复现请求

```powershell
$s = "<auth-session.json 的 session>"
curl.exe -N -X POST "https://loomyad.xunfei.cn/api/v1/chat/completions" `
  -H "Content-Type: application/json" -H "Authorization: Bearer $s" `
  -H "loomy-version: 0.9.36" `
  -H "chatid: chat-00000000-0000-0000-0000-000000000000" `
  -H "msgid: msg-00000000-0000-0000-0000-000000000000" `
  -H "invokeorigin: user" `
  -H "traceparent: 00-00000000000000000000000000000001-0000000000000001-01" `
  -d '{\"model\":\"deepseek-v4-flash-0731\",\"max_tokens\":32000,\"messages\":[{\"role\":\"user\",\"content\":\"测试\"}],\"stream\":true,\"stream_options\":{\"include_usage\":true}}'
```

非流式：`"stream": false` 并去掉 `stream_options`，响应退化为单个标准 `chat.completion` 对象。
（上游是否强依赖 `stream: true` 尚未逐一实测；插件对「请求非流式但网关仍回 SSE」的情况已做聚合兜底，
见 `src/api/sse.ts` 的 `aggregateSseToCompletion`。）

## 6. 未实测项（遗留）

- `@ai-sdk/anthropic` 路线（预期走 `/messages`）—— 本插件未使用；
- `tools` 真实触发时的 `tool_calls` 帧（仅有单测夹具覆盖）；
- 上游是否强依赖流式。
