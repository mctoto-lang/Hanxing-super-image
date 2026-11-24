import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  selectionMonitors,
  selectionReviews,
  selectionResults,
  selectionTasks,
} from "@/db/schema"
import { refundUserCredits } from "@/server/services/credits-service"
import {
  creditsPerResultFor,
  isSelectionPlatform,
} from "@/lib/selection/platforms"
import {
  isActorErrorRow,
  normalizeSelectionItem,
  normalizeReviewItem,
} from "@/lib/selection/normalizers"

/**
 * 选品任务结算与结果入库（worker 收割循环与 action 取消路径共用）
 *
 * 本文件绝不放进 "use server" 导出（计费内部逻辑，见 credits-service
 * refundFailedTask 同款红线注释）。
 */

/** 入库分批大小（单批 insert 行数） */
const INGEST_BATCH_SIZE = 100

interface TaskRef {
  id: string
  enterpriseId: string
  platform: string
  taskType: "discover" | "market" | "monitor" | "review"
  /** 任务国家快照（selection_task.country，传播到结果行供数据池筛选） */
  country?: string | null
}

/**
 * 归一化 + 分批入库（ON CONFLICT (task_id, dedupe_key) DO NOTHING——
 * worker 崩溃重启后重拉 dataset 幂等）。返回本批实际新插入行数。
 * Actor 的错误记录行（如 Amazon 榜单不支持的类目）不是结果：不入库、不计费。
 */
export async function ingestSelectionResults(
  task: TaskRef,
  items: Array<Record<string, unknown>>,
): Promise<number> {
  if (items.length === 0) return 0
  const platform = isSelectionPlatform(task.platform) ? task.platform : "amazon"
  const values = items
    .filter((item) => !isActorErrorRow(item))
    .map((item) => {
      const n = normalizeSelectionItem(platform, task.taskType, item)
      return {
        taskId: task.id,
        enterpriseId: task.enterpriseId,
        platform: task.platform,
        country: task.country ?? null,
        taskType: task.taskType,
        externalId: n.externalId,
        sourceUrl: n.sourceUrl,
        dedupeKey: n.dedupeKey,
        title: n.title,
        content: n.content,
        price: n.price,
        originalPrice: n.originalPrice,
        currency: n.currency,
        rating: n.rating,
        reviewCount: n.reviewCount,
        salesCount: n.salesCount,
        likesCount: n.likesCount,
        commentsCount: n.commentsCount,
        sharesCount: n.sharesCount,
        viewsCount: n.viewsCount,
        rank: n.rank,
        sellerName: n.sellerName,
        images: n.images,
        videos: n.videos,
        category: n.category,
        categoryPath: n.categoryPath,
        tags: n.tags,
        hashtags: n.hashtags,
        publishedAt: n.publishedAt,
        rawData: n.rawData,
      }
    })

  let inserted = 0
  for (let i = 0; i < values.length; i += INGEST_BATCH_SIZE) {
    const batch = values.slice(i, i + INGEST_BATCH_SIZE)
    const rows = await db
      .insert(selectionResults)
      .values(batch)
      .onConflictDoNothing({ target: [selectionResults.taskId, selectionResults.dedupeKey] })
      .returning({ id: selectionResults.id })
    inserted += rows.length
  }
  return inserted
}

/** 任务实际入库行数（结算计费口径：按唯一行计，不按 dataset 原始条数） */
export async function countTaskResults(taskId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(selectionResults)
    .where(eq(selectionResults.taskId, taskId))
  return count
}

// ── 评论入库（0106） ────────────────────────────────────────────

interface ReviewTaskRef extends TaskRef {
  monitorId?: string | null
  /** 监控目标上下文（列表页展示被评论对象；reddit monitor 任务=帖子本身） */
  targetTitle?: string | null
  targetUrl?: string | null
}

/**
 * 评论归一化 + 分批入库（ON CONFLICT (task_id, dedupe_key) DO NOTHING 幂等）。
 * 返回本批实际新插入行数。被评论对象上下文取任务级快照（评论行内字段不统一）。
 * Actor 错误记录行不是评论：不入库、不计费。
 */
export async function ingestSelectionReviews(
  task: ReviewTaskRef,
  items: Array<Record<string, unknown>>,
): Promise<number> {
  if (items.length === 0) return 0
  const values = items
    .filter((item) => !isActorErrorRow(item))
    .map((item) => {
      const n = normalizeReviewItem(item)
      return {
        taskId: task.id,
        monitorId: task.monitorId ?? null,
        enterpriseId: task.enterpriseId,
        platform: task.platform,
        country: task.country ?? null,
        externalId: n.externalId,
        dedupeKey: n.dedupeKey,
        targetTitle: task.targetTitle ?? null,
        targetUrl: task.targetUrl ?? null,
        authorName: n.authorName,
        rating: n.rating,
        content: n.content,
        likesCount: n.likesCount,
        verified: n.verified,
        publishedAt: n.publishedAt,
        rawData: n.rawData,
      }
    })
  let inserted = 0
  for (let i = 0; i < values.length; i += INGEST_BATCH_SIZE) {
    const batch = values.slice(i, i + INGEST_BATCH_SIZE)
    const rows = await db
      .insert(selectionReviews)
      .values(batch)
      .onConflictDoNothing({ target: [selectionReviews.taskId, selectionReviews.dedupeKey] })
      .returning({ id: selectionReviews.id })
    inserted += rows.length
  }
  return inserted
}

/**
 * reddit monitor 任务专用：帖子行内嵌 comments 数组（automation-lab
 * includeComments 出参）抽出评论入库。顶层 + replies 一层展开。
 */
export async function ingestRedditPostComments(
  task: ReviewTaskRef,
  posts: Array<Record<string, unknown>>,
): Promise<number> {
  const flat: Array<Record<string, unknown>> = []
  for (const post of posts) {
    const comments = post.comments ?? post.replies
    if (!Array.isArray(comments)) continue
    for (const c of comments) {
      if (!c || typeof c !== "object") continue
      flat.push(c as Record<string, unknown>)
      const replies = (c as Row).replies
      if (Array.isArray(replies)) {
        for (const r of replies) {
          if (r && typeof r === "object") flat.push(r as Record<string, unknown>)
        }
      }
    }
  }
  return ingestSelectionReviews(task, flat)
}

type Row = Record<string, unknown>

/** 任务评论入库行数（review 型任务结算计费口径） */
export async function countTaskReviews(taskId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(selectionReviews)
    .where(eq(selectionReviews.taskId, taskId))
  return count
}

// ── 监控快照回写（0106：monitor 任务收割后调用） ────────────────

/**
 * 用 monitor 任务最新一次入库的结果行刷新监控目标快照列（列表页免 join）。
 * 按 externalId/sourceUrl 匹配目标行，找不到则取该任务最新一行兜底。
 */
export async function refreshMonitorSnapshot(
  monitorId: string,
  taskId: string,
): Promise<void> {
  const [monitor] = await db
    .select()
    .from(selectionMonitors)
    .where(eq(selectionMonitors.id, monitorId))
    .limit(1)
  if (!monitor) return
  const rows = await db
    .select()
    .from(selectionResults)
    .where(eq(selectionResults.taskId, taskId))
    .orderBy(desc(selectionResults.createdAt))
    .limit(20)
  if (rows.length === 0) return
  const hit =
    rows.find(
      (r) =>
        (monitor.externalId && r.externalId === monitor.externalId) ||
        (monitor.targetUrl && r.sourceUrl === monitor.targetUrl),
    ) ?? rows[0]!
  await db
    .update(selectionMonitors)
    .set({
      lastPrice: hit.price,
      lastCurrency: hit.currency ?? monitor.lastCurrency,
      lastRating: hit.rating,
      // 单品详情类 actor 不提供销量（TEMU）时保留上次值，避免被 null 抹掉
      lastSalesCount: hit.salesCount ?? monitor.lastSalesCount,
      lastReviewCount: hit.reviewCount,
      lastLikesCount: hit.likesCount,
      lastCommentsCount: hit.commentsCount,
      lastViewsCount: hit.viewsCount,
      lastSharesCount: hit.sharesCount,
      lastRank: hit.rank,
      lastMetricsAt: hit.scrapedAt,
      // 顺带回填标题/首图（首次重抓发现池内行缺图时兜底）。粘贴链接添加的目标
      // 标题留空，首轮抓到真实标题后回填；形如裸域名的历史占位标题同样覆盖
      title:
        !monitor.title || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(monitor.title)
          ? (hit.title ?? monitor.title)
          : monitor.title,
      imageUrl: monitor.imageUrl ?? (hit.images?.[0] ?? null),
      updatedAt: new Date(),
    })
    .where(eq(selectionMonitors.id, monitorId))
}

/**
 * 任务终态结算（幂等，防并发双退）：
 *   actual = min(预估, 入库行数 × 费率)，差额退回个人配额。
 *
 * 幂等机制：actualCredits 从 NULL 条件更新「认领」（对齐 refundFailedTask），
 * 多副本/取消与收割并发时只有一方能结算；取消（queued 无 run）由 action
 * 直接调用本函数全额退款，收割路径发现已结算自动跳过。
 */
export async function settleSelectionTask(input: {
  taskId: string
  finalStatus: "completed" | "failed" | "cancelled"
  fetchedCount: number
  errorMessage?: string | null
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(selectionTasks)
      .where(eq(selectionTasks.id, input.taskId))
      .limit(1)
      .for("update")
    if (!task || task.actualCredits != null) return // 已结算

    const rate = isSelectionPlatform(task.platform)
      ? creditsPerResultFor(task.platform, task.taskType)
      : 1
    const actual = Math.min(
      task.estimatedCredits,
      Math.max(0, input.fetchedCount) * rate,
    )
    const refund = Math.max(0, task.estimatedCredits - actual)

    // 认领：actualCredits NULL → actual（并发另一方认领失败即返回）
    const claimed = await tx
      .update(selectionTasks)
      .set({ actualCredits: actual })
      .where(
        and(
          eq(selectionTasks.id, task.id),
          isNull(selectionTasks.actualCredits),
        ),
      )
      .returning({ id: selectionTasks.id })
    if (claimed.length === 0) return

    if (refund > 0) {
      await refundUserCredits({
        enterpriseId: task.enterpriseId,
        userId: task.userId,
        amount: refund,
        taskId: task.id,
        type: "selection_refund",
        remark:
          actual > 0
            ? `选品任务结算退还（预估 ${task.estimatedCredits}，实际 ${actual}）`
            : input.finalStatus === "cancelled"
              ? "选品任务取消全额退还"
              : input.finalStatus === "completed"
                ? "任务完成，未获取到结果数据，未扣积分"
                : "选品任务失败全额退还",
        tx,
      })
    }

    await tx
      .update(selectionTasks)
      .set({
        status: input.finalStatus,
        fetchedCount: Math.max(0, input.fetchedCount),
        progress: 100,
        errorMessage: input.errorMessage ?? null,
        completedAt: new Date(),
        cancelledAt:
          input.finalStatus === "cancelled" ? (task.cancelledAt ?? new Date()) : task.cancelledAt,
      })
      .where(eq(selectionTasks.id, task.id))
  })
}
