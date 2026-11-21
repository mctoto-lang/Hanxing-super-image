import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  selectionAiSummaries,
  selectionMonitors,
  selectionReviews,
  selectionResults,
} from "@/db/schema"
import { callAiJson } from "@/server/services/ai-json"
import { SELECTION_PLATFORM_CONFIGS, isSelectionPlatform } from "@/lib/selection/platforms"
import type { SelectionAiSummaryData } from "@/lib/selection/ai-summary-types"

/**
 * 选品 AI 洞察（0106）：内部对话模型（resolveProductChatConfig，平台承担
 * 成本、不扣任何用户积分）对两类对象生成结构化汇总：
 *   kind='monitor'：单监控目标的评论汇总（重抓/评论任务完成后刷新）
 *   kind='digest' ：社媒平台当日帖子汇总（discover/market 社交任务完成后刷新）
 *
 * 全链路失败静默降级（未配置内部 AI / 超时 / 输出异常）：不写行、不影响
 * 任务结算；下次触发覆盖刷新（partial unique index upsert）。
 */

/** AI 汇总输入上限（防 prompt 超长：评论 120 条 / 帖子 60 条，超出截断） */
const MAX_REVIEW_INPUT = 120
const MAX_POST_INPUT = 60

const REVIEW_SYSTEM = `你是跨境电商选品分析师。根据给定的用户评论/社媒评论数据，输出严格的 JSON（不要 markdown 代码块、不要解释），结构：
{"sentiment":"positive|neutral|negative|mixed","sentimentScore":0到100整数,"pros":["..."],"cons":["..."],"keywords":["..."],"quotes":["..."],"suggestion":"..."}
要求：pros/cons 各不超过5条且每条不超过20个字；quotes 不超过3条、每条不超过60个字并附来源评分或点赞；keywords 不超过8个；suggestion 不超过120个字、给出可执行的选品或运营建议。全部用中文。`

const DIGEST_SYSTEM = `你是社媒趋势分析师。根据给定的某平台当日帖子数据（标题/正文/互动数），输出严格的 JSON（不要 markdown 代码块、不要解释），结构：
{"sentiment":"positive|neutral|negative|mixed","sentimentScore":0到100整数,"hotTopics":["..."],"pros":["..."],"cons":["..."],"keywords":["..."],"quotes":["..."],"suggestion":"..."}
要求：hotTopics 是当日热议话题（不超过5条）；pros 可写热度/需求信号、cons 写负面信号或风险；quotes 不超过3条、每条不超过60个字并附互动数据；其余同评论分析。全部用中文。`

/**
 * 收割完成后的统一入口（processor 调用）：
 *   monitor/review 任务 → 刷新该监控目标的评论汇总
 *   discover/market 社交平台任务 → 刷新该平台当日 digest
 */
export async function triggerSelectionAiHooks(input: {
  taskId: string
  monitorId: string | null
  enterpriseId: string
  platform: string
  taskType: "discover" | "market" | "monitor" | "review"
}): Promise<void> {
  if (input.monitorId) {
    await generateMonitorAiSummary(input.monitorId).catch((err) => {
      console.warn(
        `[selection-ai] 监控 ${input.monitorId} AI 汇总失败（静默跳过）:`,
        err instanceof Error ? err.message : err,
      )
    })
  }
  if (
    (input.taskType === "discover" || input.taskType === "market") &&
    isSelectionPlatform(input.platform) &&
    SELECTION_PLATFORM_CONFIGS[input.platform].category === "social"
  ) {
    const day = new Date()
    await generateSocialDigest(input.enterpriseId, input.platform, day).catch(
      (err) => {
        console.warn(
          `[selection-ai] ${input.platform} digest 生成失败（静默跳过）:`,
          err instanceof Error ? err.message : err,
        )
      },
    )
  }
}

/** 单监控目标评论汇总（kind='monitor'，覆盖刷新） */
export async function generateMonitorAiSummary(monitorId: string): Promise<void> {
  const [monitor] = await db
    .select()
    .from(selectionMonitors)
    .where(eq(selectionMonitors.id, monitorId))
    .limit(1)
  if (!monitor) return

  const reviews = await db
    .select({
      authorName: selectionReviews.authorName,
      rating: selectionReviews.rating,
      content: selectionReviews.content,
      likesCount: selectionReviews.likesCount,
      publishedAt: selectionReviews.publishedAt,
    })
    .from(selectionReviews)
    .where(
      and(
        eq(selectionReviews.monitorId, monitorId),
        eq(selectionReviews.enterpriseId, monitor.enterpriseId),
      ),
    )
    .orderBy(desc(selectionReviews.scrapedAt), desc(selectionReviews.publishedAt))
    .limit(MAX_REVIEW_INPUT)
  if (reviews.length === 0) return

  const lines = reviews.map((r, i) => {
    const score = r.rating != null ? `${Number(r.rating)}分` : "无评分"
    const likes = r.likesCount != null ? ` 赞${r.likesCount}` : ""
    return `${i + 1}. [${score}${likes}] ${(r.content ?? "").slice(0, 200) || "（无正文）"}`
  })
  const userText = [
    `监控目标：${monitor.title ?? monitor.targetUrl}`,
    `平台：${monitor.platform}`,
    monitor.lastRating != null ? `当前评分：${Number(monitor.lastRating)}` : "",
    monitor.lastReviewCount != null ? `评论总数：${monitor.lastReviewCount}` : "",
    `以下是最新 ${reviews.length} 条评论：`,
    ...lines,
  ]
    .filter(Boolean)
    .join("\n")

  const { data } = await callAiJson<SelectionAiSummaryData>({
    enterpriseId: monitor.enterpriseId,
    system: REVIEW_SYSTEM,
    userText,
    images: [],
    timeoutMs: 45_000,
  })
  const summary = sanitizeSummary(data)
  await db
    .insert(selectionAiSummaries)
    .values({
      enterpriseId: monitor.enterpriseId,
      kind: "monitor",
      monitorId,
      summary,
      reviewCount: reviews.length,
    })
    .onConflictDoUpdate({
      target: selectionAiSummaries.monitorId,
      targetWhere: sql`kind = 'monitor' AND ${selectionAiSummaries.monitorId} IS NOT NULL`,
      set: {
        summary,
        reviewCount: reviews.length,
        updatedAt: new Date(),
      },
    })
}

/** 社媒平台当日 digest（kind='digest'，enterprise+platform+day 覆盖刷新） */
export async function generateSocialDigest(
  enterpriseId: string,
  platform: string,
  day: Date,
): Promise<void> {
  const dayStart = new Date(day)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  const posts = await db
    .select({
      title: selectionResults.title,
      content: selectionResults.content,
      likesCount: selectionResults.likesCount,
      commentsCount: selectionResults.commentsCount,
      viewsCount: selectionResults.viewsCount,
    })
    .from(selectionResults)
    .where(
      and(
        eq(selectionResults.enterpriseId, enterpriseId),
        eq(selectionResults.platform, platform),
        inArray(selectionResults.taskType, ["discover", "market"]),
        gte(selectionResults.scrapedAt, dayStart),
        lt(selectionResults.scrapedAt, dayEnd),
      ),
    )
    .orderBy(desc(selectionResults.likesCount))
    .limit(MAX_POST_INPUT)
  if (posts.length === 0) return

  const lines = posts.map((p, i) => {
    const stats = [
      p.likesCount != null ? `赞${p.likesCount}` : "",
      p.commentsCount != null ? `评${p.commentsCount}` : "",
      p.viewsCount != null ? `看${p.viewsCount}` : "",
    ]
      .filter(Boolean)
      .join("/")
    const text = (p.content ?? p.title ?? "").slice(0, 160) || "（无正文）"
    return `${i + 1}. [${stats || "无互动"}] ${text}`
  })
  const dayStr = `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, "0")}-${String(dayStart.getDate()).padStart(2, "0")}`
  const userText = [
    `平台：${platform}`,
    `日期：${dayStr}`,
    `以下是当日抓取的 ${posts.length} 条帖子（按点赞排序）：`,
    ...lines,
  ].join("\n")

  const { data } = await callAiJson<SelectionAiSummaryData>({
    enterpriseId,
    system: DIGEST_SYSTEM,
    userText,
    images: [],
    timeoutMs: 45_000,
  })
  const summary = sanitizeSummary(data)
  await db
    .insert(selectionAiSummaries)
    .values({
      enterpriseId,
      kind: "digest",
      day: dayStr,
      platform,
      summary,
      postCount: posts.length,
    })
    .onConflictDoUpdate({
      target: [
        selectionAiSummaries.enterpriseId,
        selectionAiSummaries.platform,
        selectionAiSummaries.day,
      ],
      targetWhere: sql`kind = 'digest'`,
      set: {
        summary,
        postCount: posts.length,
        updatedAt: new Date(),
      },
    })
}

/** 模型输出防御式清洗：缺字段/错型回落空值，数组截断 */
function sanitizeSummary(data: SelectionAiSummaryData): SelectionAiSummaryData {
  const arr = (v: unknown, max: number): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, max)
      : []
  const score = Number(data?.sentimentScore)
  const sentiment =
    typeof data?.sentiment === "string" &&
    ["positive", "neutral", "negative", "mixed"].includes(data.sentiment)
      ? data.sentiment
      : "neutral"
  return {
    sentiment,
    sentimentScore: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 50,
    pros: arr(data?.pros, 5),
    cons: arr(data?.cons, 5),
    keywords: arr(data?.keywords, 8),
    quotes: arr(data?.quotes, 3),
    suggestion: typeof data?.suggestion === "string" ? data.suggestion.slice(0, 300) : "",
    hotTopics: arr(data?.hotTopics, 5),
  }
}
