import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import { ReviewsClient } from "@/components/selection/reviews-client"
import { platformLabel } from "@/components/selection/labels"
import { isSelectionPlatform } from "@/lib/selection/platforms"
import { isCalendarDate } from "@/lib/selection/pool-url"
import { parseUuid } from "@/lib/selection/ids"
import {
  REVIEW_SORTS,
  type InsightCard,
  type ReviewsFilter,
} from "@/lib/selection/review-types"
import {
  getSelectionInsightSummariesAction,
  getSelectionReviewsAction,
} from "@/server/actions/selection-monitor"

export const dynamic = "force-dynamic"

const PAGE_SIZES = [20, 40, 60]

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/** YYYY-MM-DD 且是真实日期（格式对但非真实日期的值进 SQL ::date 转换会整页 500） */
function dateOrEmpty(v: string): string {
  return isCalendarDate(v) ? v : ""
}

/**
 * 评论洞察：监控周期抓取 / 一次性抓取的评论（电商评论 + 社媒评论）+ AI 洞察
 * （监控目标级、一次性抓取目标级、社媒日报；内部模型自动生成、不扣积分）。
 * 平台 / 监控目标 / 星级 / 仅已验证 / 关键词 / 日期 / 排序 / 分页全部 URL 驱动。
 */
export default async function SelectionReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("selection")) return <NoPermission module="选品工具" />

  const sp = await searchParams
  const ratingRaw = first(sp.rating)
  const sortRaw = first(sp.sort)
  // monitorId 过 parseUuid 消毒：垃圾值直传 action 的 uuid 字段会让整页只渲染
  // 「参数错误」，消毒后按「无该筛选」处理
  const monitorId = parseUuid(first(sp.monitor)) ?? ""
  const filter: ReviewsFilter = {
    platform: isSelectionPlatform(first(sp.platform)) ? first(sp.platform) : "",
    monitorId,
    rating: ["1", "2", "3", "4", "5"].includes(ratingRaw) ? ratingRaw : "",
    verified: first(sp.verified) === "1" ? "1" : "",
    q: first(sp.q).slice(0, 120),
    sort: (REVIEW_SORTS as readonly string[]).includes(sortRaw) ? sortRaw : "newest",
    dateFrom: dateOrEmpty(first(sp.dateFrom)),
    dateTo: dateOrEmpty(first(sp.dateTo)),
  }
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1))
  const pageSizeRaw = Number(first(sp.pageSize))
  const pageSize = PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : PAGE_SIZES[0]!

  const [reviews, insight] = await Promise.all([
    getSelectionReviewsAction({
      platform: filter.platform || undefined,
      monitorId: filter.monitorId || undefined,
      rating: filter.rating ? Number(filter.rating) : undefined,
      verifiedOnly: filter.verified === "1",
      q: filter.q || undefined,
      sort: filter.sort,
      dateFrom: filter.dateFrom || undefined,
      dateTo: filter.dateTo || undefined,
      page,
      pageSize,
    }),
    getSelectionInsightSummariesAction(),
  ])

  if (!reviews.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="评论洞察" description="评论流与 AI 分析。" />
        <p className="text-sm text-destructive">{reviews.error}</p>
      </div>
    )
  }

  const monitorTitle = new Map(insight.monitors.map((m) => [m.id, m.title ?? m.targetUrl]))
  const insights: InsightCard[] = [
    ...insight.monitorSummaries.map((s) => ({
      id: s.id,
      kind: "monitor" as const,
      monitorId: s.monitorId,
      targetUrl: null,
      platform: s.platform ?? insight.monitors.find((m) => m.id === s.monitorId)?.platform ?? null,
      day: null,
      reviewCount: s.reviewCount,
      postCount: s.postCount,
      updatedAt: s.updatedAt,
      summary: s.summary,
      title: (s.monitorId ? monitorTitle.get(s.monitorId) : null) ?? `监控目标 ${(s.monitorId ?? "").slice(0, 8)}`,
    })),
    ...insight.targetSummaries.map((s) => ({
      id: s.id,
      kind: "target" as const,
      monitorId: null,
      targetUrl: s.targetUrl,
      platform: s.platform,
      day: null,
      reviewCount: s.reviewCount,
      postCount: s.postCount,
      updatedAt: s.updatedAt,
      summary: s.summary,
      title: s.title ?? s.targetUrl ?? "抓取目标",
    })),
    ...insight.digests.map((s) => ({
      id: s.id,
      kind: "digest" as const,
      monitorId: null,
      targetUrl: null,
      platform: s.platform,
      day: s.day ? String(s.day).slice(0, 10) : null,
      reviewCount: s.reviewCount,
      postCount: s.postCount,
      updatedAt: s.updatedAt,
      summary: s.summary,
      title: `${platformLabel(s.platform ?? "")} 日报`,
    })),
  ].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())

  return (
    <div className="space-y-4">
      <PageHeader
        title="评论洞察"
        description="竞品监控与一次性抓取的评论（电商评论 / 社媒评论），AI 自动汇总情感、卖点、痛点与行动建议；KPI 与星级分布随筛选联动。"
      />
      <ReviewsClient
        initial={reviews}
        filter={filter}
        monitors={insight.monitors.map((m) => ({
          id: m.id,
          platform: m.platform,
          title: m.title,
          targetUrl: m.targetUrl,
        }))}
        insights={insights}
      />
    </div>
  )
}
