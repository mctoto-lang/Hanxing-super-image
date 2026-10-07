import { describe, expect, it } from "vitest"
import {
  buildTarotCardPlan,
  composeDraftPrompt,
  DRAFT_PROMPT_MIN_CHARS,
  FINAL_CONTENT_MIN_CHARS,
  validateTarotDraftPlan,
  validateTarotFinalPlan,
} from "@/lib/agent/cards/plan"
import type { AgentTemplateDirection } from "@/lib/agent/graph"

const direction: AgentTemplateDirection = {
  id: "d1",
  name: "星夜水彩",
  concept: "午夜蓝紫的星辰宇宙",
  description: "以水彩呈现的星空塔罗",
  worldview: "群星低垂的暗夜大陆",
  visualLanguage: "手绘水彩，午夜蓝紫基调，星尘金点缀",
  palette: "午夜蓝、星尘金",
} as unknown as AgentTemplateDirection

describe("tarot card plan", () => {
  it("builds exactly 78 cards in canonical order", () => {
    const plan = buildTarotCardPlan({ brief: "月相与潮汐", direction: null })
    expect(plan).toHaveLength(78)
    expect(plan[0]!.name).toBe("愚者")
    expect(plan[21]!.name).toBe("世界")
    expect(plan[77]!.index).toBe(77)
  })

  it("新流程拼装：初稿直通（无风格前缀、无负向约束段）", () => {
    const plan = buildTarotCardPlan({ brief: null, direction })
    // 兜底初稿即提示词正文：不带护栏段、不带方向风格前缀
    expect(plan.every((item) => !item.prompt.includes("卡面负向约束"))).toBe(true)
    expect(plan.every((item) => !item.prompt.includes(direction.visualLanguage))).toBe(true)
    expect(composeDraftPrompt("  一位持灯的旅人  ")).toBe("一位持灯的旅人")
  })

  it("初稿门槛：张数/顺序错误与过短初稿被拦", () => {
    const plan = buildTarotCardPlan({ brief: null, direction: null })
    expect(() => validateTarotDraftPlan(plan.slice(0, 77).map(({ ...rest }) => ({ ...rest })))).toThrow("78")
    const swapped = [...plan]
    ;[swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!]
    expect(() =>
      validateTarotDraftPlan(swapped.map(({ prompt: _p, ...rest }) => ({ ...rest, visualBrief: rest.visualBrief }))),
    ).toThrow("顺序")
    const short = plan.map((item, i) =>
      i === 0 ? { index: item.index, name: item.name, visualBrief: "太短" } : item,
    )
    expect(() => validateTarotDraftPlan(short)).toThrow("初稿过短")
    // 兜底画面描述满足门槛
    expect(plan[0]!.visualBrief.length).toBeGreaterThanOrEqual(DRAFT_PROMPT_MIN_CHARS)
    expect(() => validateTarotDraftPlan(plan)).not.toThrow()
  })

  it("终稿门槛：结构化终稿按 60 字校验，旧式提示词按初稿下限放行", () => {
    const plan = buildTarotCardPlan({ brief: null, direction: null })
    const items = plan.map((item) => ({ index: item.index, name: item.name, prompt: item.prompt }))
    // 兜底初稿（无两段结构）按宽松下限放行（存量过渡期口径）
    expect(() => validateTarotFinalPlan(items)).not.toThrow()
    // 结构化终稿：[画面内容] 段不足 60 字被拦
    const style = "手绘水彩，午夜蓝紫基调"
    const tooShort = plan.map((item, i) =>
      i === 0
        ? {
            index: item.index,
            name: item.name,
            prompt: `[1] 画面风格：${style}\n[2] 画面内容：太短`,
          }
        : { index: item.index, name: item.name, prompt: item.prompt },
    )
    expect(() => validateTarotFinalPlan(tooShort)).toThrow("终稿过短")
    expect(FINAL_CONTENT_MIN_CHARS).toBe(60)
  })
})
