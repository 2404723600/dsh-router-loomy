/**
 * Loomy 供应商常量。
 *
 * 上游事实来源（全部为实测/取证结果，非猜测）：
 *   - 端点与鉴权：D:\loomy\ 静态分析 + LLM 调试代理实测（docs/loomy-upstream.md）
 *   - 模型清单：本机 C:\Users\Public\Loomy\<安装ID>\opencode\opencode.json 的
 *     provider.imodel.models（12 个），并在 /models 实测中复核
 */
import type { LoomyModelInfo } from '../types.ts'

/** 供应商 id / 名称（dsh-router 内部标识，模型全名 = <alias>/<modelId>）。 */
export const SUPPLIER_ID = 'loomy'
export const SUPPLIER_NAME = 'Loomy'

/**
 * 路由优先级：数值越小越优先。
 * 参照值：opencode（完全免费直连）= 0，nvidia（第三方 key）= 20。
 * Loomy 走本机客户端登录态、对话会消耗账号积分（上游按 points_consumed 计费），
 * 故排在完全免费通道之后；比 nvidia 靠前，因其是本机已装客户端的自有通道。
 */
export const PRIORITY = 10

/** 上游 OpenAI 兼容端点（opencode.json provider.imodel.options.baseURL）。 */
export const DEFAULT_BASE_URL = 'https://loomyad.xunfei.cn/api/v1'

/** 追踪头 loomy-version 的取值（对应 Loomy 客户端版本）。 */
export const DEFAULT_LOOMY_VERSION = '0.9.36'

/** 对话请求超时：与客户端 opencode.json options.timeout 一致（20 分钟）。 */
export const DEFAULT_TIMEOUT_MS = 1_200_000

/** /models 拉取超时（轻量调用，短超时避免拖慢面板）。 */
export const DEFAULT_MODELS_TIMEOUT_MS = 20_000

/** 上游模型目录内存缓存 TTL。 */
export const DEFAULT_MODELS_TTL_MS = 600_000

/**
 * 登录态文件重新读取间隔。
 * 客户端重新登录会重写 auth-session.json；5s 的窗口既能及时跟上换号，
 * 又不至于让面板轮询把磁盘读热。
 */
export const DEFAULT_SESSION_TTL_MS = 5_000

/** 本机登录态账号的固定 uid（非面板添加，不可删除）。 */
export const AUTO_UID = 'local-session'

/** 面板手填 Key 的 uid 前缀（uid 形如 key-1、key-2）。 */
export const KEY_UID_PREFIX = 'key-'

/** Loomy 客户端公共数据根目录（含 <安装ID>/userData、<安装ID>/opencode）。 */
export const DEFAULT_PUBLIC_DIR = 'C:\\Users\\Public\\Loomy'

/** 登录态文件名。 */
export const AUTH_SESSION_FILE = 'auth-session.json'

/** OpenCode 配置文件名（模型清单兜底来源）。 */
export const OPENCODE_CONFIG_FILE = 'opencode.json'

/** 上游能力的默认请求 UA（与客户端 opencode 运行时的 UA 不同，此处用自标识）。 */
export const USER_AGENT = 'dsh-router-loomy/0.1.0'

/**
 * 内置兜底模型清单 —— 摘自本机 opencode.json（provider.imodel.models）。
 *
 * context_length 由 token 换算为 **K**（core 约定，见 core router/types.ts 注释）；
 * type='image' 的模型输出为图片（图生图/文生图），dsh-router 走 chat 通道，
 * 会在 listModels 阶段过滤掉。
 */
export const BUILTIN_MODELS: LoomyModelInfo[] = [
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731（x3.0）', type: 'chat', context_length: 1049, max_output_tokens: 384000, function_calling: true },
  { id: 'MiniMax-M3', name: 'MiniMax M3 （x4.0）', type: 'chat', context_length: 1049, max_output_tokens: 512000, vision: true, function_calling: true },
  { id: 'Kimi-k2.6', name: 'Kimi k2.6 （x6.5）', type: 'chat', context_length: 262, max_output_tokens: 65536, vision: true, function_calling: true },
  { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max (x12.0)', type: 'chat', context_length: 1000, max_output_tokens: 65536, function_calling: true },
  { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash(x0.8)', type: 'chat', context_length: 1049, max_output_tokens: 131072, vision: true, function_calling: true },
  { id: 'qwen3.8-flash', name: 'qwen 3.8 flash（x0.8）', type: 'chat', context_length: 1000, max_output_tokens: 131072, vision: true, function_calling: true },
  { id: 'spark-x', name: 'Spark X2.5（x3.2）', type: 'chat', context_length: 262, max_output_tokens: 65536, function_calling: true },
  { id: 'doubao-seed-2.0-mini', name: 'Doubao Seed 2.0 mini（x0.8）', type: 'chat', context_length: 262, max_output_tokens: 131072, vision: true, function_calling: true },
  { id: 'mimo-v2.5', name: 'MiMo V2.5（x3.3）', type: 'chat', context_length: 1049, max_output_tokens: 131072, vision: true, function_calling: true },
  { id: 'qwen3.5-flash', name: 'Qwen3.5 Flash（x1.0）', type: 'chat', context_length: 1000, max_output_tokens: 65536, vision: true, function_calling: true },
  { id: 'doubao-seedream-5-lite', name: 'doubao-seedream-5-lite', type: 'image', context_length: 128, max_output_tokens: 131072 },
  { id: 'qwen-image-3.0-pro', name: 'qwen-image-3.0-pro', type: 'image' },
]
