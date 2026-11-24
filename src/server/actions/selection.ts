"use server"

import { and, desc, eq, gte, inArray, isNotNull, sql, type SQL } from "drizzle-orm"
import { z } from "zod"
import ExcelJS from "exceljs"
import { db } from "@/db/client"
import {
  selectionBookmarks,
  selectionMonitors,
  selectionResults,
  selectionTasks,
  users,
} from "@/db/schema"
import {
  requireEnterpriseContext,
  type UserContext,
} from "@/lib/auth/session"
import { settleSelectionTask } from "@/server/services/selection-service"
import { createSelectionTask } from "@/server/services/selection-task-service"
import {
  SELECTION_DAILY_TASK_LIMIT,
  SELECTION_PLATFORM_CONFIGS,
  isSelectionPlatform,
  platformsForCategory,
  type PlatformCategory,
  type SelectionPlatform,
} from "@/lib/selection/platforms"
import { platformView } from "@/lib/selection/platform-views"
import {
  isPoolSort,
  rawPoolRowToItem,
  resultRowToItem,
  type PoolSort,
  type PoolStats,
} from "@/lib/selection/pool-types"
import { parseUuid, parseUuidList } from "@/lib/selection/ids"
import { isCalendarDate } from "@/lib/selection/pool-url"

/**
 * 选品工具 Server Actions（0104）
 *
 * 权限：模块级单 key selection（canAccess 校验）；任务与结果企业共享，
 * 全部查询带 enterpriseId 隔离；收藏按用户隔离。
 * 计费：提交时单事务（insert 任务 + deductUserCredits 预扣），结算/退款
 * 全部走 selection-service（worker 收割或取消路径），action 不直接退款。
 */

function requireSelection(ctx: UserContext): UserContext {
  if (!ctx.canAccess("selection")) throw new Error("无选品工具权限")
  return ctx
}

const createTaskSchema = z.object({
  platform: z.string().min(1),
  taskType: z.enum(["discover", "market"]),
  maxResults: z.number().int().min(1).max(2000),
  params: z.record(z.string(), z.unknown()).optional(),
})

/** 创建抓取任务（权限/日限/参数清洗 → 单事务入库+预扣积分） */
export async function createSelectionTaskAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  requireSelection(ctx)

  const q = createTaskSchema.safeParse(input)
  if (!q.success) {
    return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  }
  const { platform, taskType } = q.data
  if (!isSelectionPlatform(platform)) {
    return { ok: false as const, error: "不支持的平台" }
  }
  return createSelectionTask({
    userId: ctx.user.id,
    enterpriseId: ctx.user.enterpriseId!,
    platform,
    taskType,
    params: q.data.params ?? {},
    maxResults: q.data.maxResults,
    label: SELECTION_PLATFORM_CONFIGS[platform].label,
  })
}

/** 重新提交失败/取消的任务（用原参数原量新建并重新计费） */
export async function retrySelectionTaskAction(taskId: string) {
  const ctx = await requireEnterpriseContext()
  requireSelection(ctx)
  if (parseUuid(taskId) == null) return { ok: false as const, error: "参数错误" }

  const [task] = await db
    .select()
    .from(selectionTasks)
    .where(
      and(
        eq(selectionTasks.id, taskId),
        eq(selectionTasks.enterpriseId, ctx.user.enterpriseId!),
      ),
    )
    .limit(1)
  if (!task) return { ok: false as const, error: "任务不存在" }
  if (task.status !== "failed" && task.status !== "cancelled") {
    return { ok: false as const, error: "仅失败/已取消的任务可重新提交" }
  }
  // 监控/评论任务不支持一键重试：原任务参数按市场字段集清洗后会变成「用监控标题
  // 当关键词的市场分析任务」并立即预扣积分——监控失败由周期调度自然重抓，一次性
  // 评论回详情弹窗重新发起（有 1 小时冷却）
  if (task.taskType === "monitor" || task.taskType === "review") {
    return {
      ok: false as const,
      error:
        task.taskType === "monitor"
          ? "监控任务不支持重试：监控由周期调度自动重抓，可在竞品监控页点「立即抓取」"
          : "评论任务不支持重试：请在数据池详情弹窗重新发起「抓取评论」",
    }
  }
  if (!isSelectionPlatform(task.platform)) {
    return { ok: false as const, error: "任务平台已下线" }
  }
  return createSelectionTask({
    userId: ctx.user.id,
    enterpriseId: ctx.user.enterpriseId!,
    platform: task.platform,
    taskType: task.taskType === "discover" ? "discover" : "market",
    params: task.searchParams ?? {},
    maxResults: task.maxResults,
    label: SELECTION_PLATFORM_CONFIGS[task.platform].label,
  })
}

/**
 * 取消任务：queued → 立即结算全额退款；processing → 置 cancelled 由
 * worker 收割循环 abort Apify run 后按实际条数结算。
 */
export async function cancelSelectionTaskAction(taskId: string) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  // 调用方直接传 taskId 字符串，按单值校验（非对象包装）
  if (!z.string().uuid().safeParse(taskId).success) {
    return { ok: false as const, error: "参数错误" }
  }

  const [task] = await db
    .select()
    .from(selectionTasks)
    .where(
      and(
        eq(selectionTasks.id, taskId),
        eq(selectionTasks.enterpriseId, ctx.user.enterpriseId!),
      ),
    )
    .limit(1)
  if (!task) return { ok: false as const, error: "任务不存在" }
  if (
    task.userId !== ctx.user.id &&
    ctx.user.enterpriseRole !== "owner" &&
    ctx.user.enterpriseRole !== "admin"
  ) {
    return { ok: false as const, error: "仅创建人或企业管理员可取消" }
  }
  if (task.status === "queued") {
    const claimed = await db
      .update(selectionTasks)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(selectionTasks.id, task.id),
          eq(selectionTasks.status, "queued"),
        ),
      )
      .returning({ id: selectionTasks.id })
    if (claimed.length === 0) {
      return { ok: false as const, error: "任务状态已变化，请刷新" }
    }
    await settleSelectionTask({
      taskId: task.id,
      finalStatus: "cancelled",
      fetchedCount: 0,
      errorMessage: "用户取消（未开始抓取，全额退还）",
    })
    return { ok: true as const }
  }
  if (task.status === "processing") {
    const claimed = await db
      .update(selectionTasks)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(selectionTasks.id, task.id),
          eq(selectionTasks.status, "processing"),
        ),
      )
      .returning({ id: selectionTasks.id })
    if (claimed.length === 0) {
      return { ok: false as const, error: "任务状态已变化，请刷新" }
    }
    return { ok: true as const } // worker abort + 按实际条数结算
  }
  return { ok: false as const, error: "任务已结束，无需取消" }
}

const taskListSchema = z.object({
  status: z.enum(["active", "completed", "failed", "cancelled", "all"]).optional(),
  platform: z.string().optional(),
  taskType: z.enum(["discover", "market", "monitor", "review"]).optional(),
  q: z.string().max(120).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
})

/** 任务列表筛选条件（列表与计数共用） */
function taskListConds(
  enterpriseId: string,
  userId: string,
  opts: z.infer<typeof taskListSchema> | { onlyMine?: boolean },
) {
  const conds: SQL[] = [eq(selectionTasks.enterpriseId, enterpriseId)]
  if ("onlyMine" in opts && opts.onlyMine) conds.push(eq(selectionTasks.userId, userId))
  const status = "status" in opts ? (opts.status ?? "all") : "all"
  if (status === "active") {
    conds.push(sql`${selectionTasks.status} in ('queued', 'processing')`)
  } else if (status !== "all") {
    conds.push(sql`${selectionTasks.status}::text = ${status}`)
  }
  const platform = "platform" in opts ? opts.platform : undefined
  if (platform && isSelectionPlatform(platform)) {
    conds.push(eq(selectionTasks.platform, platform))
  }
  const taskType = "taskType" in opts ? opts.taskType : undefined
  if (taskType) {
    conds.push(sql`${selectionTasks.taskType}::text = ${taskType}`)
  }
  const q = "q" in opts ? opts.q : undefined
  if (q && q.trim()) {
    const like = `%${q.trim()}%`
    conds.push(
      sql`(${selectionTasks.keyword} ilike ${like} or ${selectionTasks.errorMessage} ilike ${like})`,
    )
  }
  return and(...conds)
}

/**
 * 任务列表（企业共享；URL 驱动筛选 + 分页）。status 枚举列用 ::text 比较，
 * 避开全新库单事务迁移里枚举字面量的 unsafe use 坑。
 */
export async function getSelectionTasksAction(input?: unknown) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const q = taskListSchema.safeParse(input ?? {})
  if (!q.success) return { ok: false as const, error: "参数错误" }
  const enterpriseId = ctx.user.enterpriseId!
  const page = Math.max(1, Math.floor(q.data.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(q.data.pageSize ?? 20)))
  const where = taskListConds(enterpriseId, ctx.user.id, q.data)

  const [rows, [{ count }]] = await Promise.all([
    db
      .select({
        task: selectionTasks,
        creatorName: users.name,
        creatorUsername: users.username,
      })
      .from(selectionTasks)
      .leftJoin(users, eq(selectionTasks.userId, users.id))
      .where(where)
      .orderBy(desc(selectionTasks.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(selectionTasks)
      .where(where),
  ])

  return {
    ok: true as const,
    items: rows.map((r) => ({
      ...r.task,
      creatorName: r.creatorName || r.creatorUsername || null,
    })),
    total: count,
    page,
    pageSize,
  }
}

/**
 * 任务页概览：各状态任务数（状态标签角标）+ 当前用户今日已用任务数
 * （新建弹窗展示每日剩余额度，与 createTaskCore 的日限同口径）。
 */
export async function getSelectionTaskOverviewAction() {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const enterpriseId = ctx.user.enterpriseId!
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)

  const [statusRows, [{ todayUsed }]] = await Promise.all([
    db
      .select({
        status: sql<string>`case when ${selectionTasks.status}::text in ('queued','processing') then 'active' else ${selectionTasks.status}::text end`,
        count: sql<number>`count(*)::int`,
      })
      .from(selectionTasks)
      .where(eq(selectionTasks.enterpriseId, enterpriseId))
      .groupBy(
        sql`case when ${selectionTasks.status}::text in ('queued','processing') then 'active' else ${selectionTasks.status}::text end`,
      ),
    db
      .select({ todayUsed: sql<number>`count(*)::int` })
      .from(selectionTasks)
      .where(
        and(
          eq(selectionTasks.userId, ctx.user.id),
          gte(selectionTasks.createdAt, dayStart),
          // 只数手动提交的任务：竞品监控自动生成的 monitor/review 任务不占每日
          // 额度（与 createTaskCore 的日限同口径，弹窗「今日剩余」不再被监控顶满）
          inArray(selectionTasks.taskType, ["discover", "market"]),
        ),
      ),
  ])
  const counts: Record<string, number> = { active: 0, completed: 0, failed: 0, cancelled: 0, all: 0 }
  for (const r of statusRows) {
    counts[r.status] = r.count
    counts.all += r.count
  }
  return {
    ok: true as const,
    counts,
    todayUsed,
    dailyLimit: SELECTION_DAILY_TASK_LIMIT,
    creditsBalance: ctx.user.creditsBalance,
  }
}

/** 轻量状态轮询（任务页进度条/市场页横幅共用） */
export async function getSelectionTaskStatusesAction(ids: string[]) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  // 非法 uuid 过滤后再查（inArray 直塞非法串 PG 会 500），全非法/超量回空
  const validIds = parseUuidList(ids)
  if (validIds.length === 0 || validIds.length > 100) {
    return { ok: true as const, items: [] as Array<{ id: string; status: string; progress: number; fetchedCount: number }> }
  }
  const rows = await db
    .select({
      id: selectionTasks.id,
      status: selectionTasks.status,
      progress: selectionTasks.progress,
      fetchedCount: selectionTasks.fetchedCount,
    })
    .from(selectionTasks)
    .where(
      and(
        eq(selectionTasks.enterpriseId, ctx.user.enterpriseId!),
        inArray(selectionTasks.id, validIds),
      ),
    )
  return { ok: true as const, items: rows }
}

/** 收藏/取消收藏（toggle） */
export async function toggleSelectionBookmarkAction(resultId: string) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  if (parseUuid(resultId) == null) return { ok: false as const, error: "参数错误" }
  const [result] = await db
    .select({ id: selectionResults.id })
    .from(selectionResults)
    .where(
      and(
        eq(selectionResults.id, resultId),
        eq(selectionResults.enterpriseId, ctx.user.enterpriseId!),
      ),
    )
    .limit(1)
  if (!result) return { ok: false as const, error: "结果不存在" }

  const inserted = await db
    .insert(selectionBookmarks)
    .values({ userId: ctx.user.id, resultId })
    .onConflictDoNothing({ target: [selectionBookmarks.userId, selectionBookmarks.resultId] })
    .returning({ id: selectionBookmarks.id })
  if (inserted.length > 0) return { ok: true as const, bookmarked: true }

  await db
    .delete(selectionBookmarks)
    .where(
      and(
        eq(selectionBookmarks.userId, ctx.user.id),
        eq(selectionBookmarks.resultId, resultId),
      ),
    )
  return { ok: true as const, bookmarked: false }
}

const bookmarkPatchSchema = z.object({
  resultId: z.string().uuid(),
  notes: z.string().max(2000).nullable().optional(),
  customTags: z.array(z.string().trim().min(1).max(30)).max(10).nullable().optional(),
  collectionName: z.string().trim().max(100).nullable().optional(),
  priority: z.enum(["high", "medium", "low"]).nullable().optional(),
})

/** 编辑收藏（笔记/标签/集合/优先级） */
export async function updateSelectionBookmarkAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const q = bookmarkPatchSchema.safeParse(input)
  if (!q.success) {
    return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  }
  const { resultId, ...patch } = q.data
  const updated = await db
    .update(selectionBookmarks)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(selectionBookmarks.userId, ctx.user.id),
        eq(selectionBookmarks.resultId, resultId),
      ),
    )
    .returning({ id: selectionBookmarks.id })
  if (updated.length === 0) return { ok: false as const, error: "收藏不存在" }
  return { ok: true as const }
}

/** 批量移除收藏 */
export async function removeSelectionBookmarksAction(resultIds: string[]) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  // 过滤非法 uuid 后删除，全非法视同未选择
  const validIds = parseUuidList(resultIds)
  if (validIds.length === 0) {
    return { ok: false as const, error: "未选择收藏项" }
  }
  await db
    .delete(selectionBookmarks)
    .where(
      and(
        eq(selectionBookmarks.userId, ctx.user.id),
        inArray(selectionBookmarks.resultId, validIds.slice(0, 200)),
      ),
    )
  return { ok: true as const }
}

const bookmarkListSchema = z.object({
  /** 集合名；空串 = 未分组；缺省 = 全部 */
  collectionName: z.string().optional(),
  platform: z.string().optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  q: z.string().max(120).optional(),
  sort: z.enum(["newest", "price_asc", "price_desc", "sales_desc", "likes_desc"]).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
})

/** 收藏列表筛选条件（列表 / 计数共用；按用户隔离） */
function bookmarkConds(userId: string, enterpriseId: string, q: z.infer<typeof bookmarkListSchema>) {
  const conds: SQL[] = [
    eq(selectionBookmarks.userId, userId),
    eq(selectionResults.enterpriseId, enterpriseId),
  ]
  if (q.collectionName != null && q.collectionName !== "") {
    conds.push(eq(selectionBookmarks.collectionName, q.collectionName))
  } else if (q.collectionName === "") {
    // 空字符串 = 未分组集合
    conds.push(sql`${selectionBookmarks.collectionName} is null`)
  }
  if (q.platform && isSelectionPlatform(q.platform)) {
    conds.push(eq(selectionResults.platform, q.platform))
  }
  if (q.priority) {
    conds.push(eq(selectionBookmarks.priority, q.priority))
  }
  if (q.q && q.q.trim()) {
    const like = `%${q.q.trim()}%`
    conds.push(
      sql`(${selectionResults.title} ilike ${like} or ${selectionResults.content} ilike ${like} or ${selectionBookmarks.notes} ilike ${like})`,
    )
  }
  return and(...conds)
}

function bookmarkOrder(q: z.infer<typeof bookmarkListSchema>) {
  switch (q.sort) {
    case "price_asc":
      return sql`${selectionResults.price} asc nulls last, ${selectionBookmarks.createdAt} desc`
    case "price_desc":
      return sql`${selectionResults.price} desc nulls last, ${selectionBookmarks.createdAt} desc`
    case "sales_desc":
      return sql`coalesce(${selectionResults.salesCount}, 0) desc, ${selectionBookmarks.createdAt} desc`
    case "likes_desc":
      return sql`coalesce(${selectionResults.likesCount}, 0) desc, ${selectionBookmarks.createdAt} desc`
    default:
      return desc(selectionBookmarks.createdAt)
  }
}

/** 我的收藏列表（join 结果行；URL 驱动筛选 + 分页，结果投影 extras 不带 rawData） */
export async function listSelectionBookmarksAction(input?: unknown) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const parsed = bookmarkListSchema.safeParse(input ?? {})
  if (!parsed.success) return { ok: false as const, error: "参数错误" }
  const q = parsed.data
  const enterpriseId = ctx.user.enterpriseId!
  const page = Math.max(1, Math.floor(q.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(q.pageSize ?? 24)))
  const where = bookmarkConds(ctx.user.id, enterpriseId, q)

  const rowsQuery = (targetPage: number) =>
    db
      .select({ bookmark: selectionBookmarks, result: selectionResults })
      .from(selectionBookmarks)
      .innerJoin(selectionResults, eq(selectionBookmarks.resultId, selectionResults.id))
      .where(where)
      .orderBy(bookmarkOrder(q))
      .limit(pageSize)
      .offset((targetPage - 1) * pageSize)

  const [rows, [{ count }]] = await Promise.all([
    rowsQuery(page),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(selectionBookmarks)
      .innerJoin(selectionResults, eq(selectionBookmarks.resultId, selectionResults.id))
      .where(where),
  ])

  // 批量移除删光末页等场景：page 超出总页数时回落到实际末页（返回实际页码，
  // 客户端用它同步 state），仅在超界时补一次查询
  const totalPages = Math.max(1, Math.ceil(count / pageSize))
  const actualPage = Math.min(page, totalPages)
  const finalRows = actualPage === page ? rows : await rowsQuery(actualPage)

  return {
    ok: true as const,
    items: finalRows.map((r) => ({
      id: r.bookmark.id,
      resultId: r.bookmark.resultId,
      notes: r.bookmark.notes,
      customTags: r.bookmark.customTags,
      collectionName: r.bookmark.collectionName,
      priority: r.bookmark.priority,
      createdAt: r.bookmark.createdAt,
      updatedAt: r.bookmark.updatedAt,
      result: resultRowToItem(r.result),
    })),
    total: count,
    page: actualPage,
    pageSize,
  }
}

const batchBookmarkSchema = z.object({
  resultIds: z.array(z.string()).min(1).max(200),
  /** 归入集合（空串 = 移出分组）；缺省不改 */
  collectionName: z.string().max(100).optional(),
  /** 设优先级；缺省不改 */
  priority: z.enum(["high", "medium", "low"]).nullable().optional(),
})

/** 批量整理收藏：归入集合 / 设优先级（我的选品批量条） */
export async function batchUpdateSelectionBookmarksAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const q = batchBookmarkSchema.safeParse(input)
  if (!q.success) {
    return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  }
  const validIds = parseUuidList(q.data.resultIds)
  if (validIds.length === 0) return { ok: false as const, error: "未选择收藏项" }
  const set: { updatedAt: Date; collectionName?: string | null; priority?: "high" | "medium" | "low" | null } = {
    updatedAt: new Date(),
  }
  if (q.data.collectionName != null) {
    set.collectionName = q.data.collectionName.trim() || null
  }
  if (q.data.priority !== undefined) set.priority = q.data.priority
  const updated = await db
    .update(selectionBookmarks)
    .set(set)
    .where(
      and(
        eq(selectionBookmarks.userId, ctx.user.id),
        inArray(selectionBookmarks.resultId, validIds),
      ),
    )
    .returning({ id: selectionBookmarks.id })
  return { ok: true as const, updated: updated.length }
}

/** 集合清单（名称 + 计数） */
export async function listSelectionCollectionsAction() {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const rows = await db
    .select({
      name: selectionBookmarks.collectionName,
      count: sql<number>`count(*)::int`,
    })
    .from(selectionBookmarks)
    .where(eq(selectionBookmarks.userId, ctx.user.id))
    .groupBy(selectionBookmarks.collectionName)
  return { ok: true as const, items: rows }
}

/** 收藏导出（ExcelJS base64，对齐库存导出形态）；入参与列表筛选同构（见 bookmarkListSchema） */
export async function exportSelectionBookmarksExcelAction(opts?: {
  collectionName?: string
  platform?: string
  priority?: "high" | "medium" | "low"
  q?: string
  sort?: "newest" | "price_asc" | "price_desc" | "sales_desc" | "likes_desc"
}): Promise<
  { ok: true; base64: string; filename: string } | { ok: false; error: string }
> {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  // 复用列表的筛选与排序口径：此前只认集合名，按平台/优先级/关键词筛完导出的
  // 是全部收藏，与「导出」按钮的禁用态（按筛选后条数）相矛盾
  const parsed = bookmarkListSchema.safeParse(opts ?? {})
  if (!parsed.success) return { ok: false, error: "参数错误" }
  const q = parsed.data

  const rows = await db
    .select({ bookmark: selectionBookmarks, result: selectionResults })
    .from(selectionBookmarks)
    .innerJoin(selectionResults, eq(selectionBookmarks.resultId, selectionResults.id))
    .where(bookmarkConds(ctx.user.id, ctx.user.enterpriseId!, q))
    .orderBy(bookmarkOrder(q))
    .limit(5000)

  const platformLabel = (p: string) =>
    isSelectionPlatform(p) ? SELECTION_PLATFORM_CONFIGS[p].label : p

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("我的选品")
  ws.columns = [
    { header: "平台", key: "platform", width: 14 },
    { header: "标题/内容", key: "title", width: 50 },
    { header: "价格", key: "price", width: 10 },
    { header: "币种", key: "currency", width: 8 },
    { header: "评分", key: "rating", width: 8 },
    { header: "评论数", key: "reviewCount", width: 10 },
    { header: "销量", key: "salesCount", width: 10 },
    { header: "点赞", key: "likesCount", width: 10 },
    { header: "链接", key: "url", width: 46 },
    { header: "集合", key: "collection", width: 16 },
    { header: "优先级", key: "priority", width: 10 },
    { header: "笔记", key: "notes", width: 40 },
    { header: "收藏时间", key: "createdAt", width: 20 },
  ]
  for (const r of rows) {
    ws.addRow({
      platform: platformLabel(r.result.platform),
      title: (r.result.title ?? r.result.content ?? "").slice(0, 300),
      price: r.result.price != null ? Number(r.result.price) : null,
      currency: r.result.currency,
      rating: r.result.rating != null ? Number(r.result.rating) : null,
      reviewCount: r.result.reviewCount,
      salesCount: r.result.salesCount,
      likesCount: r.result.likesCount,
      url: r.result.sourceUrl,
      collection: r.bookmark.collectionName,
      priority: r.bookmark.priority,
      notes: r.bookmark.notes,
      createdAt: r.bookmark.createdAt.toISOString().slice(0, 19).replace("T", " "),
    })
  }

  const buf = await wb.xlsx.writeBuffer()
  return {
    ok: true as const,
    base64: Buffer.from(buf).toString("base64"),
    filename: `我的选品_${new Date().toISOString().slice(0, 10)}.xlsx`,
  }
}

/* ── 数据池（选品发现 / 市场分析：平台标签视图，商品 / 帖子维度去重） ─────── */

/**
 * 平台标签视图入口参数（两页共用）：平台必填（没有「全部平台」聚合视图），
 * 传入 category 时校验平台属于该页面类别。
 */
const poolQuerySchema = z.object({
  platform: z.string().min(1),
  category: z.enum(["ecommerce", "social"]).optional(),
  country: z.string().max(16).optional(),
  taskType: z.enum(["discover", "market", "monitor"]).optional(),
  taskId: z.string().uuid().optional(),
  q: z.string().max(120).optional(),
  sort: z.string().optional(),
  dedupe: z.boolean().optional(),
  /** 抓取日期范围（YYYY-MM-DD，含端点；按 scraped_at 过滤；须为真实日期） */
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isCalendarDate, "日期不存在")
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isCalendarDate, "日期不存在")
    .optional(),
  page: z.number().int().min(1).optional(),
  // 前端分页选项为 25/50/100，上限与之对齐
  pageSize: z.number().int().min(1).max(100).optional(),
})

type PoolQuery = z.infer<typeof poolQuerySchema>

interface ResolvedPoolQuery {
  q: PoolQuery
  platform: SelectionPlatform
  /** 排序键：只接受该平台视图声明的项，其余回落「最新抓取」 */
  sort: PoolSort
  page: number
  pageSize: number
  dedupeOn: boolean
}

type PoolQueryResult =
  | ({ ok: true } & ResolvedPoolQuery)
  | { ok: false; error: string }

/** 解析 + 校验平台标签视图参数（列表 / 统计共用口径） */
function resolvePoolQuery(input: unknown): PoolQueryResult {
  const parsed = poolQuerySchema.safeParse(input ?? {})
  if (!parsed.success) return { ok: false, error: "参数错误" }
  const q = parsed.data
  if (!isSelectionPlatform(q.platform)) return { ok: false, error: "不支持的平台" }
  if (q.category && !platformsForCategory(q.category).includes(q.platform)) {
    return { ok: false, error: "平台与页面类别不匹配" }
  }
  const view = platformView(q.platform)
  const sort: PoolSort =
    q.sort && isPoolSort(q.sort) && view.sorts.includes(q.sort) ? q.sort : "newest"
  return {
    ok: true,
    q,
    platform: q.platform,
    sort,
    page: Math.max(1, Math.floor(q.page ?? 1)),
    pageSize: Math.min(100, Math.max(1, Math.floor(q.pageSize ?? 25))),
    dedupeOn: q.dedupe !== false,
  }
}

/**
 * 数据池筛选条件（列表 / KPI 统计共用）。按平台过滤恒在最前——标签视图内
 * 只看当前平台的数据。
 */
function poolConds(enterpriseId: string, platform: string, q: PoolQuery): SQL[] {
  const conds: SQL[] = [
    sql`sr.enterprise_id = ${enterpriseId}`,
    sql`sr.platform = ${platform}`,
  ]
  if (q.country) {
    conds.push(sql`sr.country = ${q.country.toUpperCase()}`)
  }
  if (q.taskType) {
    conds.push(sql`sr.task_type = ${q.taskType}`)
  }
  if (q.taskId) {
    conds.push(sql`sr.task_id = ${q.taskId}`)
  }
  if (q.q && q.q.trim()) {
    const like = `%${q.q.trim()}%`
    conds.push(sql`(sr.title ilike ${like} or sr.content ilike ${like})`)
  }
  if (q.dateFrom) {
    conds.push(sql`sr.scraped_at >= ${q.dateFrom}::date`)
  }
  if (q.dateTo) {
    conds.push(sql`sr.scraped_at < (${q.dateTo}::date + interval '1 day')`)
  }
  return conds
}

/**
 * 去重子查询：按（平台, external_id‖dedupe_key）开窗取一条——同款商品多任务
 * 重复抓取只出一张卡。发现 / 市场任务行优先于监控重抓行（后者字段较少，如 TEMU
 * 单品详情无销量），同类按入库时间取最新。
 */
function dedupedInnerSql(conds: SQL[], dedupeOn: boolean): SQL {
  const whereSql = sql.join(conds, sql` and `)
  return dedupeOn
    ? sql`select sr.*, row_number() over (partition by sr.platform, coalesce(sr.external_id, sr.dedupe_key) order by coalesce(sr.task_type = 'monitor', false) asc, sr.created_at desc) as rn from selection_result sr where ${whereSql}`
    : sql`select sr.* from selection_result sr where ${whereSql}`
}

function poolOrderSql(sort: PoolSort): SQL {
  // 每个分支末尾统一追加 t.id 作唯一兜底键：同一任务的结果行整批入库、created_at
  // 完全相同，指标并列时无兜底键的分页排序每页不同（后页重复前页卡片、部分行翻不到）
  switch (sort) {
    case "rank_asc":
      return sql`t.rank asc nulls last, t.created_at desc, t.id`
    case "sales_desc":
      return sql`coalesce(t.sales_count, 0) desc, t.id`
    case "price_asc":
      return sql`t.price asc nulls last, t.id`
    case "price_desc":
      return sql`t.price desc nulls last, t.id`
    case "rating_desc":
      return sql`t.rating desc nulls last, t.id`
    case "reviews_desc":
      return sql`coalesce(t.review_count, 0) desc, t.id`
    case "likes_desc":
      return sql`coalesce(t.likes_count, 0) desc, t.id`
    case "comments_desc":
      return sql`coalesce(t.comments_count, 0) desc, t.id`
    case "shares_desc":
      return sql`coalesce(t.shares_count, 0) desc, t.id`
    case "views_desc":
      return sql`coalesce(t.views_count, 0) desc, t.id`
    default:
      return sql`t.created_at desc, t.id`
  }
}

/**
 * 数据池分页查询（选品发现 / 市场分析平台标签视图）。列表项由服务端投影 extras、
 * 不携带 rawData（原始行在详情弹窗按需拉取，见 getResultRawDataAction）。
 */
export async function getSelectionResultsPoolAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const resolved = resolvePoolQuery(input)
  if (!resolved.ok) return { ok: false as const, error: resolved.error }
  const enterpriseId = ctx.user.enterpriseId!
  const { q, platform, sort, page, pageSize, dedupeOn } = resolved
  const offset = (page - 1) * pageSize
  const whereSql = sql.join(poolConds(enterpriseId, platform, q), sql` and `)
  const innerSql = dedupedInnerSql(poolConds(enterpriseId, platform, q), dedupeOn)

  const rowsRaw = (await db.execute(
    sql`select t.id, t.task_id, t.platform, t.country, t.task_type, t.external_id, t.source_url,
        t.dedupe_key, t.title, t.content, t.price, t.original_price, t.currency, t.rating,
        t.review_count, t.sales_count, t.likes_count, t.comments_count, t.shares_count,
        t.views_count, t.rank, t.seller_name, t.images, t.videos, t.category, t.category_path,
        t.tags, t.hashtags, t.published_at, t.scraped_at, t.created_at, t.raw_data
      from (${innerSql}) t ${dedupeOn ? sql`where t.rn = 1` : sql``}
      order by ${poolOrderSql(sort)} limit ${pageSize} offset ${offset}`,
  )) as unknown as Array<Record<string, unknown>>
  const countRes = (await db.execute(
    dedupeOn
      ? sql`select count(*)::int as count from (select distinct sr.platform, coalesce(sr.external_id, sr.dedupe_key) as k from selection_result sr where ${whereSql}) c`
      : sql`select count(*)::int as count from selection_result sr where ${whereSql}`,
  )) as unknown as Array<{ count: number }>
  const total = Number(countRes[0]?.count ?? 0)

  const items = rowsRaw.map((row) => rawPoolRowToItem(row))

  // 来源任务关键词（详情弹窗「来源任务」展示）+ 当前页收藏态
  const resultIds = items.map((i) => i.id)
  const taskIds = [...new Set(items.map((i) => i.taskId))]
  const [keywordRows, bookmarkRows] = await Promise.all([
    taskIds.length
      ? db
          .select({ id: selectionTasks.id, keyword: selectionTasks.keyword })
          .from(selectionTasks)
          .where(
            and(
              eq(selectionTasks.enterpriseId, enterpriseId),
              inArray(selectionTasks.id, taskIds),
            ),
          )
      : Promise.resolve([] as Array<{ id: string; keyword: string | null }>),
    resultIds.length
      ? db
          .select({ resultId: selectionBookmarks.resultId })
          .from(selectionBookmarks)
          .where(
            and(
              eq(selectionBookmarks.userId, ctx.user.id),
              inArray(selectionBookmarks.resultId, resultIds),
            ),
          )
      : Promise.resolve([] as Array<{ resultId: string }>),
  ])
  const keywordMap = new Map(keywordRows.map((r) => [r.id, r.keyword]))
  for (const item of items) item.taskKeyword = keywordMap.get(item.taskId) ?? null
  const bookmarkedIds = new Set(bookmarkRows.map((r) => r.resultId))

  // 企业内已监控目标（卡片「竞品监控」按钮态）：按平台原生 ID 匹配
  const monitorRows = await db
    .select({ externalId: selectionMonitors.externalId, targetUrl: selectionMonitors.targetUrl })
    .from(selectionMonitors)
    .where(eq(selectionMonitors.enterpriseId, enterpriseId))
    .limit(1000)

  return {
    ok: true as const,
    items,
    total,
    page,
    pageSize,
    sort,
    bookmarkedIds: [...bookmarkedIds],
    monitoredUrls: monitorRows.map((r) => r.targetUrl),
    monitoredIds: monitorRows.map((r) => r.externalId).filter((v): v is string => v != null),
    dedupe: dedupeOn,
  }
}

/** 详情弹窗「原始数据」按需拉取（列表项不携带 rawData） */
export async function getResultRawDataAction(resultId: string) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  if (parseUuid(resultId) == null) return { ok: false as const, error: "参数错误" }
  const [row] = await db
    .select({ rawData: selectionResults.rawData })
    .from(selectionResults)
    .where(
      and(
        eq(selectionResults.id, resultId),
        eq(selectionResults.enterpriseId, ctx.user.enterpriseId!),
      ),
    )
    .limit(1)
  if (!row) return { ok: false as const, error: "结果不存在" }
  return { ok: true as const, rawData: row.rawData as Record<string, unknown> }
}

/**
 * 平台标签视图 KPI 统计（随筛选联动）：条数 / 均价 / 平均评分 / 各互动列合计，
 * 口径与列表去重一致。均价只按主币种（众数）计算，避免多站点数据把美元与
 * 英镑混算。各平台取自己有意义的字段（见 platform-views）。
 */
export async function getSelectionPoolStatsAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const resolved = resolvePoolQuery(input)
  if (!resolved.ok) return { ok: false as const, error: resolved.error }
  const enterpriseId = ctx.user.enterpriseId!
  const innerSql = dedupedInnerSql(
    poolConds(enterpriseId, resolved.platform, resolved.q),
    resolved.dedupeOn,
  )
  const deduped = sql`(${innerSql}) t ${resolved.dedupeOn ? sql`where t.rn = 1` : sql``}`

  const [rowsRaw, priceRows] = await Promise.all([
    db.execute(
      sql`select count(*)::int as count,
        avg(t.rating)::float8 as avg_rating,
        coalesce(sum(coalesce(t.review_count, 0)), 0)::bigint as sum_reviews,
        coalesce(sum(coalesce(t.sales_count, 0)), 0)::bigint as sum_sales,
        coalesce(sum(coalesce(t.likes_count, 0)), 0)::bigint as sum_likes,
        coalesce(sum(coalesce(t.comments_count, 0)), 0)::bigint as sum_comments,
        coalesce(sum(coalesce(t.shares_count, 0)), 0)::bigint as sum_shares,
        coalesce(sum(coalesce(t.views_count, 0)), 0)::bigint as sum_views
      from ${deduped}`,
    ) as unknown as Promise<
      Array<{
        count: number
        avg_rating: number | null
        sum_reviews: string | number
        sum_sales: string | number
        sum_likes: string | number
        sum_comments: string | number
        sum_shares: string | number
        sum_views: string | number
      }>
    >,
    // 主币种（有价格的商品里出现最多的币种）及其均价；无价格为空。
    // deduped 已带 where rn=1，这里再包一层子查询追加价格过滤
    db.execute(
      sql`select p.currency, avg(p.price)::float8 as avg_price
        from (select coalesce(nullif(t.currency, ''), 'USD') as currency, t.price from ${deduped}) p
        where p.price is not null
        group by p.currency
        order by count(*) desc, p.currency
        limit 1`,
    ) as unknown as Promise<Array<{ currency: string; avg_price: number | null }>>,
  ])
  const r = rowsRaw[0]
  // 全空列（如社媒的销量）聚合为 0，按「无此指标」归一为 null
  const sumOrNull = (v: string | number | null | undefined) => {
    const n = Number(v ?? 0)
    return n > 0 ? n : null
  }
  const stats: PoolStats = {
    count: Number(r?.count ?? 0),
    currency: priceRows[0]?.currency ?? null,
    avgPrice:
      priceRows[0]?.avg_price != null ? Math.round(priceRows[0].avg_price * 100) / 100 : null,
    avgRating: r?.avg_rating != null ? Math.round(r.avg_rating * 100) / 100 : null,
    sumReviews: sumOrNull(r?.sum_reviews),
    sumSales: sumOrNull(r?.sum_sales),
    sumLikes: sumOrNull(r?.sum_likes),
    sumComments: sumOrNull(r?.sum_comments),
    sumShares: sumOrNull(r?.sum_shares),
    sumViews: sumOrNull(r?.sum_views),
  }
  return { ok: true as const, stats }
}

/**
 * 各平台去重后的条数（平台标签角标 + 市场分析页缺省标签选择）。
 * 按页面类别返回该类别全部平台，无数据为 0。
 */
export async function getSelectionPoolCountsAction(input?: unknown) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const enterpriseId = ctx.user.enterpriseId!
  const category: PlatformCategory =
    typeof input === "object" && input != null && "category" in input
      ? ((input as { category: unknown }).category === "social" ? "social" : "ecommerce")
      : "ecommerce"
  const list = platformsForCategory(category)
  const rowsRaw = (await db.execute(
    sql`select t.platform, count(*)::int as count from (
        select sr.platform, row_number() over (partition by sr.platform, coalesce(sr.external_id, sr.dedupe_key) order by coalesce(sr.task_type = 'monitor', false) asc, sr.created_at desc) as rn
        from selection_result sr
        where sr.enterprise_id = ${enterpriseId} and sr.platform in (${sql.join(list.map((p) => sql`${p}`), sql`, `)})
      ) t where t.rn = 1 group by t.platform`,
  )) as unknown as Array<{ platform: string; count: number }>
  const counts: Record<string, number> = Object.fromEntries(list.map((p) => [p, 0]))
  for (const r of rowsRaw) counts[r.platform] = Number(r.count)
  return { ok: true as const, counts }
}

/**
 * 数据池筛选元信息：当前平台已出现的国家 + 该平台最近完成的任务（来源任务
 * 下拉）。社媒平台无国家维度（恒空），调用方据此隐藏国家筛选。
 */
export async function getSelectionPoolMetaAction(input?: unknown) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const enterpriseId = ctx.user.enterpriseId!
  const platform =
    typeof input === "object" && input != null && "platform" in input
      ? String((input as { platform: unknown }).platform)
      : ""
  if (!isSelectionPlatform(platform)) return { ok: false as const, error: "不支持的平台" }

  const [countryRows, taskRows] = await Promise.all([
    db
      .selectDistinct({ country: selectionResults.country })
      .from(selectionResults)
      .where(
        and(
          eq(selectionResults.enterpriseId, enterpriseId),
          eq(selectionResults.platform, platform),
          isNotNull(selectionResults.country),
        ),
      ),
    db
      .select({
        id: selectionTasks.id,
        platform: selectionTasks.platform,
        taskType: selectionTasks.taskType,
        keyword: selectionTasks.keyword,
        country: selectionTasks.country,
        fetchedCount: selectionTasks.fetchedCount,
        completedAt: selectionTasks.completedAt,
      })
      .from(selectionTasks)
      .where(
        and(
          eq(selectionTasks.enterpriseId, enterpriseId),
          eq(selectionTasks.platform, platform),
          eq(selectionTasks.status, "completed"),
          // 只列会写入数据池的任务：评论任务只进 selection_review（选中后列表必为
          // 空）、监控任务挤占 30 条名额，把用户真正的发现/市场任务顶出下拉
          inArray(selectionTasks.taskType, ["discover", "market"]),
          sql`${selectionTasks.fetchedCount} > 0`,
        ),
      )
      .orderBy(desc(selectionTasks.completedAt))
      .limit(30),
  ])

  return {
    ok: true as const,
    countries: countryRows.map((r) => r.country).filter((c): c is string => c != null),
    tasks: taskRows,
  }
}
