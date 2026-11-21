import { describe, expect, it, vi } from "vitest"
import { toAdProductIdList } from "@/lib/temu-api/ad-params"

/**
 * 广告组 productIdList 净化（官方 LIST<INTEGER>，非数字/形变整批报 230012000
 * ——2026-11-19 生产 MISS FIREE 案）。
 */

describe("toAdProductIdList", () => {
  it("纯数字字符串转 number 透传", () => {
    expect(toAdProductIdList(["7001", "42639544711"], false)).toEqual([7001, 42639544711])
  })

  it("剔除非数字 ID（空串/字母/科学计数法）并 warn 一次", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(toAdProductIdList(["7001", "", "DP-001", "1e3"], false)).toEqual([7001])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain("DP-001")
    } finally {
      warn.mockRestore()
    }
  })

  it("剔除形变 ID：前导零 / 超安全整数精度", () => {
    // "0123" → Number=123 回验不一致；16 位超 Number.MAX_SAFE_INTEGER 精度丢失
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(toAdProductIdList(["0123", "9007199254740993"], false)).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it("全部被剔除时返回空数组（调用方自然跳过 API 分批）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(toAdProductIdList(["DP-A", "DP-B"], false)).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it("演示层原样透传字符串 DPID（demo 拦截按请求 productIdList 回数据）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(toAdProductIdList(["DP-001", "7001", "1e3"], true)).toEqual(["DP-001", "7001", "1e3"])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
