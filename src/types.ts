/**
 * Loomy 插件私有类型（上游报文、会话文件、凭证 blob、模型元信息）。
 *
 * 数据来源见 docs/loomy-upstream.md：静态取证 + LLM 调试代理实测抓包。
 */
import type { ModelInfo } from './contract.ts'

/** auth-session.json（Loomy 客户端登录态落盘文件）。 */
export interface LoomySessionFile {
  /** 会话串 —— 即 `/chat/completions` 的 `Authorization: Bearer <session>`。 */
  session: string
  /** Loomy 用户 id（可能不存在）。 */
  userid?: string
  /** 手机号（客户端已脱敏，如 132****3519）。 */
  phone?: string
  /** 其它未知字段原样保留，不做假设。 */
  [key: string]: unknown
}

/** 面板手填 Key 的凭证 blob（存 core CredentialStore）。 */
export interface LoomyKeyAccount {
  name: string
  /** 手填的 Loomy 会话串。 */
  apiKey: string
  createdAt: number
}

/** 上游 `/models` 返回的单个模型（object=model）。 */
export interface UpstreamModel {
  id: string
  object?: string
  name?: string
  /** 'chat' 为对话模型；图生图等其它类型需过滤掉（dsh-router 走 chat 通道）。 */
  type?: string
  /** 上下文窗口，单位 **token**。 */
  context_length?: number
  /** 最大输出，单位 **token**。 */
  max_output_tokens?: number
  reasoning_efforts?: string[]
  default_reasoning_effort?: string
  capabilities?: {
    reasoning?: boolean
    vision?: boolean
    function_calling?: boolean
    input_modalities?: string[]
    output_modalities?: string[]
  }
}

/** 插件内部模型元信息：ModelInfo 的超集（额外字段仅用于面板/推理档位判断）。 */
export interface LoomyModelInfo extends ModelInfo {
  name?: string
  /** 上游 type，'chat' 才进模型列表。 */
  type?: string
  max_output_tokens?: number
  reasoning_efforts?: string[]
  default_reasoning_effort?: string
  vision?: boolean
  function_calling?: boolean
}

/** 模型目录（内存缓存条目）。 */
export interface ModelCatalog {
  models: LoomyModelInfo[]
  /** 来源：上游 /models · 本机 opencode.json · 内置兜底清单。 */
  source: 'upstream' | 'opencode' | 'builtin'
  fetchedAt: number
  /** 上游拉取失败时的原因（面板/日志可读）。 */
  note?: string
}

/** 一次 chatOnce 实际使用的会话凭据。 */
export interface ResolvedSession {
  session: string
  /** 该会话归属的账号 uid（AUTO_UID 或 key-N）。 */
  uid: string
  nickname: string
  source: 'file' | 'key'
  /** file 来源时的文件绝对路径。 */
  file?: string
}
