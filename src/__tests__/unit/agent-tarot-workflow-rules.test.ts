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
  composeStyleFixedPrompt,
  CONTENT_TARGET,
  isStructuredFinalPrompt,
  normalizeFinalPrompt,
  SINGLE_PROMPT_BORDER_SUFFIX,
  splitFinalPromptSegments,
  validateTarotFinalPlan,
  validateTarotPromptPlan,
} from "@/lib/agent/cards/plan"
import {
  DEFAULT_ART_RULES,
  DEFAULT_REVIEWER_PROMPT,
  ROLE_PROMPTS,
  sampleIndexes,
} from "@/lib/agent/pipelines"
import {
  stylePhraseOf,
  validateStyleDirections,
} from "@/server/services/agent/template-parse"

/**
 * 四阶段工作流规则单测（纯函数）：
 * - 阶段归一化（存量 world/prompt/final 映射到 draft）；
 * - 花色数量硬规则（Ace-10 恰好 N 个 + ≥2 件不描述具体摆放位置；宫廷牌/大阿卡纳无数量与牌名要求）；
 * - 单段短提示词（画面内容 120-200 字约 160 字、严禁风格词，系统在末尾拼接固定风格提示词；首次撰写即终稿）与存量两段结构兼容；
 * - 风格规范方向（总述 80-120 字 + 风格短语 20-50 字）；
 * - 提示词无负向约束（默认角色提示词与画面规则不含禁令表述，无边框句除外）。
 */

describe("normalizeTemplateStage（存量阶段归一化）", () => {
  it("四阶段原样返回；旧 world/prompt/final 全部映射到 draft；空值回退 clarify", () => {
    expect(normalizeTemplateStage("clarify")).toBe("clarify")
    expect(normalizeTemplateStage("draft")).toBe("draft")
    expect(normalizeTemplateStage("art")).toBe("art")
    expect(normalizeTemplateStage("compose")).toBe("compose")
    expect(normalizeTemplateStage("world")).toBe("draft")
    expect(normalizeTemplateStage("prompt")).toBe("draft")
    expect(normalizeTemplateStage("final")).toBe("draft")
    expect(normalizeTemplateStage(null)).toBe("clarify")
    expect(normalizeTemplateStage("unknown")).toBe("clarify")
  })
})

describe("花色数量硬规则", () => {
  it("骨架：权杖王牌（index 22）rank=1；权杖十（index 31）rank=10；宝剑侍从 rank=11 无数量要求", () => {
    expect(TAROT_CARDS[22]).toMatchObject({ name: "权杖王牌", suit: "权杖", rank: 1 })
    expect(TAROT_CARDS[31]).toMatchObject({ name: "权杖十", suit: "权杖", rank: 10 })
    expect(TAROT_CARDS[38]).toMatchObject({ name: "圣杯三", suit: "圣杯", rank: 3 })
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

  it("多件数字牌（rank ≥2）不描述具体摆放位置（交给生图模型自由发挥）；王牌（单件）与宫廷牌无摆放措辞", () => {
    expect(suitCountRuleByIndex(31)).toContain("自然成组")
    expect(suitCountRuleByIndex(31)).toContain("不要描述具体的摆放方式与位置关系")
    expect(suitCountRuleByIndex(38)).toContain("摆放构图交给生图模型自由发挥")
    // 不再强制成组平衡摆放/交代位置关系
    expect(suitCountRuleByIndex(31)).not.toContain("成组平衡摆放")
    expect(suitCountRuleByIndex(22)).not.toContain("自然成组")
    expect(suitCountRuleByIndex(60)).not.toContain("自然成组")
  })

  it("规则总述注入提示词撰写/存量终稿/评审默认提示词体系", () => {
    expect(SUIT_COUNT_RULE_SUMMARY).toContain("Ace（王牌）至十")
    expect(SUIT_COUNT_RULE_SUMMARY).toContain("不要求画面体现牌名")
    expect(SUIT_COUNT_RULE_SUMMARY).toContain("不要描述具体的摆放方式与位置关系")
    expect(ROLE_PROMPTS.copywriter).toContain("恰好对应数量")
    expect(ROLE_PROMPTS.copywriter).not.toContain("成组平衡摆放")
    expect(ROLE_PROMPTS.finalRefiner).toContain("恰好对应数量")
    expect(DEFAULT_REVIEWER_PROMPT).toContain("逐一清点")
  })
})

describe("拼接式单段提示词（画面内容 + 固定风格提示词）", () => {
  const FIXED_STYLE = "受 Rebecca Campbell 启发的现代空灵神谕卡艺术，灰蓝色磨砂薄雾，柔和哑光磨砂质感，fine art 神谕插画，柔和漫射光"
  const CONTENT = "一只黑羽乌鸦立在悬崖边缘的枯骨之上，翼尖滴落墨珠，背景血月高悬，冷红光照亮羽毛与骨缝，风中飘散着细碎的灰烬与星尘，近景特写、主体占画面大半。"

  it("composeStyleFixedPrompt：画面内容在前 + 固定风格拼接末尾 + 无边框句收尾（顺序固定）", () => {
    const prompt = composeStyleFixedPrompt(CONTENT, FIXED_STYLE)
    // 内容尾部句号被清理后拼接（避免「。。」）
    expect(prompt.startsWith(CONTENT.replace(/[。]$/, ""))).toBe(true)
    expect(prompt).toContain(`，${FIXED_STYLE}。`)
    expect(prompt.endsWith(SINGLE_PROMPT_BORDER_SUFFIX)).toBe(true)
    // 内容尾部句号与风格尾部标点被清理后拼接，不产生重复标点
    expect(prompt).not.toContain("。。")
    expect(composeStyleFixedPrompt(`${CONTENT}。`, `${FIXED_STYLE}，`)).toBe(prompt)
    // 固定风格逐字统一：两次拼接结果中风格段完全一致
    const other = composeStyleFixedPrompt("另一位旅人持灯立于长阶。", FIXED_STYLE)
    expect(prompt.slice(prompt.indexOf(FIXED_STYLE))).toBe(other.slice(other.indexOf(FIXED_STYLE)))
  })

  it("validateTarotPromptPlan：拼接式提示词 ≥60 字通过；过短打回（提示内容目标 120-200 字）", () => {
    const singleItems = TAROT_CARDS.map((card) => ({
      index: card.index,
      name: card.name,
      prompt: composeStyleFixedPrompt(CONTENT, FIXED_STYLE),
    }))
    expect(() => validateTarotPromptPlan(singleItems)).not.toThrow()

    // 过短（< 60 字）打回，错误文案提示内容目标
    expect(() =>
      validateTarotPromptPlan(singleItems.map((item, i) => (i === 0 ? { ...item, prompt: "太短的提示词" } : item))),
    ).toThrow(new RegExp(`${CONTENT_TARGET.min}-${CONTENT_TARGET.max}`))

    // 存量结构化两段终稿：内容段 ≥60 字放行；内容段过短打回
    const structured = TAROT_CARDS.map((card) => ({
      index: card.index,
      name: card.name,
      prompt: composeFinalPrompt(FIXED_STYLE, CONTENT),
    }))
    expect(() => validateTarotPromptPlan(structured)).not.toThrow()
    expect(() =>
      validateTarotPromptPlan(structured.map((item, i) => (i === 0 ? { ...item, prompt: composeFinalPrompt(FIXED_STYLE, "太短") } : item))),
    ).toThrow(/过短/)

    // 张数/顺序错误拒绝
    expect(() => validateTarotPromptPlan(singleItems.slice(0, 77))).toThrow(/78 张/)
  })
})

describe("存量两段终稿结构（legacy 兼容）", () => {
  const STYLE = "欧美暗夜数字手绘水彩插画，金色勾线，星尘颗粒质感"
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

  it("非结构化文本解析为 null（单段提示词/旧式提示词）；normalizeFinalPrompt 补齐两段结构", () => {
    expect(splitFinalPromptSegments("单段短提示词，无段标记")).toBeNull()
    expect(isStructuredFinalPrompt("单段提示词")).toBe(false)

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

  it("存量校验器保持旧口径（final 按结构化内容长度）", () => {
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
  const styleDirection = (name: string, visualLanguage = "x".repeat(45), stylePhrase?: string) => ({
    id: name,
    name,
    concept: "一句话概念",
    description: "两三句说明",
    worldview: "世界观概述",
    suitMapping: [{ suit: "权杖", mapping: "火" }],
    palette: "深蓝紫+金",
    visualLanguage,
    ...(stylePhrase !== undefined ? { stylePhrase } : {}),
    sampleCards: [{ name: "愚者", scene: "初登台顶的观测者" }],
  })

  it("恰好 3 个、名称唯一时通过并归一化（总述 ≥60 字、风格短语齐备）", () => {
    const directions = validateStyleDirections({
      directions: [styleDirection("星轨观测者"), styleDirection("月潮吟游"), styleDirection("午夜星市")],
    })
    expect(directions).toHaveLength(3)
    expect(directions.map((d) => d.name)).toEqual(["星轨观测者", "月潮吟游", "午夜星市"])
    expect(directions.every((d) => d.visualLanguage.length >= 60)).toBe(true)
    expect(directions.every((d) => typeof d.stylePhrase === "string" && d.stylePhrase.length >= 10)).toBe(true)
  })

  it("风格短语原样透传（20-50 字）；缺失/过短时取总述首句确定性补全", () => {
    const phrase = "暗夜水彩厚涂，深蓝鎏金，星尘颗粒质感，神秘史诗氛围"
    const directionsWithPhrase = validateStyleDirections({
      directions: [styleDirection("A", "x".repeat(60), phrase), styleDirection("B"), styleDirection("C")],
    })
    expect(directionsWithPhrase[0]!.stylePhrase).toBe(phrase)

    // 缺失：取总述首句（≥10 字）兜底；总述首句过短则用固定文案
    const directions = validateStyleDirections({
      directions: [
        styleDirection("A", "手绘水彩厚涂，深蓝与鎏金主色调，戏剧性明暗对比，星尘颗粒质感。补充说明文字让总述达到六十字以上。"),
        styleDirection("B", ""),
        styleDirection("C"),
      ],
    })
    expect(directions[0]!.stylePhrase).toContain("手绘水彩厚涂")
    expect((directions[1]!.stylePhrase ?? "").length).toBeGreaterThan(0)
    expect(stylePhraseOf({ visualLanguage: "总述首句足够长时直接取用，后半句不再纳入。", name: "方向" })).toContain("总述首句足够长")
    expect(stylePhraseOf({ visualLanguage: "短", name: "星轨" })).toContain("星轨")
  })

  it("总述过短时确定性补全而非拒绝（防流程卡死）", () => {
    const directions = validateStyleDirections({
      directions: [styleDirection("A", "手绘水彩"), styleDirection("B", ""), styleDirection("C")],
    })
    expect(directions).toHaveLength(3)
    // 补全后每份总述仍 ≥60 字，可继续作为风格规范总述
    expect(directions.every((d) => d.visualLanguage.length >= 60)).toBe(true)
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

describe("小样代表卡（混合覆盖）", () => {
  it("塔罗默认 6 张 = 大阿卡纳 3 张 + 小阿卡纳数字牌 3 张（含最难摆放的权杖十）", () => {
    const indexes = sampleIndexes("tarot", 78, 6)
    expect(indexes).toEqual([0, 1, 21, 22, 31, 38])
    expect(indexes.filter((i) => i < 22)).toHaveLength(3)
    expect(indexes.filter((i) => i >= 22)).toHaveLength(3)
    expect(indexes).toContain(31) // 权杖十：10 件物品的最难摆放卡
  })

  it("sampleCount 超出基础序号数时在余下卡中均匀补足且不重复", () => {
    const indexes = sampleIndexes("tarot", 78, 10)
    expect(new Set(indexes).size).toBe(10)
    expect(indexes).toContain(0)
    expect(indexes).toContain(77)
  })
})

describe("四阶段与角色编制", () => {
  it("四阶段 = 澄清 → 画面提示词 → 生图评审 → 融合与交付", () => {
    expect(TAROT_STAGES.map((stage) => stage.id)).toEqual(["clarify", "draft", "art", "compose"])
    expect(TAROT_STAGES.map((stage) => stage.name)).toEqual([
      "需求澄清",
      "画面提示词",
      "生图与评审",
      "融合与交付",
    ])
  })

  it("八角色编制：风格策划与提示词设计师在编，终稿细化师保留为存量角色", () => {
    const ids = TAROT_ROLES.map((role) => role.id)
    expect(ids).toContain("style_director")
    expect(ids).toContain("prompt_designer")
    expect(ids).toContain("final_refiner")
    expect(ids).not.toContain("world_planner")
    expect(ids).toHaveLength(8)
  })

  it("风格策划提示词为三候选口径并产出固定风格提示词（含格式范例）", () => {
    const stylist = TAROT_ROLES.find((role) => role.id === "style_director")!
    expect(stylist.duty).toContain("3 个候选")
    expect(stylist.systemPrompt).toContain("固定风格提示词")
    expect(stylist.systemPrompt).toContain("Rebecca Campbell")
    expect(stylist.systemPrompt).toContain("供用户选择")
  })

  it("创意总监提示词分内容/风格两轨追问，不问生产细节", () => {
    const director = TAROT_ROLES.find((role) => role.id === "creative_director")!
    expect(director.systemPrompt).toContain("严禁追问任何生产与印制细节")
    expect(director.systemPrompt).toContain("内容轨")
    expect(director.systemPrompt).toContain("风格轨")
    expect(director.systemPrompt).toContain("参考图仅用于提取艺术风格样式")
  })

  it("提示词设计师提示词：只写画面内容（120-200 字，约 160 字），严禁风格词，风格与结尾句由系统拼接", () => {
    const designer = TAROT_ROLES.find((role) => role.id === "prompt_designer")!
    expect(designer.systemPrompt).toContain("120-200 字")
    expect(designer.systemPrompt).toContain("固定风格提示词")
    expect(designer.systemPrompt).toContain("由系统自动拼接")
    expect(designer.systemPrompt).toContain("请勿写入任何风格描述或结尾句")
    expect(designer.systemPrompt).toContain("不写任何负向约束")
    // 风格词禁令落到具体类目（媒介/画风流派/质感/整体色调色系）
    expect(designer.systemPrompt).toContain("严禁任何风格词")
    expect(designer.systemPrompt).toContain("整体色调色系")
    expect(designer.systemPrompt).not.toContain("光影与色调倾向")
    expect(ROLE_PROMPTS.copywriter).toContain("120-200 字")
    expect(ROLE_PROMPTS.copywriter).toContain("请勿写入任何风格描述或结尾句")
    expect(ROLE_PROMPTS.copywriter).toContain("整体色调色系")
  })

  it("终稿细化师提示词保留存量两段结构口径（legacy）", () => {
    const refiner = TAROT_ROLES.find((role) => role.id === "final_refiner")!
    expect(refiner.systemPrompt).toContain("[1] 画面风格")
    expect(refiner.systemPrompt).toContain("[2] 画面内容")
    expect(refiner.systemPrompt).toContain("存量 run")
  })

  it("边框禁令落在画面规则/评审员提示词，撰写侧明确结尾句由系统拼接", () => {
    const designer = TAROT_ROLES.find((role) => role.id === "prompt_designer")!
    expect(designer.systemPrompt).toContain("无边框结尾句由系统自动拼接")
    expect(DEFAULT_ART_RULES).toContain("边缘干净（无边框硬规则）")
    expect(DEFAULT_ART_RULES).toContain("该约束的结尾句由系统统一拼接")
    expect(DEFAULT_REVIEWER_PROMPT).toContain("类似边框的连续装饰")
    expect(ROLE_PROMPTS.finalRefiner).toContain("无边框硬规则")
  })

  it("评审员提示词审查物理合理性（摆放样式不扣分）与可执行反馈要求", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toContain("悬空漂浮")
    // 摆放方式与位置关系交给生图模型自由发挥，不因排列样式扣分
    expect(DEFAULT_REVIEWER_PROMPT).not.toContain("排列失衡")
    expect(DEFAULT_REVIEWER_PROMPT).not.toContain("堆叠杂乱")
    expect(DEFAULT_REVIEWER_PROMPT).toContain("不接受「美感不足」类空泛理由")
  })

  it("画面规则含风格分离（含风格词类目）与内容篇幅（120-200 字，整体约 260 字）", () => {
    expect(DEFAULT_ART_RULES).toContain("风格分离")
    expect(DEFAULT_ART_RULES).toContain("120-200 字")
    expect(DEFAULT_ART_RULES).toContain("260 字左右")
    expect(DEFAULT_ART_RULES).toContain("整体色调色系")
    expect(DEFAULT_ART_RULES).toContain("由系统自动拼接到每张提示词末尾")
    expect(DEFAULT_ART_RULES).toContain("英文画种词")
  })

  it("澄清清单只覆盖内容/风格（无生产细节问题）", () => {
    const titles = TAROT_CLARIFICATION.map((section) => section.title)
    expect(titles).toEqual(["主题与世界观", "艺术风格"])
    const allQuestions = TAROT_CLARIFICATION.flatMap((section) => section.questions.map((q) => q.question))
    expect(allQuestions.some((q) => /牌盒|尺寸|边框/.test(q))).toBe(false)
  })
})
