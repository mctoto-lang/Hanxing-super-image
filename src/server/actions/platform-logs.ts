"use server"

import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  generationTasks,
  loginLogs,
  taskSourceEnum,
  users,
  models,
  enterprises,
  apiCallLogs,
} from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import { parseDayRange } from "@/lib/admin/table-filters"

/**
 * 平台全量日志 Server Actions（超管）。
 *
 * 与企业侧 admin-logs 同构，但无企业过滤（全平台视角），行数据附归属
 * 企业名；只读口径（不含删除——跨企业数据删除走各企业管理端）。
 */

export interface PlatformTaskLogRow {
  id: string
  username: string | null
  enterpriseName: string | null
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

export interface PlatformLoginLogRow {
  id: string
  username: string | null
  enterpriseName: string | null
  ip: string
  userAgent: string | null
  success: boolean
  failureReason: string | null
  createdAt: Date
}

export interface PlatformTaskLogDetail extends PlatformTaskLogRow {
  apiCallLogs: Array<{
    id: string
    requestSummary: string | null
    responseSummary: string | null
    errorMessage: string | null
    durationMs: number | null
    createdAt: Date
  }>
}

/** 列出全平台生图任务日志（超管，可按用户 / 模块 / 日期筛选） */
export async function listAllTaskLogsAction(params?: {
  page?: number
  pageSize?: number
  /** 用户关键词（username / 昵称模糊） */
  q?: string
  /** 模块（generation_task.source 枚举） */
  source?: string
  /** 日期范围（YYYY-MM-DD，Asia/Shanghai 日界） */
  from?: string
  to?: string
}): Promise<{ tasks: PlatformTaskLogRow[]; total: number }> {
  await requireSuperAdmin()

  const page = Math.max(1, params?.page ?? 1)
  const pageSize = Math.min(50, params?.pageSize ?? 20)
  const offset = (page - 1) * pageSize

  const conds = []
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
  const where = conds.length > 0 ? and(...conds) : undefined

  const rows = await db
    .select({
      id: generationTasks.id,
      username: users.username,
      enterpriseName: enterprises.name,
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
    .leftJoin(enterprises, eq(generationTasks.enterpriseId, enterprises.id))
    .where(where)
    .orderBy(desc(generationTasks.createdAt))
    .limit(pageSize)
    .offset(offset)

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(generationTasks)
    .leftJoin(users, eq(users.id, generationTasks.userId))
    .leftJoin(models, eq(models.id, generationTasks.modelId))
    .where(where)

  return { tasks: rows, total: count }
}

/** 列出全平台登录日志（超管，含归属企业） */
export async function listAllLoginLogsAction(params?: {
  page?: number
  pageSize?: number
}): Promise<{ logs: PlatformLoginLogRow[]; total: number }> {
  await requireSuperAdmin()

  const page = Math.max(1, params?.page ?? 1)
  const pageSize = Math.min(50, params?.pageSize ?? 20)
  const offset = (page - 1) * pageSize

  const rows = await db
    .select({
      id: loginLogs.id,
      username: loginLogs.username,
      enterpriseName: enterprises.name,
      ip: loginLogs.ip,
      userAgent: loginLogs.userAgent,
      success: loginLogs.success,
      failureReason: loginLogs.failureReason,
      createdAt: loginLogs.createdAt,
    })
    .from(loginLogs)
    .leftJoin(enterprises, eq(loginLogs.enterpriseId, enterprises.id))
    .orderBy(desc(loginLogs.createdAt))
    .limit(pageSize)
    .offset(offset)

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loginLogs)

  return { logs: rows, total: count }
}

/** 获取全平台任务详情（含 API 调用日志；超管只读视角） */
export async function getPlatformTaskDetailAction(
  taskId: string,
): Promise<{ ok: boolean; detail?: PlatformTaskLogDetail; error?: string }> {
  await requireSuperAdmin()

  const [task] = await db
    .select({
      id: generationTasks.id,
      username: users.username,
      enterpriseName: enterprises.name,
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
    .leftJoin(enterprises, eq(generationTasks.enterpriseId, enterprises.id))
    .where(eq(generationTasks.id, taskId))
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
