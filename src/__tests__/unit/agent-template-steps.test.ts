import { describe, expect, it } from "vitest"
// 直接测纯函数模块（不经 template-steps → orchestrator → redis 的执行链）
import {
  buildDirectionExamplePrompt,
  parseClarifyOutput,
  validateDirections,
} from "@/server/services/agent/template-parse"
import { LlmValidationError } from "@/server/services/agent/llm-errors"

function direction(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    concept: `${name} 概念`,
    description: `${name} 说明`,
    suitMapping: [{ suit: "权杖", mapping: "火焰" }],
    sampleCards: [{ name: "愚者", scene: "悬崖边的旅人" }],
    ...extra,
  }
}

describe("validateDirections", () => {
  it("接受恰好 3 个方向，并补全四花色映射", () => {
    const result = validateDirections({
      directions: [direction("潮汐神殿", { id: "tide" }), direction("星海旅人", { id: "star" }), direction("大地寓言", { id: "earth" })],
    })
    expect(result.map((d) => d.id)).toEqual(["tide", "star", "earth"])
    expect(result[0]!.suitMapping!.map((s) => s.suit)).toEqual(["权杖", "圣杯", "宝剑", "星币"])
    expect(result[0]!.suitMapping![0]!.mapping).toBe("火焰")
  })

  it("数量不是 3 时抛校验错误", () => {
    expect(() => validateDirections({ directions: [direction("A"), direction("B")] })).toThrow(LlmValidationError)
  })

  it("方向名重复时抛校验错误", () => {
    expect(() => validateDirections({ directions: [direction("同名"), direction("同名"), direction("另一个")] })).toThrow(LlmValidationError)
  })

  it("缺少 id 时生成唯一 id", () => {
    const result = validateDirections({ directions: [direction("月相秘境"), direction("星海旅人"), direction("大地寓言")] })
    const ids = result.map((d) => d.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(3)
  })

  it("缺少示例牌时抛校验错误", () => {
    expect(() =>
      validateDirections({ directions: [direction("A", { sampleCards: [] }), direction("B"), direction("C")] }),
    ).toThrow(LlmValidationError)
  })
})

describe("buildDirectionExamplePrompt（方向示例图提示词）", () => {
  it("由风格总述 + 首张示例卡场景拼装，以无边框句结尾", () => {
    const prompt = buildDirectionExamplePrompt({
      id: "d1",
      name: "星夜水彩",
      description: "说明",
      visualLanguage: "手绘水彩，午夜蓝紫基调，星尘金点缀",
      stylePhrase: "手绘水彩，午夜蓝紫",
      sampleCards: [{ name: "愚者", scene: "悬崖边持杖远眺的旅人" }],
    })
    expect(prompt.startsWith("手绘水彩，午夜蓝紫基调，星尘金点缀。")).toBe(true)
    expect(prompt).toContain("愚者：悬崖边持杖远眺的旅人")
    expect(prompt).toContain("主体占画面 60% 以上")
    expect(prompt.endsWith("画面边缘干净，无任何边框或边缘装饰")).toBe(true)
  })

  it("无示例卡时用核心意象占位，不抛错", () => {
    const prompt = buildDirectionExamplePrompt({
      id: "d2",
      name: "月潮",
      description: "说明",
      visualLanguage: "厚涂油画，深蓝鎏金",
      sampleCards: [],
    })
    expect(prompt).toContain("以该方向核心意象设计的塔罗卡面")
  })
})

describe("parseClarifyOutput", () => {
  it("超过 3 个问题时截断；每题选项清理空值并截到 3 个推荐选项", () => {
    const result = parseClarifyOutput({
      analysis: "主题已明确",
      questions: [
        { id: "a", question: "问题一", options: ["选项1", "选项2", "选项3", "选项4", " ", "选项5"] },
        { id: "b", question: "问题二", options: [] },
        { id: "c", question: "问题三" },
        { id: "d", question: "问题四" },
      ],
      ready: false,
    })
    expect(result.questions).toHaveLength(3)
    expect(result.questions[0]!.options).toEqual(["选项1", "选项2", "选项3"])
    expect(result.ready).toBe(false)
  })

  it("问题带 topic（content/style）时透传；非法/缺失 topic 按 content 兼容（不写入字段）", () => {
    const result = parseClarifyOutput({
      analysis: "",
      questions: [
        { id: "a", topic: "content", question: "内容问题", options: [] },
        { id: "b", topic: "style", question: "风格问题", options: [] },
        { id: "c", topic: "其他", question: "无轨问题", options: [] },
      ],
      ready: false,
    })
    expect(result.questions[0]).toMatchObject({ id: "a", topic: "content" })
    expect(result.questions[1]).toMatchObject({ id: "b", topic: "style" })
    expect(result.questions[2]).not.toHaveProperty("topic")
  })

  it("ready 为 true 时允许空问题", () => {
    const result = parseClarifyOutput({ analysis: "信息足够", questions: [], ready: true })
    expect(result.ready).toBe(true)
    expect(result.questions).toEqual([])
  })

  it("ready 不是布尔值或问题文本为空时抛校验错误", () => {
    expect(() => parseClarifyOutput({ questions: [], ready: "yes" })).toThrow(LlmValidationError)
    expect(() => parseClarifyOutput({ questions: [{ id: "a", question: "" }], ready: false })).toThrow(LlmValidationError)
  })
})
