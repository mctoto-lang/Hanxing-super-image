import { describe, it, expect } from "vitest"
import { formatCnDateTime } from "@/lib/datetime"

/** 中文全格式（TEMU 概览时间框/同步时间弹窗）：YYYY年MM月DD日HH时mm分ss秒，补零 */
describe("formatCnDateTime", () => {
  it("补零完整格式（2026-09-09 16:15:23）", () => {
    expect(formatCnDateTime(new Date(2026, 8, 9, 16, 15, 23))).toBe(
      "2026年09月09日16时15分23秒",
    )
  })

  it("两位月日时分秒不变形", () => {
    expect(formatCnDateTime(new Date(2026, 11, 31, 23, 59, 59))).toBe(
      "2026年12月31日23时59分59秒",
    )
  })

  it("空值/无效输入返回 —（与 formatDateTime 口径一致）", () => {
    expect(formatCnDateTime(null)).toBe("—")
    expect(formatCnDateTime(undefined)).toBe("—")
    expect(formatCnDateTime("not-a-date")).toBe("—")
  })

  it("epoch 毫秒数字入参（秒级自适应沿用 formatDateTime）", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5)
    expect(formatCnDateTime(d.getTime())).toBe("2026年01月02日03时04分05秒")
  })
})
