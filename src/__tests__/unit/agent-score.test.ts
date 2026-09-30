import { describe, expect, it } from "vitest"
import {
  averageScores,
  clampScore,
  DEFAULT_SCORE_THRESHOLDS,
  scoreTone,
  violationLabel,
} from "@/lib/agent/score"

describe("agent score tone boundaries", () => {
  const threshold = DEFAULT_SCORE_THRESHOLDS.aesthetic // 75

  it("score < 60 is low regardless of threshold", () => {
    expect(scoreTone(59, threshold)).toBe("low")
    expect(scoreTone(0, threshold)).toBe("low")
    expect(scoreTone(59, 90)).toBe("low")
  })

  it("60 <= score < threshold is warn", () => {
    expect(scoreTone(60, threshold)).toBe("warn")
    expect(scoreTone(threshold - 1, threshold)).toBe("warn")
  })

  it("score >= threshold is pass", () => {
    expect(scoreTone(threshold, threshold)).toBe("pass")
    expect(scoreTone(100, threshold)).toBe("pass")
  })

  it("threshold <= 60 collapses the warn band", () => {
    expect(scoreTone(59, 60)).toBe("low")
    expect(scoreTone(60, 60)).toBe("pass")
    expect(scoreTone(70, 60)).toBe("pass")
    expect(scoreTone(49, 50)).toBe("low")
    expect(scoreTone(55, 50)).toBe("pass")
  })
})

describe("clampScore", () => {
  it("rounds and clamps into 0-100", () => {
    expect(clampScore(82.4)).toBe(82)
    expect(clampScore(82.6)).toBe(83)
    expect(clampScore(-5)).toBe(0)
    expect(clampScore(120)).toBe(100)
  })
})

describe("averageScores", () => {
  it("ignores nulls per dimension and counts below-threshold items", () => {
    const result = averageScores([
      { content: 80, aesthetic: 90, consistency: 80 },
      { content: 40, aesthetic: null, consistency: 60 },
      { content: null, aesthetic: 70, consistency: null },
    ])
    expect(result.content).toBe(60) // (80+40)/2
    expect(result.aesthetic).toBe(80) // (90+70)/2，null 忽略
    expect(result.consistency).toBe(70) // (80+60)/2
    expect(result.belowThreshold.content).toBe(1) // 40 < 60
    expect(result.belowThreshold.aesthetic).toBe(1) // 70 < 75
    expect(result.belowThreshold.consistency).toBe(1) // 60 < 70
  })

  it("returns null averages and zero counts when nothing is scored", () => {
    const result = averageScores([{ content: null, aesthetic: null, consistency: null }])
    expect(result.content).toBeNull()
    expect(result.aesthetic).toBeNull()
    expect(result.consistency).toBeNull()
    expect(result.belowThreshold).toEqual({ content: 0, aesthetic: 0, consistency: 0 })
  })

  it("supports custom thresholds", () => {
    const result = averageScores([{ content: 65, aesthetic: 65, consistency: 65 }], {
      aesthetic: 60,
    })
    expect(result.belowThreshold.aesthetic).toBe(0)
    expect(result.belowThreshold.consistency).toBe(1)
  })
})

describe("violationLabel", () => {
  it("maps known keys and falls back to the raw key", () => {
    expect(violationLabel("text")).toBe("含文字")
    expect(violationLabel("numerals")).toBe("含数字")
    expect(violationLabel("number")).toBe("含数字")
    expect(violationLabel("border")).toBe("含边框")
    expect(violationLabel("incomplete")).toBe("画面不完整")
    expect(violationLabel("watermark")).toBe("含水印")
    expect(violationLabel("weird_key")).toBe("weird_key")
  })
})
