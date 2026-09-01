import { describe, expect, it } from "vitest"
import { parseAiJson } from "@/server/services/workspace-ai"

describe("parseAiJson 容错解析", () => {
  it("纯 JSON 直接解析", () => {
    const out = parseAiJson<{ a: number }>('{"a":1}')
    expect(out).toEqual({ a: 1 })
  })

  it("剥离 ```json 围栏", () => {
    const raw = '```json\n{"a": [1, 2]}\n```'
    expect(parseAiJson(raw)).toEqual({ a: [1, 2] })
  })

  it("剥无语言标注围栏", () => {
    const raw = '```\n{"ok": true}\n```'
    expect(parseAiJson(raw)).toEqual({ ok: true })
  })

  it("跳过前置引导语（取首个平衡大括号块）", () => {
    const raw = '好的，以下是结果：\n{"name":"x","nested":{"v":1}}\n希望有帮助'
    expect(parseAiJson(raw)).toEqual({ name: "x", nested: { v: 1 } })
  })

  it("大括号出现在字符串内不影响配平", () => {
    const raw = '{"text":"包含 } 与 { 的内容","n":2}'
    expect(parseAiJson<{ text: string; n: number }>(raw).text).toContain("}")
  })

  it("转义引号不破坏字符串态判断", () => {
    const raw = '{"text":"he said \\"hi {there}\\"","n":3}'
    expect(parseAiJson<{ n: number }>(raw).n).toBe(3)
  })

  it("无 JSON 内容时抛错", () => {
    expect(() => parseAiJson("完全没有大括号的输出")).toThrow()
  })

  it("畸形 JSON（不平衡）抛错", () => {
    expect(() => parseAiJson('{"a": 1')).toThrow()
  })
})
