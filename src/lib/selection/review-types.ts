import type { ReviewExtras } from "@/lib/selection/extras"
import type { SelectionAiSummaryData } from "@/lib/selection/ai-summary-types"

/**
 * 评论洞察页共享类型（client-safe：action 返回形状 / 页面 / 客户端组件三方共用）
 */

/** 评论列表项 = selection_review 行（去 rawData）+ extras 投影 */
export interface ReviewItem {
  id: string
  taskId: string
  monitorId: string | null
  enterpriseId: string
  platform: string
  country: string | null
  externalId: string | null
  dedupeKey: string
  targetTitle: string | null
  targetUrl: string | null
  authorName: string | null
  /** numeric 字符串 */
  rating: string | null
  content: string | null
  likesCount: number | null
  verified: boolean | null
  publishedAt: Date | null
  scrapedAt: Date
  createdAt: Date
  extras: ReviewExtras
}

/** 当前筛选口径下的统计 */
export interface ReviewStats {
  count: number
  ratedCount: number
  avgRating: number | null
  verifiedCount: number
  /** 1 星 → 5 星的条数 */
  ratingCounts: number[]
}

export interface ReviewsPayload {
  ok: true
  items: ReviewItem[]
  total: number
  page: number
  pageSize: number
  stats: ReviewStats
}

/** AI 洞察卡（监控目标级 / 一次性抓取目标级 / 社媒平台日报） */
export interface InsightCard {
  id: string
  kind: "monitor" | "target" | "digest"
  monitorId: string | null
  targetUrl: string | null
  platform: string | null
  day: string | null
  reviewCount: number
  postCount: number
  updatedAt: Date
  summary: SelectionAiSummaryData
  /** 展示标题（监控目标名 / 抓取目标名 / 平台·日期） */
  title: string
}

/** 评论洞察页 URL 筛选状态 */
export interface ReviewsFilter {
  platform: string
  /** 监控目标 ID */
  monitorId: string
  /** 1~5；空 = 全部星级 */
  rating: string
  /** "1" = 仅已验证 */
  verified: string
  q: string
  sort: string
  dateFrom: string
  dateTo: string
}

export const REVIEW_SORTS = ["newest", "likes_desc", "rating_desc", "rating_asc", "published_desc"] as const
export const REVIEW_SORT_LABELS: Record<(typeof REVIEW_SORTS)[number], string> = {
  newest: "最新抓取",
  likes_desc: "点赞优先",
  rating_desc: "评分从高到低",
  rating_asc: "评分从低到高",
  published_desc: "发布时间",
}
