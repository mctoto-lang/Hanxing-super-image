"use server"

import { and, desc, eq, isNull, sql } from "drizzle-orm"
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
 * 跨来源图片画廊（自由创作/批量生图/商品/穿戴/样机），个人维度：
 * 仅显示当前用户自己生成的图片（企业管理员同样只看个人，无特权）。
 * 查询、收藏。
 */

/** 列出当前用户生成的图片资产（含来源模型信息；企业内其他成员的图不展示） */
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
      startedAt: generationTasks.startedAt,
      completedAt: generationTasks.completedAt,
    })
    .from(generationTasks)
    .leftJoin(models, eq(generationTasks.modelId, models.id))
    .$dynamic()

  const conditions = [
    eq(generationTasks.enterpriseId, enterpriseId),
    eq(generationTasks.userId, ctx.user.id),
    eq(generationTasks.status, "completed"),
    isNull(generationTasks.deletedAt),
    sql`${generationTasks.resultImages} IS NOT NULL`,
  ]
  // onlyPinned: 进一步限定为当前用户收藏的（保留参数供未来使用）
  void onlyPinned

  query = query.where(and(...conditions))

  // 按完成时间倒序（新图在上；NULLS LAST 防御缺 completedAt 的脏数据）：
  // 按提交时间排序会让先提交后完成的慢任务排在感知更新的图下面
  return await query
    .orderBy(
      sql`${generationTasks.completedAt} DESC NULLS LAST`,
      desc(generationTasks.createdAt),
    )
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
        isNull(generationTasks.deletedAt),
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

  // 任务必须属于本人（个人画廊口径：他人任务不可收藏；软删任务不可收藏）
  const [task] = await db
    .select({ id: generationTasks.id })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, input.taskId),
        eq(generationTasks.enterpriseId, enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        isNull(generationTasks.deletedAt),
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

