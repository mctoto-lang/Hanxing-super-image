/**
 * 对话模型配置纯函数库（零副作用，零外部依赖）
 *
 * 接口格式：openai（OpenAI 兼容）/ claude（Anthropic）/ gemini（Google）/
 * grok（xAI，OpenAI 兼容）。
 *
 * 统一思考强度档位（UI 七档：关闭 + 六档滑杆），各适配器映射为自家请求参数：
 * - openai / grok：reasoning_effort（高档位默认封顶 high）
 * - claude：thinking.budget_tokens（2048 → 65536 梯度，钳制 < max_tokens）
 * - gemini：thinkingConfig.thinkingBudget（1024 → 32768，ultracode = -1 动态）
 *
 * 高档位（extra / max / ultracode）参数可被管理员在 chat_api_config.extraConfig
 * .thinkingOverrides 中按模型覆盖（先测试再投产），未配置时用上方内置默认值兜底。
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

/** 思考强度档位（UI 文案：关闭/低/中/高/加强/最大/极限） */
export type ThinkingLevel =
  | "off"
  | "low"
  | "medium"
  | "high"
  | "extra"
  | "max"
  | "ultracode"

export const CHAT_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "extra",
  "max",
  "ultracode",
]

/** 非关闭档位（滑杆六档） */
export type ActiveThinkingLevel = Exclude<ThinkingLevel, "off">

export const CHAT_ACTIVE_THINKING_LEVELS: readonly ActiveThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "extra",
  "max",
  "ultracode",
]

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (CHAT_THINKING_LEVELS as readonly string[]).includes(value)
  )
}

/**
 * 管理员按模型覆盖各档位的实际上游参数（chat_api_config.extraConfig
 * .thinkingOverrides）。openai/grok 格式读 effort（自由字符串，可传
 * "xhigh" 等网关自定义值）；claude/gemini 读 budgetTokens（gemini 允许
 * -1 = 动态思考）。留空的档位回退内置默认映射。
 */
export interface ThinkingLevelOverride {
  effort?: string
  budgetTokens?: number
}

export type ChatThinkingOverrides = Partial<
  Record<ActiveThinkingLevel, ThinkingLevelOverride>
>

/** claude thinking.budget_tokens 档位（需 < max_tokens，适配器内钳制） */
export const CLAUDE_THINKING_BUDGETS: Record<ActiveThinkingLevel, number> = {
  low: 2048,
  medium: 8192,
  high: 32768,
  extra: 40960,
  max: 49152,
  ultracode: 65536,
}

/** gemini thinkingConfig.thinkingBudget 档位（-1 = 动态思考） */
export const GEMINI_THINKING_BUDGETS: Record<ActiveThinkingLevel, number> = {
  low: 1024,
  medium: 8192,
  high: 16384,
  extra: 24576,
  max: 32768,
  ultracode: -1,
}

/**
 * openai / grok reasoning_effort 默认档位。官方 API 仅支持
 * low/medium/high，高档位默认封顶 high（管理员可通过覆盖传自定义值）。
 */
export const OPENAI_REASONING_EFFORTS: Record<ActiveThinkingLevel, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra: "high",
  max: "high",
  ultracode: "high",
}

// ═══════════════ 档位参数解析（默认表 + 管理员覆盖，纯函数） ═══════════════

function readOverride(
  level: ThinkingLevel,
  overrides?: ChatThinkingOverrides | null,
): ThinkingLevelOverride | null {
  if (level === "off" || !overrides) return null
  const o = overrides[level]
  return o && typeof o === "object" ? o : null
}

/**
 * 解析 openai / grok 的 reasoning_effort。
 * 返回 null 表示不发送该字段（off 或无有效值）。
 */
export function resolveReasoningEffort(
  level: ThinkingLevel,
  overrides?: ChatThinkingOverrides | null,
): string | null {
  const o = readOverride(level, overrides)
  if (o && typeof o.effort === "string" && o.effort.trim()) {
    return o.effort.trim()
  }
  if (level === "off") return null
  return OPENAI_REASONING_EFFORTS[level]
}

/** 解析 claude 的 thinking.budget_tokens；off 返回 null（不开启思考）。 */
export function resolveClaudeThinkingBudget(
  level: ThinkingLevel,
  overrides?: ChatThinkingOverrides | null,
): number | null {
  const o = readOverride(level, overrides)
  if (o && typeof o.budgetTokens === "number" && Number.isFinite(o.budgetTokens)) {
    return Math.max(0, Math.floor(o.budgetTokens))
  }
  if (level === "off") return null
  return CLAUDE_THINKING_BUDGETS[level]
}

/** 解析 gemini 的 thinkingConfig.thinkingBudget；off 返回 null。 */
export function resolveGeminiThinkingBudget(
  level: ThinkingLevel,
  overrides?: ChatThinkingOverrides | null,
): number | null {
  const o = readOverride(level, overrides)
  if (o && typeof o.budgetTokens === "number" && Number.isFinite(o.budgetTokens)) {
    return Math.floor(o.budgetTokens) // 允许 -1（动态思考）
  }
  if (level === "off") return null
  return GEMINI_THINKING_BUDGETS[level]
}

/**
 * 多模态 content part（OpenAI 格式；claude/gemini 适配器各自转换）。
 * 与 workspace-ai.ts 的 ChatContentPart 同构。
 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

/** 历史消息（发往上游前的统一中间形态；图片消息 content 为 part 数组） */
export interface ChatUpstreamMessage {
  role: "user" | "assistant"
  content: string | ChatContentPart[]
}

/** content 归一化为 part 数组（空字符串 → 空数组） */
export function toContentParts(
  content: string | ChatContentPart[],
): ChatContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  return content
}

/** content 中的纯文本（token 估算/预算检查用） */
export function contentToText(content: string | ChatContentPart[]): string {
  if (typeof content === "string") return content
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

/** 单张图片的 token 估算（计费兜底与上下文预算的保守近似值） */
export const IMAGE_TOKEN_ESTIMATE = 1000

/** 消息级 token 估算（文本字符启发式 + 图片按张数近似） */
export function estimateMessageTokens(
  message: Pick<ChatUpstreamMessage, "content">,
): number {
  let tokens = estimateTokens(contentToText(message.content))
  if (typeof message.content !== "string") {
    const images = message.content.filter((p) => p.type === "image_url").length
    tokens += images * IMAGE_TOKEN_ESTIMATE
  }
  return tokens
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
  /** 管理员按模型覆盖的档位参数（extraConfig.thinkingOverrides） */
  thinkingOverrides?: ChatThinkingOverrides | null
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
 * 含图片的 content 以 part 数组合并；合并后无图片则折叠回纯文本，
 * 保持纯文本链路的请求体形态不变。
 */
export function mergeConsecutiveMessages(
  messages: ChatUpstreamMessage[],
): ChatUpstreamMessage[] {
  const merged: ChatUpstreamMessage[] = []
  for (const msg of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      last.content = mergeMessageContent(last.content, msg.content)
    } else {
      merged.push({ ...msg })
    }
  }
  return merged
}

function mergeMessageContent(
  a: string | ChatContentPart[],
  b: string | ChatContentPart[],
): string | ChatContentPart[] {
  if (typeof a === "string" && typeof b === "string") {
    return a ? a + "\n\n" + b : b
  }
  const parts = [...toContentParts(a), ...toContentParts(b)]
  if (parts.some((p) => p.type === "image_url")) return parts
  return parts.map((p) => (p as { text: string }).text).join("\n\n")
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
