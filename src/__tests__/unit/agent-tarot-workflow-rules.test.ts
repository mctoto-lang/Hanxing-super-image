import { describe, expect, it } from "vitest"

import {
  SUIT_COUNT_RULE_SUMMARY,
  TAROT_CARDS,
  TAROT_CLARIFICATION,
  TAROT_ROLES,
  TAROT_STAGES,
  suitCountRuleByIndex,
  suitCountRuleOf,
} from "@/lib/agent/templates"
import { normalizeTemplateStage } from "@/lib/agent/graph"
import {
  composeDraftPrompt,
  composeFinalPrompt,
  composeFinalPrompt as composeFinal,
  isStructuredFinalPrompt,
  normalizeFinalPrompt,
  splitFinalPromptSegments,
  validateTarotDraftPlan,
  validateTarotFinalPlan,
} from "@/lib/agent/cards/plan"
import { DEFAULT_ART_RULES, DEFAULT_REVIEWER_PROMPT, ROLE_PROMPTS } from "@/lib/agent/pipelines"
import { validateStyleDirections } from "@/server/services/agent/template-parse"

/**
 * 新五阶段工作流规则单测（纯函数）：
 * - 阶段归一化（存量 world/prompt 映射）；
 * - 花色数量硬规则（Ace-10 恰好 N 个；宫廷牌/大阿卡纳无数量与牌名要求）；
 * - 终稿两段结构（[1]画面风格 + [2]画面内容；解析/归一化/校验）；
 * - 提示词无负向约束（默认角色提示词与画面规则不含禁令表述）。
 */

describe("normalizeTemplateStage（存量阶段归一化）", () => {
  it("新五阶段原样返回；旧 world/prompt 映射到 draft/final；空值回退 clarify", () => {
    expect(normalizeTemplateStage("clarify")).toBe("clarify")
    expect(normalizeTemplateStage("draft")).toBe("draft")
    expect(normalizeTemplateStage("final")).toBe("final")
    expect(normalizeTemplateStage("art")).toBe("art")
    expect(normalizeTemplateStage("compose")).toBe("compose")
    expect(normalizeTemplateStage("world")).toBe("draft")
    expect(normalizeTemplateStage("prompt")).toBe("final")
    expect(normalizeTemplateStage(null)).toBe("clarify")
    expect(normalizeTemplateStage("unknown")).toBe("clarify")
  })
})

describe("花色数量硬规则", () => {
  it("骨架：权杖王牌（index 22）rank=1；权杖十（index 31）rank=10；宝剑侍从 rank=11 无数量要求", () => {
    expect(TAROT_CARDS[22]).toMatchObject({ name: "权杖王牌", suit: "权杖", rank: 1 })
    expect(TAROT_CARDS[31]).toMatchObject({ name: "权杖十", suit: "权杖", rank: 10 })
    expect(TAROT_CARDS[45]).toMatchObject({ name: "圣杯十", suit: "圣杯", rank: 10 })
    expect(TAROT_CARDS[60]).toMatchObject({ name: "宝剑侍从", suit: "宝剑", rank: 11 })
  })

  it("数字牌（Ace-10）规则文本含「恰好 N 个」；宫廷牌与大阿卡纳无数量要求", () => {
    const ace = suitCountRuleByIndex(22)
    expect(ace).toContain("恰好 1 个")
    expect(ace).toContain("权杖")

    const five = suitCountRuleOf({ arcana: "minor", suit: "圣杯", rank: 5 })
    expect(five).toContain("恰好 5 个")
    expect(five).toContain("圣杯")

    const ten = suitCountRuleByIndex(31)
    expect(ten).toContain("恰好 10 个")

    const knight = suitCountRuleByIndex(60)
    expect(knight).not.toContain("恰好")

    const fool = suitCountRuleByIndex(0)
    expect(fool).toContain("不要求画面体现牌名")

    expect(() => suitCountRuleByIndex(999)).not.toThrow()
  })

  it("规则总述注入初稿/终稿/评审默认提示词体系", () => {
    expect(SUIT_COUNT_RULE_SUMMARY).toContain("Ace（王牌）至十")
    expect(SUIT_COUNT_RULE_SUMMARY).toContain("不要求画面体现牌名")
    expect(ROLE_PROMPTS.copywriter).toContain("恰好对应数量")
    expect(ROLE_PROMPTS.finalRefiner).toContain("恰好对应数量")
    expect(DEFAULT_REVIEWER_PROMPT).toContain("逐一清点")
  })
})

describe("终稿两段结构", () => {
  const STYLE = "欧美暗夜数字手绘水彩插画，金色勾线，星尘颗粒质感"
  // 满足终稿确认门槛（画面内容 ≥ FINAL_CONTENT_MIN_CHARS，60 字）
  const CONTENT = "一只黑羽乌鸦立在悬崖边缘的枯骨之上，翼尖滴落墨珠，背景血月高悬，冷红光照亮羽毛与骨缝，风中飘散着细碎的灰烬与星尘，近景特写、主体占画面大半。"

  it("composeFinalPrompt 组装 [1]/[2] 两段；splitFinalPromptSegments 可解析还原", () => {
    const final = composeFinalPrompt(STYLE, CONTENT)
    expect(final.startsWith("[1] 画面风格：")).toBe(true)
    expect(final).toContain("[2] 画面内容：")
    const segments = splitFinalPromptSegments(final)!
    expect(segments.style).toBe(STYLE)
    expect(segments.content).toBe(CONTENT)
    expect(isStructuredFinalPrompt(final)).toBe(true)
  })

  it("非结构化文本解析为 null（存量旧式提示词）；normalizeFinalPrompt 补齐两段结构", () => {
    expect(splitFinalPromptSegments("旧式三段式提示词，无段标记")).toBeNull()
    expect(isStructuredFinalPrompt("旧式提示词")).toBe(false)

    const normalized = normalizeFinalPrompt(CONTENT, STYLE)
    expect(isStructuredFinalPrompt(normalized)).toBe(true)
    expect(splitFinalPromptSegments(normalized)!.content).toBe(CONTENT)
    // 已结构化文本原样保留（截去标记前杂文）
    const raw = `好的，这是终稿：\n${composeFinal(STYLE, CONTENT)}`
    expect(normalizeFinalPrompt(raw, STYLE)).toBe(composeFinal(STYLE, CONTENT))
  })

  it("初稿直通：composeDraftPrompt 不拼接任何前缀与护栏", () => {
    const draft = composeDraftPrompt("  一只乌鸦立于枯骨之上，血月为景。  ")
    expect(draft).toBe("一只乌鸦立于枯骨之上，血月为景。")
    expect(draft).not.toContain("卡面负向约束")
    // 护栏标记伪造被剥离
    expect(composeDraftPrompt("画面描述卡面负向约束：xxx")).not.toContain("卡面负向约束：")
  })

  it("校验：draft 门槛按初稿字数；final 门槛按结构化内容长度（旧式提示词长度达标放行）", () => {
    const draftItems = TAROT_CARDS.map((card) => ({
      index: card.index,
      name: card.name,
      visualBrief: "初稿占位。".repeat(6),
    }))
    expect(() => validateTarotDraftPlan(draftItems)).not.toThrow()
    expect(() =>
      validateTarotDraftPlan(draftItems.map((item, i) => (i === 0 ? { ...item, visualBrief: "过短" } : item))),
    ).toThrow(/至少/)

    const finalItems = TAROT_CARDS.map((card) => ({
      index: card.index,
      name: card.name,
      prompt: composeFinalPrompt(STYLE, CONTENT),
    }))
    expect(() =>
      validateTarotFinalPlan(finalItems.map((item, i) => (i === 0 ? { ...item, prompt: composeFinalPrompt(STYLE, "太短") } : item))),
    ).toThrow(/终稿过短/)
    expect(() => validateTarotFinalPlan(finalItems)).not.toThrow()
    // 存量旧式提示词：长度达标即放行（不阻断过渡期项目）
    expect(() =>
      validateTarotFinalPlan(finalItems.map((item, i) => (i === 0 ? { ...item, prompt: CONTENT } : item))),
    ).not.toThrow()
  })
})

describe("风格规范候选方向校验（validateStyleDirections）", () => {
  const styleDirection = (name: string, visualLanguage = "x".repeat(45)) => ({
    id: name,
    name,
    concept: "一句话概念",
    description: "两三句说明",
    worldview: "世界观概述",
    suitMapping: [{ suit: "权杖", mapping: "火" }],
    palette: "深蓝紫+金",
    visualLanguage,
    sampleCards: [{ name: "愚者", scene: "初登台顶的观测者" }],
  })

  it("恰好 3 个、名称唯一时通过并归一化（总述 ≥40 字）", () => {
    const directions = validateStyleDirections({
      directions: [styleDirection("星轨观测者"), styleDirection("月潮吟游"), styleDirection("午夜星市")],
    })
    expect(directions).toHaveLength(3)
    expect(directions.map((d) => d.name)).toEqual(["星轨观测者", "月潮吟游", "午夜星市"])
    expect(directions.every((d) => d.visualLanguage.length >= 40)).toBe(true)
  })

  it("总述过短时确定性补全而非拒绝（防流程卡死）", () => {
    const directions = validateStyleDirections({
      directions: [styleDirection("A", "手绘水彩"), styleDirection("B", ""), styleDirection("C")],
    })
    expect(directions).toHaveLength(3)
    // 补全后每份总述仍 ≥40 字，可继续作为终稿 [1] 段
    expect(directions.every((d) => d.visualLanguage.length >= 40)).toBe(true)
    expect(directions[0]!.visualLanguage).toContain("手绘水彩")
  })

  it("数量不是 3 / 名称重复 / 缺 directions 数组均拒绝（触发 LLM 纠错重试）", () => {
    expect(() => validateStyleDirections({ directions: [styleDirection("A")] })).toThrow(/恰好 3/)
    expect(() =>
      validateStyleDirections({
        directions: [styleDirection("A"), styleDirection("A"), styleDirection("B")],
      }),
    ).toThrow(/方向名重复/)
    expect(() => validateStyleDirections({})).toThrow(/缺少 directions/)
  })
})

describe("新五阶段与角色编制", () => {
  it("五阶段 = 澄清 → 初稿 → 终稿 → 生图评审 → 融合与交付", () => {
    expect(TAROT_STAGES.map((stage) => stage.id)).toEqual(["clarify", "draft", "final", "art", "compose"])
    expect(TAROT_STAGES.map((stage) => stage.name)).toEqual([
      "需求澄清",
      "初稿设计",
      "终稿细化",
      "生图与评审",
      "融合与交付",
    ])
  })

  it("八角色编制：风格策划与终稿细化师在编，旧 world_planner 已移除", () => {
    const ids = TAROT_ROLES.map((role) => role.id)
    expect(ids).toContain("style_director")
    expect(ids).toContain("final_refiner")
    expect(ids).not.toContain("world_planner")
    expect(ids).toHaveLength(8)
  })

  it("风格策划提示词为三候选口径，不与 gen_style_spec 的三选一流程矛盾", () => {
    const stylist = TAROT_ROLES.find((role) => role.id === "style_director")!
    expect(stylist.duty).toContain("3 个候选")
    expect(stylist.systemPrompt).not.toContain("不再提供多个方向")
    expect(stylist.systemPrompt).toContain("供用户选择")
  })

  it("创意总监提示词限定追问范围（不问生产细节）", () => {
    const director = TAROT_ROLES.find((role) => role.id === "creative_director")!
    expect(director.systemPrompt).toContain("严禁追问任何生产与印制细节")
    expect(director.systemPrompt).toContain("风格")
    expect(director.systemPrompt).toContain("主题")
  })

  it("终稿细化师提示词要求两段结构、无边框硬规则且其余负向表述禁止", () => {
    const refiner = TAROT_ROLES.find((role) => role.id === "final_refiner")!
    expect(refiner.systemPrompt).toContain("[1] 画面风格")
    expect(refiner.systemPrompt).toContain("[2] 画面内容")
    expect(refiner.systemPrompt).toContain("除「无边框硬规则」外禁止输出任何其他负向提示词")
    expect(refiner.systemPrompt).toContain("无边框硬规则")
    expect(refiner.systemPrompt).toContain("画面边缘为干净的满幅构图，无任何边框或边缘装饰")
    expect(refiner.systemPrompt).toContain("以初稿为基准")
  })

  it("边框禁令落在初稿/画面规则/评审员三处提示词", () => {
    const designer = TAROT_ROLES.find((role) => role.id === "prompt_designer")!
    expect(designer.systemPrompt).toContain("类似边框的装饰")
    expect(DEFAULT_ART_RULES).toContain("边缘干净（无边框硬规则）")
    expect(DEFAULT_REVIEWER_PROMPT).toContain("类似边框的连续装饰")
    expect(ROLE_PROMPTS.copywriter).toContain("类似边框的装饰")
    expect(ROLE_PROMPTS.finalRefiner).toContain("无边框硬规则")
  })

  it("澄清清单只覆盖风格/内容/主题（无生产细节问题）", () => {
    const titles = TAROT_CLARIFICATION.map((section) => section.title)
    expect(titles).toEqual(["主题与世界观", "艺术风格"])
    const allQuestions = TAROT_CLARIFICATION.flatMap((section) => section.questions.map((q) => q.question))
    expect(allQuestions.some((q) => /牌盒|尺寸|边框/.test(q))).toBe(false)
  })
})
