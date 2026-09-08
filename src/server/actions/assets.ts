"use server"

import { and, desc, eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  generationTasks,
  models,
  pinnedTasks,
} from "@/db/schema"
import { checkModuleAccess } from "@/lib/auth/permissions"
import {
  requireUserContext,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { revalidatePath } from "next/cache"

/**
 * 资产管理 Server Actions（手册 M4）
 *
 * 跨来源图片画廊（自由创作/批量生图/商品/穿戴/样机），按企业 + 用户隔离。
 * 查询、收藏。
 */

/** 列出当前企业的所有图片资产（含来源模型信息） */
export async function listAssetsAction(opts?: {
  limit?: number
  offset?: number
  onlyPinned?: boolean
}) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "assets")
  if (denied) return []
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const { limit = 60, offset = 0, onlyPinned = false } = opts ?? {}

  let query = db
    .select({
      id: generationTasks.id,
      prompt: generationTasks.prompt,
      status: generationTasks.status,
      resultImages: generationTasks.resultImages,
      source: generationTasks.source,
      taskType: generationTasks.taskType,
      userId: generationTasks.userId,
      modelDisplayName: models.displayName,
      createdAt: generationTasks.createdAt,
    })
    .from(generationTasks)
    .leftJoin(models, eq(generationTasks.modelId, models.id))
    .$dynamic()

  const conditions = [
    eq(generationTasks.enterpriseId, enterpriseId),
    eq(generationTasks.status, "completed"),
    sql`${generationTasks.resultImages} IS NOT NULL`,
  ]
  // onlyPinned: 进一步限定为当前用户收藏的（保留参数供未来使用）
  void onlyPinned

  query = query.where(and(...conditions))

  return await query
    .orderBy(desc(generationTasks.createdAt))
    .limit(limit)
    .offset(offset)
}

/** 列出当前用户的收藏任务 */
export async function listPinnedTasksAction() {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "assets")
  if (denied) return []
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  return await db
    .select({
      id: pinnedTasks.id,
      taskId: pinnedTasks.taskId,
      note: pinnedTasks.note,
      createdAt: pinnedTasks.createdAt,
      prompt: generationTasks.prompt,
      resultImages: generationTasks.resultImages,
      modelDisplayName: models.displayName,
    })
    .from(pinnedTasks)
    .innerJoin(
      generationTasks,
      eq(pinnedTasks.taskId, generationTasks.id),
    )
    .leftJoin(models, eq(generationTasks.modelId, models.id))
    .where(
      and(
        eq(pinnedTasks.enterpriseId, enterpriseId),
        eq(pinnedTasks.userId, ctx.user.id),
      ),
    )
    .orderBy(desc(pinnedTasks.createdAt))
}

/** 收藏任务 */
export async function pinTaskAction(input: {
  taskId: string
  note?: string
}) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "assets")
  if (denied) return { ok: false, error: denied }
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  // 任务必须属于本企业
  const [task] = await db
    .select({ id: generationTasks.id })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, input.taskId),
        eq(generationTasks.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (!task) return { ok: false, error: "任务不存在" }

  try {
    await db.insert(pinnedTasks).values({
      enterpriseId,
      userId: ctx.user.id,
      taskId: input.taskId,
      source: "create",
      note: input.note ?? null,
    })
  } catch {
    return { ok: false, error: "已收藏过该任务" }
  }

  revalidatePath("/assets")
  return { ok: true, error: null }
}

/** 取消收藏 */
export async function unpinTaskAction(pinnedId: string) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "assets")
  if (denied) return { ok: false, error: denied }
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  await db
    .delete(pinnedTasks)
    .where(
      and(
        eq(pinnedTasks.id, pinnedId),
        eq(pinnedTasks.enterpriseId, enterpriseId),
        eq(pinnedTasks.userId, ctx.user.id),
      ),
    )
  revalidatePath("/assets")
  return { ok: true, error: null }
}

