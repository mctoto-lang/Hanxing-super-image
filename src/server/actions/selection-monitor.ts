"use server"

import { and, desc, eq, inArray, lte, sql, type SQL } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db/client"
import {
  selectionAiSummaries,
  selectionMonitors,
  selectionReviews,
  selectionResults,
  selectionTasks,
} from "@/db/schema"
import { requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import {
  CreditsInsufficientError,
  deductUserCredits,
} from "@/server/services/credits-service"
import { settleSelectionTask } from "@/server/services/selection-service"
import {
  SELECTION_PLATFORMS,
  SELECTION_PLATFORM_CONFIGS,
  SELECTION_REVIEW_SCRAPE_DEFAULT_MAX,
  isMonitorablePlatform,
  isSelectionPlatform,
} from "@/lib/selection/platforms"
import { isCalendarDate } from "@/lib/selection/pool-url"
import { buildActorInput } from "@/lib/selection/input-builders"
import { reviewExtras, type ReviewExtras } from "@/lib/selection/extras"
import { resolveMonitorTarget } from "@/lib/selection/monitor-target"
import { parseUuid } from "@/lib/selection/ids"
import type { MonitorListItem } from "@/lib/selection/monitor-types"
import { resolveSelectionToken } from "@/lib/selection/provider-config"
import { createMonitorRunTasks } from "@/server/services/selection-monitor-service"
import {
  generateMonitorAiSummary,
  generateSocialDigest,
  generateTargetAiSummary,
} from "@/server/services/selection-ai"

/**
 * 竞品监控 + 评论洞察 Server Actions（0106；0108 扩展手动添加监控、一次性抓评论、
 * 目标级 AI 洞察、涨跌对比）
 *
 * 权限与任务/结果同口径（模块级 selection key，企业域隔离）。监控计费走
 * selection-monitor-service（与普通任务同构：预扣发起人积分、收割结算退款）。
 */

async function requireSelection(): Promise<UserContext> {
  const ctx = await requireEnterpriseContext()
  if (!ctx.canAccess("selection")) throw new Error("无选品工具权限")
  return ctx
}

/** 同一目标两次一次性抓评论的最短间隔（防重复点击重复扣费） */
const REVIEW_SCRAPE_COOLDOWN_MS = 60 * 60_000

/**
 * 结果行 sourceUrl 的双形态匹配键：监控/评论任务落库的 target_url 是规范化链接
 * （去 slug、追踪参数、换域名），与结果行原始 sourceUrl 可能不同形——读侧按两个
 * 形态同时匹配，规范化失败或与原链相同时只有一个元素。
 */
function monitorTargetUrls(sourceUrl: string): string[] {
  const urls = [sourceUrl]
  const resolved = resolveMonitorTarget(sourceUrl)
  if (resolved.ok && !urls.includes(resolved.target.url)) urls.push(resolved.target.url)
  return urls
}

// ── 竞品监控 ────────────────────────────────────────────────────

const addMonitorSchema = z.object({
  /** 数据池结果行 ID（enterprise 域校验后取快照字段） */
  resultId: z.string().uuid(),
  /** 重抓间隔（小时） */
  intervalHours: z.number().int().min(6).max(168).optional(),
  trackReviews: z.boolean().optional(),
})

/** 粘贴链接添加监控入参 */
const addMonitorByUrlSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  /** 备注名（缺省用链接解析出的标题占位，首轮抓取后回填） */
  title: z.string().trim().max(255).optional(),
  intervalHours: z.number().int().min(6).max(168).optional(),
  trackReviews: z.boolean().optional(),
})

/** 监控目标输入（数据池卡片 / 粘贴链接两种入口归一后的形状） */
interface MonitorInput {
  platform: string
  targetUrl: string
  externalId: string | null
  country: string | null
  title: string | null
  imageUrl: string | null
  intervalHours: number
  trackReviews: boolean
}

/**
 * 建监控目标并立即发起首轮重抓 + 评论抓取（两种入口共用）：按（企业, 目标链接）
 * upsert（同企业同链接只有一行）；按普通任务口径预扣发起人积分，积分不足自动暂停。
 */
async function upsertMonitorAndRun(
  ctx: UserContext,
  input: MonitorInput,
): Promise<
  | { ok: true; monitorId: string; firstRun: "ran" | "paused" | "skipped" }
  | { ok: false; error: string; monitorId?: string }
> {
  const enterpriseId = ctx.user.enterpriseId!
  if (!isSelectionPlatform(input.platform)) return { ok: false, error: "不支持的监控平台" }
  if (!isMonitorablePlatform(input.platform)) {
    return { ok: false, error: "该平台暂不支持竞品监控（无链接直抓入口）" }
  }
  if (!input.targetUrl) return { ok: false, error: "缺少监控目标链接" }
  const mon = SELECTION_PLATFORM_CONFIGS[input.platform].monitor!
  // 无指标重抓能力的平台（如 Etsy 仅评论追踪）必须开评论追踪：否则一个任务都
  // 不建、零产出零扣费，目标却显示「监控中」——直接拒绝（前端同步隐藏评论开关）
  if (!mon.metricsActorId && !input.trackReviews) {
    return {
      ok: false,
      error: "该平台无指标重抓能力，需开启「评论追踪」才会有抓取产出",
    }
  }

  const values = {
    enterpriseId,
    userId: ctx.user.id,
    platform: input.platform,
    targetUrl: input.targetUrl,
    externalId: input.externalId,
    title: input.title,
    imageUrl: input.imageUrl,
    country: input.country,
    intervalHours: input.intervalHours,
    trackReviews: input.trackReviews,
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
        title: values.title ?? sql`${selectionMonitors.title}`,
        imageUrl: values.imageUrl ?? sql`${selectionMonitors.imageUrl}`,
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

  // 首轮立即重抓：先原子认领（runCount 条件更新推进时钟）再建任务，与
  // runDueMonitorsOnce /「立即抓取」同构。认领失败 = 30s 调度或并发提交刚认领过
  // （首轮任务已在途）——不重复建任务、不重复扣费，直接按成功返回。
  const [current] = await db
    .select({
      status: selectionMonitors.status,
      pauseReason: selectionMonitors.pauseReason,
      intervalHours: selectionMonitors.intervalHours,
      runCount: selectionMonitors.runCount,
    })
    .from(selectionMonitors)
    .where(eq(selectionMonitors.id, monitorId))
    .limit(1)

  if (current?.status === "paused") {
    return {
      ok: false,
      monitorId,
      error: `已加入监控，但首轮抓取未发起：${current.pauseReason ?? "积分不足"}。可在监控页补足积分后点「立即抓取」`,
    }
  }
  if (current?.status === "active") {
    const now = new Date()
    const claimed = await db
      .update(selectionMonitors)
      .set({
        lastRunAt: now,
        nextRunAt: new Date(now.getTime() + current.intervalHours * 3600_000),
        runCount: current.runCount + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(selectionMonitors.id, monitorId),
          eq(selectionMonitors.status, "active"),
          lte(selectionMonitors.nextRunAt, now),
          eq(selectionMonitors.runCount, current.runCount),
        ),
      )
      .returning({ id: selectionMonitors.id })
    if (claimed.length === 0) {
      // 并发认领：首轮任务由先认领的一方创建（含计费），无需重复
      return { ok: true, monitorId, firstRun: "ran" as const }
    }
    const firstRun = await createMonitorRunTasks(monitorId)
    if (firstRun === "paused") {
      const [m] = await db
        .select({ pauseReason: selectionMonitors.pauseReason })
        .from(selectionMonitors)
        .where(eq(selectionMonitors.id, monitorId))
        .limit(1)
      return {
        ok: false,
        monitorId,
        error: `已加入监控，但首轮抓取未发起：${m?.pauseReason ?? "积分不足"}。可在监控页补足积分后点「立即抓取」`,
      }
    }
    return { ok: true, monitorId, firstRun }
  }
  return { ok: true, monitorId, firstRun: "skipped" as const }
}

/**
 * 从数据池卡片加入竞品监控：按 resultId 取目标快照（平台/链接/ID/标题/图/
 * 国家，链接按平台规则规范化成稳定键）upsert 监控行，并立即发起首轮重抓 + 评论。
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

  // 链接规范化（去追踪参数、补平台 ID），保证同企业同目标只有一行监控
  const resolved = result.sourceUrl ? resolveMonitorTarget(result.sourceUrl) : null
  if (resolved && !resolved.ok && !result.externalId) {
    return { ok: false as const, error: resolved.error }
  }
  const target = resolved?.ok
    ? resolved.target
    : { url: result.sourceUrl, externalId: result.externalId, country: result.country }

  const outcome = await upsertMonitorAndRun(ctx, {
    platform: result.platform,
    targetUrl: target.url ?? "",
    externalId: target.externalId ?? result.externalId,
    country: target.country ?? result.country,
    title: result.title ?? (result.content ?? "").slice(0, 120),
    imageUrl: result.images?.[0] ?? null,
    intervalHours: q.data.intervalHours ?? 24,
    trackReviews: q.data.trackReviews ?? true,
  })
  if (!outcome.ok) {
    return outcome.monitorId
      ? { ok: false as const, error: outcome.error, monitorId: outcome.monitorId }
      : { ok: false as const, error: outcome.error }
  }
  return { ok: true as const, monitorId: outcome.monitorId }
}

/**
 * 粘贴商品 / 帖子链接添加监控（不必先在数据池里找到）：解析平台与平台 ID →
 * upsert 监控行 → 首轮抓取。标题与图片在首轮抓取后由快照回填。
 */
export async function addSelectionMonitorByUrlAction(input: unknown) {
  const ctx = await requireSelection()
  const q = addMonitorByUrlSchema.safeParse(input)
  if (!q.success) {
    return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  }
  const resolved = resolveMonitorTarget(q.data.url)
  if (!resolved.ok) return { ok: false as const, error: resolved.error }
  const target = resolved.target
  return upsertMonitorAndRun(ctx, {
    platform: target.platform,
    targetUrl: target.url,
    externalId: target.externalId,
    country: target.country,
    // 标题留空：首轮抓取后 refreshMonitorSnapshot 用抓到的真实标题回填
    //（卡片在回填前显示链接域名占位）
    title: q.data.title || null,
    imageUrl: null,
    intervalHours: q.data.intervalHours ?? 24,
    trackReviews: q.data.trackReviews ?? true,
  })
}

const monitorListSchema = z.object({
  status: z.enum(["active", "paused"]).optional(),
  platform: z.string().optional(),
  q: z.string().max(120).optional(),
})

/**
 * 监控目标列表（企业域）：最新快照 + 上一次快照（涨跌对比）+ 创建人。
 * 上一次快照 = 该目标倒数第二次指标重抓的结果行（lateral 子查询，原生 SQL——
 * drizzle 的 lateral 构造器带 limit 时类型对不上）。
 */
export async function listSelectionMonitorsAction(input?: unknown) {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!
  const q = monitorListSchema.safeParse(input ?? {})
  if (!q.success) return { ok: false as const, error: "参数错误" }

  // 原生 SQL 里表别名为 m，条件须手写 m. 前缀（drizzle 列引用会带表全名）
  const conds: SQL[] = [sql`m.enterprise_id = ${enterpriseId}`]
  if (q.data.status) conds.push(sql`m.status = ${q.data.status}`)
  if (q.data.platform && isSelectionPlatform(q.data.platform)) {
    conds.push(sql`m.platform = ${q.data.platform}`)
  }
  if (q.data.q && q.data.q.trim()) {
    const like = `%${q.data.q.trim()}%`
    conds.push(sql`(m.title ilike ${like} or m.target_url ilike ${like})`)
  }

  // 原生 SQL 行（snake_case；latest 快照列在 SQL 里不别名，统一在此映射）
  interface MonitorListRow {
    id: string
    price: string | null
    rating: string | null
    sales_count: number | null
    review_count: number | null
    likes_count: number | null
    comments_count: number | null
    views_count: number | null
    shares_count: number | null
    rank: number | null
    user_id: string
    platform: string
    target_url: string
    external_id: string | null
    title: string | null
    image_url: string | null
    country: string | null
    last_currency: string | null
    last_metrics_at: Date | null
    interval_hours: number
    track_reviews: boolean
    review_max: number
    status: string
    pause_reason: string | null
    last_run_at: Date | null
    next_run_at: Date | null
    run_count: number
    created_at: Date
    creator_name: string | null
    prev_price: string | null
    prev_rating: string | null
    prev_sales_count: number | null
    prev_review_count: number | null
    prev_likes_count: number | null
    prev_comments_count: number | null
    prev_views_count: number | null
    prev_shares_count: number | null
    prev_rank: number | null
    prev_scraped_at: Date | null
  }

  const [rows, statusRows, trackingRows] = await Promise.all([
    db.execute(
      sql`select m.id, m.user_id, m.platform, m.target_url, m.external_id, m.title, m.image_url, m.country,
          m.last_price as price, m.last_currency, m.last_rating as rating, m.last_sales_count as sales_count,
          m.last_review_count as review_count, m.last_likes_count as likes_count,
          m.last_comments_count as comments_count, m.last_views_count as views_count,
          m.last_shares_count as shares_count, m.last_rank as rank, m.last_metrics_at,
          m.interval_hours, m.track_reviews, m.review_max, m.status, m.pause_reason, m.last_run_at, m.next_run_at,
          m.run_count, m.created_at, u.name as creator_name,
          p.price as prev_price, p.rating as prev_rating, p.sales_count as prev_sales_count,
          p.review_count as prev_review_count, p.likes_count as prev_likes_count,
          p.comments_count as prev_comments_count, p.views_count as prev_views_count,
          p.shares_count as prev_shares_count, p.rank as prev_rank, p.scraped_at as prev_scraped_at
        from selection_monitor m
        left join "user" u on u.id = m.user_id
        left join lateral (
          select sr.price, sr.rating, sr.sales_count, sr.review_count, sr.likes_count,
                 sr.comments_count, sr.views_count, sr.shares_count, sr.rank, sr.scraped_at
          from selection_result sr
          join selection_task st on st.id = sr.task_id
          where st.monitor_id = m.id and st.task_type = 'monitor'
          order by sr.scraped_at desc
          offset 1 limit 1
        ) p on true
        where ${sql.join(conds, sql` and `)}
        order by m.created_at desc
        limit 200`,
    ) as unknown as Promise<MonitorListRow[]>,
    db
      .select({ status: selectionMonitors.status, count: sql<number>`count(*)::int` })
      .from(selectionMonitors)
      .where(eq(selectionMonitors.enterpriseId, enterpriseId))
      .groupBy(selectionMonitors.status),
    // 「评论追踪中」计数：企业口径（与上面状态计数一致不受筛选影响），平台白名单
    // 动态拼进 where，与列表项 canScrapeReviews 同口径——此前按筛选后的 res.items
    // 计数，切平台/搜索后该卡跳动且 limit 200 截断时失真
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(selectionMonitors)
      .where(
        and(
          eq(selectionMonitors.enterpriseId, enterpriseId),
          eq(selectionMonitors.status, "active"),
          eq(selectionMonitors.trackReviews, true),
          inArray(
            selectionMonitors.platform,
            SELECTION_PLATFORMS.filter(
              (p) => SELECTION_PLATFORM_CONFIGS[p].monitor?.reviewActorId,
            ),
          ),
        ),
      ),
  ])

  // 状态标签角标：企业内全部监控目标按状态计数（不受筛选影响）
  const counts = {
    active: 0,
    paused: 0,
    total: 0,
    trackingReviews: Number(trackingRows[0]?.count ?? 0),
  }
  for (const r of statusRows) {
    if (r.status === "active" || r.status === "paused") counts[r.status] = r.count
    counts.total += r.count
  }

  const items: MonitorListItem[] = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    platform: r.platform,
    targetUrl: r.target_url,
    externalId: r.external_id,
    title: r.title,
    imageUrl: r.image_url,
    country: r.country,
    price: r.price,
    rating: r.rating,
    salesCount: r.sales_count,
    reviewCount: r.review_count,
    likesCount: r.likes_count,
    commentsCount: r.comments_count,
    viewsCount: r.views_count,
    sharesCount: r.shares_count,
    rank: r.rank,
    lastCurrency: r.last_currency,
    lastMetricsAt: r.last_metrics_at,
    intervalHours: r.interval_hours,
    trackReviews: r.track_reviews,
    reviewMax: r.review_max,
    status: r.status,
    pauseReason: r.pause_reason,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    runCount: r.run_count,
    createdAt: r.created_at,
    creatorName: r.creator_name,
    prev:
      r.prev_scraped_at == null
        ? null
        : {
            price: r.prev_price,
            rating: r.prev_rating,
            salesCount: r.prev_sales_count,
            reviewCount: r.prev_review_count,
            likesCount: r.prev_likes_count,
            commentsCount: r.prev_comments_count,
            viewsCount: r.prev_views_count,
            sharesCount: r.prev_shares_count,
            rank: r.prev_rank,
            scrapedAt: r.prev_scraped_at,
          },
    canScrapeReviews: Boolean(
      isSelectionPlatform(r.platform) &&
        SELECTION_PLATFORM_CONFIGS[r.platform].monitor?.reviewActorId,
    ),
    metricsNote: isSelectionPlatform(r.platform)
      ? (SELECTION_PLATFORM_CONFIGS[r.platform].monitor?.metricsNote ?? null)
      : null,
  }))

  return {
    ok: true as const,
    /** 当前用户 ID（「立即抓取」只对发起人开放） */
    currentUserId: ctx.user.id,
    counts,
    items,
  }
}

const updateMonitorSchema = z.object({
  id: z.string().uuid(),
  intervalHours: z.number().int().min(6).max(168).optional(),
  trackReviews: z.boolean().optional(),
  /** active=恢复（清暂停原因并立即到期）/ paused=手动暂停 */
  status: z.enum(["active", "paused"]).optional(),
})

/**
 * 取消该监控已排队未启动的任务并全额退款（暂停 / 删除共用）：与取消任务 action
 * 同口径——queued 条件认领置 cancelled，再走 settleSelectionTask 全额退还；
 * processing 任务交由 worker 收割中止后按实际条数结算，不动。
 */
async function cancelQueuedMonitorTasks(monitorId: string): Promise<void> {
  const queued = await db
    .select({ id: selectionTasks.id })
    .from(selectionTasks)
    .where(
      and(eq(selectionTasks.monitorId, monitorId), eq(selectionTasks.status, "queued")),
    )
  for (const t of queued) {
    const claimed = await db
      .update(selectionTasks)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(and(eq(selectionTasks.id, t.id), eq(selectionTasks.status, "queued")))
      .returning({ id: selectionTasks.id })
    if (claimed.length === 0) continue
    await settleSelectionTask({
      taskId: t.id,
      finalStatus: "cancelled",
      fetchedCount: 0,
      errorMessage: "监控已暂停/删除，取消排队任务（全额退还）",
    })
  }
}

/** 更新监控配置（间隔/评论追踪/暂停恢复）——仅发起人或企业管理员（与取消任务、手动重抓同口径） */
export async function updateSelectionMonitorAction(input: unknown) {
  const ctx = await requireSelection()
  const q = updateMonitorSchema.safeParse(input)
  if (!q.success) {
    return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  }
  const enterpriseId = ctx.user.enterpriseId!
  const [monitor] = await db
    .select({ id: selectionMonitors.id, userId: selectionMonitors.userId, platform: selectionMonitors.platform })
    .from(selectionMonitors)
    .where(
      and(eq(selectionMonitors.id, q.data.id), eq(selectionMonitors.enterpriseId, enterpriseId)),
    )
    .limit(1)
  if (!monitor) return { ok: false as const, error: "监控目标不存在" }
  if (
    monitor.userId !== ctx.user.id &&
    ctx.user.enterpriseRole !== "owner" &&
    ctx.user.enterpriseRole !== "admin"
  ) {
    return {
      ok: false as const,
      error: "仅监控发起人或企业管理员可修改监控（重抓费用从发起人账户扣除）",
    }
  }
  // 无指标重抓能力的平台（如 Etsy）关掉评论追踪 = 永远零产出零扣费，拒绝
  if (q.data.trackReviews === false) {
    const mon = isSelectionPlatform(monitor.platform)
      ? SELECTION_PLATFORM_CONFIGS[monitor.platform].monitor
      : undefined
    if (mon && !mon.metricsActorId) {
      return {
        ok: false as const,
        error: "该平台无指标重抓能力，关闭评论追踪后监控将无任何产出；如需停止请直接删除监控",
      }
    }
  }

  const set: { updatedAt: Date; intervalHours?: number; trackReviews?: boolean; status?: "active" | "paused"; pauseReason?: string | null; nextRunAt?: Date } = {
    updatedAt: new Date(),
  }
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
  // 暂停同时取消已排队未启动的任务并全额退款（否则慢队列里它们照常启动扣费）
  if (q.data.status === "paused") {
    await cancelQueuedMonitorTasks(q.data.id)
  }
  return { ok: true as const }
}

/** 删除监控目标（级联清 selection_task.monitor_id 置 null，历史数据保留；仅发起人或企业管理员） */
export async function removeSelectionMonitorAction(id: string) {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!
  if (parseUuid(id) == null) return { ok: false as const, error: "参数错误" }
  const [monitor] = await db
    .select({ id: selectionMonitors.id, userId: selectionMonitors.userId })
    .from(selectionMonitors)
    .where(and(eq(selectionMonitors.id, id), eq(selectionMonitors.enterpriseId, enterpriseId)))
    .limit(1)
  if (!monitor) return { ok: false as const, error: "监控目标不存在" }
  if (
    monitor.userId !== ctx.user.id &&
    ctx.user.enterpriseRole !== "owner" &&
    ctx.user.enterpriseRole !== "admin"
  ) {
    return { ok: false as const, error: "仅监控发起人或企业管理员可删除监控" }
  }
  // 删行前取消已排队未启动的任务并全额退款（删行后任务仍在队列会照常启动扣费）
  await cancelQueuedMonitorTasks(id)
  const deleted = await db
    .delete(selectionMonitors)
    .where(
      and(eq(selectionMonitors.id, id), eq(selectionMonitors.enterpriseId, enterpriseId)),
    )
    .returning({ id: selectionMonitors.id })
  if (deleted.length === 0) return { ok: false as const, error: "监控目标不存在" }
  return { ok: true as const }
}

/** 立即重抓（手动触发，按普通任务口径计费；仅发起人） */
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
  // 失败 = 调度或其他手动触发刚认领过——避免同一目标重复建任务重复扣积分
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
    // skipped 的常见原因：该监控已有 queued/processing 任务（在途检查兜底）
    return { ok: false as const, error: "该监控已有抓取任务在执行或排队中，请稍后再试" }
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

  // monitor 任务的结果行（每任务一般 1 行；目标行按 ID/链接命中，其余行兜底取每
  // 任务最新一条）。倒序取最新 200 条再在 JS 里反转回升序——正序 limit 会在重抓
  // 超过 200 次后永远只返回最早的点，最新数据不再进趋势图
  const rows = (await db.execute(sql`
    select sr.scraped_at, sr.price, sr.rating, sr.sales_count, sr.review_count,
           sr.likes_count, sr.comments_count, sr.views_count, sr.shares_count, sr.rank
    from selection_result sr
    join selection_task st on st.id = sr.task_id
    where st.monitor_id = ${id} and st.task_type = 'monitor'
    order by sr.scraped_at desc, sr.id desc
    limit 200
  `)) as unknown as Array<{
    scraped_at: string
    price: string | null
    rating: string | null
    sales_count: number | null
    review_count: number | null
    likes_count: number | null
    comments_count: number | null
    views_count: number | null
    shares_count: number | null
    rank: number | null
  }>
  // price / rating 保持 numeric 字符串（与监控快照列同形，展示层再转数字）
  const points = rows.reverse().map((r) => ({
    date: r.scraped_at,
    price: r.price,
    rating: r.rating,
    salesCount: r.sales_count,
    reviewCount: r.review_count,
    likesCount: r.likes_count,
    commentsCount: r.comments_count,
    viewsCount: r.views_count,
    sharesCount: r.shares_count,
    rank: r.rank,
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

/** 手动刷新一次性抓评论目标的 AI 洞察 */
export async function refreshTargetAiSummaryAction(targetUrl: string) {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!
  if (!targetUrl || targetUrl.length > 2000) return { ok: false as const, error: "参数错误" }
  const [review] = await db
    .select({ platform: selectionReviews.platform })
    .from(selectionReviews)
    .where(
      and(
        eq(selectionReviews.enterpriseId, enterpriseId),
        eq(selectionReviews.targetUrl, targetUrl),
      ),
    )
    .limit(1)
  if (!review) return { ok: false as const, error: "该目标暂无抓取的评论" }
  try {
    await generateTargetAiSummary(enterpriseId, review.platform, targetUrl)
  } catch (err) {
    return {
      ok: false as const,
      error: `AI 分析失败：${err instanceof Error ? err.message.slice(0, 120) : "未知错误"}`,
    }
  }
  return { ok: true as const }
}

// ── 评论洞察 ────────────────────────────────────────────────────

/** 评论行 → 列表项（带 extras，不带 rawData） */
function reviewListItem(r: typeof selectionReviews.$inferSelect) {
  const { rawData, ...rest } = r
  return { ...rest, extras: reviewExtras(rawData) }
}

export interface DialogReview {
  id: string
  platform: string
  authorName: string | null
  rating: string | null
  content: string | null
  likesCount: number | null
  verified: boolean | null
  publishedAt: Date | null
  scrapedAt: Date
  extras: ReviewExtras
}

/**
 * 数据池卡片详情弹窗的评论区：按结果行 sourceUrl 匹配抓取的评论（监控 target_url
 * 与结果行 sourceUrl 同源），最新 50 条 + 总数 + 该目标的 AI 洞察（监控级优先，
 * 其次一次性抓取的目标级）+ 是否支持「抓取评论」。
 */
export async function getResultReviewsAction(resultId: string) {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!
  // 调用方不检查 ok 分支直接取 items/total，非法入参沿用空结果形状
  const empty = {
    ok: true as const,
    items: [] as DialogReview[],
    total: 0,
    aiSummary: null,
    canScrape: false,
    scrapeCredits: 0,
    platform: null as string | null,
  }
  if (parseUuid(resultId) == null) return empty
  const [row] = await db
    .select({ sourceUrl: selectionResults.sourceUrl, platform: selectionResults.platform })
    .from(selectionResults)
    .where(
      and(
        eq(selectionResults.id, resultId),
        eq(selectionResults.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (!row?.sourceUrl) return empty

  // 双形态匹配：结果行原始 sourceUrl + 监控规范化 target_url（监控/评论任务落库
  // 的是规范化链接，与结果行 sourceUrl 可能不同形，按两个形态同时命中）
  const urls = monitorTargetUrls(row.sourceUrl)
  const urlList = sql.join(
    urls.map((u) => sql`${u}`),
    sql`, `,
  )
  const where = and(
    eq(selectionReviews.enterpriseId, enterpriseId),
    inArray(selectionReviews.targetUrl, urls),
  )
  // 读取侧去重：评论入库幂等只到 (task_id, dedupe_key)，跨任务/跨轮重抓会各存
  // 一份——按 dedupe_key 取每键最新一条，同一条评论不再重复出现、条数不再虚高
  const latest = db
    .selectDistinctOn([selectionReviews.dedupeKey])
    .from(selectionReviews)
    .where(where)
    .orderBy(selectionReviews.dedupeKey, desc(selectionReviews.scrapedAt), desc(selectionReviews.id))
    .as("latest_reviews")
  const [items, countRes, summaryRows] = await Promise.all([
    db
      .select()
      .from(latest)
      .orderBy(desc(latest.scrapedAt), desc(latest.publishedAt))
      .limit(50),
    db
      .select({ count: sql<number>`count(distinct ${selectionReviews.dedupeKey})::int` })
      .from(selectionReviews)
      .where(where),
    db
      .select({
        kind: selectionAiSummaries.kind,
        summary: selectionAiSummaries.summary,
        reviewCount: selectionAiSummaries.reviewCount,
        updatedAt: selectionAiSummaries.updatedAt,
      })
      .from(selectionAiSummaries)
      .where(
        and(
          eq(selectionAiSummaries.enterpriseId, enterpriseId),
          // 监控级（经 monitor.target_url 关联）或目标级（target_url 直接命中），
          // 同样按双形态匹配
          sql`(${selectionAiSummaries.kind} = 'target' and ${selectionAiSummaries.targetUrl} in (${urlList}))
            or (${selectionAiSummaries.kind} = 'monitor' and exists (
              select 1 from selection_monitor m
              where m.id = ${selectionAiSummaries.monitorId} and m.target_url in (${urlList})
            ))`,
        ),
      )
      .orderBy(sql`case ${selectionAiSummaries.kind} when 'monitor' then 0 else 1 end`)
      .limit(1),
  ])
  const mon = isSelectionPlatform(row.platform)
    ? SELECTION_PLATFORM_CONFIGS[row.platform].monitor
    : undefined
  const canScrape = Boolean(mon?.reviewActorId)
  return {
    ok: true as const,
    items: items.map(reviewListItem),
    total: Number(countRes[0]?.count ?? 0),
    aiSummary: summaryRows[0]
      ? {
          kind: summaryRows[0].kind,
          summary: summaryRows[0].summary,
          reviewCount: summaryRows[0].reviewCount,
          updatedAt: summaryRows[0].updatedAt,
        }
      : null,
    canScrape,
    scrapeCredits: canScrape
      ? Math.min(SELECTION_REVIEW_SCRAPE_DEFAULT_MAX, mon!.reviewMaxPerTask) * mon!.reviewCreditsPerResult
      : 0,
    platform: row.platform,
  }
}

const scrapeReviewsSchema = z.object({
  resultId: z.string().uuid(),
  maxReviews: z.number().int().min(1).max(500).optional(),
})

/**
 * 详情弹窗「抓取评论」：为数据池里任意商品 / 帖子建一次性评论抓取任务（无监控
 * 目标，按评论费率预扣发起人积分），完成后入库并生成目标级 AI 洞察。
 * 同一目标冷却期内不重复建任务。
 */
export async function scrapeResultReviewsAction(input: unknown) {
  const ctx = await requireSelection()
  const q = scrapeReviewsSchema.safeParse(input)
  if (!q.success) {
    return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  }
  const enterpriseId = ctx.user.enterpriseId!

  const [result] = await db
    .select({
      platform: selectionResults.platform,
      externalId: selectionResults.externalId,
      sourceUrl: selectionResults.sourceUrl,
      title: selectionResults.title,
      content: selectionResults.content,
      country: selectionResults.country,
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
  if (!isSelectionPlatform(result.platform)) return { ok: false as const, error: "不支持的平台" }
  const mon = SELECTION_PLATFORM_CONFIGS[result.platform].monitor
  if (!mon?.reviewActorId) return { ok: false as const, error: "该平台暂不支持评论抓取" }
  if (!result.sourceUrl) return { ok: false as const, error: "该数据行缺少来源链接" }

  const max = Math.min(q.data.maxReviews ?? SELECTION_REVIEW_SCRAPE_DEFAULT_MAX, mon.reviewMaxPerTask)
  const estimatedCredits = max * mon.reviewCreditsPerResult
  if (ctx.user.creditsBalance < estimatedCredits) {
    return {
      ok: false as const,
      error: `积分不足：抓取 ${max} 条评论需 ${estimatedCredits} 积分（当前余额 ${ctx.user.creditsBalance}）`,
    }
  }

  const cred = await resolveSelectionToken({ enterpriseId })
  if (!cred) {
    return {
      ok: false as const,
      error: "企业未配置选品抓取凭证（请联系超管在平台管理配置 Apify Token）",
    }
  }

  const targetTitle = (result.title ?? result.content ?? "").slice(0, 120)
  const params = {
    targetUrl: result.sourceUrl,
    externalId: result.externalId ?? "",
    targetTitle,
    keyword: targetTitle || result.sourceUrl,
    country: result.country ?? "",
    reviewMax: max,
    // 一次性抓取取「最有用」的评论（监控周期抓取才取最新）
    reviewSort: "helpful",
  }
  const built = buildActorInput({
    platform: result.platform,
    taskType: "review",
    params,
    maxResults: max,
  })

  // 事务闭包里收窄会丢失，先落到局部常量
  const sourceUrl = result.sourceUrl
  const platformLabel = SELECTION_PLATFORM_CONFIGS[result.platform].label
  const labelBase = (targetTitle || sourceUrl).slice(0, 60)
  // 冷却匹配同样按双形态（监控建的任务存规范化链接，本入口存原始 sourceUrl）
  const cooldownUrls = monitorTargetUrls(sourceUrl)
  const since = new Date(Date.now() - REVIEW_SCRAPE_COOLDOWN_MS)
  let outcome: { ok: true; taskId: string } | { ok: false; error: string }
  try {
    outcome = await db.transaction(async (tx) => {
      // 冷却检查与插入同事务 + 目标级 advisory 锁串行化并发（照 createSelectionTask
      // 的日限模式）：先查后插不在同一事务时，两个并发请求都能通过冷却、各建一
      // 个任务各扣一次费
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${enterpriseId} || ':review:' || ${sourceUrl}))`,
      )
      // 冷却：同一目标在途、或一小时内已完成的评论抓取任务（含监控建的）→ 不重复建
      const [recent] = await tx
        .select({ status: selectionTasks.status, createdAt: selectionTasks.createdAt })
        .from(selectionTasks)
        .where(
          and(
            eq(selectionTasks.enterpriseId, enterpriseId),
            eq(selectionTasks.taskType, "review"),
            sql`${selectionTasks.searchParams}->>'targetUrl' in (${sql.join(
              cooldownUrls.map((u) => sql`${u}`),
              sql`, `,
            )})`,
          ),
        )
        .orderBy(desc(selectionTasks.createdAt))
        .limit(1)
      if (recent) {
        const inFlight = recent.status === "queued" || recent.status === "processing"
        const freshDone = recent.status === "completed" && recent.createdAt > since
        if (inFlight || freshDone) {
          return {
            ok: false as const,
            error: inFlight
              ? "该目标的评论正在抓取中，请稍候"
              : "该目标一小时内的评论刚抓取过，请稍后再试",
          }
        }
      }
      const [t] = await tx
        .insert(selectionTasks)
        .values({
          enterpriseId,
          userId: ctx.user.id,
          taskType: "review",
          platform: result.platform,
          actorId: built.actorId,
          searchParams: params,
          keyword: (targetTitle || sourceUrl).slice(0, 255),
          country: result.country,
          providerId: cred.providerId,
          maxResults: max,
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
        remark: `抓取评论：${platformLabel}「${labelBase}」×${max}`,
        tx,
      })
      return { ok: true as const, taskId: t!.id }
    })
  } catch (err) {
    // 预扣余额是渲染时快照，锁内扣款仍可能不足：接住给可读错误（否则生产环境
    // 被 Next 通用文案遮蔽，弹窗只看到转圈结束）
    if (err instanceof CreditsInsufficientError) {
      return {
        ok: false as const,
        error: `个人配额不足（需 ${err.needed ?? estimatedCredits} 积分，当前余额 ${err.balance ?? 0}）`,
      }
    }
    throw err
  }
  return { ...outcome, estimatedCredits, maxReviews: max }
}

const reviewsQuerySchema = z.object({
  platform: z.string().optional(),
  country: z.string().max(16).optional(),
  monitorId: z.string().uuid().optional(),
  q: z.string().max(120).optional(),
  // 格式 + 真实日期双重校验（2026-02-31 这类格式对但非真实日期的值进 SQL
  // ::date 转换会直接报错，整页 500）
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
  /** 星级（1~5，按评论评分取整） */
  rating: z.number().int().min(1).max(5).optional(),
  verifiedOnly: z.boolean().optional(),
  sort: z.enum(["newest", "likes_desc", "rating_desc", "rating_asc", "published_desc"]).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(60).optional(),
})

/**
 * 评论流分页查询（评论洞察页）：筛选条件原样驱动统计（条数 / 均分 / 星级分布 /
 * 已验证占比），列表项带 extras 不带 rawData。
 */
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
  // 日期日界按北京时间（与页面时间戳的展示时区一致；库会话时区是 UTC，直接
  // timestamptz vs ::date 会把 00:00~08:00 UTC 的行算进前一天，与 TEMU 模块
  // 的北京日界先例同口径）
  if (q.data.dateFrom) {
    conds.push(
      sql`(${selectionReviews.scrapedAt} at time zone 'Asia/Shanghai')::date >= ${q.data.dateFrom}::date`,
    )
  }
  if (q.data.dateTo) {
    conds.push(
      sql`(${selectionReviews.scrapedAt} at time zone 'Asia/Shanghai')::date <= ${q.data.dateTo}::date`,
    )
  }
  if (q.data.rating) {
    conds.push(sql`floor(${selectionReviews.rating}) = ${q.data.rating}`)
  }
  if (q.data.verifiedOnly) {
    conds.push(eq(selectionReviews.verified, true))
  }
  const where = and(...conds)

  // 读取侧去重：按 dedupe_key 取每键最新一条（跨任务/跨轮重抓的重复行不再计入
  // 列表与统计），列表 / 计数 / 星级分布都在去重后的集合上算
  const latest = db
    .selectDistinctOn([selectionReviews.dedupeKey])
    .from(selectionReviews)
    .where(where)
    .orderBy(selectionReviews.dedupeKey, desc(selectionReviews.scrapedAt), desc(selectionReviews.id))
    .as("latest_reviews")

  const orderBy =
    q.data.sort === "likes_desc"
      ? desc(sql`coalesce(${latest.likesCount}, 0)`)
      : q.data.sort === "rating_desc"
        ? sql`${latest.rating} desc nulls last`
        : q.data.sort === "rating_asc"
          ? sql`${latest.rating} asc nulls last`
          : q.data.sort === "published_desc"
            ? sql`${latest.publishedAt} desc nulls last`
            : desc(latest.scrapedAt)

  const [items, countRes, statRes] = await Promise.all([
    db
      .select()
      .from(latest)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(latest),
    db
      .select({
        ratedCount: sql<number>`count(${latest.rating})::int`,
        avgRating: sql<string | null>`avg(${latest.rating})::numeric(3,2)`,
        verifiedCount: sql<number>`count(*) filter (where ${latest.verified})::int`,
        r1: sql<number>`count(*) filter (where floor(${latest.rating}) = 1)::int`,
        r2: sql<number>`count(*) filter (where floor(${latest.rating}) = 2)::int`,
        r3: sql<number>`count(*) filter (where floor(${latest.rating}) = 3)::int`,
        r4: sql<number>`count(*) filter (where floor(${latest.rating}) = 4)::int`,
        r5: sql<number>`count(*) filter (where floor(${latest.rating}) = 5)::int`,
      })
      .from(latest),
  ])
  const stat = statRes[0]
  return {
    ok: true as const,
    items: items.map(reviewListItem),
    total: Number(countRes[0]?.count ?? 0),
    page,
    pageSize,
    stats: {
      count: Number(countRes[0]?.count ?? 0),
      ratedCount: Number(stat?.ratedCount ?? 0),
      avgRating: stat?.avgRating != null ? Number(stat.avgRating) : null,
      verifiedCount: Number(stat?.verifiedCount ?? 0),
      ratingCounts: [
        Number(stat?.r1 ?? 0),
        Number(stat?.r2 ?? 0),
        Number(stat?.r3 ?? 0),
        Number(stat?.r4 ?? 0),
        Number(stat?.r5 ?? 0),
      ],
    },
  }
}

/**
 * 评论洞察页汇总：监控目标选项（筛选下拉用）+ AI 洞察三类来源
 * （监控目标级 / 一次性抓取目标级 / 社媒平台日报）。只读既有汇总行，
 * 缺失时需手动刷新补生成。
 */
export async function getSelectionInsightSummariesAction() {
  const ctx = await requireSelection()
  const enterpriseId = ctx.user.enterpriseId!

  const [monitorRows, monitorSummaries, targetSummaries, digestRows, targetTitles] =
    await Promise.all([
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
            eq(selectionAiSummaries.kind, "target"),
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
      // 一次性抓取目标的标题（取该目标最新一条评论上的标题快照）
      db.execute(sql`
        select distinct on (target_url) target_url, target_title
        from selection_review
        where enterprise_id = ${enterpriseId} and target_url is not null
        order by target_url, scraped_at desc
      `) as unknown as Promise<Array<{ target_url: string; target_title: string | null }>>,
    ])

  const titleMap = new Map(
    (targetTitles as Array<{ target_url: string; target_title: string | null }>).map((r) => [
      r.target_url,
      r.target_title,
    ]),
  )
  const targets = targetSummaries.map((s) => ({
    ...s,
    title: s.targetUrl ? (titleMap.get(s.targetUrl) ?? s.targetUrl) : s.targetUrl,
  }))

  return {
    ok: true as const,
    monitors: monitorRows,
    monitorSummaries,
    targetSummaries: targets,
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

