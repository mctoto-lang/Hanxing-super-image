import { describe, it, expect } from "vitest"
import { previousPeriodRanges } from "@/server/services/temu-time"

/**
 * 上个自然周期区间（概览七日/30日卡环比基线）边界回归：
 * 北京时区日界 + ISO 周一为一周开始 + 月末/跨年回退。
 * 构造用例时直接给北京时间当天的绝对时间点，避免本地时区干扰。
 */

/** 北京时间某日某时刻的绝对时间（+08:00） */
const cst = (s: string) => new Date(s)

describe("previousPeriodRanges", () => {
  it("周一（2026-11-16）：上周 = 11-09~11-15，上月 = 10-01~10-31", () => {
    expect(previousPeriodRanges(cst("2026-11-16T10:00:00+08:00"))).toEqual({
      week: { start: "2026-11-09", end: "2026-11-15" },
      month: { start: "2026-10-01", end: "2026-10-31" },
    })
  })

  it("周三（2026-11-18）：仍属同一自然周，上周区间不变", () => {
    expect(previousPeriodRanges(cst("2026-11-18T23:59:59+08:00"))).toEqual({
      week: { start: "2026-11-09", end: "2026-11-15" },
      month: { start: "2026-10-01", end: "2026-10-31" },
    })
  })

  it("周日（2026-11-15）：本自然周最后一天，上周 = 11-02~11-08", () => {
    expect(previousPeriodRanges(cst("2026-11-15T08:00:00+08:00"))).toEqual({
      week: { start: "2026-11-02", end: "2026-11-08" },
      month: { start: "2026-10-01", end: "2026-10-31" },
    })
  })

  it("UTC 侧仍在周日（北京已周一凌晨）：按北京日界取周一 → 上周 11-09~11-15", () => {
    // 2026-11-15T17:00Z = 北京 2026-11-16 01:00（周一凌晨）
    expect(previousPeriodRanges(cst("2026-11-15T17:00:00Z"))).toEqual({
      week: { start: "2026-11-09", end: "2026-11-15" },
      month: { start: "2026-10-01", end: "2026-10-31" },
    })
  })

  it("月初（2026-12-01 周二）：上月 = 11-01~11-30，上周 = 11-23~11-29", () => {
    expect(previousPeriodRanges(cst("2026-12-01T09:30:00+08:00"))).toEqual({
      week: { start: "2026-11-23", end: "2026-11-29" },
      month: { start: "2026-11-01", end: "2026-11-30" },
    })
  })

  it("跨年（2027-01-01 周五）：上月 = 2026-12-01~12-31，上周 = 12-21~12-27", () => {
    expect(previousPeriodRanges(cst("2027-01-01T12:00:00+08:00"))).toEqual({
      week: { start: "2026-12-21", end: "2026-12-27" },
      month: { start: "2026-12-01", end: "2026-12-31" },
    })
  })

  it("月末（2026-11-30 周一）：上周 = 11-23~11-29，上月 = 10 月整月（90 天窗口内可达）", () => {
    expect(previousPeriodRanges(cst("2026-11-30T15:00:00+08:00"))).toEqual({
      week: { start: "2026-11-23", end: "2026-11-29" },
      month: { start: "2026-10-01", end: "2026-10-31" },
    })
  })
})
