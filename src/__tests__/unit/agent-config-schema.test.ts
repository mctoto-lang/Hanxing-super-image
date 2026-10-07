import { describe, expect, it } from "vitest"

import { directionConfigUpdateSchema } from "@/server/schemas/agent"
import {
  DEFAULT_ART_RULES,
  DEFAULT_REVIEWER_PROMPT,
  DEFAULT_TAROT_TEMPLATE_CONFIG,
  ROLE_PROMPTS,
  TEMPLATE_ASSET_SIZE_KEYS,
  composeFinalRefinerPrompt,
  composePromptDesignerPrompt,
  normalizeTarotTemplateConfig,
  resolveArtRules,
  resolveRolePrompt,
} from "@/lib/agent/pipelines"

/**
 * 方向配置保存 schema 回归测试：
 * assetSizes 的尺寸正则曾误写为 /^\\d+x\\d+$/（匹配字面量反斜杠+d，
 * 任何合法尺寸都会被拒，导致 Agent 工坊配置保存必然报
 * invalid_format），此处锁定「WxH 合法 / 其他非法」的语义。
 */

/** 套件资产与 AI 融合一律延用卡面比例：assetSizes 仅卡面一键 */
const VALID_SIZES = {
  card: "1024x1024",
}

const baseInput = {
  direction: "tarot",
  enabled: true,
  templateConfig: {
    template: "tarot",
    copywriterChatModelId: null,
    reviewerModelIds: ["00000000-0000-4000-8000-000000000001"],
    assetSizes: VALID_SIZES,
    reviewThresholds: { content: 75, aesthetic: 75, consistency: 70 },
    maxRetries: 2,
    sampleCount: 6,
    concurrency: 2,
    clarifyMaxRounds: 4,
    frameMode: "ai",
    aiFrameModelId: null,
    assetImageModelId: null,
    cardImageModelId: null,
  },
}

describe("directionConfigUpdateSchema.templateConfig.assetSizes", () => {
  it("接受合法的 WxH 尺寸（含非对称尺寸）", () => {
    const parsed = directionConfigUpdateSchema.parse(baseInput)
    expect(parsed.templateConfig?.assetSizes).toEqual(VALID_SIZES)
  })

  it("接受空字符串（= 跟随平台经典 imageSize，由消费侧 || 链回退）", () => {
    const parsed = directionConfigUpdateSchema.parse({
      ...baseInput,
      templateConfig: {
        ...baseInput.templateConfig,
        assetSizes: { ...VALID_SIZES, card: "" },
      },
    })
    expect(parsed.templateConfig?.assetSizes.card).toBe("")
  })

  it.each([
    ["只有数字", "1024"],
    ["用乘号", "1024×1024"],
    ["用星号", "1024*1024"],
    ["带单位", "1024x1024px"],
    ["字面量反斜杠 d（旧 bug 误匹配目标）", "\\d+x\\d"],
  ])("拒绝非法尺寸：%s", (_label, value) => {
    const bad = {
      ...baseInput,
      templateConfig: {
        ...baseInput.templateConfig,
        assetSizes: { ...VALID_SIZES, card: value },
      },
    }
    expect(() => directionConfigUpdateSchema.parse(bad)).toThrow()
  })

  it("拒绝多余/缺失的尺寸键（键集固定为卡面一键）", () => {
    expect(() =>
      directionConfigUpdateSchema.parse({
        ...baseInput,
        templateConfig: {
          ...baseInput.templateConfig,
          assetSizes: { ...VALID_SIZES, extra: "1024x1024" },
        },
      }),
    ).toThrow()
    expect(() =>
      directionConfigUpdateSchema.parse({
        ...baseInput,
        templateConfig: {
          ...baseInput.templateConfig,
          assetSizes: { border: "1024x1024" } as unknown as typeof VALID_SIZES,
        },
      }),
    ).toThrow()
    const { card, ...missing } = VALID_SIZES
    void card
    expect(() =>
      directionConfigUpdateSchema.parse({
        ...baseInput,
        templateConfig: {
          ...baseInput.templateConfig,
          assetSizes: missing,
        },
      }),
    ).toThrow()
  })
})

describe("normalizeTarotTemplateConfig（存量脏值清洗）", () => {
  it("空输入返回内置默认", () => {
    expect(normalizeTarotTemplateConfig(null)).toEqual(DEFAULT_TAROT_TEMPLATE_CONFIG)
    expect(normalizeTarotTemplateConfig("junk")).toEqual(DEFAULT_TAROT_TEMPLATE_CONFIG)
  })

  it("越界数值就近钳制（旧库 maxRetries≤10 时代的脏值）", () => {
    const n = normalizeTarotTemplateConfig({
      maxRetries: 10,
      sampleCount: 99,
      clarifyMaxRounds: 0,
      concurrency: 8,
      reviewThresholds: { content: 10, aesthetic: 99, consistency: 50 },
    })
    expect(n.maxRetries).toBe(3)
    expect(n.sampleCount).toBe(12)
    expect(n.clarifyMaxRounds).toBe(1)
    expect(n.concurrency).toBe(4)
    expect(n.reviewThresholds).toEqual({ content: 40, aesthetic: 95, consistency: 50 })
  })

  it("尺寸输入归一化后仅含卡面键（缺键回退默认）", () => {
    const n = normalizeTarotTemplateConfig({ assetSizes: { card: "768x1024" } })
    expect(Object.keys(n.assetSizes).sort()).toEqual([...TEMPLATE_ASSET_SIZE_KEYS].sort())
    expect(n.assetSizes.card).toBe("768x1024")
  })

  it("资产尺寸仅保留白名单键，非法值回退默认，空串（跟随平台）保留", () => {
    const n = normalizeTarotTemplateConfig({
      assetSizes: { card: "768x1024", border: "1024x1536", back: "", extra: "1x1" },
    })
    expect(Object.keys(n.assetSizes).sort()).toEqual([...TEMPLATE_ASSET_SIZE_KEYS].sort())
    expect(n.assetSizes.card).toBe("768x1024")
    // 存量逐资产键（border/back/box_*）读取侧即剔除——套件资产延用卡面比例
    expect("border" in n.assetSizes).toBe(false)
    expect("back" in n.assetSizes).toBe(false)
  })

  it("卡面显式空串保留（跟随平台），不回退默认尺寸——与缺键回退区分", () => {
    // 显式 ""：用户明确选择跟随平台 imageSize，归一化原样保留
    const n = normalizeTarotTemplateConfig({ assetSizes: { card: "" } })
    expect(n.assetSizes.card).toBe("")
    expect(n.assetSizes.card).not.toBe(DEFAULT_TAROT_TEMPLATE_CONFIG.assetSizes.card)
  })

  it("reviewerModelIds 去重、剔除非字符串并截断到 3 个", () => {
    const n = normalizeTarotTemplateConfig({ reviewerModelIds: ["a", "a", "b", 42, "", "c", "d"] })
    expect(n.reviewerModelIds).toEqual(["a", "b", "c"])
  })

  it("模型槽位非字符串归一为 null，frameMode 恒为 ai", () => {
    const n = normalizeTarotTemplateConfig({ copywriterChatModelId: 123, cardImageModelId: "m-1", frameMode: "local" })
    expect(n.copywriterChatModelId).toBeNull()
    expect(n.cardImageModelId).toBe("m-1")
    expect(n.frameMode).toBe("ai")
  })

  it("任意脏输入归一化后恒可通过保存 schema（闭环）", () => {
    const n = normalizeTarotTemplateConfig({
      maxRetries: 10,
      assetSizes: { extra: "1x1", card: "bad" },
      reviewThresholds: { content: 999 },
      reviewerModelIds: ["00000000-0000-4000-8000-000000000001"],
    })
    expect(() =>
      directionConfigUpdateSchema.parse({
        ...baseInput,
        templateConfig: { ...baseInput.templateConfig, ...n },
      }),
    ).not.toThrow()
  })
})

describe("rolePrompts / artRules（角色提示词与画面规则可配置）", () => {
  it("归一化：白名单键保留、空串剔除、超长截断、未知键丢弃", () => {
    const n = normalizeTarotTemplateConfig({
      rolePrompts: {
        prompt_designer: " 自定义初稿设计师 ",
        final_refiner: " 自定义终稿细化师 ",
        reviewer: "",
        hacker: "不应保留",
      },
      artRules: "  自定义画面规则  ",
    })
    expect(n.rolePrompts).toEqual({
      prompt_designer: "自定义初稿设计师",
      final_refiner: "自定义终稿细化师",
    })
    expect(n.artRules).toBe("自定义画面规则")
  })

  it("归一化：空输入不产生空字段（回退内置默认）", () => {
    const n = normalizeTarotTemplateConfig({ rolePrompts: {}, artRules: "   " })
    expect(n.rolePrompts).toBeUndefined()
    expect(n.artRules).toBeUndefined()
  })

  it("schema 接受合法配置并透传（含 final_refiner），拒绝超长", () => {
    const parsed = directionConfigUpdateSchema.parse({
      ...baseInput,
      templateConfig: {
        ...baseInput.templateConfig,
        rolePrompts: { prompt_designer: "自定义", final_refiner: "自定义终稿" },
        artRules: "主体占比 60% 以上",
      },
    })
    expect(parsed.templateConfig?.rolePrompts?.prompt_designer).toBe("自定义")
    expect(parsed.templateConfig?.rolePrompts?.final_refiner).toBe("自定义终稿")
    expect(parsed.templateConfig?.artRules).toBe("主体占比 60% 以上")
    expect(() =>
      directionConfigUpdateSchema.parse({
        ...baseInput,
        templateConfig: {
          ...baseInput.templateConfig,
          artRules: "x".repeat(2001),
        },
      }),
    ).toThrow()
  })

  it("resolve：空配置回退内置默认，配置覆盖生效", () => {
    expect(resolveArtRules(null)).toBe(DEFAULT_ART_RULES)
    expect(resolveRolePrompt("prompt_designer", null)).toBe(ROLE_PROMPTS.copywriter)
    expect(resolveRolePrompt("final_refiner", null)).toBe(ROLE_PROMPTS.finalRefiner)
    expect(resolveRolePrompt("reviewer", null)).toBe(DEFAULT_REVIEWER_PROMPT)
    const config = {
      templateConfig: normalizeTarotTemplateConfig({
        rolePrompts: { prompt_designer: "覆盖版", final_refiner: "覆盖终稿", reviewer: "覆盖评审" },
        artRules: "覆盖规则",
      }),
    } as Parameters<typeof resolveArtRules>[0]
    expect(resolveArtRules(config)).toBe("覆盖规则")
    expect(resolveRolePrompt("prompt_designer", config)).toBe("覆盖版")
    expect(resolveRolePrompt("final_refiner", config)).toBe("覆盖终稿")
    expect(resolveRolePrompt("reviewer", config)).toBe("覆盖评审")
    // 初稿设计师基底（design_drafts 用）与终稿细化师基底（design_finals 与打回重细化用）
    expect(composePromptDesignerPrompt(config)).toBe("覆盖版\n\n覆盖规则")
    expect(composePromptDesignerPrompt(null)).toBe(`${ROLE_PROMPTS.copywriter}\n\n${DEFAULT_ART_RULES}`)
    expect(composeFinalRefinerPrompt(config)).toBe("覆盖终稿\n\n覆盖规则")
    expect(composeFinalRefinerPrompt(null)).toBe(`${ROLE_PROMPTS.finalRefiner}\n\n${DEFAULT_ART_RULES}`)
  })
})
