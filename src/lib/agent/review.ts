import type { ReviewDimension } from "./graph"

/** 单个评审员对一张候选图的结构化三维评分。 */
export interface ReviewerScore {
  reviewerId: string
  reviewerName?: string
  contentPass: boolean
  contentScore: number
  aestheticScore: number
  consistencyScore: number
  violations: string[]
  reasons: Partial<Record<ReviewDimension, string>>
}

/** 多个视觉评审员的聚合结论，供总控规则节点使用。 */
export interface AggregatedReview {
  contentPass: boolean
  contentScore: number
  aestheticScore: number
  consistencyScore: number
  violations: string[]
  reasons: Partial<Record<ReviewDimension, string>>
  reviewerCount: number
  passedReviewers: number
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/**
 * 聚合 1~3 个评审员：分数取算术平均，内容与违规项采用多数票。
 * 只有单评审员时保持一票否决，避免低质量图被平均分掩盖。
 */
export function aggregateReviewerScores(scores: ReviewerScore[]): AggregatedReview {
  if (scores.length === 0) {
    throw new Error("至少需要一个视觉评审员")
  }
  const count = scores.length
  const contentPassVotes = scores.filter((score) => score.contentPass).length
  const violationCounts = new Map<string, number>()
  for (const score of scores) {
    for (const violation of score.violations) {
      violationCounts.set(violation, (violationCounts.get(violation) ?? 0) + 1)
    }
  }
  const violations = [...violationCounts.entries()]
    .filter(([, votes]) => count === 1 ? votes >= 1 : votes > count / 2)
    .map(([violation]) => violation)
  const reasons: Partial<Record<ReviewDimension, string>> = {}
  for (const dimension of ["content", "aesthetic", "consistency"] as const) {
    const values = scores.map((score) => score.reasons[dimension]).filter(Boolean)
    if (values.length > 0) reasons[dimension] = values.join("；")
  }
  return {
    contentPass: count === 1 ? contentPassVotes === 1 : contentPassVotes > count / 2,
    contentScore: clampScore(scores.reduce((sum, score) => sum + score.contentScore, 0) / count),
    aestheticScore: clampScore(scores.reduce((sum, score) => sum + score.aestheticScore, 0) / count),
    consistencyScore: clampScore(scores.reduce((sum, score) => sum + score.consistencyScore, 0) / count),
    violations,
    reasons,
    reviewerCount: count,
    passedReviewers: contentPassVotes,
  }
}

/** reviewPasses 的入参子集（前端评分卡与聚合结论共用同一判定口径） */
export interface ReviewPassInput {
  contentPass: boolean
  contentScore: number
  aestheticScore: number
  consistencyScore: number
  violations: string[]
}

export function reviewPasses(input: ReviewPassInput, thresholds: { contentScore?: number; aestheticScore: number; consistencyScore: number }): boolean {
  return input.contentPass && input.violations.length === 0 && input.aestheticScore >= thresholds.aestheticScore && input.consistencyScore >= thresholds.consistencyScore && (input.contentScore >= (thresholds.contentScore ?? 60))
}

/**
 * 多数票通过判定（生产统一口径）：每个评审对某维度各投一票，超过半数通过；
 * 单评审时一票否决（1/1 过、0/1 不过）。
 * orchestrator 的聚合刷新（refreshAggregatedReviewState）、deck 整副评分
 * 聚合与前端评分卡共用本函数——此前三处各自手写复刻，口径已出现漂移
 * （平均分 vs 多数票对「74/100、阈值 75」结论相反）。
 */
export function majorityVotePassed(passVotes: number, total: number): boolean {
  if (total <= 0) return false
  return total === 1 ? passVotes === 1 : passVotes > total / 2
}
