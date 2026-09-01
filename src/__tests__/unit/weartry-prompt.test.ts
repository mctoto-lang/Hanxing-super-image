import { describe, it, expect } from "vitest"
import {
  buildColorPrompt,
  buildModelImagePrompt,
  buildOutfitPrompt,
  buildTryonPrompt,
  pushRecentColor,
} from "@/lib/weartry/prompt"
import {
  WEARTRY_DEFAULT_PROMPT_TEMPLATES,
  WEARTRY_PROMPT_SCENES,
} from "@/lib/weartry/prompt-defaults"

/**
 * 穿戴图片 prompt 组装单测：变量注入、场景注入段、严格模式（未引用即丢弃）、
 * 最近颜色去重；并校验默认模板引用的变量全部在注册表内。
 */

describe("buildOutfitPrompt", () => {
  it("注入编号块解析产物变量", () => {
    const out = buildOutfitPrompt({
      promptTemplate: "{{productName}} 穿戴图 {{topSellingPoint}}",
      baseVars: {
        productName: "法式碎花连衣裙",
        topSellingPoint: "垂坠不挑人",
      },
    })
    expect(out).toBe("法式碎花连衣裙 穿戴图 垂坠不挑人")
  })
  it("未引用的变量不注入（严格模式）", () => {
    const out = buildOutfitPrompt({
      promptTemplate: "固定文案",
      baseVars: { productName: "连衣裙" },
    })
    expect(out).toBe("固定文案")
  })
})

describe("buildModelImagePrompt", () => {
  it("模特属性映射为英文提示词", () => {
    const out = buildModelImagePrompt({
      template: "{{gender}} {{age}} {{race}} {{bodyType}} {{details}}",
      attrs: {
        gender: "female",
        age: "young",
        race: "asian",
        bodyType: "slim",
      },
      details: "长发",
    })
    expect(out).toBe("female young adult (18-28) East Asian slim 长发")
  })
  it("未选属性与空细节自然省略", () => {
    const out = buildModelImagePrompt({
      template: "{{gender}}|{{age}}|{{race}}|{{bodyType}}|{{details}}",
      attrs: { gender: "male" },
    })
    expect(out).toBe("male||||")
  })
})

describe("buildTryonPrompt", () => {
  it("场景模板填充为 sceneSegment 注入主模板", () => {
    const out = buildTryonPrompt({
      template: "试穿：{{sceneSegment}}",
      attrs: {},
      scene: {
        key: "street_snap",
        name: "城市街拍",
        promptTemplate: "{{sceneName}}街头场景",
      },
    })
    expect(out).toBe("试穿：城市街拍街头场景")
  })
  it("无场景时 sceneSegment 为空（模板未引用不注入）", () => {
    const out = buildTryonPrompt({
      template: "试穿图 {{sceneSegment}}",
      attrs: {},
      scene: null,
    })
    expect(out).toBe("试穿图")
  })
  it("补充要求经 additionalPrompt 注入", () => {
    const out = buildTryonPrompt({
      template: "试穿 {{additionalPrompt}}",
      attrs: {},
      additionalPrompt: "正面全身",
    })
    expect(out).toBe("试穿 正面全身")
  })
})

describe("buildColorPrompt", () => {
  it("注入部位与三色值", () => {
    const out = buildColorPrompt({
      template:
        "{{part}} → {{colorName}} {{colorHex}} {{colorHsb}} {{colorRgb}}",
      part: "上衣主体",
      colorName: "藏青",
      colorHex: "#1F2A44",
      colorHsb: "231,55,27",
      colorRgb: "31,42,68",
    })
    expect(out).toBe("上衣主体 → 藏青 #1F2A44 231,55,27 31,42,68")
  })
  it("兼容变量 colorCmyk（旧模板）可选注入", () => {
    const out = buildColorPrompt({
      template: "{{colorName}} CMYK {{colorCmyk}}",
      part: "上衣主体",
      colorName: "藏青",
      colorHex: "#1F2A44",
      colorHsb: "231,55,27",
      colorRgb: "31,42,68",
      colorCmyk: "56,39,0,73",
    })
    expect(out).toBe("藏青 CMYK 56,39,0,73")
  })
})

describe("pushRecentColor", () => {
  const base = [
    { name: "藏青", hex: "#1F2A44", hsb: "231,55,27", savedAt: 1 },
    { name: "驼色", hex: "#C19A6B", hsb: "32,45,76", savedAt: 2 },
  ]
  it("新色插入队首并去重（大小写不敏感）", () => {
    const next = pushRecentColor(base, {
      name: "正红",
      hex: "#E60012",
      hsb: "355,100,90",
    })
    expect(next).toHaveLength(3)
    expect(next[0]!.name).toBe("正红")
  })
  it("重复色前移去重", () => {
    const next = pushRecentColor(base, {
      name: "藏青",
      hex: "#1f2a44",
      hsb: "231,55,27",
    })
    expect(next).toHaveLength(2)
    expect(next[0]!.hex).toBe("#1f2a44")
  })
  it("超过上限截断（默认 5）", () => {
    let list = base
    for (const c of ["#111111", "#222222", "#333333", "#444444"]) {
      list = pushRecentColor(list, { name: c, hex: c, hsb: "0,0,0" })
    }
    expect(list).toHaveLength(5)
    expect(list[0]!.hex).toBe("#444444")
  })
})

describe("默认模板与场景注册表一致性", () => {
  it("5 个穿戴场景均有默认模板/标签/说明", () => {
    expect(WEARTRY_PROMPT_SCENES).toHaveLength(5)
    for (const scene of WEARTRY_PROMPT_SCENES) {
      expect(WEARTRY_DEFAULT_PROMPT_TEMPLATES[scene]).toBeTruthy()
    }
  })
  it("换色默认模板引用全部换色变量", () => {
    const tpl = WEARTRY_DEFAULT_PROMPT_TEMPLATES["weartry.color"]!
    for (const v of ["part", "colorName", "colorHex", "colorHsb", "colorRgb"]) {
      expect(tpl).toContain(`{{${v}}}`)
    }
    // 已切换 HSB 输入模式，默认模板不再引用 CMYK
    expect(tpl).not.toContain("{{colorCmyk}}")
  })
  it("模特穿戴默认模板引用场景注入段", () => {
    expect(
      WEARTRY_DEFAULT_PROMPT_TEMPLATES["weartry.tryon"],
    ).toContain("{{sceneSegment}}")
  })
})
