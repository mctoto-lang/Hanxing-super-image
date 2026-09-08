"use server"

import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  generationTasks,
  loginLogs,
  taskSourceEnum,
  users,
  models,
  apiCallLogs,
} from "@/db/schema"
import {
  requireEnterpriseAdmin,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { parseDayRange } from "@/lib/admin/table-filters"
import { revalidatePath } from "next/cache"

/**
 * 企业操作日志 Server Actions（手册 M7、§10.7）
 *
 * 企业管理员可查看本企业的生图日志与登录日志。
 */

export interface TaskLogRow {
  id: string
  username: string | null
  prompt: string
  modelName: string | null
  status: string
  source: string
  taskType: string
  creditsCharged: number
  retryCount: number
  errorMessage: string | null
  imageSize: string | null
  imageCount: number
  resultImages: string[] | null
  createdAt: Date
  completedAt: Date | null
}

export interface LoginLogRow {
  id: string
  username: string | null
  ip: string
  userAgent: string | null
  success: boolean
  failureReason: string | null
  createdAt: Date
}

export interface TaskLogDetail extends TaskLogRow {
  apiCallLogs: Array<{
    id: string
    requestSummary: string | null
    responseSummary: string | null
    errorMessage: string | null
    durationMs: number | null
    createdAt: Date
  }>
}

/** 列出生图任务日志（企业隔离，可按用户 / 模块 / 日期筛选） */
export async function listTaskLogsAction(params?: {
  page?: number
  pageSize?: number
  /** 用户关键词（username / 昵称模糊） */
  q?: string
  /** 模块（generation_task.source 枚举） */
  source?: string
  /** 日期范围（YYYY-MM-DD，Asia/Shanghai 日界） */
  from?: string
  to?: string
}): Promise<{ tasks: TaskLogRow[]; total: number }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  const page = Math.max(1, params?.page ?? 1)
  const pageSize = Math.min(50, params?.pageSize ?? 20)
  const offset = (page - 1) * pageSize

  const conds = [eq(generationTasks.enterpriseId, enterpriseId)]
  const q = params?.q?.trim()
  if (q) {
    const kw = `%${q}%`
    conds.push(or(ilike(users.username, kw), ilike(users.name, kw))!)
  }
  if (params?.source) {
    conds.push(
      eq(
        generationTasks.source,
        params.source as (typeof taskSourceEnum.enumValues)[number],
      ),
    )
  }
  const { from, toEnd } = parseDayRange(params?.from, params?.to)
  if (from) conds.push(gte(generationTasks.createdAt, from))
  if (toEnd) conds.push(lt(generationTasks.createdAt, toEnd))
  const where = and(...conds)

  const rows = await db
    .select({
      id: generationTasks.id,
      username: users.username,
      prompt: generationTasks.prompt,
      modelName: models.displayName,
      status: generationTasks.status,
      source: generationTasks.source,
      taskType: generationTasks.taskType,
      creditsCharged: generationTasks.creditsCharged,
      retryCount: generationTasks.retryCount,
      errorMessage: generationTasks.errorMessage,
      imageSize: generationTasks.imageSize,
      imageCount: generationTasks.imageCount,
      resultImages: generationTasks.resultImages,
      createdAt: generationTasks.createdAt,
      completedAt: generationTasks.completedAt,
    })
    .from(generationTasks)
    .leftJoin(users, eq(users.id, generationTasks.userId))
    .leftJoin(models, eq(models.id, generationTasks.modelId))
    .where(where)
    .orderBy(desc(generationTasks.createdAt))
    .limit(pageSize)
    .offset(offset)

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(generationTasks)
    .leftJoin(users, eq(users.id, generationTasks.userId))
    .where(where)

  return { tasks: rows, total: count }
}

/** 列出登录日志（企业隔离） */
export async function listLoginLogsAction(params?: {
  page?: number
  pageSize?: number
}): Promise<{ logs: LoginLogRow[]; total: number }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  const page = Math.max(1, params?.page ?? 1)
  const pageSize = Math.min(50, params?.pageSize ?? 20)
  const offset = (page - 1) * pageSize

  const rows = await db
    .select({
      id: loginLogs.id,
      username: loginLogs.username,
      ip: loginLogs.ip,
      userAgent: loginLogs.userAgent,
      success: loginLogs.success,
      failureReason: loginLogs.failureReason,
      createdAt: loginLogs.createdAt,
    })
    .from(loginLogs)
    .where(eq(loginLogs.enterpriseId, enterpriseId))
    .orderBy(desc(loginLogs.createdAt))
    .limit(pageSize)
    .offset(offset)

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loginLogs)
    .where(eq(loginLogs.enterpriseId, enterpriseId))

  return { logs: rows, total: count }
}

/** 获取任务详情（含 API 调用日志） */
export async function getTaskDetailAction(
  taskId: string,
): Promise<{ ok: boolean; detail?: TaskLogDetail; error?: string }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  const [task] = await db
    .select({
      id: generationTasks.id,
      username: users.username,
      prompt: generationTasks.prompt,
      modelName: models.displayName,
      status: generationTasks.status,
      source: generationTasks.source,
      taskType: generationTasks.taskType,
      creditsCharged: generationTasks.creditsCharged,
      retryCount: generationTasks.retryCount,
      errorMessage: generationTasks.errorMessage,
      imageSize: generationTasks.imageSize,
      imageCount: generationTasks.imageCount,
      resultImages: generationTasks.resultImages,
      createdAt: generationTasks.createdAt,
      completedAt: generationTasks.completedAt,
    })
    .from(generationTasks)
    .leftJoin(users, eq(users.id, generationTasks.userId))
    .leftJoin(models, eq(models.id, generationTasks.modelId))
    .where(
      sql`${generationTasks.id} = ${taskId} AND ${generationTasks.enterpriseId} = ${enterpriseId}`,
    )
    .limit(1)

  if (!task) return { ok: false, error: "任务不存在" }

  const calls = await db
    .select({
      id: apiCallLogs.id,
      requestSummary: apiCallLogs.requestSummary,
      responseSummary: apiCallLogs.responseSummary,
      errorMessage: apiCallLogs.errorMessage,
      durationMs: apiCallLogs.durationMs,
      createdAt: apiCallLogs.createdAt,
    })
    .from(apiCallLogs)
    .where(eq(apiCallLogs.taskId, taskId))
    .orderBy(desc(apiCallLogs.createdAt))

  return { ok: true, detail: { ...task, apiCallLogs: calls } }
}

/** 删除任务日志（企业隔离） */
export async function deleteTaskLogAction(
  taskId: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  const result = await db
    .delete(generationTasks)
    .where(
      sql`${generationTasks.id} = ${taskId} AND ${generationTasks.enterpriseId} = ${enterpriseId}`,
    )
    .returning({ id: generationTasks.id })

  if (result.length === 0) {
    return { ok: false, error: "任务不存在或无权删除" }
  }

  revalidatePath("/admin/logs")
  return { ok: true }
}
