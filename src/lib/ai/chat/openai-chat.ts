/**
 * OpenAI 兼容对话流式适配器（openai / grok 格式共用）
 *
 * POST {apiEndpoint}/v1/chat/completions，Bearer 鉴权，SSE 流式响应。
 *
 * - 请求体：{ model, messages, stream: true, stream_options: {include_usage},
 *   max_tokens, temperature?, reasoning_effort? }
 * - 思考强度：reasoning_effort: low/medium/high（off 不发送字段，由模型默认）；
 *   思考流读取 delta.reasoning_content（DeepSeek 系）或 delta.reasoning
 *   （OpenRouter 等网关变体），正文读取 delta.content。
 * - usage：开启 stream_options 后最后一个 chunk 携带 usage
 *   （prompt_tokens / completion_tokens）；兼容网关在多个 chunk 分次上报。
 */
import {
  extractChatErrorMessage,
  OPENAI_REASONING_EFFORTS,
  resolveOpenAiChatEndpoint,
  type ChatStreamEvent,
  type StreamChatAdapterOptions,
} from "@/lib/ai/chat/chat-model-config"
import { readSseStream } from "@/lib/ai/chat/sse"

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  } | null
}

/** 组合外部 signal 与超时硬限（任一触发即中止 fetch） */
export function createChatAbortSignal(
  apiTimeout: number,
  signal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), apiTimeout * 1000)
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener("abort", onAbort)
    },
  }
}

/** 构建 OpenAI 兼容流式请求体（纯函数，单测直接覆盖） */
export function buildOpenAiChatRequestBody(
  opts: StreamChatAdapterOptions,
): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = []
  if (opts.systemPrompt?.trim()) {
    messages.push({ role: "system", content: opts.systemPrompt.trim() })
  }
  for (const msg of opts.messages) {
    messages.push({ role: msg.role, content: msg.content })
  }
  const body: Record<string, unknown> = {
    model: opts.modelName,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Math.max(1, opts.maxOutputTokens),
  }
  if (typeof opts.temperature === "number") {
    body.temperature = opts.temperature
  }
  if (
    opts.supportsThinking &&
    opts.thinkingLevel !== "off" &&
    OPENAI_REASONING_EFFORTS[opts.thinkingLevel]
  ) {
    body.reasoning_effort = OPENAI_REASONING_EFFORTS[opts.thinkingLevel]
  }
  return body
}

/** OpenAI 兼容流式对话（openai / grok 格式共用代码路径） */
export async function* streamOpenAiCompatibleChat(
  opts: StreamChatAdapterOptions,
): AsyncGenerator<ChatStreamEvent> {
  const endpoint = resolveOpenAiChatEndpoint(opts.apiEndpoint)
  const { signal, dispose } = createChatAbortSignal(opts.apiTimeout, opts.signal)
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(buildOpenAiChatRequestBody(opts)),
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
      // 非 JSON 错误体，原样截断
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
      if (sse.data === "[DONE]") break
      if (!sse.data.trim()) continue
      let chunk: OpenAiStreamChunk
      try {
        chunk = JSON.parse(sse.data) as OpenAiStreamChunk
      } catch {
        continue // 网关偶发非 JSON 心跳行，跳过
      }
      if (chunk.usage) {
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        }
      }
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning
      if (typeof reasoning === "string" && reasoning) {
        yield { type: "thinking_delta", text: reasoning }
      }
      if (typeof choice.delta?.content === "string" && choice.delta.content) {
        yield { type: "text_delta", text: choice.delta.content }
      }
      if (choice.finish_reason) {
        yield { type: "done", finishReason: choice.finish_reason }
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
