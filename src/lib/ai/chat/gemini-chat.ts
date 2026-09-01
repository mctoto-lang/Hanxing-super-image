/**
 * Gemini（Google Generative Language API）对话流式适配器
 *
 * POST {apiEndpoint}/v1beta/models/{model}:streamGenerateContent?alt=sse，
 * x-goog-api-key 头鉴权（key 不进 URL，避免落网关访问日志）。
 *
 * - 历史消息映射：assistant → role:"model"；parts:[{text}]；
 * - systemInstruction 独立字段；generationConfig.maxOutputTokens 控制上限；
 * - 思考：generationConfig.thinkingConfig.thinkingBudget（1024/8192/24576），
 *   off 不发送字段（模型默认行为）；
 * - 流式数据块：candidates[0].content.parts[].text（含 thought:true 的
 *   思考摘要 part，归一化为 thinking_delta）；
 * - usage：usageMetadata.promptTokenCount / candidatesTokenCount。
 */
import {
  extractChatErrorMessage,
  GEMINI_THINKING_BUDGETS,
  mergeConsecutiveMessages,
  resolveGeminiStreamEndpoint,
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

/** 构建 Gemini 请求体（纯函数，单测直接覆盖；modelName 由 URL 承载） */
export function buildGeminiRequestBody(
  opts: StreamChatAdapterOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: mergeConsecutiveMessages(opts.messages).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      maxOutputTokens: Math.max(1, opts.maxOutputTokens),
      ...(typeof opts.temperature === "number"
        ? { temperature: opts.temperature }
        : {}),
      ...(opts.supportsThinking && opts.thinkingLevel !== "off"
        ? {
            thinkingConfig: {
              thinkingBudget:
                GEMINI_THINKING_BUDGETS[opts.thinkingLevel],
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

export async function* streamGeminiChat(
  opts: StreamChatAdapterOptions,
): AsyncGenerator<ChatStreamEvent> {
  const endpoint = resolveGeminiStreamEndpoint(opts.apiEndpoint, opts.modelName)
  const { signal, dispose } = createChatAbortSignal(opts.apiTimeout, opts.signal)
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify(buildGeminiRequestBody(opts)),
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
