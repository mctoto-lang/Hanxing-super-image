import { describe, it, expect } from "vitest"
import { normalizeBadgeColor, pickBadgeTextColor } from "@/lib/plans/badge"

/**
 * 套餐勋章实底前景色自适应单测：浅色底选黑字、深色底选白字，
 * 任意 #RRGGBB 下所选前景与底色的 WCAG 对比度 ≥ 4.5（AA 正文）。
 */

/** 与 plan-form-dialog.tsx PRESET_COLORS 一致的色板（浅色回归色 + 预设色一并覆盖） */
const BADGE_BG_COLORS = [
  "#fef08a", // 浅黄（自由输入回归色）
  "#ffffff", // 纯白（白字完全不可见）
  "#10b981",
  "#8b5cf6", // 默认回退紫
  "#f59e0b",
  "#3b82f6",
  "#ef4444",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#64748b",
]

/** WCAG 相对亮度与对比度（与 badge.ts 同公式，独立复算作交叉验证） */
function luminance(hex: string): number {
  const ch = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * ch(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * ch(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * ch(parseInt(hex.slice(5, 7), 16))
  )
}

function contrast(hex: string, fg: string): number {
  const l1 = luminance(fg)
  const l2 = luminance(hex)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

describe("pickBadgeTextColor", () => {
  it("浅色底选黑字（白字不可读的回归场景）", () => {
    expect(pickBadgeTextColor("#fef08a")).toBe("#000000")
    expect(pickBadgeTextColor("#ffffff")).toBe("#000000")
  })
  it("深色底选白字", () => {
    expect(pickBadgeTextColor("#1f2a44")).toBe("#ffffff")
    expect(pickBadgeTextColor("#64748b")).toBe("#ffffff")
  })
  it("非法色回退默认紫后同样自适应", () => {
    expect(pickBadgeTextColor(normalizeBadgeColor("nope"))).toBe(
      pickBadgeTextColor("#8b5cf6")
    )
  })
  it("任意合法 hex 所选前景对比度 ≥ 4.5（AA）", () => {
    for (const c of BADGE_BG_COLORS) {
      expect(contrast(c, pickBadgeTextColor(c))).toBeGreaterThanOrEqual(4.5)
    }
  })
})
