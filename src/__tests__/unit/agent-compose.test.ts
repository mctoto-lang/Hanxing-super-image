import { describe, expect, it } from "vitest"
import { buildAiFramePrompt, AI_FRAME_PREVIEW_COUNT } from "@/lib/agent/compose"

describe("AI frame composition", () => {
  it("builds a guarded prompt without dimensions", () => {
    const prompt = buildAiFramePrompt({ cardName: "愚者", meaning: "启程与自由" })
    expect(prompt).toContain("参考图 1")
    expect(prompt).toContain("参考图 2")
    // 融合护栏用独立标记（禁文字/水印，不禁边框——融合的目标就是装进边框）
    expect(prompt).toContain("融合负向约束")
    expect(prompt).not.toContain("卡面负向约束")
    expect(prompt).not.toMatch(/1024x|16:9|2:3/)
  })
  it("uses exactly three preview images", () => expect(AI_FRAME_PREVIEW_COUNT).toBe(3))
})
