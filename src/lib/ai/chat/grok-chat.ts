/**
 * Grok（xAI）对话流式适配器
 *
 * xAI API 与 OpenAI 完全兼容（默认端点 https://api.x.ai/v1），
 * 复用 openai 兼容代码路径；独立文件 + 独立格式枚举值，
 * 便于未来 xAI 出现专有参数时在此分化。
 */
import { streamOpenAiCompatibleChat } from "@/lib/ai/chat/openai-chat"
import type { ChatStreamEvent, StreamChatAdapterOptions } from "@/lib/ai/chat/chat-model-config"

export async function* streamGrokChat(
  opts: StreamChatAdapterOptions,
): AsyncGenerator<ChatStreamEvent> {
  yield* streamOpenAiCompatibleChat(opts)
}
