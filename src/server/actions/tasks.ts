"use server"

import { and, desc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { generationTasks } from "@/db/schema"
import {
  requireUserContext,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"

/**
 * 任务查询 Server Actions（手册 M3）
 *
 * 前端轮询任务状态 + 查询历史。
 */

/** 查询单个任务（必须属于当前用户 + 当前企业） */
export async function getTaskAction(taskId: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const [task] = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, taskId),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  return task ?? null
}

/** 查询当前用户最近的任务历史 */
export async function listMyTasksAction(opts?: {
  limit?: number
  status?: "queued" | "processing" | "completed" | "failed"
}) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  let query = db
    .select({
      id: generationTasks.id,
      prompt: generationTasks.prompt,
      status: generationTasks.status,
      imageSize: generationTasks.imageSize,
      imageCount: generationTasks.imageCount,
      resultImages: generationTasks.resultImages,
      errorMessage: generationTasks.errorMessage,
      creditsCharged: generationTasks.creditsCharged,
      createdAt: generationTasks.createdAt,
      completedAt: generationTasks.completedAt,
      modelId: generationTasks.modelId,
    })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
      ),
    )
    .$dynamic()

  if (opts?.status) {
    query = query.where(eq(generationTasks.status, opts.status))
  }

  return await query
    .orderBy(desc(generationTasks.createdAt))
    // 上限钳制：limit 由客户端传入，防止 limit: 1000000 拖垮查询
    .limit(Math.min(Math.max(opts?.limit ?? 50, 1), 200))
}
