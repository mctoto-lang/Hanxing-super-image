import { describe, expect, it } from "vitest"
import { assetGenerationOrder, buildTarotAssetPrompt } from "@/lib/agent/asset-prompts"

describe("tarot asset prompts", () => {
  it("uses the six asset order", () => {
    expect(assetGenerationOrder()).toEqual(["border", "back", "box_front", "box_back", "box_side", "box_top"])
  })
  it("does not put dimensions into prompts", () => {
    const prompt = buildTarotAssetPrompt({ kind: "border", direction: "月相神殿 1024x1536 2:3", styleDoc: null })
    expect(prompt).not.toMatch(/1024x1536|2:3/)
    expect(prompt).toContain("卡面负向约束")
  })
})
