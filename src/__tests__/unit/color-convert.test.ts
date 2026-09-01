import { describe, it, expect } from "vitest"
import {
  cmykToRgb,
  formatCmyk,
  formatHsb,
  formatRgb,
  hexToRgb,
  hsbToRgb,
  nearestColorName,
  normalizeHex,
  parseCmyk,
  parseHsb,
  parseRgb,
  rgbToCmyk,
  rgbToHex,
  rgbToHsb,
} from "@/lib/color/convert"
import { COLOR_LIBRARY_FLAT } from "@/lib/weartry/dictionaries"

/**
 * AI换色取色换算单测：HEX/RGB/HSB（选色输入）与 CMYK（兼容派生）。
 * HSB/CMYK 为近似换算，只断言近似值（容差）。
 */

describe("normalizeHex", () => {
  it("合法 6 位补 # 大写化", () => {
    expect(normalizeHex("1f2a44")).toBe("#1F2A44")
    expect(normalizeHex("#ffffff")).toBe("#FFFFFF")
  })
  it("非法输入返回 null", () => {
    expect(normalizeHex("#fff")).toBeNull()
    expect(normalizeHex("#12345g")).toBeNull()
    expect(normalizeHex("")).toBeNull()
  })
})

describe("hex ↔ rgb ↔ cmyk", () => {
  it("白色：CMYK 全 0 且 K=0", () => {
    const cmyk = rgbToCmyk({ r: 255, g: 255, b: 255 })
    expect(cmyk).toEqual({ c: 0, m: 0, y: 0, k: 0 })
  })
  it("黑色：K=100", () => {
    const cmyk = rgbToCmyk({ r: 0, g: 0, b: 0 })
    expect(cmyk).toEqual({ c: 0, m: 0, y: 0, k: 100 })
  })
  it("rgb→hex→rgb 往返一致", () => {
    const rgb = { r: 31, g: 42, b: 68 }
    expect(hexToRgb(rgbToHex(rgb))).toEqual(rgb)
  })
  it("rgb→cmyk→rgb 近似往返（±2 容差）", () => {
    for (const rgb of [
      { r: 31, g: 42, b: 68 },
      { r: 193, g: 154, b: 107 },
      { r: 230, g: 0, b: 18 },
    ]) {
      const back = cmykToRgb(rgbToCmyk(rgb))
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(2)
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(2)
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(2)
    }
  })
  it("格式化输出紧凑格式", () => {
    expect(formatRgb({ r: 1, g: 2, b: 3 })).toBe("1,2,3")
    expect(formatCmyk({ c: 56, m: 39, y: 0, k: 73 })).toBe("56,39,0,73")
  })
})

describe("parseRgb / parseCmyk / parseHsb", () => {
  it("支持中英文逗号与空格分隔", () => {
    expect(parseRgb("31, 42, 68")).toEqual({ r: 31, g: 42, b: 68 })
    expect(parseRgb("31，42，68")).toEqual({ r: 31, g: 42, b: 68 })
    expect(parseCmyk("56 39 0 73")).toEqual({ c: 56, m: 39, y: 0, k: 73 })
    expect(parseHsb("231，55，27")).toEqual({ h: 231, s: 55, b: 27 })
  })
  it("分量数不对或越界返回 null", () => {
    expect(parseRgb("31,42")).toBeNull()
    expect(parseRgb("31,42,999")).toBeNull()
    expect(parseCmyk("56,39,0")).toBeNull()
    expect(parseCmyk("56,39,0,101")).toBeNull()
    expect(parseHsb("231,55")).toBeNull()
    expect(parseHsb("361,55,27")).toBeNull()
    expect(parseHsb("231,101,27")).toBeNull()
  })
})

describe("hsb ↔ rgb", () => {
  it("纯黑/纯白边界", () => {
    expect(rgbToHsb({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, b: 0 })
    expect(rgbToHsb({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, b: 100 })
  })
  it("红绿蓝三原色的色相", () => {
    const red = rgbToHsb({ r: 255, g: 0, b: 0 })
    expect(red).toEqual({ h: 0, s: 100, b: 100 })
    const green = rgbToHsb({ r: 0, g: 255, b: 0 })
    expect(green.h).toBe(120)
    expect(green.s).toBe(100)
    const blue = rgbToHsb({ r: 0, g: 0, b: 255 })
    expect(blue.h).toBe(240)
  })
  it("rgb→hsb→rgb 往返一致（±1 容差）", () => {
    for (const rgb of [
      { r: 31, g: 42, b: 68 },
      { r: 193, g: 154, b: 107 },
      { r: 230, g: 0, b: 18 },
      { r: 128, g: 128, b: 128 },
    ]) {
      const back = hsbToRgb(rgbToHsb(rgb))
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1)
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1)
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1)
    }
  })
  it("格式化输出紧凑格式", () => {
    expect(formatHsb({ h: 231.4, s: 55.2, b: 26.7 })).toBe("231,55,27")
  })
})

describe("nearestColorName", () => {
  it("色库原色命中自身名称", () => {
    expect(nearestColorName("#1F2A44", COLOR_LIBRARY_FLAT)).toBe("藏青")
  })
  it("近似色命中最近色库名", () => {
    expect(nearestColorName("#1E2940", COLOR_LIBRARY_FLAT)).toBe("藏青")
    expect(nearestColorName("#010101", COLOR_LIBRARY_FLAT)).toBe("纯黑")
  })
  it("非法 hex 返回 null", () => {
    expect(nearestColorName("xxx", COLOR_LIBRARY_FLAT)).toBeNull()
  })
})
