import { describe, it, expect } from "vitest"
import { sanitizeSvg } from "@/lib/storage/svg"
import { safeImageExt } from "@/lib/storage/ext"

/**
 * SVG 图标清洗单测：模型图标开放 SVG 上传后的纵深防御层——
 * 剥离 script / foreignObject / on* 事件属性 / javascript: 引用 / DOCTYPE，
 * 正常矢量标记（path/circle/g）不受影响；safeImageExt 放行 svg 扩展名。
 */

const CLEAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <g fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/>
  <path d="M12 8v4l3 3"/></g></svg>`

describe("sanitizeSvg 攻击向量剥离", () => {
  it("剥离 <script> 块（含大小写与多行）", () => {
    const evil = `<svg xmlns="a"><script>alert(1)
      </script><path d="M0 0"/></svg>`
    const out = sanitizeSvg(evil)
    expect(out).not.toMatch(/script/i)
    expect(out).toContain("<path")
  })

  it("剥离内联事件属性（onload/onclick/onerror，双引号/单引号/无引号）", () => {
    const evil = `<svg onload="alert(1)"><image onclick='x()' href="a.png"/><rect onerror=boom /></svg>`
    const out = sanitizeSvg(evil)
    expect(out).not.toMatch(/\son[a-z]+=/i)
    expect(out).toContain("<image")
    expect(out).toContain("<rect")
  })

  it("剥离 javascript:/data:text/html 引用（href 与 xlink:href）", () => {
    const evil = `<svg><a href="javascript:alert(1)"><text>x</text></a>
      <use xlink:href="javascript:alert(2)"/>
      <a href='data:text/html,<script>'>y</a></svg>`
    const out = sanitizeSvg(evil)
    expect(out).not.toMatch(/javascript:/i)
    expect(out).not.toMatch(/data:text\/html/i)
  })

  it("剥离 <foreignObject>（HTML 注入载体）与 DOCTYPE/ENTITY", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]>
      <svg><foreignObject width="1" height="1"><body onload="a()">x</body></foreignObject></svg>`
    const out = sanitizeSvg(evil)
    expect(out).not.toMatch(/foreignObject/i)
    expect(out).not.toMatch(/DOCTYPE/i)
    expect(out).not.toMatch(/ENTITY/i)
  })

  it("正常矢量图标不受影响", () => {
    expect(sanitizeSvg(CLEAN_SVG)).toBe(CLEAN_SVG)
  })

  it("空值原样返回（调用方按无效内容拒绝）", () => {
    expect(sanitizeSvg("")).toBe("")
  })
})

describe("safeImageExt svg 扩展名", () => {
  it(".svg → \"svg\"；非白名单扩展名仍回落 png", () => {
    expect(safeImageExt("icon.svg")).toBe("svg")
    expect(safeImageExt("evil.html")).toBe("png")
    expect(safeImageExt("photo.jpeg")).toBe("jpg")
  })
})
