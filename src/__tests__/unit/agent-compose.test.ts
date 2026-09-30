import { describe, expect, it } from "vitest"
import { buildAiFramePrompt, AI_FRAME_PREVIEW_COUNT } from "@/lib/agent/compose"

describe("AI frame composition", () => {
  it("builds a guarded prompt without dimensions", () => {
    const prompt = buildAiFramePrompt({ cardName: "愚者", meaning: "启程与自由" })
    expect(prompt).toContain("参考图 1")
    expect(prompt).toContain("参考图 2")
    expect(prompt).toContain("卡面负向约束")
    expect(prompt).not.toMatch(/1024x|16:9|2:3/)
  })
  it("uses exactly three preview images", () => expect(AI_FRAME_PREVIEW_COUNT).toBe(3))
})
