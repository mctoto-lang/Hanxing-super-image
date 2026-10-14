import { describe, expect, it } from "vitest"
import {
  averageDimensionScores,
  cardKindToSizeKind,
  computeWeightedTotalScore,
  pickBestScoredRound,
  resolveReviewVerdict,
  weightedTotalPasses,
} from "@/lib/workspace/agent-templates"
import { readQualityThresholds } from "@/server/services/workspace-agent/input"

/**
 * 工作台 Agent 生图评审循环（review_image）的决策口径单测：
 * - 加权总分 = round(0.4×审美 + 0.3×一致性 + 0.3×内容)；
 * - 只以总分 ≥ qualityThreshold 通过，任何单项不得一票否决；
 * - 低分按 roundsUsed < maxRetries 打回，耗尽 fallback；
 * - 兜底选图跨全部尝试取最高加权分。
 */
describe("computeWeightedTotalScore / weightedTotalPasses", () => {
  it("按 0.4/0.3/0.3 权重计算并四舍五入", () => {
    // 0.4×80 + 0.3×70 + 0.3×60 = 32 + 21 + 18 = 71
    expect(computeWeightedTotalScore({ content: 60, aesthetic: 80, consistency: 70 })).toBe(71)
    // 0.4×90 + 0.3×90 + 0.3×89 = 36 + 27 + 26.7 = 89.7 → 90
    expect(computeWeightedTotalScore({ content: 89, aesthetic: 90, consistency: 90 })).toBe(90)
    // 全 0 / 全 100 边界
    expect(computeWeightedTotalScore({ content: 0, aesthetic: 0, consistency: 0 })).toBe(0)
    expect(computeWeightedTotalScore({ content: 100, aesthetic: 100, consistency: 100 })).toBe(100)
  })

  it("恰好等于阈值也算过线（>= 语义）", () => {
    expect(weightedTotalPasses(75, 75)).toBe(true)
    expect(weightedTotalPasses(74, 75)).toBe(false)
    expect(weightedTotalPasses(76, 75)).toBe(true)
  })

  it("单项维度极低但总分过线时仍通过（不得单项否决）", () => {
    // 内容 40（远低于内容线 75），但 0.4×95 + 0.3×95 + 0.3×40 = 38 + 28.5 + 12 = 78.5 → 79 ≥ 75
    const total = computeWeightedTotalScore({ content: 40, aesthetic: 95, consistency: 95 })
    expect(total).toBe(79)
    expect(weightedTotalPasses(total, 75)).toBe(true)
  })
})

describe("resolveReviewVerdict（评审循环裁决）", () => {
  it("总分过线 → approve（即便某单项低于各自及格线）", () => {
    expect(
      resolveReviewVerdict({
        weightedTotalScore: 80,
        qualityThreshold: 75,
        roundsUsed: 0,
        maxRetries: 2,
      }),
    ).toBe("approve")
  })

  it("低分且未耗尽 → retry；roundsUsed 达到 maxRetries → fallback", () => {
    const base = { weightedTotalScore: 60, qualityThreshold: 75 }
    expect(resolveReviewVerdict({ ...base, roundsUsed: 0, maxRetries: 2 })).toBe("retry")
    expect(resolveReviewVerdict({ ...base, roundsUsed: 1, maxRetries: 2 })).toBe("retry")
    expect(resolveReviewVerdict({ ...base, roundsUsed: 2, maxRetries: 2 })).toBe("fallback")
    expect(resolveReviewVerdict({ ...base, roundsUsed: 3, maxRetries: 3 })).toBe("fallback")
  })

  it("耗尽边界上总分过线仍 approve（先判总分再判耗尽）", () => {
    expect(
      resolveReviewVerdict({
        weightedTotalScore: 75,
        qualityThreshold: 75,
        roundsUsed: 2,
        maxRetries: 2,
      }),
    ).toBe("approve")
  })
})

describe("averageDimensionScores（多评审员等权聚合）", () => {
  it("三维各自平均并收敛 0-100", () => {
    expect(
      averageDimensionScores([
        { content: 80, aesthetic: 90, consistency: 70 },
        { content: 70, aesthetic: 80, consistency: 60 },
      ]),
    ).toEqual({ content: 75, aesthetic: 85, consistency: 65 })
  })

  it("空投票抛错（调用方 bug 早暴露）", () => {
    expect(() => averageDimensionScores([])).toThrow()
  })
})

describe("pickBestScoredRound（跨尝试选优）", () => {
  const round = (id: string, imageUrl: string | null, score: number | null) => ({
    id,
    imageUrl,
    candidates: score == null ? [] : [{ url: imageUrl ?? "", score, contentPass: null }],
  })

  it("选最高加权分的有图轮", () => {
    const rounds = [
      round("r1", "http://a", 71),
      round("r2", "http://b", 68),
      round("r3", "http://c", 79),
    ]
    expect(pickBestScoredRound(rounds)?.id).toBe("r3")
  })

  it("跳过生图失败（无图）与未评分（score null）的轮", () => {
    const rounds = [
      round("r1", null, 90), // 无图
      round("r2", "http://b", 60),
      round("r3", "http://c", null), // 未评分
    ]
    expect(pickBestScoredRound(rounds)?.id).toBe("r2")
  })

  it("平分取后生成的轮（新尝试优先）；全部无图返回 null", () => {
    const rounds = [round("r1", "http://a", 70), round("r2", "http://b", 70)]
    expect(pickBestScoredRound(rounds)?.id).toBe("r2")
    expect(pickBestScoredRound([round("r1", null, 80)])).toBeNull()
    expect(pickBestScoredRound([])).toBeNull()
  })
})

describe("cardKindToSizeKind（冻结尺寸类别映射）", () => {
  it("face → card；套件各自独立", () => {
    expect(cardKindToSizeKind("face")).toBe("card")
    expect(cardKindToSizeKind("back")).toBe("back")
    expect(cardKindToSizeKind("border")).toBe("border")
    expect(cardKindToSizeKind("box")).toBe("box")
  })
})

describe("readQualityThresholds（质量线读取，冻结优先 + 默认回退）", () => {
  it("无任何配置时回退默认 75 / 打回 2，qualityThreshold 缺省 75", () => {
    const t = readQualityThresholds({ cardCount: 1, prompt: "p", referenceImages: [] })
    expect(t).toEqual({
      contentThreshold: 75,
      aestheticThreshold: 75,
      consistencyThreshold: 75,
      qualityThreshold: 75,
      maxRetries: 2,
    })
  })

  it("frozenConfig.quality 优先；存量冻结无 qualityThreshold 时回退默认", () => {
    const t = readQualityThresholds({
      cardCount: 1,
      prompt: "p",
      referenceImages: [],
      frozenConfig: {
        templateKey: "tarot81",
        cardCount: 81,
        quality: { contentThreshold: 70, aestheticThreshold: 80, consistencyThreshold: 85, maxRetries: 3 },
        sizes: { card: "1024x1536", back: "1024x1536", border: "1024x1536", box: "1536x1024" },
        frozenAt: "2026-01-01T00:00:00.000Z",
      },
    })
    expect(t.qualityThreshold).toBe(75)
    expect(t.maxRetries).toBe(3)
    expect(t.aestheticThreshold).toBe(80)
  })

  it("显式 qualityThreshold（jsonb 新字段）被读取", () => {
    const t = readQualityThresholds({
      cardCount: 1,
      prompt: "p",
      referenceImages: [],
      quality: {
        contentThreshold: 70,
        aestheticThreshold: 70,
        consistencyThreshold: 70,
        qualityThreshold: 85,
        maxRetries: 1,
      },
    })
    expect(t.qualityThreshold).toBe(85)
  })
})
