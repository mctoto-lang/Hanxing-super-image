import { describe, it, expect } from "vitest"
import {
  CARD_ART_GUARDRAIL_MARKER,
  CARD_ART_NEGATIVE_PROMPT,
  appendCardArtGuardrails,
  applyCardArtGuardrails,
  hasCardArtGuardrails,
  sanitizeDimensionWording,
} from "@/lib/agent/prompt-guardrails"

/**
 * 卡面提示词护栏单测：负向约束幂等追加、尺寸/比例措辞清洗、一站式加固
 * （清洗跳过已追加的护栏段，重复应用不叠加）。
 */

describe("appendCardArtGuardrails", () => {
  it("把负向约束段追加到提示词末尾", () => {
    const out = appendCardArtGuardrails("月光下的白鹿，油画面质")
    expect(out).toContain("月光下的白鹿，油画面质")
    expect(out.endsWith(CARD_ART_NEGATIVE_PROMPT)).toBe(true)
    expect(out).toContain("no border")
    expect(out).toContain("no Roman numerals")
  })

  it("幂等：已带护栏的提示词原样返回", () => {
    const once = appendCardArtGuardrails("占卜少女")
    const twice = appendCardArtGuardrails(once)
    expect(twice).toBe(once)
  })

  it("空提示词返回空串", () => {
    expect(appendCardArtGuardrails("")).toBe("")
    expect(appendCardArtGuardrails("   ")).toBe("")
  })

  it("hasCardArtGuardrails 以 marker 判定", () => {
    expect(hasCardArtGuardrails(`正文\n${CARD_ART_NEGATIVE_PROMPT}`)).toBe(true)
    expect(hasCardArtGuardrails("普通提示词")).toBe(false)
  })
})

describe("sanitizeDimensionWording", () => {
  it("删除孤立的像素尺寸（WxH / × / px）", () => {
    expect(sanitizeDimensionWording("主题画面 1024x1024 构图")).toBe(
      "主题画面 构图",
    )
    expect(sanitizeDimensionWording("画面 768 × 1024，竖幅")).toBe(
      "画面，竖幅",
    )
    expect(sanitizeDimensionWording("细节丰富 1024px 清晰")).toBe("细节丰富 清晰")
  })

  it("删除孤立的宽高比（半角/全角冒号）", () => {
    expect(sanitizeDimensionWording("卡面 3:4 构图稳重大气")).toBe(
      "卡面 构图稳重大气",
    )
    expect(sanitizeDimensionWording("横幅 16：9 场景")).toBe("横幅 场景")
  })

  it("删除关键词引导与倒装的尺寸/比例措辞", () => {
    expect(sanitizeDimensionWording("整卡画面，尺寸 1024x1024，细节丰富")).toBe(
      "整卡画面，细节丰富",
    )
    expect(sanitizeDimensionWording("主体居中，比例：2:3，暗调")).toBe(
      "主体居中，暗调",
    )
    expect(sanitizeDimensionWording("作品 aspect ratio 16:9 宽阔")).toBe(
      "作品 宽阔",
    )
    expect(sanitizeDimensionWording("画面 1024x1024 的尺寸，庄重")).toBe(
      "画面，庄重",
    )
  })

  it("不误伤单数字组合与正常比例类措辞", () => {
    expect(sanitizeDimensionWording("4x4 网格布局")).toBe("4x4 网格布局")
    // 「比例」单独出现（无参数值）不删：人物比例是合法画面措辞
    expect(sanitizeDimensionWording("人物比例夸张，动感十足")).toBe(
      "人物比例夸张，动感十足",
    )
  })

  it("已带护栏的提示词：护栏段原样保留，只清洗正文", () => {
    const guarded = appendCardArtGuardrails("正文 1024x1024 画面")
    const cleaned = sanitizeDimensionWording(guarded)
    expect(cleaned).not.toContain("1024x1024")
    expect(cleaned).toContain(CARD_ART_GUARDRAIL_MARKER)
    expect(cleaned).toContain("no aspect ratio")
  })
})

describe("applyCardArtGuardrails", () => {
  it("先清洗再追加负向约束", () => {
    const out = applyCardArtGuardrails("圣杯骑士 1024x1024，比例 3:4")
    expect(out).not.toContain("1024x1024")
    expect(out).not.toContain("3:4")
    expect(out).toContain("no border")
  })

  it("幂等：重复应用不叠加护栏、不破坏已有护栏文案", () => {
    const once = applyCardArtGuardrails("命运之轮 768x1024")
    const twice = applyCardArtGuardrails(once)
    expect(twice).toBe(once)
  })
})
