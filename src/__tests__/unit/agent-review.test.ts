import { describe, expect, it } from "vitest"
import { aggregateReviewerScores, majorityVotePassed, reviewPasses } from "@/lib/agent/review"

describe("agent reviewer aggregation", () => {
  it("averages scores and applies majority votes", () => {
    const result = aggregateReviewerScores([
      { reviewerId: "a", contentPass: true, contentScore: 90, aestheticScore: 80, consistencyScore: 70, violations: [], reasons: {} },
      { reviewerId: "b", contentPass: false, contentScore: 40, aestheticScore: 60, consistencyScore: 50, violations: ["text"], reasons: { content: "出现文字" } },
      { reviewerId: "c", contentPass: true, contentScore: 80, aestheticScore: 70, consistencyScore: 60, violations: ["text"], reasons: { consistency: "风格跳出" } },
    ])
    expect(result.contentPass).toBe(true)
    expect(result.contentScore).toBe(70)
    expect(result.aestheticScore).toBe(70)
    expect(result.violations).toEqual(["text"])
    expect(reviewPasses(result, { aestheticScore: 65, consistencyScore: 55 })).toBe(false)
  })

  it("single reviewer is a strict gate", () => {
    const result = aggregateReviewerScores([{ reviewerId: "a", contentPass: false, contentScore: 80, aestheticScore: 95, consistencyScore: 95, violations: ["border"], reasons: {} }])
    expect(result.contentPass).toBe(false)
    expect(reviewPasses(result, { aestheticScore: 70, consistencyScore: 70 })).toBe(false)
  })

  // 判别用例：无违规且三维分数全部过线时 reviewPasses 必须为 true——
  // 此前两个用例都被 violations/contentPass 短路成 false，分数比较分支
  // 即使写反（>= 改 <=）测试也照常通过
  it("passes when no violations and every score clears its threshold", () => {
    const result = aggregateReviewerScores([
      { reviewerId: "a", contentPass: true, contentScore: 80, aestheticScore: 82, consistencyScore: 71, violations: [], reasons: {} },
    ])
    expect(reviewPasses(result, { contentScore: 60, aestheticScore: 75, consistencyScore: 70 })).toBe(true)
    // 分数恰在阈值上也算过线（>= 语义）
    expect(reviewPasses(result, { contentScore: 80, aestheticScore: 82, consistencyScore: 71 })).toBe(true)
    // 任一维度低于阈值则不通过（审美 82 < 90）
    expect(reviewPasses(result, { contentScore: 60, aestheticScore: 90, consistencyScore: 95 })).toBe(false)
  })

  it("majorityVotePassed：生产多数票口径（单评审一票否决）", () => {
    // 单评审：一票定生死
    expect(majorityVotePassed(1, 1)).toBe(true)
    expect(majorityVotePassed(0, 1)).toBe(false)
    // 多评审：严格过半
    expect(majorityVotePassed(2, 3)).toBe(true)
    expect(majorityVotePassed(1, 2)).toBe(false)
    expect(majorityVotePassed(2, 4)).toBe(false)
    // 生产反例：两评审 74/100、阈值 75 → 多数票判不过（平均 87 的口径结论相反）
    expect(majorityVotePassed(1, 2)).toBe(false)
    // 无票不通过 / 非法入参兜底
    expect(majorityVotePassed(0, 0)).toBe(false)
  })
})
