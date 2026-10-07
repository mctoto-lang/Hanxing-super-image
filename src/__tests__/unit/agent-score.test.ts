import { describe, expect, it } from "vitest"
import {
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
