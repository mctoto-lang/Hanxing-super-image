import { Suspense } from "react"
import { requireEnterpriseContext } from "@/lib/auth/session"
import {
  listChatModelsAction,
  listChatConversationsAction,
  listChatMessagesAction,
  getChatConversationAction,
} from "@/server/actions/chat"
import { ChatApp } from "@/components/chat/chat-app"
import type {
  ChatConversationListItem,
  ChatMessageItem,
} from "@/components/chat/types"

export const dynamic = "force-dynamic"

/**
 * AI 对话页（/chat）
 *
 * 布局复刻自由创作：绝对定位贴满 header 以下工作区（相对 SidebarInset），
 * 页面级不出现滚动条，仅右侧消息流内部滚动。
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>
}) {
  const ctx = await requireEnterpriseContext()
  if (!ctx.canAccess("chat")) {
    throw new Error("FORBIDDEN: 无权访问该模块（chat）")
  }

  const [models, conversations, sp] = await Promise.all([
    listChatModelsAction(),
    listChatConversationsAction(),
    searchParams,
  ])

  // 预取选中会话详情 + 消息（仅当 c 指向真实会话）
  const selected = conversations.find((x) => x.id === sp.c) ?? null
  let selectedConversation: ChatConversationListItem | null = null
  let messages: ChatMessageItem[] = []
  if (selected) {
    const [detail, msgs] = await Promise.all([
      getChatConversationAction(selected.id),
      listChatMessagesAction(selected.id),
    ])
    if (detail) {
      selectedConversation = {
        id: detail.id,
        title: detail.title,
        modelId: detail.modelId,
        thinkingLevel: detail.thinkingLevel,
        contextTokens: detail.contextTokens,
        pinnedAt: detail.pinnedAt,
        lastMessageAt: detail.lastMessageAt,
        updatedAt: detail.updatedAt,
      }
    }
    messages = msgs as ChatMessageItem[]
  }

  return (
    <div className="absolute inset-x-0 top-16 bottom-0">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            加载中…
          </div>
        }
      >
        <ChatApp
          models={models}
          conversations={conversations as ChatConversationListItem[]}
          selectedConversation={selectedConversation}
          messages={messages}
          userAvatarUrl={ctx.user.image ?? null}
        />
      </Suspense>
    </div>
  )
}
