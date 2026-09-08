/**
 * AI 对话统一调度入口
 *
 * 按 chat_api_config.formatType 分发到 openai / claude / gemini / grok
 * 流式适配器，与 src/lib/ai/index.ts（生图调度）同构：解密 apiKey、
 * 校验格式、剥离 DB 行为适配器入参。
 */
import { decrypt } from "@/lib/crypto"
import type { chatApiConfigs } from "@/db/schema"
import {
  CHAT_API_FORMATS,
  type ChatApiFormat,
  type ChatStreamEvent,
  type ChatUpstreamMessage,
  type StreamChatAdapterOptions,
  type ThinkingLevel,
} from "@/lib/ai/chat/chat-model-config"
import { streamOpenAiCompatibleChat } from "@/lib/ai/chat/openai-chat"
import { streamClaudeChat } from "@/lib/ai/chat/claude-chat"
import { streamGeminiChat } from "@/lib/ai/chat/gemini-chat"
import { streamGrokChat } from "@/lib/ai/chat/grok-chat"

type ChatModelRow = typeof chatApiConfigs.$inferSelect

export type {
  ChatApiFormat,
  ChatStreamEvent,
  ChatUpstreamMessage,
  StreamChatAdapterOptions,
  ThinkingLevel,
}

export function assertSupportedChatApiFormat(value: unknown): ChatApiFormat {
  if (!CHAT_API_FORMATS.includes(value as ChatApiFormat)) {
    throw new Error(`不支持的对话接口格式：${String(value)}`)
  }
  return value as ChatApiFormat
}

/**
 * 统一流式调用：按模型 formatType 分发。
 *
 * @param model       chat_api_config 行（来自 DB）
 * @param opts        历史 messages / systemPrompt / thinkingLevel / signal
 */
export async function* dispatchStreamChat(
  model: ChatModelRow,
  opts: {
    messages: ChatUpstreamMessage[]
    systemPrompt?: string | null
    thinkingLevel: ThinkingLevel
    signal?: AbortSignal
  },
): AsyncGenerator<ChatStreamEvent> {
  const format = assertSupportedChatApiFormat(model.formatType)
  const apiKey = decrypt(model.apiKeyEncrypted)
  const adapterOpts: StreamChatAdapterOptions = {
    apiKey,
    modelName: model.name,
    apiEndpoint: model.apiEndpoint,
    apiTimeout: model.apiTimeout || 120,
    maxOutputTokens: model.maxOutputTokens || 4096,
    supportsThinking: model.supportsThinking,
    temperature: model.extraConfig?.temperature ?? null,
    messages: opts.messages,
    systemPrompt: opts.systemPrompt,
    thinkingLevel: opts.thinkingLevel,
    thinkingOverrides: model.extraConfig?.thinkingOverrides ?? null,
    signal: opts.signal,
  }
  switch (format) {
    case "openai":
      yield* streamOpenAiCompatibleChat(adapterOpts)
      return
    case "claude":
      yield* streamClaudeChat(adapterOpts)
      return
    case "gemini":
      yield* streamGeminiChat(adapterOpts)
      return
    case "grok":
      yield* streamGrokChat(adapterOpts)
      return
  }
}
