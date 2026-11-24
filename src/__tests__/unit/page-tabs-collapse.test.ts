import { describe, expect, it } from "vitest"
import { shouldCollapsePageTabs } from "@/components/shared/page-tabs-collapse"

describe("shouldCollapsePageTabs（页面级 tab 条折叠判定）", () => {
  it("有右侧工具：tab 条 + 行间距 + 工具挤不下一行即折叠", () => {
    expect(shouldCollapsePageTabs({ barWidth: 890, toolsWidth: 176, gap: 12, rowWidth: 1000 })).toBe(true)
    expect(shouldCollapsePageTabs({ barWidth: 890, toolsWidth: 176, gap: 12, rowWidth: 1100 })).toBe(false)
  })

  it("恰好等宽不折叠（1px 容差吸收亚像素舍入）", () => {
    expect(shouldCollapsePageTabs({ barWidth: 812, toolsWidth: 176, gap: 12, rowWidth: 1000 })).toBe(false)
    expect(shouldCollapsePageTabs({ barWidth: 812.6, toolsWidth: 176, gap: 12, rowWidth: 1000 })).toBe(false)
    // 813 + 176 + 12 = 1001 = 行宽 + 容差，仍不折叠；再多 0.5px 即折叠
    expect(shouldCollapsePageTabs({ barWidth: 813, toolsWidth: 176, gap: 12, rowWidth: 1000 })).toBe(false)
    expect(shouldCollapsePageTabs({ barWidth: 813.5, toolsWidth: 176, gap: 12, rowWidth: 1000 })).toBe(true)
  })

  it("无右侧工具（宽度 0）：退化为 tab 条自身放不下才折叠", () => {
    expect(shouldCollapsePageTabs({ barWidth: 890, toolsWidth: 0, gap: 12, rowWidth: 1000 })).toBe(false)
    expect(shouldCollapsePageTabs({ barWidth: 890, toolsWidth: 0, gap: 12, rowWidth: 800 })).toBe(true)
  })

  it("行尚未布局（0 宽）不折叠", () => {
    expect(shouldCollapsePageTabs({ barWidth: 890, toolsWidth: 176, gap: 12, rowWidth: 0 })).toBe(false)
  })
})
