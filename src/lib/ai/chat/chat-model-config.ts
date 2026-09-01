/**
 * 对话模型配置纯函数库（零副作用，零外部依赖）
 *
 * 接口格式：openai（OpenAI 兼容）/ claude（Anthropic）/ gemini（Google）/
 * grok（xAI，OpenAI 兼容）。
 *
 * 统一思考强度档位（UI 四档），各适配器映射为自家请求参数：
 * - openai / grok：reasoning_effort: low | medium | high
 * - claude：thinking.budget_tokens（2048 / 8192 / 32768，钳制 < max_tokens）
 * - gemini：thinkingConfig.thinkingBudget（1024 / 8192 / 24576）
 */

/** 对话接口格式（chat_api_config.format_type） */
export type ChatApiFormat = "openai" | "claude" | "gemini" | "grok"

export const CHAT_API_FORMATS: readonly ChatApiFormat[] = [
  "openai",
  "claude",
  "gemini",
  "grok",
]

/** 各格式的端点示例（管理端表单提示用） */
export const CHAT_FORMAT_ENDPOINT_EXAMPLES: Record<ChatApiFormat, string> = {
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  grok: "https://api.x.ai/v1",
}

/** 思考强度档位（UI 文案：关闭/低/中/高） */
export type ThinkingLevel = "off" | "low" | "medium" | "high"

export const CHAT_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
]

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (CHAT_THINKING_LEVELS as readonly string[]).includes(value)
  )
}

/** claude thinking.budget_tokens 档位（需 < max_tokens，适配器内钳制） */
export const CLAUDE_THINKING_BUDGETS: Record<
  Exclude<ThinkingLevel, "off">,
  number
> = { low: 2048, medium: 8192, high: 32768 }

/** gemini thinkingConfig.thinkingBudget 档位 */
export const GEMINI_THINKING_BUDGETS: Record<
  Exclude<ThinkingLevel, "off">,
  number
> = { low: 1024, medium: 8192, high: 24576 }

/** openai / grok reasoning_effort 档位（与统一档位同名直传） */
export const OPENAI_REASONING_EFFORTS: Record<
  Exclude<ThinkingLevel, "off">,
  "low" | "medium" | "high"
> = { low: "low", medium: "medium", high: "high" }

/** 历史消息（发往上游前的统一中间形态） */
export interface ChatUpstreamMessage {
  role: "user" | "assistant"
  content: string
}

/**
 * 统一流式事件（四种格式归一化后的输出）。
 *
 * - text_delta / thinking_delta：增量内容（正文 / 思考过程）
 * - usage：上游报告的真实 token 用量（可多次上报，取最大值合并）
 * - done：正常结束（finishReason 为上游停止原因）
 * - error：流中错误（终止迭代）
 */
export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "done"; finishReason?: string }
  | { type: "error"; message: string }

/** 适配器入参（模型行中与请求相关的字段 + 会话内容） */
export interface StreamChatAdapterOptions {
  apiKey: string
  /** 模型标识（请求体 model / URL path 参数） */
  modelName: string
  apiEndpoint: string
  /** 秒；控制整个流式请求的硬超时 */
  apiTimeout: number
  /** 单次最大输出（模型硬上限，请求 max_tokens 钳制基准） */
  maxOutputTokens: number
  supportsThinking: boolean
  temperature?: number | null
  messages: ChatUpstreamMessage[]
  systemPrompt?: string | null
  thinkingLevel: ThinkingLevel
  signal?: AbortSignal
}

// ═══════════════ 端点归一化（容错各类配置后缀，与生图 resolve* 同构） ═══════════════

/** openai / grok：{base}/v1/chat/completions */
export function resolveOpenAiChatEndpoint(endpoint: string): string {
  const url = endpoint.replace(/\/+$/, "")
  if (url.includes("/chat/completions")) return url
  if (url.endsWith("/v1")) return url + "/chat/completions"
  return url + "/v1/chat/completions"
}

/** claude：{base}/v1/messages */
export function resolveClaudeEndpoint(endpoint: string): string {
  const url = endpoint.replace(/\/+$/, "")
  if (url.endsWith("/messages")) return url
  if (url.endsWith("/v1")) return url + "/messages"
  return url + "/v1/messages"
}

/** gemini：{base}/v1beta/models/{model}:streamGenerateContent?alt=sse */
export function resolveGeminiStreamEndpoint(
  endpoint: string,
  modelName: string,
): string {
  let base = endpoint.replace(/\/+$/, "")
  if (base.includes(":streamGenerateContent") || base.includes(":generateContent")) {
    // 已是完整方法 URL：直接复用（stream 场景强制 alt=sse）
    const url = new URL(base)
    url.searchParams.set("alt", "sse")
    return url.toString()
  }
  if (base.endsWith("/v1beta") || base.endsWith("/v1")) {
    // 保持原版本段
  } else {
    base += "/v1beta"
  }
  return `${base}/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse`
}

// ═══════════════ 消息预处理 ═══════════════

/**
 * 合并连续同角色消息（claude 要求严格 user/assistant 交替；
 * 对话历史中失败/停止的 assistant 消息会产生连续同角色段）。
 */
export function mergeConsecutiveMessages(
  messages: ChatUpstreamMessage[],
): ChatUpstreamMessage[] {
  const merged: ChatUpstreamMessage[] = []
  for (const msg of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      last.content = last.content ? last.content + "\n\n" + msg.content : msg.content
    } else {
      merged.push({ ...msg })
    }
  }
  return merged
}

// ═══════════════ token 估算（usage 缺失时的计费兜底） ═══════════════

/**
 * 字符级 token 估算（中英混合启发式）。
 *
 * 仅在上游不返回 usage 时用于计费兜底——宁可略高不漏账：
 * CJK 按 0.8 token/字、拉丁按 1 token / 3.5 字符。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/.test(ch)) {
      cjk++
    } else {
      other++
    }
  }
  return Math.ceil(cjk * 0.8 + other / 3.5)
}

// ═══════════════ 计费（厘 = 0.01 积分） ═══════════════

/**
 * 计算单条消息成本（单位：厘 = 0.01 积分）。
 *
 * cost = ceil( (输入tokens × 输入价 + 输出tokens × 输出价) / 1e6 )
 * 价格单位为「厘/百万 tokens」；全整数运算（先乘后除）避免浮点误差；
 * 原始成本 > 0 时向上取整且最小 1 厘（用户设定的最小计费单位 0.01 积分）。
 */
export function calcMessageCostCenticredits(input: {
  inputTokens: number
  outputTokens: number
  /** 百万输入 token 价格（厘） */
  inputPriceCenticredits: number
  /** 百万输出 token 价格（厘） */
  outputPriceCenticredits: number
}): number {
  const {
    inputTokens,
    outputTokens,
    inputPriceCenticredits,
    outputPriceCenticredits,
  } = input
  const total =
    Math.max(0, Math.trunc(inputTokens)) * Math.max(0, inputPriceCenticredits) +
    Math.max(0, Math.trunc(outputTokens)) * Math.max(0, outputPriceCenticredits)
  if (total <= 0) return 0
  return Math.max(1, Math.ceil(total / 1_000_000))
}

/** 厘 → 积分显示文案（如 3 → "0.03"） */
export function formatCenticredits(centicredits: number): string {
  return (centicredits / 100).toFixed(2)
}

/** 厘/百万价格 → 积分显示文案（如 250 → "2.50"） */
export function formatPricePerMillion(centicredits: number): string {
  return (centicredits / 100).toFixed(2)
}

// ═══════════════ 错误提取 ═══════════════

/**
 * 从错误响应体提取可读信息。
 * 兼容：{error:{message}}（openai/gemini/xai）、{error:{msg}}（网关变体）、
 * {message}（部分代理）、{error:"字符串"}。
 */
export function extractChatErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const obj = data as Record<string, unknown>
  const err = obj.error
  if (typeof err === "string" && err) return err
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>
    for (const key of ["message", "msg"]) {
      if (typeof e[key] === "string" && e[key]) return e[key] as string
    }
  }
  if (typeof obj.message === "string" && obj.message) return obj.message
  return null
}
