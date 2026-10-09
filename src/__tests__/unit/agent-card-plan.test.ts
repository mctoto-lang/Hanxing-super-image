import { describe, expect, it } from "vitest"
import {
  buildTarotCardPlan,
  composeDraftPrompt,
  FINAL_CONTENT_MIN_CHARS,
  isPromptItemReady,
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
    // 牌义默认占位仍提供（LLM 撰写时的内部参考）
    expect(plan[0]!.meaning.length).toBeGreaterThan(0)
  })

  it("建清单不预填提示词：正文为空（待 AI 撰写），无风格前缀与护栏段", () => {
    const plan = buildTarotCardPlan({ brief: null, direction })
    // 提示词必须经 AI 生成：不预填任何兜底模板文案
    expect(plan.every((item) => item.prompt === "")).toBe(true)
    expect(plan.every((item) => item.visualBrief === "")).toBe(true)
    // 显式传入 visualBriefs 时使用给定值（历史调用方兼容）
    const withBriefs = buildTarotCardPlan({ brief: null, direction, visualBriefs: { 愚者: "一位持灯的旅人" } })
    expect(withBriefs[0]!.visualBrief).toBe("一位持灯的旅人")
    expect(withBriefs[0]!.prompt).toBe("一位持灯的旅人")
    expect(composeDraftPrompt("  一位持灯的旅人  ")).toBe("一位持灯的旅人")
  })

  it("isPromptItemReady：initial（待写/撰写中/失败）不算就绪，AI/手动成稿达标即就绪", () => {
    const long =
      "一位黑羽乌鸦立在悬崖边缘的枯骨之上，翼尖滴落墨珠，背景血月高悬，冷红光照亮羽毛与骨缝，风中飘散着细碎的灰烬与星尘，近景特写、主体占画面大半。"
    // initial：建清单态 / 撰写失败态（带 errorMessage 场景同样不就绪）
    expect(isPromptItemReady({ promptSource: "initial", currentPrompt: long })).toBe(false)
    expect(isPromptItemReady({ promptSource: "initial", currentPrompt: null })).toBe(false)
    // AI 终稿 / 手动编辑：文本达标即就绪
    expect(isPromptItemReady({ promptSource: "final", currentPrompt: long })).toBe(true)
    expect(isPromptItemReady({ promptSource: "manual", currentPrompt: long })).toBe(true)
    expect(isPromptItemReady({ promptSource: "ai", currentPrompt: long })).toBe(true)
    // 文本不达标
    expect(isPromptItemReady({ promptSource: "final", currentPrompt: "太短" })).toBe(false)
    expect(isPromptItemReady({ promptSource: "final", currentPrompt: null })).toBe(false)
    // 存量结构化两段终稿（final 归并的 run）按两段结构判定
    const structured = `[1] 画面风格：手绘水彩\n[2] 画面内容：${long}`
    expect(isPromptItemReady({ promptSource: "final", currentPrompt: structured })).toBe(true)
    // 过渡期数据：无来源标记但文本达标
    expect(isPromptItemReady({ promptSource: null, currentPrompt: long })).toBe(true)
  })

  it("终稿门槛：结构化终稿按 60 字校验，旧式提示词按初稿下限放行", () => {
    const plan = buildTarotCardPlan({ brief: null, direction: null })
    const legacyText = "一只黑羽乌鸦立在悬崖边缘的枯骨之上，血月高悬为景。"
    const items = plan.map((item) => ({ index: item.index, name: item.name, prompt: legacyText }))
    // 旧式长文本（无两段结构）按宽松下限放行（存量过渡期口径）
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
        : { index: item.index, name: item.name, prompt: legacyText },
    )
    expect(() => validateTarotFinalPlan(tooShort)).toThrow("终稿过短")
    expect(FINAL_CONTENT_MIN_CHARS).toBe(60)
  })
})
