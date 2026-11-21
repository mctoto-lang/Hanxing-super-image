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
import { deductUserCredits } from "@/server/services/credits-service"
import { settleSelectionTask } from "@/server/services/selection-service"
import { buildActorInput } from "@/lib/selection/input-builders"
import {
  SELECTION_DAILY_TASK_LIMIT,
  SELECTION_KEYWORD_MAX_LEN,
  SELECTION_PLATFORM_CONFIGS,
  estimateCredits,
  getFormFields,
  isSelectionPlatform,
  type PlatformField,
  type SelectionPlatform,
} from "@/lib/selection/platforms"
import { resolveSelectionToken } from "@/lib/selection/provider-config"
import { parseUuid, parseUuidList } from "@/lib/selection/ids"
import {
  POOL_SORTS,
  rawPoolRowToItem,
  type SelectionPoolItem,
} from "@/lib/selection/pool-types"

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

/** 按注册表字段声明清洗表单参数（必填/枚举/数字范围），越权键丢弃 */
function sanitizeParams(
  fields: PlatformField[],
  raw: unknown,
): { ok: true; params: Record<string, string | number> } | { ok: false; error: string } {
  if (raw != null && typeof raw !== "object") {
    return { ok: false, error: "参数格式错误" }
  }
  const input = (raw ?? {}) as Record<string, unknown>
  const out: Record<string, string | number> = {}
  for (const f of fields) {
    const v = input[f.key]
    if (v == null || v === "") {
      if (f.required) return { ok: false, error: `请填写「${f.label}」` }
      if (f.defaultValue != null) out[f.key] = f.defaultValue
      continue
    }
    if (f.type === "number") {
      const n = Number(v)
      if (!Number.isFinite(n)) return { ok: false, error: `「${f.label}」须为数字` }
      if (f.min != null && n < f.min) return { ok: false, error: `「${f.label}」不得小于 ${f.min}` }
      if (f.max != null && n > f.max) return { ok: false, error: `「${f.label}」不得大于 ${f.max}` }
      out[f.key] = n
      continue
    }
    const s = String(v).trim()
    if (s.length === 0) {
      if (f.required) return { ok: false, error: `请填写「${f.label}」` }
      continue
    }
    if (s.length > SELECTION_KEYWORD_MAX_LEN) {
      return { ok: false, error: `「${f.label}」过长（≤${SELECTION_KEYWORD_MAX_LEN} 字符）` }
    }
    if (f.type === "select" && f.options && !f.options.some((o) => o.value === s)) {
      return { ok: false, error: `「${f.label}」取值无效` }
    }
    out[f.key] = s
  }
  return { ok: true, params: out }
}

const createTaskSchema = z.object({
  platform: z.string().min(1),
  taskType: z.enum(["discover", "market"]),
  maxResults: z.number().int().min(1).max(2000),
  params: z.record(z.string(), z.unknown()).optional(),
})

/** 创建核心（create 与 retry 共用）：校验/清洗/日限 → 单事务入库+预扣 */
async function createTaskCore(
  ctx: UserContext,
  input: {
    platform: SelectionPlatform
    taskType: "discover" | "market"
    params: Record<string, unknown>
    maxResults: number
    label: string
  },
): Promise<{ ok: true; taskId: string; estimatedCredits: number } | { ok: false; error: string }> {
  const enterpriseId = ctx.user.enterpriseId!
  // 凭证解析（企业 provider → 平台 APIFY_API_TOKEN 兜底）；providerId 快照到
  // 任务行，worker 启动/收割按快照取同一 token（dataset 归属启动账号）
  const cred = await resolveSelectionToken({ enterpriseId })
  if (!cred) {
    return {
      ok: false as const,
      error: "企业未配置选品抓取凭证（请联系超管在平台管理配置 Apify Token）",
    }
  }
  const cfg = SELECTION_PLATFORM_CONFIGS[input.platform]

  const fields = getFormFields(input.platform, input.taskType)
  const sanitized = sanitizeParams(fields, input.params)
  if (!sanitized.ok) return { ok: false as const, error: sanitized.error }
  const params = sanitized.params

  const maxResults = Math.min(
    Math.max(input.maxResults, cfg.minResults),
    cfg.maxResultsPerTask,
  )

  const built = buildActorInput({
    platform: input.platform,
    taskType: input.taskType,
    params,
    maxResults,
  })
  const estimatedCredits = estimateCredits(input.platform, input.taskType, maxResults)

  const outcome = await db
    .transaction(async (tx) => {
      // 每日任务数上限（自然日，服务器本地时区）：count+insert 放进同一事务，
      // 前置 pg advisory 事务锁串行化同用户并发创建（盐隔离其他用途的锁；
      // 锁随事务结束自动释放），避免先查后插被并发突破日限
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${ctx.user.id} || ':selection:daily'))`,
      )
      const dayStart = new Date()
      dayStart.setHours(0, 0, 0, 0)
      const [{ count: todayCount }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(selectionTasks)
        .where(
          and(
            eq(selectionTasks.userId, ctx.user.id),
            gte(selectionTasks.createdAt, dayStart),
          ),
        )
      if (todayCount >= SELECTION_DAILY_TASK_LIMIT) {
        return {
          ok: false as const,
          error: `今日任务数已达上限（${SELECTION_DAILY_TASK_LIMIT} 个/天）`,
        }
      }
      const [t] = await tx
        .insert(selectionTasks)
        .values({
          enterpriseId,
          userId: ctx.user.id,
          taskType: input.taskType,
          platform: input.platform,
          actorId: built.actorId,
          searchParams: params,
          keyword: built.keyword.slice(0, SELECTION_KEYWORD_MAX_LEN),
          country: built.country,
          providerId: cred.providerId,
          maxResults,
          estimatedCredits,
          status: "queued",
        })
        .returning({ id: selectionTasks.id })
      await deductUserCredits({
        enterpriseId,
        userId: ctx.user.id,
        amount: estimatedCredits,
        taskId: t!.id,
        type: "selection_deduct",
        remark: `选品任务：${input.label}「${built.keyword.slice(0, 60)}」×${maxResults}`,
        tx,
      })
      return { ok: true as const, taskId: t!.id }
    })

  if (!outcome.ok) return outcome
  return { ok: true as const, taskId: outcome.taskId, estimatedCredits }
}

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
  return createTaskCore(ctx, {
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
  if (!isSelectionPlatform(task.platform)) {
    return { ok: false as const, error: "任务平台已下线" }
  }
  return createTaskCore(ctx, {
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

/** 任务列表（企业共享；status=active 含 queued+processing） */
export async function getSelectionTasksAction(opts?: {
  status?: "active" | "completed" | "failed" | "cancelled" | "all"
  platform?: string
  page?: number
  pageSize?: number
}) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const page = Math.max(1, Math.floor(opts?.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts?.pageSize ?? 20)))

  const conds = [eq(selectionTasks.enterpriseId, ctx.user.enterpriseId!)]
  const status = opts?.status ?? "all"
  if (status === "active") {
    conds.push(inArray(selectionTasks.status, ["queued", "processing"]))
  } else if (status !== "all") {
    conds.push(
      eq(
        selectionTasks.status,
        status as (typeof selectionTasks.$inferSelect)["status"],
      ),
    )
  }
  if (opts?.platform && isSelectionPlatform(opts.platform)) {
    conds.push(eq(selectionTasks.platform, opts.platform))
  }
  const where = and(...conds)

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

/** 任务结果分页（企业隔离校验） */
export async function getSelectionTaskResultsAction(
  taskId: string,
  opts?: { page?: number; pageSize?: number; order?: "default" | "sales" | "price_asc" | "price_desc" | "likes" },
) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  if (parseUuid(taskId) == null) return { ok: false as const, error: "参数错误" }
  const [task] = await db
    .select({ id: selectionTasks.id, platform: selectionTasks.platform })
    .from(selectionTasks)
    .where(
      and(
        eq(selectionTasks.id, taskId),
        eq(selectionTasks.enterpriseId, ctx.user.enterpriseId!),
      ),
    )
    .limit(1)
  if (!task) return { ok: false as const, error: "任务不存在" }

  const page = Math.max(1, Math.floor(opts?.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts?.pageSize ?? 50)))
  const order =
    opts?.order === "sales"
      ? desc(sql`coalesce(${selectionResults.salesCount}, 0)`)
      : opts?.order === "price_asc"
        ? sql`${selectionResults.price} asc nulls last`
        : opts?.order === "price_desc"
          ? sql`${selectionResults.price} desc nulls last`
          : opts?.order === "likes"
            ? desc(sql`coalesce(${selectionResults.likesCount}, 0)`)
            : desc(selectionResults.createdAt)

  const [rows, [{ count }]] = await Promise.all([
    db
      .select()
      .from(selectionResults)
      .where(eq(selectionResults.taskId, taskId))
      .orderBy(order)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(selectionResults)
      .where(eq(selectionResults.taskId, taskId)),
  ])
  return { ok: true as const, items: rows, total: count, page, pageSize }
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

/** 我的收藏列表（join 结果行） */
export async function listSelectionBookmarksAction(opts?: {
  collectionName?: string
  page?: number
  pageSize?: number
}) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const page = Math.max(1, Math.floor(opts?.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts?.pageSize ?? 24)))

  const conds = [
    eq(selectionBookmarks.userId, ctx.user.id),
    eq(selectionResults.enterpriseId, ctx.user.enterpriseId!),
  ]
  if (opts?.collectionName != null && opts.collectionName !== "") {
    conds.push(eq(selectionBookmarks.collectionName, opts.collectionName))
  } else if (opts?.collectionName === "") {
    // 空字符串 = 未分组集合
    conds.push(sql`${selectionBookmarks.collectionName} is null`)
  }
  const where = and(...conds)

  const rowsQuery = (targetPage: number) =>
    db
      .select({ bookmark: selectionBookmarks, result: selectionResults })
      .from(selectionBookmarks)
      .innerJoin(selectionResults, eq(selectionBookmarks.resultId, selectionResults.id))
      .where(where)
      .orderBy(desc(selectionBookmarks.createdAt))
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
    items: finalRows.map((r) => ({ ...r.bookmark, result: r.result })),
    total: count,
    page: actualPage,
    pageSize,
  }
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

/** 收藏导出（ExcelJS base64，对齐库存导出形态） */
export async function exportSelectionBookmarksExcelAction(opts?: {
  collectionName?: string
}): Promise<
  { ok: true; base64: string; filename: string } | { ok: false; error: string }
> {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)

  const conds = [
    eq(selectionBookmarks.userId, ctx.user.id),
    eq(selectionResults.enterpriseId, ctx.user.enterpriseId!),
  ]
  if (opts?.collectionName != null && opts.collectionName !== "") {
    conds.push(eq(selectionBookmarks.collectionName, opts.collectionName))
  } else if (opts?.collectionName === "") {
    conds.push(sql`${selectionBookmarks.collectionName} is null`)
  }

  const rows = await db
    .select({ bookmark: selectionBookmarks, result: selectionResults })
    .from(selectionBookmarks)
    .innerJoin(selectionResults, eq(selectionBookmarks.resultId, selectionResults.id))
    .where(and(...conds))
    .orderBy(desc(selectionBookmarks.createdAt))
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

/* ── 数据池（选品发现：跨任务综合展示，商品维度去重） ─────────── */

function drizzleResultToItem(r: typeof selectionResults.$inferSelect): SelectionPoolItem {
  return {
    id: r.id,
    taskId: r.taskId,
    platform: r.platform,
    country: r.country,
    taskType: r.taskType,
    externalId: r.externalId,
    sourceUrl: r.sourceUrl,
    title: r.title,
    content: r.content,
    price: r.price,
    originalPrice: r.originalPrice,
    currency: r.currency,
    rating: r.rating,
    reviewCount: r.reviewCount,
    salesCount: r.salesCount,
    likesCount: r.likesCount,
    commentsCount: r.commentsCount,
    sharesCount: r.sharesCount,
    viewsCount: r.viewsCount,
    sellerName: r.sellerName,
    images: r.images,
    videos: r.videos,
    category: r.category,
    categoryPath: r.categoryPath,
    tags: r.tags,
    hashtags: r.hashtags,
    publishedAt: r.publishedAt,
    scrapedAt: r.scrapedAt,
    createdAt: r.createdAt,
    rawData: r.rawData as Record<string, unknown>,
  }
}

const poolQuerySchema = z.object({
  platform: z.string().optional(),
  country: z.string().max(16).optional(),
  taskType: z.enum(["discover", "market", "monitor"]).optional(),
  taskId: z.string().uuid().optional(),
  q: z.string().max(120).optional(),
  sort: z.enum(POOL_SORTS).optional(),
  dedupe: z.boolean().optional(),
  /** 抓取日期范围（YYYY-MM-DD，含端点；按 scraped_at 过滤） */
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** 平台类别过滤：ecommerce=选品发现页（仅电商）、social=市场分析页（仅社媒） */
  category: z.enum(["ecommerce", "social"]).optional(),
  page: z.number().int().min(1).optional(),
  // 前端分页选项为 25/50/100，上限与之对齐（曾为 60，选 100 条/页会整页报参数错误）
  pageSize: z.number().int().min(1).max(100).optional(),
})

/**
 * 数据池分页查询（选品发现页）：
 * 企业域跨任务合并；dedupe=true（默认）按（平台, externalId‖dedupeKey）开窗
 * 取最新一条——同款商品多任务重复抓取只出一张卡。
 * 去重查询走原生 SQL 窗口函数（drizzle 构造器表达不了 row_number）。
 */
export async function getSelectionResultsPoolAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const q = poolQuerySchema.safeParse(input ?? {})
  if (!q.success) return { ok: false as const, error: "参数错误" }
  const enterpriseId = ctx.user.enterpriseId!
  const page = q.data.page ?? 1
  const pageSize = q.data.pageSize ?? 24
  const offset = (page - 1) * pageSize
  const dedupeOn = q.data.dedupe !== false

  const conds: SQL[] = [sql`sr.enterprise_id = ${enterpriseId}`]
  if (q.data.platform && isSelectionPlatform(q.data.platform)) {
    conds.push(sql`sr.platform = ${q.data.platform}`)
  }
  if (q.data.country) {
    conds.push(sql`sr.country = ${q.data.country.toUpperCase()}`)
  }
  if (q.data.taskType) {
    conds.push(sql`sr.task_type = ${q.data.taskType}`)
  }
  if (q.data.taskId) {
    conds.push(sql`sr.task_id = ${q.data.taskId}`)
  }
  if (q.data.q && q.data.q.trim()) {
    const like = `%${q.data.q.trim()}%`
    conds.push(sql`(sr.title ilike ${like} or sr.content ilike ${like})`)
  }
  if (q.data.category) {
    conds.push(
      q.data.category === "ecommerce"
        ? sql`sr.platform in ('amazon','etsy','temu','shopify')`
        : sql`sr.platform in ('instagram','tiktok','pinterest','reddit','x','facebook')`,
    )
  }
  if (q.data.dateFrom) {
    conds.push(sql`sr.scraped_at >= ${q.data.dateFrom}::date`)
  }
  if (q.data.dateTo) {
    conds.push(sql`sr.scraped_at < (${q.data.dateTo}::date + interval '1 day')`)
  }
  const whereSql = sql.join(conds, sql` and `)

  const innerSql = dedupeOn
    ? sql`select sr.*, row_number() over (partition by sr.platform, coalesce(sr.external_id, sr.dedupe_key) order by sr.created_at desc) as rn from selection_result sr where ${whereSql}`
    : sql`select sr.* from selection_result sr where ${whereSql}`

  const orderSql =
    q.data.sort === "sales_desc"
      ? sql`coalesce(t.sales_count, 0) desc`
      : q.data.sort === "price_asc"
        ? sql`t.price asc nulls last`
        : q.data.sort === "price_desc"
          ? sql`t.price desc nulls last`
          : q.data.sort === "rating_desc"
            ? sql`t.rating desc nulls last`
            : q.data.sort === "likes_desc"
              ? sql`coalesce(t.likes_count, 0) desc`
              : q.data.sort === "comments_desc"
                ? sql`coalesce(t.comments_count, 0) desc`
                : q.data.sort === "views_desc"
                  ? sql`coalesce(t.views_count, 0) desc`
                  : sql`t.created_at desc`

  const rowsRaw = (await db.execute(
    sql`select t.* from (${innerSql}) t ${dedupeOn ? sql`where t.rn = 1` : sql``} order by ${orderSql} limit ${pageSize} offset ${offset}`,
  )) as unknown as Array<Record<string, unknown>>
  const countRes = (await db.execute(
    dedupeOn
      ? sql`select count(*)::int as count from (select distinct sr.platform, coalesce(sr.external_id, sr.dedupe_key) as k from selection_result sr where ${whereSql}) c`
      : sql`select count(*)::int as count from selection_result sr where ${whereSql}`,
  )) as unknown as Array<{ count: number }>
  const total = Number(countRes[0]?.count ?? 0)

  const items = rowsRaw.map(rawPoolRowToItem)

  // 来源任务关键词（详情弹窗「来源任务」展示）+ 当前页收藏态
  const [keywordRows, bookmarkRows] = await Promise.all([
    items.length
      ? db
          .select({ id: selectionTasks.id, keyword: selectionTasks.keyword })
          .from(selectionTasks)
          .where(
            inArray(
              selectionTasks.id,
              [...new Set(items.map((i) => i.taskId))],
            ),
          )
      : Promise.resolve([] as Array<{ id: string; keyword: string | null }>),
    items.length
      ? db
          .select({ resultId: selectionBookmarks.resultId })
          .from(selectionBookmarks)
          .where(
            and(
              eq(selectionBookmarks.userId, ctx.user.id),
              inArray(
                selectionBookmarks.resultId,
                items.map((i) => i.id),
              ),
            ),
          )
      : Promise.resolve([] as Array<{ resultId: string }>),
  ])
  const keywordMap = new Map(keywordRows.map((r) => [r.id, r.keyword]))
  for (const item of items) item.taskKeyword = keywordMap.get(item.taskId) ?? null
  const bookmarkedIds = new Set(bookmarkRows.map((r) => r.resultId))

  // 企业内已监控目标 URL（卡片「竞品监控」按钮态）
  const monitorRows = await db
    .select({ targetUrl: selectionMonitors.targetUrl })
    .from(selectionMonitors)
    .where(eq(selectionMonitors.enterpriseId, enterpriseId))
    .limit(500)

  return {
    ok: true as const,
    items,
    total,
    page,
    pageSize,
    bookmarkedIds: [...bookmarkedIds],
    monitoredUrls: monitorRows.map((r) => r.targetUrl),
    dedupe: dedupeOn,
  }
}

/** 数据池筛选元信息：已出现的国家 + 最近完成任务（来源任务下拉） */
export async function getSelectionPoolMetaAction() {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const enterpriseId = ctx.user.enterpriseId!

  const [countryRows, taskRows] = await Promise.all([
    db
      .selectDistinct({ country: selectionResults.country })
      .from(selectionResults)
      .where(
        and(
          eq(selectionResults.enterpriseId, enterpriseId),
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
          eq(selectionTasks.status, "completed"),
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

/**
 * 社媒帖子脉搏（市场分析页 KPI 条）：按筛选口径（平台/国家/日期/关键词/
 * 去重）聚合 帖子数/总点赞/总评论/总浏览。与数据池同构的 where 组装。
 */
export async function getSelectionSocialPulseAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
  const q = poolQuerySchema.safeParse({ ...(input as object), category: 'social' as const })
  if (!q.success) return { ok: false as const, error: "参数错误" }
  const enterpriseId = ctx.user.enterpriseId!
  const dedupeOn = q.data.dedupe !== false

  const conds: SQL[] = [sql`sr.enterprise_id = ${enterpriseId}`]
  conds.push(
    sql`sr.platform in ('instagram','tiktok','pinterest','reddit','x','facebook')`,
  )
  if (q.data.platform && isSelectionPlatform(q.data.platform)) {
    conds.push(sql`sr.platform = ${q.data.platform}`)
  }
  if (q.data.country) {
    conds.push(sql`sr.country = ${q.data.country.toUpperCase()}`)
  }
  if (q.data.q && q.data.q.trim()) {
    const like = `%${q.data.q.trim()}%`
    conds.push(sql`(sr.title ilike ${like} or sr.content ilike ${like})`)
  }
  if (q.data.dateFrom) {
    conds.push(sql`sr.scraped_at >= ${q.data.dateFrom}::date`)
  }
  if (q.data.dateTo) {
    conds.push(sql`sr.scraped_at < (${q.data.dateTo}::date + interval '1 day')`)
  }
  const whereSql = sql.join(conds, sql` and `)

  const innerSql = dedupeOn
    ? sql`select sr.*, row_number() over (partition by sr.platform, coalesce(sr.external_id, sr.dedupe_key) order by sr.created_at desc) as rn from selection_result sr where ${whereSql}`
    : sql`select sr.* from selection_result sr where ${whereSql}`
  const rowsRaw = (await db.execute(
    sql`select coalesce(sum(1),0)::int as posts, coalesce(sum(coalesce(t.likes_count,0)),0)::bigint as likes, coalesce(sum(coalesce(t.comments_count,0)),0)::bigint as comments, coalesce(sum(coalesce(t.views_count,0)),0)::bigint as views from (${innerSql}) t ${dedupeOn ? sql`where t.rn = 1` : sql``}`,
  )) as unknown as Array<{
    posts: number
    likes: string | number
    comments: string | number
    views: string | number
  }>
  const r = rowsRaw[0]
  return {
    ok: true as const,
    posts: Number(r?.posts ?? 0),
    likes: Number(r?.likes ?? 0),
    comments: Number(r?.comments ?? 0),
    views: Number(r?.views ?? 0),
  }
}

/* ── 市场分析（任务维度聚合统计） ───────────────────────────── */

/** 桶标签数字格式化（≥100 取整；否则保留一位小数去尾零） */
function fmtBucketNum(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
}

/**
 * 单任务聚合统计：KPI（条数/价格区间/中位销量/评分）+ 价格分布 + 评分分布 +
 * 销量 TOP10。任务结果 ≤ maxResultsPerTask（≤1000），全量拉数值列 JS 聚合
 * （分桶口径灵活、免多轮 SQL）。
 */
export async function getSelectionMarketStatsAction(taskId: string) {
  const ctx = await requireEnterpriseContext()
  await requireSelection(ctx)
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

  const rows = await db
    .select({
      price: selectionResults.price,
      currency: selectionResults.currency,
      salesCount: selectionResults.salesCount,
      rating: selectionResults.rating,
      reviewCount: selectionResults.reviewCount,
    })
    .from(selectionResults)
    .where(eq(selectionResults.taskId, taskId))

  const prices = rows
    .map((r) => Number(r.price))
    .filter((n) => Number.isFinite(n) && n >= 0)
  const sales = rows
    .map((r) => r.salesCount)
    .filter((n): n is number => n != null && Number.isFinite(n))
  const ratings = rows
    .map((r) => Number(r.rating))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 5)
  const reviewTotal = rows.reduce((s, r) => s + (r.reviewCount ?? 0), 0)

  const sum = (arr: number[]) => arr.reduce((s, n) => s + n, 0)
  const avg = (arr: number[]) => (arr.length ? sum(arr) / arr.length : null)
  const sortedSales = [...sales].sort((a, b) => a - b)
  const medianSales = sortedSales.length
    ? sortedSales[Math.floor((sortedSales.length - 1) / 2)]
    : null

  // 主币种（众数）
  const currencyCounts = new Map<string, number>()
  for (const r of rows) {
    if (r.currency) currencyCounts.set(r.currency, (currencyCounts.get(r.currency) ?? 0) + 1)
  }
  const currency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  // 价格分布：等宽 8 桶（<2 个不同价格时退化为单桶）
  let priceBuckets: Array<{ label: string; count: number }> | null = null
  if (prices.length > 0) {
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    if (max > min) {
      const bucketCount = 8
      const width = (max - min) / bucketCount
      const counts = new Array(bucketCount).fill(0)
      for (const p of prices) {
        const idx = Math.min(bucketCount - 1, Math.floor((p - min) / width))
        counts[idx] += 1
      }
      priceBuckets = counts.map((c, i) => ({
        label: `${fmtBucketNum(min + i * width)}~${fmtBucketNum(min + (i + 1) * width)}`,
        count: c,
      }))
    } else {
      priceBuckets = [{ label: fmtBucketNum(min), count: prices.length }]
    }
  }

  // 评分分布：1~5 星（(i-1, i] 区间）+ 无评分
  const ratingBuckets: Array<{ label: string; count: number }> = []
  for (let i = 1; i <= 5; i++) {
    ratingBuckets.push({
      label: `${i}星`,
      count: ratings.filter((r) => r > i - 1 && r <= i).length,
    })
  }
  const unrated = rows.length - ratings.length
  if (unrated > 0) ratingBuckets.push({ label: "无评分", count: unrated })

  // 销量 TOP10 + 最新 10 条（完整行，复用数据池卡片渲染）
  const [topRows, latestRows] = await Promise.all([
    db
      .select()
      .from(selectionResults)
      .where(eq(selectionResults.taskId, taskId))
      .orderBy(desc(sql`coalesce(${selectionResults.salesCount}, 0)`), desc(selectionResults.createdAt))
      .limit(10),
    db
      .select()
      .from(selectionResults)
      .where(eq(selectionResults.taskId, taskId))
      .orderBy(desc(selectionResults.createdAt))
      .limit(10),
  ])

  const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100)

  return {
    ok: true as const,
    task: {
      id: task.id,
      platform: task.platform,
      taskType: task.taskType,
      keyword: task.keyword,
      country: task.country,
      currency,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    },
    kpi: {
      count: rows.length,
      priceCount: prices.length,
      avgPrice: round2(avg(prices)),
      minPrice: prices.length ? round2(Math.min(...prices)) : null,
      maxPrice: prices.length ? round2(Math.max(...prices)) : null,
      ratingCount: ratings.length,
      avgRating: round2(avg(ratings)),
      reviewTotal,
      salesCounted: sales.length,
      medianSales,
      totalSales: sales.length ? sum(sales) : null,
    },
    priceBuckets,
    ratingBuckets,
    salesTop: topRows.map(drizzleResultToItem),
    latest: latestRows.map(drizzleResultToItem),
  }
}
