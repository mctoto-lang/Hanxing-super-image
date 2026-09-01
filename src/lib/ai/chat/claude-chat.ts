/**
 * Claude（Anthropic）对话流式适配器
 *
 * POST {apiEndpoint}/v1/messages，x-api-key + anthropic-version 鉴权，SSE 流式。
 *
 * - system 独立字段（非 messages 内 system 角色）；
 * - max_tokens 必填：取 min(请求上限, 模型 maxOutputTokens)；
 * - 消息须 user/assistant 交替（mergeConsecutiveMessages 预处理）；
 * - 思考：thinking: {type:"enabled", budget_tokens}，档位 2048/8192/32768
 *   且必须 < max_tokens（低输出上限模型自动钳制；thinking 开启时不发送
 *   temperature——Anthropic 限制扩展思考仅支持默认温度）；
 * - usage：message_start 报 input_tokens，message_delta 报（累计）output_tokens。
 */
import {
  CLAUDE_THINKING_BUDGETS,
  extractChatErrorMessage,
  mergeConsecutiveMessages,
  resolveClaudeEndpoint,
  type ChatStreamEvent,
  type StreamChatAdapterOptions,
} from "@/lib/ai/chat/chat-model-config"
import { readSseStream } from "@/lib/ai/chat/sse"
import { createChatAbortSignal } from "@/lib/ai/chat/openai-chat"

interface ClaudeStreamEvent {
  type: string
  delta?: { type?: string; text?: string; stop_reason?: string }
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { type?: string; message?: string }
}

/** 钳制 thinking 预算：≥1024 且 < max_tokens（Anthropic 硬约束） */
export function clampClaudeThinkingBudget(
  budget: number,
  maxTokens: number,
): number {
  const min = Math.min(1024, Math.max(1, maxTokens - 1))
  return Math.max(min, Math.min(budget, maxTokens - 1))
}

/** 构建 Claude 请求体（纯函数，单测直接覆盖） */
export function buildClaudeRequestBody(
  opts: StreamChatAdapterOptions,
): Record<string, unknown> {
  const maxTokens = Math.max(1, opts.maxOutputTokens)
  const body: Record<string, unknown> = {
    model: opts.modelName,
    max_tokens: maxTokens,
    stream: true,
    messages: mergeConsecutiveMessages(opts.messages).map((m) => ({
      role: m.role,
      content: m.content,
    })),
  }
  if (opts.systemPrompt?.trim()) {
    body.system = opts.systemPrompt.trim()
  }
  const level = opts.thinkingLevel
  const budget =
    opts.supportsThinking && level !== "off"
      ? CLAUDE_THINKING_BUDGETS[level]
      : null
  if (budget != null) {
    body.thinking = {
      type: "enabled",
      budget_tokens: clampClaudeThinkingBudget(budget, maxTokens),
    }
  } else if (typeof opts.temperature === "number") {
    body.temperature = opts.temperature
  }
  return body
}

export async function* streamClaudeChat(
  opts: StreamChatAdapterOptions,
): AsyncGenerator<ChatStreamEvent> {
  const endpoint = resolveClaudeEndpoint(opts.apiEndpoint)
  const { signal, dispose } = createChatAbortSignal(opts.apiTimeout, opts.signal)
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(buildClaudeRequestBody(opts)),
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
      let evt: ClaudeStreamEvent
      try {
        evt = JSON.parse(sse.data) as ClaudeStreamEvent
      } catch {
        continue
      }
      const eventName = sse.event ?? evt.type
      switch (eventName) {
        case "message_start": {
          const usage = evt.message?.usage
          if (usage) {
            yield { type: "usage", inputTokens: usage.input_tokens }
          }
          break
        }
        case "content_block_delta": {
          const delta = evt.delta
          if (delta?.text) {
            if (delta.type === "thinking_delta") {
              yield { type: "thinking_delta", text: delta.text }
            } else {
              yield { type: "text_delta", text: delta.text }
            }
          }
          break
        }
        case "message_delta": {
          const usage = evt.usage
          if (usage) {
            yield { type: "usage", outputTokens: usage.output_tokens }
          }
          if (evt.delta?.stop_reason) {
            yield { type: "done", finishReason: evt.delta.stop_reason }
          }
          break
        }
        case "error": {
          yield {
            type: "error",
            message:
              evt.error?.message ?? "对话 API 返回错误事件（claude 流）",
          }
          return
        }
        case "message_stop": {
          yield { type: "done" }
          return
        }
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
