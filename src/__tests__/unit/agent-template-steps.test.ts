import { describe, expect, it } from "vitest"
// 直接测纯函数模块（不经 template-steps → orchestrator → redis 的执行链）
import { parseClarifyOutput, validateDirections } from "@/server/services/agent/template-parse"
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

describe("parseClarifyOutput", () => {
  it("超过 3 个问题时截断，并清理空选项", () => {
    const result = parseClarifyOutput({
      analysis: "主题已明确",
      questions: [
        { id: "a", question: "问题一", options: ["x", " ", "y"] },
        { id: "b", question: "问题二", options: [] },
        { id: "c", question: "问题三" },
        { id: "d", question: "问题四" },
      ],
      ready: false,
    })
    expect(result.questions).toHaveLength(3)
    expect(result.questions[0]!.options).toEqual(["x", "y"])
    expect(result.ready).toBe(false)
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
