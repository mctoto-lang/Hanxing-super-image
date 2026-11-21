"use server"

import { and, desc, eq, lte, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db/client"
import {
  selectionAiSummaries,
  selectionMonitors,
  selectionReviews,
  selectionResults,
  users,
} from "@/db/schema"
import { requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import {
  SELECTION_PLATFORM_CONFIGS,
  isMonitorablePlatform,
  isSelectionPlatform,
} from "@/lib/selection/platforms"
import { parseUuid } from "@/lib/selection/ids"
import { createMonitorRunTasks } from "@/server/services/selection-monitor-service"
import {
  generateMonitorAiSummary,
  generateSocialDigest,
} from "@/server/services/selection-ai"

/**
 * 竞品监控 + 评论洞察 Server Actions（0106）
 *
 * 权限与任务/结果同口径（模块级 selection key，企业域隔离）。监控计费走
 * selection-monitor-service（与普通任务同构：预扣发起人积分、收割结算退款）。
 */

async function requireSelection(): Promise<UserContext> {
  const ctx = await requireEnterpriseContext()
  if (!ctx.canAccess("selection")) throw new Error("无选品工具权限")
  return ctx
}

// ── 竞品监控 ────────────────────────────────────────────────────

const addMonitorSchema = z.object({
  /** 数据池结果行 ID（enterprise 域校验后取快照字段） */
  resultId: z.string().uuid(),
  /** 重抓间隔（小时） */
  intervalHours: z.number().int().min(6).max(168).optional(),
  trackReviews: z.boolean().optional(),
})

/**
 * 从数据池卡片加入竞品监控：按 resultId 取目标快照（平台/链接/ID/标题/图/
 * 国家）upsert 监控行（同企业同 URL 只有一行），并立即发起首轮重抓+评论
 * 抓取（按普通任务口径预扣发起人积分；积分不足自动暂停并提示）。
 */
export async function addSelectionMonitorAction(input: unknown) {
  const ctx = await requireSelection()
  const q = addMonitorSchema.safeParse(input)
  if (!q.success) {
    return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  }
  const enterpriseId = ctx.user.enterpriseId!

  const [result] = await db
    .select({
      id: selectionResults.id,
      platform: selectionResults.platform,
      externalId: selectionResults.externalId,
      sourceUrl: selectionResults.sourceUrl,
      title: selectionResults.title,
      content: selectionResults.content,
      country: selectionResults.country,
      images: selectionResults.images,
    })
    .from(selectionResults)
    .where(
      and(
        eq(selectionResults.id, q.data.resultId),
        eq(selectionResults.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (!result) return { ok: false as const, error: "数据行不存在" }
  if (!isSelectionPlatform(result.platform)) {
    return { ok: false as const, error: "不支持的平台" }
  }
  if (!isMonitorablePlatform(result.platform)) {
    return { ok: false as const, error: "该平台暂不支持竞品监控（无链接直抓入口）" }
  }
  const targetUrl = result.sourceUrl
  if (!targetUrl) {
    return { ok: false as const, error: "该数据行缺少来源链接，无法监控" }
  }
  const cfg = SELECTION_PLATFORM_CONFIGS[result.platform]
  const mon = cfg.monitor!

  const values = {
    enterpriseId,
    userId: ctx.user.id,
    platform: result.platform,
    targetUrl,
    externalId: result.externalId,
    title: result.title ?? (result.content ?? "").slice(0, 120) ?? null,
    imageUrl: result.images?.[0] ?? null,
    country: result.country,
    intervalHours: q.data.intervalHours ?? 24,
    trackReviews: q.data.trackReviews ?? true,
    reviewMax: mon.reviewMaxPerTask,
    status: "active",
    pauseReason: null,
    nextRunAt: new Date(),
    updatedAt: new Date(),
  }
  const [monitor] = await db
    .insert(selectionMonitors)
    .values(values)
    .onConflictDoUpdate({
      target: [selectionMonitors.enterpriseId, selectionMonitors.targetUrl],
      set: {
        title: values.title,
        imageUrl: values.imageUrl,
        externalId: values.externalId,
        country: values.country,
        intervalHours: values.intervalHours,
        trackReviews: values.trackReviews,
        reviewMax: values.reviewMax,
        // 重新激活（曾暂停/删除过的目标恢复监控）
        status: "active",
        pauseReason: null,
        userId: ctx.user.id,
        nextRunAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning({ id: selectionMonitors.id })
  const monitorId = monitor!.id

  // 首轮立即重抓（force 认领 + 计费；积分不足在服务内自动暂停）
  const runOutcome = await createMonitorRunTasks(monitorId)
  const [after] = await db
    .select({
      status: selectionMonitors.status,
      pauseReason: selectionMonitors.pauseReason,
      intervalHours: selectionMonitors.intervalHours,
      runCount: selectionMonitors.runCount,
    })
    .from(selectionMonitors)
    .where(eq(selectionMonitors.id, monitorId))
    .limit(1)

  // 首轮任务创建成功后推进调度时钟：nextRunAt 停在当前时刻会被 30s 调度
  // 循环再次认领、重复扣一轮积分；认领写法与 runDueMonitorsOnce 同构
  //（runCount 条件更新，失败=已被调度认领，不覆盖其推进结果）
  if (runOutcome === "ran" && after?.status === "active") {
    const now = new Date()
    await db
      .update(selectionMonitors)
      .set({
        lastRunAt: now,
        nextRunAt: new Date(now.getTime() + after.intervalHours * 3600_000),
        runCount: after.runCount + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(selectionMonitors.id, monitorId),
          eq(selectionMonitors.status, "active"),
          lte(selectionMonitors.nextRunAt, now),
          eq(selectionMonitors.runCount, after.runCount),
        ),
      )
  }

  if (runOutcome === "paused" || after?.status === "paused") {
    return {
      ok: false as const,
      error: `已加入监控，但首轮抓取未发起：${after?.pauseReason ?? "积分不足"}。可在监控页补足积分后点「立即抓取」`,
      monitorId,
    }
  }
  return { ok: true as const, monitorId }
}

/** 监控目标列表（企业域；含创建人昵称与最新快照） */
export async function listSelectionMonitorsAction(input?: unknown) {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!
  const status =
    typeof input === "object" && input != null && "status" in input
      ? String((input as { status: unknown }).status)
      : ""

  const conds = [eq(selectionMonitors.enterpriseId, enterpriseId)]
  if (status === "active" || status === "paused") {
    conds.push(eq(selectionMonitors.status, status))
  }
  const rows = await db
    .select({
      id: selectionMonitors.id,
      platform: selectionMonitors.platform,
      targetUrl: selectionMonitors.targetUrl,
      externalId: selectionMonitors.externalId,
      title: selectionMonitors.title,
      imageUrl: selectionMonitors.imageUrl,
      country: selectionMonitors.country,
      lastPrice: selectionMonitors.lastPrice,
      lastRating: selectionMonitors.lastRating,
      lastSalesCount: selectionMonitors.lastSalesCount,
      lastReviewCount: selectionMonitors.lastReviewCount,
      lastLikesCount: selectionMonitors.lastLikesCount,
      lastCommentsCount: selectionMonitors.lastCommentsCount,
      lastMetricsAt: selectionMonitors.lastMetricsAt,
      intervalHours: selectionMonitors.intervalHours,
      trackReviews: selectionMonitors.trackReviews,
      status: selectionMonitors.status,
      pauseReason: selectionMonitors.pauseReason,
      lastRunAt: selectionMonitors.lastRunAt,
      nextRunAt: selectionMonitors.nextRunAt,
      runCount: selectionMonitors.runCount,
      createdAt: selectionMonitors.createdAt,
      creatorName: users.name,
    })
    .from(selectionMonitors)
    .leftJoin(users, eq(users.id, selectionMonitors.userId))
    .where(and(...conds))
    .orderBy(desc(selectionMonitors.createdAt))
    .limit(200)
  return { ok: true as const, items: rows }
}

const updateMonitorSchema = z.object({
  id: z.string().uuid(),
  intervalHours: z.number().int().min(6).max(168).optional(),
  trackReviews: z.boolean().optional(),
  /** active=恢复（清暂停原因并立即到期）/ paused=手动暂停 */
  status: z.enum(["active", "paused"]).optional(),
})

/** 更新监控配置（间隔/评论追踪/暂停恢复） */
export async function updateSelectionMonitorAction(input: unknown) {
  const ctx = await requireSelection()
  const q = updateMonitorSchema.safeParse(input)
  if (!q.success) {
    return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  }
  const enterpriseId = ctx.user.enterpriseId!
  const [monitor] = await db
    .select({ id: selectionMonitors.id })
    .from(selectionMonitors)
    .where(
      and(eq(selectionMonitors.id, q.data.id), eq(selectionMonitors.enterpriseId, enterpriseId)),
    )
    .limit(1)
  if (!monitor) return { ok: false as const, error: "监控目标不存在" }

  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (q.data.intervalHours != null) set.intervalHours = q.data.intervalHours
  if (q.data.trackReviews != null) set.trackReviews = q.data.trackReviews
  if (q.data.status === "paused") {
    set.status = "paused"
    set.pauseReason = "手动暂停"
  } else if (q.data.status === "active") {
    set.status = "active"
    set.pauseReason = null
    set.nextRunAt = new Date()
  }
  await db.update(selectionMonitors).set(set).where(eq(selectionMonitors.id, q.data.id))
  return { ok: true as const }
}

/** 删除监控目标（级联清 selection_task.monitor_id 置 null，历史数据保留） */
export async function removeSelectionMonitorAction(id: string) {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!
  if (parseUuid(id) == null) return { ok: false as const, error: "参数错误" }
  const deleted = await db
    .delete(selectionMonitors)
    .where(
      and(eq(selectionMonitors.id, id), eq(selectionMonitors.enterpriseId, enterpriseId)),
    )
    .returning({ id: selectionMonitors.id })
  if (deleted.length === 0) return { ok: false as const, error: "监控目标不存在" }
  return { ok: true as const }
}

/** 立即重抓（手动触发，按普通任务口径计费） */
export async function runSelectionMonitorNowAction(id: string) {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!
  if (parseUuid(id) == null) return { ok: false as const, error: "参数错误" }
  const [monitor] = await db
    .select({
      id: selectionMonitors.id,
      userId: selectionMonitors.userId,
      status: selectionMonitors.status,
      runCount: selectionMonitors.runCount,
      intervalHours: selectionMonitors.intervalHours,
    })
    .from(selectionMonitors)
    .where(and(eq(selectionMonitors.id, id), eq(selectionMonitors.enterpriseId, enterpriseId)))
    .limit(1)
  if (!monitor) return { ok: false as const, error: "监控目标不存在" }
  if (monitor.userId !== ctx.user.id) {
    return {
      ok: false as const,
      error: "只有监控发起人可以手动重抓（重抓从发起人账户扣积分）",
    }
  }
  if (monitor.status !== "active") {
    return { ok: false as const, error: "监控已暂停，请先恢复后再手动重抓" }
  }
  // 原子认领（与调度循环 runDueMonitorsOnce 同构）：runCount 条件更新，
  // 失败=调度或其他手动触发刚认领过——避免同一目标重复建任务重复扣积分
  const now = new Date()
  const claimed = await db
    .update(selectionMonitors)
    .set({
      lastRunAt: now,
      nextRunAt: new Date(now.getTime() + monitor.intervalHours * 3600_000),
      runCount: monitor.runCount + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(selectionMonitors.id, monitor.id),
        eq(selectionMonitors.status, "active"),
        eq(selectionMonitors.runCount, monitor.runCount),
      ),
    )
    .returning({ id: selectionMonitors.id })
  if (claimed.length === 0) {
    return { ok: false as const, error: "已有抓取任务在执行或排队中，请稍后再试" }
  }
  const outcome = await createMonitorRunTasks(id)
  if (outcome === "paused") {
    const [m] = await db
      .select({ pauseReason: selectionMonitors.pauseReason })
      .from(selectionMonitors)
      .where(eq(selectionMonitors.id, id))
      .limit(1)
    return { ok: false as const, error: m?.pauseReason ?? "积分不足，已自动暂停" }
  }
  if (outcome === "skipped") {
    return { ok: false as const, error: "本轮未创建任务（监控可能已暂停）" }
  }
  return { ok: true as const }
}

/** 监控目标历史趋势：按重抓批次（scraped_at）展开的关键指标序列 */
export async function getSelectionMonitorTrendAction(id: string) {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!
  if (parseUuid(id) == null) return { ok: false as const, error: "参数错误" }
  const [monitor] = await db
    .select({ id: selectionMonitors.id })
    .from(selectionMonitors)
    .where(and(eq(selectionMonitors.id, id), eq(selectionMonitors.enterpriseId, enterpriseId)))
    .limit(1)
  if (!monitor) return { ok: false as const, error: "监控目标不存在" }

  // monitor 任务的结果行按时间升序（每任务一般 1 行；目标行按 URL/ID 命中，
  // 其余行兜底取每任务最新一条）
  const rows = (await db.execute(sql`
    select sr.scraped_at, sr.price, sr.rating, sr.sales_count, sr.review_count,
           sr.likes_count, sr.comments_count
    from selection_result sr
    join selection_task st on st.id = sr.task_id
    where st.monitor_id = ${id}
    order by sr.scraped_at asc
    limit 200
  `)) as unknown as Array<{
    scraped_at: string
    price: string | null
    rating: string | null
    sales_count: number | null
    review_count: number | null
    likes_count: number | null
    comments_count: number | null
  }>
  const points = rows.map((r) => ({
    date: r.scraped_at,
    price: r.price != null ? Number(r.price) : null,
    rating: r.rating != null ? Number(r.rating) : null,
    salesCount: r.sales_count,
    reviewCount: r.review_count,
    likesCount: r.likes_count,
    commentsCount: r.comments_count,
  }))
  return { ok: true as const, points }
}

/** 手动刷新监控目标的 AI 评论汇总（平时收割后自动生成） */
export async function refreshMonitorAiSummaryAction(id: string) {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!
  if (parseUuid(id) == null) return { ok: false as const, error: "参数错误" }
  const [monitor] = await db
    .select({ id: selectionMonitors.id })
    .from(selectionMonitors)
    .where(and(eq(selectionMonitors.id, id), eq(selectionMonitors.enterpriseId, enterpriseId)))
    .limit(1)
  if (!monitor) return { ok: false as const, error: "监控目标不存在" }
  try {
    await generateMonitorAiSummary(id)
  } catch (err) {
    return {
      ok: false as const,
      error: `AI 分析失败：${err instanceof Error ? err.message.slice(0, 120) : "未知错误"}`,
    }
  }
  return { ok: true as const }
}

// ── 评论洞察 ────────────────────────────────────────────────────

/**
 * 数据池卡片详情弹窗的评论区：按结果行 sourceUrl 匹配监控抓取的评论
 * （监控 target_url 与结果行 sourceUrl 同源），最新 50 条 + 总数。
 */
export async function getResultReviewsAction(resultId: string) {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!
  // 调用方不检查 ok 分支直接取 items/total，非法入参沿用空结果形状
  if (parseUuid(resultId) == null) return { ok: true as const, items: [], total: 0 }
  const [row] = await db
    .select({ sourceUrl: selectionResults.sourceUrl })
    .from(selectionResults)
    .where(
      and(
        eq(selectionResults.id, resultId),
        eq(selectionResults.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (!row?.sourceUrl) return { ok: true as const, items: [], total: 0 }

  const where = and(
    eq(selectionReviews.enterpriseId, enterpriseId),
    eq(selectionReviews.targetUrl, row.sourceUrl),
  )
  const [items, countRes] = await Promise.all([
    db
      .select({
        id: selectionReviews.id,
        platform: selectionReviews.platform,
        authorName: selectionReviews.authorName,
        rating: selectionReviews.rating,
        content: selectionReviews.content,
        likesCount: selectionReviews.likesCount,
        verified: selectionReviews.verified,
        publishedAt: selectionReviews.publishedAt,
        scrapedAt: selectionReviews.scrapedAt,
      })
      .from(selectionReviews)
      .where(where)
      .orderBy(desc(selectionReviews.scrapedAt))
      .limit(50),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(selectionReviews)
      .where(where),
  ])
  return { ok: true as const, items, total: Number(countRes[0]?.count ?? 0) }
}

const reviewsQuerySchema = z.object({
  platform: z.string().optional(),
  country: z.string().max(16).optional(),
  monitorId: z.string().uuid().optional(),
  q: z.string().max(120).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(["newest", "likes_desc", "rating_desc", "published_desc"]).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(60).optional(),
})

/** 评论流分页查询（评论洞察页） */
export async function getSelectionReviewsAction(input: unknown) {
  const ctx = await requireSelection()
  const q = reviewsQuerySchema.safeParse(input ?? {})
  if (!q.success) return { ok: false as const, error: "参数错误" }
  const enterpriseId = ctx.user.enterpriseId!
  const page = q.data.page ?? 1
  const pageSize = q.data.pageSize ?? 20

  const conds = [eq(selectionReviews.enterpriseId, enterpriseId)]
  if (q.data.platform && isSelectionPlatform(q.data.platform)) {
    conds.push(eq(selectionReviews.platform, q.data.platform))
  }
  if (q.data.country) {
    conds.push(eq(selectionReviews.country, q.data.country.toUpperCase()))
  }
  if (q.data.monitorId) conds.push(eq(selectionReviews.monitorId, q.data.monitorId))
  if (q.data.q && q.data.q.trim()) {
    conds.push(sql`${selectionReviews.content} ilike ${`%${q.data.q.trim()}%`}`)
  }
  if (q.data.dateFrom) {
    conds.push(sql`${selectionReviews.scrapedAt} >= ${q.data.dateFrom}::date`)
  }
  if (q.data.dateTo) {
    conds.push(sql`${selectionReviews.scrapedAt} < (${q.data.dateTo}::date + interval '1 day')`)
  }
  const where = and(...conds)

  const orderBy =
    q.data.sort === "likes_desc"
      ? desc(selectionReviews.likesCount)
      : q.data.sort === "rating_desc"
        ? desc(selectionReviews.rating)
        : q.data.sort === "published_desc"
          ? desc(selectionReviews.publishedAt)
          : desc(selectionReviews.scrapedAt)

  const [items, countRes, statRes] = await Promise.all([
    db
      .select()
      .from(selectionReviews)
      .where(where)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(selectionReviews)
      .where(where),
    db
      .select({
        count: sql<number>`count(*)::int`,
        avgRating: sql<string | null>`avg(rating)::numeric(3,2)`,
      })
      .from(selectionReviews)
      .where(eq(selectionReviews.enterpriseId, enterpriseId)),
  ])
  return {
    ok: true as const,
    items,
    total: Number(countRes[0]?.count ?? 0),
    page,
    pageSize,
    overallCount: Number(statRes[0]?.count ?? 0),
    overallAvgRating: statRes[0]?.avgRating != null ? Number(statRes[0].avgRating) : null,
  }
}

/**
 * 评论洞察页汇总：监控目标各自的 AI 摘要 + 社媒平台 digest + 监控目标选项
 * （筛选下拉用）。只读既有 digest 行，缺失时需手动 refreshSocialDigestAction
 * 补生成（不在此现场生成）。
 */
export async function getSelectionInsightSummariesAction() {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!

  const [monitorRows, monitorSummaries, digestRows] = await Promise.all([
    db
      .select({
        id: selectionMonitors.id,
        platform: selectionMonitors.platform,
        title: selectionMonitors.title,
        targetUrl: selectionMonitors.targetUrl,
        imageUrl: selectionMonitors.imageUrl,
        trackReviews: selectionMonitors.trackReviews,
      })
      .from(selectionMonitors)
      .where(eq(selectionMonitors.enterpriseId, enterpriseId))
      .orderBy(desc(selectionMonitors.createdAt))
      .limit(100),
    db
      .select()
      .from(selectionAiSummaries)
      .where(
        and(
          eq(selectionAiSummaries.enterpriseId, enterpriseId),
          eq(selectionAiSummaries.kind, "monitor"),
        ),
      )
      .orderBy(desc(selectionAiSummaries.updatedAt))
      .limit(100),
    db
      .select()
      .from(selectionAiSummaries)
      .where(
        and(
          eq(selectionAiSummaries.enterpriseId, enterpriseId),
          eq(selectionAiSummaries.kind, "digest"),
        ),
      )
      .orderBy(desc(selectionAiSummaries.day))
      .limit(30),
  ])

  return {
    ok: true as const,
    monitors: monitorRows,
    monitorSummaries,
    digests: digestRows,
  }
}

/** 手动刷新社媒 digest（平时任务完成后自动生成） */
export async function refreshSocialDigestAction(platform: string) {
  const ctx = await requireSelection()
  if (!isSelectionPlatform(platform)) {
    return { ok: false as const, error: "不支持的平台" }
  }
  try {
    await generateSocialDigest(ctx.user.enterpriseId!, platform, new Date())
  } catch (err) {
    return {
      ok: false as const,
      error: `AI 分析失败：${err instanceof Error ? err.message.slice(0, 120) : "未知错误"}`,
    }
  }
  return { ok: true as const }
}
