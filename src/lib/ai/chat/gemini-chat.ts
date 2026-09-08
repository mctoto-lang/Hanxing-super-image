/**
 * Gemini（Google Generative Language API）对话流式适配器
 *
 * POST {apiEndpoint}/v1beta/models/{model}:streamGenerateContent?alt=sse，
 * x-goog-api-key 头鉴权（key 不进 URL，避免落网关访问日志）。
 *
 * - 历史消息映射：assistant → role:"model"；parts:[{text}]；
 * - systemInstruction 独立字段；generationConfig.maxOutputTokens 控制上限；
 * - 思考：generationConfig.thinkingConfig.thinkingBudget（六档梯度
 *   1024 → 32768，ultracode = -1 动态思考；可被管理员 thinkingOverrides
 *   覆盖；off 不发送字段，模型默认行为）；
 * - 流式数据块：candidates[0].content.parts[].text（含 thought:true 的
 *   思考摘要 part，归一化为 thinking_delta）；
 * - usage：usageMetadata.promptTokenCount / candidatesTokenCount。
 */
import {
  extractChatErrorMessage,
  mergeConsecutiveMessages,
  resolveGeminiStreamEndpoint,
  resolveGeminiThinkingBudget,
  toContentParts,
  type ChatContentPart,
  type ChatStreamEvent,
  type StreamChatAdapterOptions,
} from "@/lib/ai/chat/chat-model-config"
import { readSseStream } from "@/lib/ai/chat/sse"
import { createChatAbortSignal } from "@/lib/ai/chat/openai-chat"

interface GeminiPart {
  text?: string
  thought?: boolean
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
  }
  error?: { code?: number; message?: string; status?: string }
}

/** Gemini inlineData 图片（Gemini 不支持公网 URL source，须服务端取图转 base64 内联） */
export interface GeminiInlineData {
  mimeType: string
  data: string
}

function toGeminiParts(
  content: string | ChatContentPart[],
  inlineImages?: Map<string, GeminiInlineData>,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  for (const p of toContentParts(content)) {
    if (p.type === "text") {
      if (p.text) parts.push({ text: p.text })
    } else {
      const inline = inlineImages?.get(p.image_url.url)
      // 取图/转换失败的图片跳过（文本部分仍发送）
      if (inline) parts.push({ inlineData: inline })
    }
  }
  if (parts.length === 0) parts.push({ text: "" })
  return parts
}

/** 构建 Gemini 请求体（纯函数，单测直接覆盖；图片 part 依赖预转换的 inlineImages 映射） */
export function buildGeminiRequestBody(
  opts: StreamChatAdapterOptions,
  inlineImages?: Map<string, GeminiInlineData>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: mergeConsecutiveMessages(opts.messages).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: toGeminiParts(m.content, inlineImages),
    })),
    generationConfig: {
      maxOutputTokens: Math.max(1, opts.maxOutputTokens),
      ...(typeof opts.temperature === "number"
        ? { temperature: opts.temperature }
        : {}),
      ...(opts.supportsThinking && opts.thinkingLevel !== "off"
        ? {
            thinkingConfig: {
              thinkingBudget: resolveGeminiThinkingBudget(
                opts.thinkingLevel,
                opts.thinkingOverrides,
              ),
            },
          }
        : {}),
    },
  }
  if (opts.systemPrompt?.trim()) {
    body.systemInstruction = { parts: [{ text: opts.systemPrompt.trim() }] }
  }
  return body
}

/** 单张内联图片上限（Gemini 请求体总量 20MB，留多图余量） */
const GEMINI_IMAGE_MAX_BYTES = 7 * 1024 * 1024
const GEMINI_IMAGE_FETCH_TIMEOUT_MS = 20_000

function guessImageMimeFromUrl(url: string): string | null {
  const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "png":
      return "image/png"
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "webp":
      return "image/webp"
    case "gif":
      return "image/gif"
    case "heic":
      return "image/heic"
    default:
      return null
  }
}

/**
 * 预取消息中的图片转 base64（Gemini 仅支持 inlineData / GCS fileData）。
 * 单图失败跳过不阻断请求；URL 来源已由 sendChatMessageSchema 校验为本系统存储。
 */
export async function prepareGeminiInlineImages(
  messages: StreamChatAdapterOptions["messages"],
): Promise<Map<string, GeminiInlineData>> {
  const urls = new Set<string>()
  for (const m of messages) {
    if (typeof m.content === "string") continue
    for (const p of m.content) {
      if (p.type === "image_url") urls.add(p.image_url.url)
    }
  }
  const map = new Map<string, GeminiInlineData>()
  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(GEMINI_IMAGE_FETCH_TIMEOUT_MS),
        })
        if (!res.ok) return
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.byteLength === 0 || buf.byteLength > GEMINI_IMAGE_MAX_BYTES) return
        const mimeType =
          res.headers.get("content-type")?.split(";")[0]?.trim() ||
          guessImageMimeFromUrl(url) ||
          "image/jpeg"
        if (!mimeType.startsWith("image/")) return
        map.set(url, { mimeType, data: buf.toString("base64") })
      } catch {
        // 单图取图失败：跳过该图
      }
    }),
  )
  return map
}

export async function* streamGeminiChat(
  opts: StreamChatAdapterOptions,
): AsyncGenerator<ChatStreamEvent> {
  const endpoint = resolveGeminiStreamEndpoint(opts.apiEndpoint, opts.modelName)
  const inlineImages = await prepareGeminiInlineImages(opts.messages)
  const { signal, dispose } = createChatAbortSignal(opts.apiTimeout, opts.signal)
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify(buildGeminiRequestBody(opts, inlineImages)),
      signal,
    })
  } catch (err) {
    dispose()
    const isAbort = err instanceof Error && err.name === "AbortError"
    yield {
      type: "error",
      message: isAbort
        ? `对话请求超时或被中止（上限 ${opts.apiTimeout} 秒）`
        : `对话服务连接失败：${err instanceof Error ? err.message : String(err)}`,
    }
    return
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "")
    let message: string | null = null
    try {
      message = extractChatErrorMessage(JSON.parse(text))
    } catch {
      // 非 JSON 错误体
    }
    dispose()
    yield {
      type: "error",
      message: message ?? `对话 API 错误 ${response.status}: ${text.slice(0, 200)}`,
    }
    return
  }

  try {
    for await (const sse of readSseStream(response.body)) {
      if (!sse.data.trim()) continue
      let chunk: GeminiStreamChunk
      try {
        chunk = JSON.parse(sse.data) as GeminiStreamChunk
      } catch {
        continue
      }
      if (chunk.error?.message) {
        yield { type: "error", message: chunk.error.message }
        return
      }
      if (chunk.usageMetadata) {
        yield {
          type: "usage",
          inputTokens: chunk.usageMetadata.promptTokenCount,
          outputTokens: chunk.usageMetadata.candidatesTokenCount,
        }
      }
      const candidate = chunk.candidates?.[0]
      if (!candidate) continue
      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text !== "string" || !part.text) continue
        if (part.thought === true) {
          yield { type: "thinking_delta", text: part.text }
        } else {
          yield { type: "text_delta", text: part.text }
        }
      }
      if (candidate.finishReason) {
        yield { type: "done", finishReason: candidate.finishReason }
      }
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError"
    yield {
      type: "error",
      message: isAbort
        ? `对话流超时或被中止（上限 ${opts.apiTimeout} 秒）`
        : `对话流中断：${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    dispose()
  }
}
