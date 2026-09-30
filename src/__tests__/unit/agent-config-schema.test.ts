import { describe, expect, it } from "vitest"

import { directionConfigUpdateSchema } from "@/server/schemas/agent"

/**
 * 方向配置保存 schema 回归测试：
 * assetSizes 的尺寸正则曾误写为 /^\\d+x\\d+$/（匹配字面量反斜杠+d，
 * 任何合法尺寸都会被拒，导致 Agent 工坊配置保存必然报
 * invalid_format），此处锁定「WxH 合法 / 其他非法」的语义。
 */

const VALID_SIZES = {
  card: "1024x1024",
  border: "768x1024",
  back: "1024x1024",
  box_front: "1024x1024",
  box_back: "1024x1024",
  box_side: "1024x300",
  box_top: "1024x1024",
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

  it("拒绝多余/缺失的尺寸键（键集固定为 7 个模板资产键）", () => {
    expect(() =>
      directionConfigUpdateSchema.parse({
        ...baseInput,
        templateConfig: {
          ...baseInput.templateConfig,
          assetSizes: { ...VALID_SIZES, extra: "1024x1024" },
        },
      }),
    ).toThrow()
    const { back, ...missing } = VALID_SIZES
    void back
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
