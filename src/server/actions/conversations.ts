"use server"

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  conversations,
  generationTasks,
  models,
  pinnedTasks,
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
        isNull(conversations.deletedAt),
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
        isNull(conversations.deletedAt),
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
        isNull(conversations.deletedAt),
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

/**
 * 删除会话（软删：会话与其下全部任务隐藏，管理端看板/生图日志/积分流水
 * 仍可见；不退积分——已消费算沉没）
 */
export async function deleteConversationAction(id: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const now = new Date()
  const result = await db.transaction(async (tx) => {
    const [conv] = await tx
      .update(conversations)
      .set({ deletedAt: now })
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.enterpriseId, scope.enterpriseId),
          eq(conversations.userId, ctx.user.id),
          isNull(conversations.deletedAt),
        ),
      )
      .returning({ id: conversations.id })
    if (!conv) return []

    // 任务随会话整批软删；收藏行硬删（任务行保留后原 cascade 不再触发）
    const taskIds = await tx
      .update(generationTasks)
      .set({ deletedAt: now })
      .where(
        and(
          eq(generationTasks.conversationId, id),
          isNull(generationTasks.deletedAt),
        ),
      )
      .returning({ id: generationTasks.id })

    if (taskIds.length > 0) {
      await tx.delete(pinnedTasks).where(
        inArray(
          pinnedTasks.taskId,
          taskIds.map((t) => t.id),
        ),
      )
    }
    return [conv]
  })

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
        isNull(conversations.deletedAt),
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
      startedAt: generationTasks.startedAt,
      completedAt: generationTasks.completedAt,
      modelDisplayName: models.displayName,
      modelIconUrl: models.iconUrl,
    })
    .from(generationTasks)
    .innerJoin(models, eq(generationTasks.modelId, models.id))
    .where(
      and(
        eq(generationTasks.conversationId, conversationId),
        isNull(generationTasks.deletedAt),
      ),
    )
    .orderBy(desc(generationTasks.createdAt))
    .limit(50)

  // 取的是最近 50 条（倒序），恢复为正序展示（最新在下）
  return rows.reverse()
}

/**
 * 会话任务状态轻量轮询：仅取 id + status（join 会话表内联归属校验，单查询）。
 *
 * 创作页有 pending 任务时每 4s 调一次——只拉状态签名与本地对比，发生变化才
 * router.refresh() 拉全量，替代原先无条件整页 SSR 重跑（多任务生成期间每轮
 * 重跑页面级聚合查询，DB 压力显著）。
 */
export async function getConversationTaskStatusesAction(
  conversationId: string,
): Promise<{ id: string; status: string }[]> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  return db
    .select({ id: generationTasks.id, status: generationTasks.status })
    .from(generationTasks)
    .innerJoin(
      conversations,
      eq(generationTasks.conversationId, conversations.id),
    )
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.enterpriseId, scope.enterpriseId),
        eq(conversations.userId, ctx.user.id),
        isNull(conversations.deletedAt),
        isNull(generationTasks.deletedAt),
      ),
    )
    // 与 listConversationTasksAction 同口径取最新 50 条：无 orderBy 时
    // 会话任务超过 50 条后两集合错位，轮询误判"有变化"每 4s 整页刷新
    .orderBy(desc(generationTasks.createdAt))
    .limit(50)
}

/**
 * 删除单次生成结果（软删 task，管理端日志仍可见；不退积分）。
 *
 * 仅限创作页（source=create）的任务：product/weartry/mockup 模块没有
 * 删除功能，其列表/轮询查询也不过滤 deletedAt，若放行会被直接调用
 * action 软删后仍在前端可见。
 */
export async function deleteTaskAction(taskId: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const now = new Date()
  const result = await db.transaction(async (tx) => {
    const [task] = await tx
      .update(generationTasks)
      .set({ deletedAt: now })
      .where(
        and(
          eq(generationTasks.id, taskId),
          eq(generationTasks.source, "create"),
          eq(generationTasks.enterpriseId, scope.enterpriseId),
          eq(generationTasks.userId, ctx.user.id),
          isNull(generationTasks.deletedAt),
        ),
      )
      .returning({ id: generationTasks.id })
    if (!task) return []

    // 收藏行硬删（任务行保留后原 cascade 不再触发）
    await tx.delete(pinnedTasks).where(eq(pinnedTasks.taskId, taskId))
    return [task]
  })

  if (result.length === 0) {
    return { ok: false, error: "任务不存在或无权操作" }
  }
  revalidatePath("/create")
  return { ok: true, error: null }
}

/**
 * 撤销删除（恢复软删任务）：删除 toast 的「撤销」动作调用（Gmail 式
 * 事后挽回，替代确认弹窗打断）。权限/归属校验与 deleteTaskAction 对齐；
 * 仅可恢复软删行（deletedAt 非空）。删除时一并清除的收藏不恢复。
 */
export async function restoreTaskAction(taskId: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const [task] = await db
    .update(generationTasks)
    .set({ deletedAt: null })
    .where(
      and(
        eq(generationTasks.id, taskId),
        eq(generationTasks.source, "create"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        isNotNull(generationTasks.deletedAt),
      ),
    )
    .returning({ id: generationTasks.id })

  if (!task) {
    return { ok: false, error: "任务不存在或无法恢复" }
  }
  revalidatePath("/create")
  return { ok: true, error: null }
}
