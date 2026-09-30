"use client"

/**
 * 评审评分卡 + 整副评分概览
 *
 * - ReviewScoreCard：聚合评审结论（三维分数条 + 通过徽标 + 违规项 + 理由），
 *   多评审员时可折叠展开逐人明细；
 * - DeckScoreSummary：整副卡牌各维度平均分 + 低于及格线张数统计。
 */
import { useState } from "react"
import { ChevronDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { ReviewDimension } from "@/lib/agent/graph"
import { aggregateReviewerScores, reviewPasses, type ReviewerScore } from "@/lib/agent/review"
import {
  averageScores,
  DEFAULT_SCORE_THRESHOLDS,
  SCORE_DIMENSION_LABELS,
  violationLabel,
  type DimensionScores,
  type ScoreThresholds,
} from "@/lib/agent/score"
import { ScoreBar } from "./score-bar"

const SCORE_DIMENSIONS: readonly ReviewDimension[] = ["content", "aesthetic", "consistency"]

/** 聚合评审结论（AggregatedReview 去掉 passedReviewers 后的展示所需子集） */
export interface ReviewAggregateLike {
  contentPass: boolean
  contentScore: number
  aestheticScore: number
  consistencyScore: number
  violations: string[]
  reasons: Partial<Record<ReviewDimension, string>>
  reviewerCount: number
}

export function ReviewScoreCard({
  aggregate,
  reviewers,
  thresholds,
  compact = false,
}: {
  /** 聚合评审结论；缺省时若给了 reviewers 则现场聚合（单评审员一票否决） */
  aggregate?: ReviewAggregateLike
  /** 各评审员原始评分（>1 位时展示「查看 N 位评审员明细」折叠列表） */
  reviewers?: ReviewerScore[]
  /** 及格线覆盖（缺省维度用 DEFAULT_SCORE_THRESHOLDS） */
  thresholds?: Partial<ScoreThresholds>
  /** 紧凑模式：隐藏理由与评审员明细，仅保留徽标 + 分数条 + 违规项 */
  compact?: boolean
}) {
  const th = { ...DEFAULT_SCORE_THRESHOLDS, ...thresholds }
  const reviewerList = reviewers ?? []
  const view =
    aggregate ??
    (reviewerList.length > 0 ? aggregateReviewerScores(reviewerList) : undefined)
  const [detailOpen, setDetailOpen] = useState(false)

  if (!view) return null
  // 统一判定口径：直接复用 review.ts 的 reviewPasses（此前本地手写复刻曾与
  // 生产口径漂移）
  const passed = reviewPasses(view, {
    contentScore: th.content,
    aestheticScore: th.aesthetic,
    consistencyScore: th.consistency,
  })

  return (
    <Card size="sm" className="gap-3">
      <CardHeader className="gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          评审评分
          <Badge
            variant="secondary"
            className={
              passed
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                : "bg-red-500/15 text-red-600 dark:text-red-300"
            }
          >
            {passed ? "通过" : "未通过"}
          </Badge>
        </CardTitle>
        {view.violations.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {view.violations.map((violation) => (
              <Badge
                key={violation}
                variant="outline"
                className="border-red-500/50 text-[10px] text-red-600 dark:text-red-400"
              >
                {violationLabel(violation)}
              </Badge>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2.5">
        {SCORE_DIMENSIONS.map((dim) => {
          const score =
            dim === "content"
              ? view.contentScore
              : dim === "aesthetic"
                ? view.aestheticScore
                : view.consistencyScore
          const reason = view.reasons[dim]
          return (
            <div key={dim} className="space-y-1">
              <ScoreBar
                label={SCORE_DIMENSION_LABELS[dim]}
                score={score}
                threshold={th[dim]}
                size={compact ? "sm" : "md"}
                showThreshold={!compact}
              />
              {!compact && reason && (
                <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                  {reason}
                </p>
              )}
            </div>
          )
        })}
        {!compact && reviewerList.length > 1 && (
          <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
            <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1 pt-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground">
              <ChevronDown
                className={cn("size-3 transition-transform", detailOpen && "rotate-180")}
              />
              查看 {reviewerList.length} 位评审员明细
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 space-y-2.5 border-t pt-2.5">
                {reviewerList.map((reviewer) => (
                  <div key={reviewer.reviewerId} className="space-y-1">
                    <p className="flex items-center gap-2 text-[11px] font-medium">
                      <span className="text-foreground/80">
                        {reviewer.reviewerName ?? reviewer.reviewerId}
                      </span>
                      <span
                        className={
                          reviewer.contentPass
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }
                      >
                        内容{reviewer.contentPass ? "通过" : "未通过"}
                      </span>
                      {reviewer.violations.length > 0 && (
                        <span className="truncate text-red-600 dark:text-red-400">
                          {reviewer.violations.map(violationLabel).join("、")}
                        </span>
                      )}
                    </p>
                    <div className="space-y-0.5">
                      <ScoreBar label={SCORE_DIMENSION_LABELS.content} score={reviewer.contentScore} threshold={th.content} size="sm" />
                      <ScoreBar label={SCORE_DIMENSION_LABELS.aesthetic} score={reviewer.aestheticScore} threshold={th.aesthetic} size="sm" />
                      <ScoreBar label={SCORE_DIMENSION_LABELS.consistency} score={reviewer.consistencyScore} threshold={th.consistency} size="sm" />
                    </div>
                    {reviewer.reasons.content && (
                      <p className="line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
                        {reviewer.reasons.content}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  )
}

export function DeckScoreSummary({
  items,
  thresholds,
}: {
  /** 每张卡的三维度得分（null = 未评分，均分时忽略） */
  items: DimensionScores[]
  /** 及格线覆盖（缺省维度用 DEFAULT_SCORE_THRESHOLDS） */
  thresholds?: Partial<ScoreThresholds>
}) {
  const th = { ...DEFAULT_SCORE_THRESHOLDS, ...thresholds }
  const totals = averageScores(items, thresholds)
  const hasAny =
    totals.content !== null || totals.aesthetic !== null || totals.consistency !== null

  return (
    <Card size="sm" className="gap-3">
      <CardHeader>
        <CardTitle className="text-sm">整副评分概览</CardTitle>
        <CardDescription className="text-xs">
          {hasAny ? `${items.length} 张卡各维度平均分与达标情况` : "暂无评分数据"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {hasAny ? (
          SCORE_DIMENSIONS.map((dim) => {
            const score =
              dim === "content"
                ? totals.content
                : dim === "aesthetic"
                  ? totals.aesthetic
                  : totals.consistency
            return (
              <div key={dim} className="space-y-0.5">
                <ScoreBar
                  label={SCORE_DIMENSION_LABELS[dim]}
                  score={score}
                  threshold={th[dim]}
                  showThreshold
                />
                <p className="text-[11px] text-muted-foreground">
                  低于及格线 {totals.belowThreshold[dim]} 张
                </p>
              </div>
            )
          })
        ) : (
          <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            还没有评分记录，运行产出评分后这里会展示整副卡牌的平均分。
          </p>
        )}
      </CardContent>
    </Card>
  )
}
