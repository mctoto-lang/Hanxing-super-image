"use client"

import type { ChatModelCard } from "@/server/actions/chat"

/**
 * AI 对话前端共享类型
 */

export type { ChatModelCard }

/** 思考强度档位（与后端统一） */
export type ThinkingLevel = "off" | "low" | "medium" | "high"

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
}

/** 服务端返回的会话列表项 */
export interface ChatConversationListItem {
  id: string
  title: string
  modelId: string | null
  thinkingLevel: string
  contextTokens: number
  pinnedAt: Date | null
  lastMessageAt: Date
  updatedAt: Date
}

/** 服务端返回的消息（含模型展示信息） */
export interface ChatMessageItem {
  id: string
  role: string
  content: string
  thinkingContent: string | null
  status: string
  inputTokens: number | null
  outputTokens: number | null
  costCenticredits: number
  durationMs: number | null
  errorMessage: string | null
  createdAt: Date
  modelId: string | null
  modelDisplayName: string | null
  modelIconUrl: string | null
}

/** 流式进行中的实时状态（乐观 UI） */
export interface ChatStreamState {
  conversationId: string
  /** 本轮发送的 user 消息（regenerate 时为 null，不新增 user 气泡） */
  userText: string | null
  /** user 消息行 id（SSE message 事件返回，用于与服务器行去重） */
  userMessageId: string | null
  /** assistant 消息 id（SSE message 事件返回，用于与服务器行对齐） */
  assistantMessageId: string | null
  assistantText: string
  assistantThinking: string
  status: "connecting" | "streaming" | "done" | "error"
  error: string | null
  inputTokens: number | null
  outputTokens: number | null
  /** done 事件返回的账单（厘） */
  costCenticredits: number | null
}
