import { describe, expect, it } from "vitest"
import { buildTarotCardPlan, validateTarotCardPlan } from "@/lib/agent/cards/plan"

describe("tarot card plan", () => {
  it("builds exactly 78 cards in canonical order", () => {
    const plan = buildTarotCardPlan({ brief: "月相与潮汐", direction: null })
    expect(plan).toHaveLength(78)
    expect(plan[0]!.name).toBe("愚者")
    expect(plan[21]!.name).toBe("世界")
    expect(plan[77]!.index).toBe(77)
    expect(plan.every((item) => item.prompt.includes("卡面负向约束"))).toBe(true)
  })

  it("rejects a wrong order or count", () => {
    const plan = buildTarotCardPlan({ brief: null, direction: null })
    expect(() => validateTarotCardPlan(plan.slice(0, 77))).toThrow("78")
    const swapped = [...plan]
    ;[swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!]
    expect(() => validateTarotCardPlan(swapped)).toThrow("顺序")
  })
})
