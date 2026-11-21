import { MessageSquareQuote } from "lucide-react"
import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { ReviewsClient } from "@/components/selection/reviews-client"
import {
  getSelectionInsightSummariesAction,
  getSelectionReviewsAction,
} from "@/server/actions/selection-monitor"

export const dynamic = "force-dynamic"

/**
 * 评论洞察（0106 开放）：竞品监控抓取的评论（电商评论/社媒评论）+ AI 汇总
 * （监控目标级 + 社媒平台日 digest，内部对话模型自动生成、不扣积分）。
 */
export default async function SelectionReviewsPage() {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("selection")) return <NoPermission module="选品工具" />

  const [reviews, insight] = await Promise.all([
    getSelectionReviewsAction({ page: 1, pageSize: 20 }),
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

  const kpis = [
    { label: "评论总数", value: String(reviews.overallCount) },
    { label: "平均评分", value: reviews.overallAvgRating != null ? reviews.overallAvgRating.toFixed(2) : "—" },
    { label: "监控目标", value: String(insight.monitors.length) },
    { label: "AI 分析", value: String(insight.monitorSummaries.length + insight.digests.length) },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="评论洞察"
        description="竞品监控抓取的评论与社媒互动数据，AI 自动汇总情感/卖点/痛点与行动建议（分析费用平台承担）。"
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="py-0">
            <CardContent className="flex items-center gap-3 px-4 py-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <MessageSquareQuote className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{k.label}</p>
                <p className="truncate text-lg leading-tight font-semibold tabular-nums">
                  {k.value}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <ReviewsClient
        initialReviews={reviews}
        monitors={insight.monitors}
        monitorSummaries={insight.monitorSummaries}
        digests={insight.digests}
      />
    </div>
  )
}
