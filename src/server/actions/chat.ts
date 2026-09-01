"use server"

import { and, desc, eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { chatConversations } from "@/db/schema"
import {
  requireUserContext,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { renameChatConversationSchema } from "@/server/schemas/chat"
import { listAccessibleChatModels, listChatMessagesWithModel } from "@/server/services/chat-service"
import { revalidatePath } from "next/cache"

/**
 * AI 对话 Server Actions（/chat 页）
 *
 * 消息发送走 /api/chat/stream 流式路由，此处只承载列表与
 * 会话管理（与创作会话 conversations.ts 同构，双租户过滤）。
 */

/** 模型卡片数据（发送侧需要的全部字段） */
export type ChatModelCard = {
  id: string
  name: string
  displayName: string
  description: string | null
  badgeText: string | null
  badgeColor: string | null
  iconUrl: string | null
  formatType: string
  maxContextTokens: number
  maxOutputTokens: number
  inputPriceCenticredits: number
  outputPriceCenticredits: number
  supportsThinking: boolean
  enterpriseId: string | null
}

/** 当前用户可用的对话模型列表 */
export async function listChatModelsAction(): Promise<ChatModelCard[]> {
  const ctx = await requireUserContext()
  const models = await listAccessibleChatModels(ctx)
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    displayName: m.displayName,
    description: m.description,
    badgeText: m.badgeText,
    badgeColor: m.badgeColor,
    iconUrl: m.iconUrl,
    formatType: m.formatType,
    maxContextTokens: m.maxContextTokens,
    maxOutputTokens: m.maxOutputTokens,
    inputPriceCenticredits: m.inputPriceCenticredits,
    outputPriceCenticredits: m.outputPriceCenticredits,
    supportsThinking: m.supportsThinking,
    enterpriseId: m.enterpriseId,
  }))
}

/** 列出当前用户会话（置顶在前，其余最近消息时间倒序） */
export async function listChatConversationsAction() {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  return await db
    .select({
      id: chatConversations.id,
      title: chatConversations.title,
      modelId: chatConversations.modelId,
      thinkingLevel: chatConversations.thinkingLevel,
      contextTokens: chatConversations.contextTokens,
      pinnedAt: chatConversations.pinnedAt,
      lastMessageAt: chatConversations.lastMessageAt,
      updatedAt: chatConversations.updatedAt,
    })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.enterpriseId, scope.enterpriseId),
        eq(chatConversations.userId, ctx.user.id),
      ),
    )
    .orderBy(
      sql`${chatConversations.pinnedAt} DESC NULLS LAST`,
      desc(chatConversations.lastMessageAt),
    )
}

/** 会话详情（含模型上下文上限，供圆环计算） */
export async function getChatConversationAction(id: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const [row] = await db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, id),
        eq(chatConversations.enterpriseId, scope.enterpriseId),
        eq(chatConversations.userId, ctx.user.id),
      ),
    )
    .limit(1)
  return row ?? null
}

/** 列出会话消息（最近 50 条正序，带模型展示信息） */
export async function listChatMessagesAction(conversationId: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const [conv] = await db
    .select({ id: chatConversations.id })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.enterpriseId, scope.enterpriseId),
        eq(chatConversations.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!conv) return []
  return await listChatMessagesWithModel(conversationId, 50)
}

/** 双击重命名 */
export async function renameChatConversationAction(input: {
  id: string
  title: string
}) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const parsed = renameChatConversationSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }

  const result = await db
    .update(chatConversations)
    .set({ title: parsed.data.title, updatedAt: new Date() })
    .where(
      and(
        eq(chatConversations.id, parsed.data.id),
        eq(chatConversations.enterpriseId, scope.enterpriseId),
        eq(chatConversations.userId, ctx.user.id),
      ),
    )
    .returning({ id: chatConversations.id })

  if (result.length === 0) {
    return { ok: false, error: "会话不存在或无权操作" }
  }
  revalidatePath("/chat")
  return { ok: true, error: null }
}

/** 置顶/取消置顶 */
export async function togglePinChatConversationAction(id: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const [conv] = await db
    .select({ id: chatConversations.id, pinnedAt: chatConversations.pinnedAt })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, id),
        eq(chatConversations.enterpriseId, scope.enterpriseId),
        eq(chatConversations.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!conv) {
    return { ok: false, error: "会话不存在或无权操作" }
  }

  await db
    .update(chatConversations)
    .set({ pinnedAt: conv.pinnedAt ? null : new Date() })
    .where(eq(chatConversations.id, id))

  revalidatePath("/chat")
  return { ok: true, error: null, pinned: !conv.pinnedAt }
}

/** 删除会话（cascade 删消息；已消耗积分不退——沉没成本） */
export async function deleteChatConversationAction(id: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const result = await db
    .delete(chatConversations)
    .where(
      and(
        eq(chatConversations.id, id),
        eq(chatConversations.enterpriseId, scope.enterpriseId),
        eq(chatConversations.userId, ctx.user.id),
      ),
    )
    .returning({ id: chatConversations.id })

  if (result.length === 0) {
    return { ok: false, error: "会话不存在或无权操作" }
  }
  revalidatePath("/chat")
  return { ok: true, error: null }
}
