import { describe, expect, it } from "vitest"
import {
  buildJsonRetryNudge,
  LlmJsonParseError,
  parseJsonLoose,
} from "@/server/services/agent/llm-json"

describe("parseJsonLoose 容错解析", () => {
  it("纯 JSON 直接解析", () => {
    expect(parseJsonLoose<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it("剥离 ```json 围栏", () => {
    expect(parseJsonLoose('```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] })
  })

  it("剥无语言标注围栏", () => {
    expect(parseJsonLoose('```\n{"ok": true}\n```')).toEqual({ ok: true })
  })

  it("单行内联围栏也能剥离", () => {
    expect(parseJsonLoose('```json{"a":1}```')).toEqual({ a: 1 })
  })

  it("跳过前置引导语与含大括号的尾注（旧首尾切片实现的必挂场景）", () => {
    const raw = '好的，以下是结果：\n{"ready": true, "questions": []}\n以上 {就是} 全部结果 }'
    expect(parseJsonLoose(raw)).toEqual({ ready: true, questions: [] })
  })

  it("前导杂文中的大括号块被跳过，取真正可解析的对象", () => {
    const raw = '配置 {json} 示例如下：{"a": 1}'
    expect(parseJsonLoose<{ a: number }>(raw)).toEqual({ a: 1 })
  })

  it("大括号出现在字符串内不影响配平", () => {
    const raw = '{"text":"包含 } 与 { 的内容","n":2}'
    expect(parseJsonLoose<{ text: string; n: number }>(raw).text).toContain("}")
  })

  it("转义引号不破坏字符串态判断", () => {
    const raw = '{"text":"he said \\"hi {there}\\"","n":3}'
    expect(parseJsonLoose<{ n: number }>(raw).n).toBe(3)
  })

  it("字符串值内的 ``` 不被误删（旧全局删除实现会破坏值）", () => {
    const raw = '{"code":"```js\\nfoo()\\n```"}'
    expect(parseJsonLoose<{ code: string }>(raw).code).toContain("```")
  })

  it("多个对象输出时取首个可解析对象", () => {
    const raw = '{"a":1}\n补充说明：\n{"b":2}'
    expect(parseJsonLoose(raw)).toEqual({ a: 1 })
  })

  it("对象与数组尾逗号被清理", () => {
    expect(parseJsonLoose('{"a":1,}')).toEqual({ a: 1 })
    expect(parseJsonLoose('{"a":[1,2,]}')).toEqual({ a: [1, 2] })
  })
})

describe("parseJsonLoose 截断自动修复（max_tokens 截断场景）", () => {
  it("对象中途截断：补齐闭合括号", () => {
    expect(parseJsonLoose('{"a":1')).toEqual({ a: 1 })
  })

  it("成员后逗号截断：退回上一完整成员", () => {
    expect(parseJsonLoose('{"a":1,')).toEqual({ a: 1 })
  })

  it("仅有键名冒号截断：保留空对象骨架", () => {
    expect(parseJsonLoose('{"a":')).toEqual({})
  })

  it("值字符串中途截断：补引号保留半截内容", () => {
    expect(parseJsonLoose('{"brief":"半截简报')).toEqual({ brief: "半截简报" })
  })

  it("值字符串含转义引号时中途截断", () => {
    expect(parseJsonLoose('{"a":"he said \\"hel')).toEqual({ a: 'he said "hel' })
  })

  it("嵌套数组元素中途截断：逐层补齐", () => {
    expect(parseJsonLoose('{"cards": [{"x":1}, {"x":2')).toEqual({
      cards: [{ x: 1 }, { x: 2 }],
    })
  })

  it("悬挂键名截断：丢弃不完整键值对", () => {
    expect(parseJsonLoose('{"a":1,"b"')).toEqual({ a: 1 })
    expect(parseJsonLoose('{"a":1,"b":')).toEqual({ a: 1 })
  })

  it("裸字面量完整时保留（数字），不完整时丢弃（半个 true）", () => {
    expect(parseJsonLoose('{"a":12')).toEqual({ a: 12 })
    expect(parseJsonLoose('{"ready":tru')).toEqual({})
  })

  it("数组内数字序列截断", () => {
    expect(parseJsonLoose('{"a":[1,2')).toEqual({ a: [1, 2] })
  })
})

describe("parseJsonLoose 失败报错（带具体原因）", () => {
  it("空输出", () => {
    expect(() => parseJsonLoose("   \n  ")).toThrow(LlmJsonParseError)
    expect(() => parseJsonLoose("   \n  ")).toThrow("输出为空")
  })

  it("无大括号的纯文本", () => {
    expect(() => parseJsonLoose("今天天气不错")).toThrow("未找到 JSON 对象")
  })

  it("平衡但含非法语法（单引号值）报语法错误", () => {
    expect(() => parseJsonLoose("{\"a\": 'x'}")).toThrow("语法错误")
  })

  it("截断且无法修复（字符串含裸换行控制符）报疑似截断", () => {
    expect(() => parseJsonLoose('{"a": "line1\nline2')).toThrow("疑似被 max_tokens 截断")
  })

  it("错误对象保留原文 raw 供纠错重试引用", () => {
    try {
      parseJsonLoose("没有大括号")
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LlmJsonParseError)
      expect((err as LlmJsonParseError).raw).toBe("没有大括号")
      expect((err as LlmJsonParseError).message).toContain("未找到 JSON 对象")
    }
  })
})

describe("buildJsonRetryNudge 纠错提示组装", () => {
  it("解析失败：原因 + 原文片段（截断到 120 字）", () => {
    const nudge = buildJsonRetryNudge("输出无法解析为 JSON（语法错误：Unexpected token）", {
      rawSnippet: "x".repeat(200),
    })
    expect(nudge).toContain("语法错误")
    expect(nudge).toContain("原文片段：")
    expect(nudge.slice(nudge.indexOf("原文片段："))).toHaveLength("原文片段：".length + 120)
  })

  it("截断失败：追加精简指令", () => {
    const nudge = buildJsonRetryNudge("输出无法解析为 JSON（输出不完整）", {
      rawSnippet: '{"a":1',
      truncated: true,
    })
    expect(nudge).toContain("max_tokens")
    expect(nudge).toContain("大幅精简")
    expect(nudge).toContain("；")
  })

  it("字段校验失败：仅校验错误信息", () => {
    expect(buildJsonRetryNudge("缺少 brief 字段或内容为空")).toBe("缺少 brief 字段或内容为空")
  })
})
