"use server"

import { and, desc, eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  conversations,
  generationTasks,
  models,
} from "@/db/schema"
import {
  requireUserContext,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { renameConversationSchema } from "@/server/schemas/conversations"
import { revalidatePath } from "next/cache"

/**
 * 创作会话 Server Actions（自由创作页 §6 重新设计）
 *
 * 会话是多次生图的容器（类似 ChatGPT 会话）。
 * 全部走 requireUserContext + 企业隔离。
 */

/** 列出当前用户的会话（置顶在前 pinnedAt 倒序，其余 updatedAt 倒序） */
export async function listConversationsAction() {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      lastImageThumb: conversations.lastImageThumb,
      pinnedAt: conversations.pinnedAt,
      updatedAt: conversations.updatedAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.enterpriseId, scope.enterpriseId),
        eq(conversations.userId, ctx.user.id),
      ),
    )
    .orderBy(
      sql`${conversations.pinnedAt} DESC NULLS LAST`,
      desc(conversations.updatedAt),
    )

  return rows
}

/** 创建会话，标题默认取首个任务提示词截断（兜底 "新建任务N"） */
export async function createConversationAction(title?: string): Promise<{
  id: string
  title: string
}> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const finalTitle = (title ?? "").trim() || "新建任务"

  const [row] = await db
    .insert(conversations)
    .values({
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      title: finalTitle,
    })
    .returning({ id: conversations.id, title: conversations.title })

  return { id: row!.id, title: row!.title }
}

/** 双击改名 */
export async function renameConversationAction(input: {
  id: string
  title: string
}) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const parsed = renameConversationSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }

  const result = await db
    .update(conversations)
    .set({ title: parsed.data.title, updatedAt: new Date() })
    .where(
      and(
        eq(conversations.id, parsed.data.id),
        eq(conversations.enterpriseId, scope.enterpriseId),
        eq(conversations.userId, ctx.user.id),
      ),
    )
    .returning({ id: conversations.id })

  if (result.length === 0) {
    return { ok: false, error: "会话不存在或无权操作" }
  }
  revalidatePath("/create")
  return { ok: true, error: null }
}

/** 置顶/取消置顶会话 */
export async function togglePinConversationAction(id: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const [conv] = await db
    .select({ id: conversations.id, pinnedAt: conversations.pinnedAt })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, id),
        eq(conversations.enterpriseId, scope.enterpriseId),
        eq(conversations.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!conv) {
    return { ok: false, error: "会话不存在或无权操作" }
  }

  await db
    .update(conversations)
    .set({ pinnedAt: conv.pinnedAt ? null : new Date() })
    .where(eq(conversations.id, id))

  revalidatePath("/create")
  return { ok: true, error: null, pinned: !conv.pinnedAt }
}

/** 删除会话（cascade 删其下 task，不退积分——已消费算沉没） */
export async function deleteConversationAction(id: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const result = await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.id, id),
        eq(conversations.enterpriseId, scope.enterpriseId),
        eq(conversations.userId, ctx.user.id),
      ),
    )
    .returning({ id: conversations.id })

  if (result.length === 0) {
    return { ok: false, error: "会话不存在或无权操作" }
  }
  revalidatePath("/create")
  return { ok: true, error: null }
}

/** 列出会话下所有 task（正序，最新在下；只取最近 50 条防轮询刷新无界放大） */
export async function listConversationTasksAction(conversationId: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  // 先校验会话归属
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.enterpriseId, scope.enterpriseId),
        eq(conversations.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!conv) return []

  const rows = await db
    .select({
      id: generationTasks.id,
      modelId: generationTasks.modelId,
      prompt: generationTasks.prompt,
      status: generationTasks.status,
      imageSize: generationTasks.imageSize,
      imageCount: generationTasks.imageCount,
      resultImages: generationTasks.resultImages,
      referenceImages: generationTasks.referenceImages,
      errorMessage: generationTasks.errorMessage,
      creditsCharged: generationTasks.creditsCharged,
      createdAt: generationTasks.createdAt,
      completedAt: generationTasks.completedAt,
      modelDisplayName: models.displayName,
      modelIconUrl: models.iconUrl,
    })
    .from(generationTasks)
    .innerJoin(models, eq(generationTasks.modelId, models.id))
    .where(eq(generationTasks.conversationId, conversationId))
    .orderBy(desc(generationTasks.createdAt))
    .limit(50)

  // 取的是最近 50 条（倒序），恢复为正序展示（最新在下）
  return rows.reverse()
}

/** 删除单次生成结果（硬删 task，不退积分） */
export async function deleteTaskAction(taskId: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const result = await db
    .delete(generationTasks)
    .where(
      and(
        eq(generationTasks.id, taskId),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
      ),
    )
    .returning({ id: generationTasks.id })

  if (result.length === 0) {
    return { ok: false, error: "任务不存在或无权操作" }
  }
  revalidatePath("/create")
  return { ok: true, error: null }
}
