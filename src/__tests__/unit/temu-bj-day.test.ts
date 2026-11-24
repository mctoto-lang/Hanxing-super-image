import { describe, expect, it } from "vitest"
import {
  bjDayRangeToInclusiveMs,
  bjDayRangeToMs,
  bjToday,
  isBjDayString,
  lastDaysRange,
  localAddDays,
  localDaySpan,
  localDayString,
  localLastDays,
  toBjDay,
} from "@/lib/temu-bj-day"

describe("toBjDay / bjToday（北京日界）", () => {
  it("按 Asia/Shanghai 取日期串，与 UTC 日界无关", () => {
    // UTC 17:00 = 北京次日 01:00；UTC 15:59:59 = 北京当日 23:59:59
    expect(toBjDay(new Date("2026-11-22T17:00:00Z"))).toBe("2026-11-23")
    expect(toBjDay(new Date("2026-11-22T15:59:59Z"))).toBe("2026-11-22")
  })

  it("bjToday 返回北京今日 00:00（+08:00）", () => {
    const t = bjToday()
    expect(toBjDay(t)).toBe(toBjDay(new Date()))
    expect(t.toISOString().endsWith("T16:00:00.000Z")).toBe(true)
  })
})

describe("lastDaysRange（近 n 天含今天）", () => {
  it("近 7 天：from = 6 天前、to = 今天", () => {
    const r = lastDaysRange(7)
    expect(r.to.getTime() - r.from.getTime()).toBe(6 * 86_400_000)
    expect(toBjDay(r.to)).toBe(toBjDay(new Date()))
  })

  it("n ≤ 1 或非整数按 1 天处理", () => {
    expect(lastDaysRange(1).from.getTime()).toBe(lastDaysRange(1).to.getTime())
    expect(lastDaysRange(0).from.getTime()).toBe(lastDaysRange(0).to.getTime())
    expect(lastDaysRange(7.9).to.getTime() - lastDaysRange(7.9).from.getTime()).toBe(6 * 86_400_000)
  })
})

describe("bjDayRangeToMs（起止日期 → 半开毫秒区间）", () => {
  it("start = 起始日北京 00:00，end = 结束日次日北京 00:00", () => {
    const r = bjDayRangeToMs("2026-11-17", "2026-11-23")
    expect(r).toEqual({
      start: Date.parse("2026-11-17T00:00:00+08:00"),
      end: Date.parse("2026-11-24T00:00:00+08:00"),
    })
    // 两端含共 7 天
    expect((r!.end - r!.start) / 86_400_000).toBe(7)
  })

  it("单日区间跨度为 1 天；跨月正常进位", () => {
    expect((bjDayRangeToMs("2026-11-23", "2026-11-23")!.end - bjDayRangeToMs("2026-11-23", "2026-11-23")!.start) / 86_400_000).toBe(1)
    expect(bjDayRangeToMs("2026-10-31", "2026-10-31")!.end).toBe(Date.parse("2026-11-01T00:00:00+08:00"))
  })

  it("非法日期串返回 null", () => {
    expect(bjDayRangeToMs("2026-13-01", "2026-11-23")).toBeNull()
    expect(bjDayRangeToMs("2026-11-17", "not-a-date")).toBeNull()
  })
})

describe("isBjDayString（YYYY-MM-DD 且为真实日历日）", () => {
  it("接受真实日期", () => {
    expect(isBjDayString("2026-11-23")).toBe(true)
    expect(isBjDayString("2024-02-29")).toBe(true)
  })

  it("拒绝格式错误与不存在的日期", () => {
    expect(isBjDayString("2026-11-2")).toBe(false)
    expect(isBjDayString("2026/11/23")).toBe(false)
    expect(isBjDayString("2026-02-31")).toBe(false)
    expect(isBjDayString("2023-02-29")).toBe(false)
  })
})

describe("bjDayRangeToInclusiveMs（两端含端点）", () => {
  it("start = 起始日北京 00:00，end = 结束日次日北京 00:00 前 1ms", () => {
    expect(bjDayRangeToInclusiveMs("2026-11-17", "2026-11-23")).toEqual({
      start: Date.parse("2026-11-17T00:00:00+08:00"),
      end: Date.parse("2026-11-24T00:00:00+08:00") - 1,
    })
    expect(bjDayRangeToInclusiveMs("bad", "2026-11-23")).toBeNull()
  })
})

describe("浏览器本地日历工具（日历回传与 SKU 明细 31 天截断用）", () => {
  // 用本地时间构造 Date，断与时区无关
  const at = (y: number, m: number, d: number, h = 15, min = 42) => new Date(y, m - 1, d, h, min)

  it("localDayString：取本地日历日期串（带时分秒也只回日期）", () => {
    expect(localDayString(at(2026, 11, 23))).toBe("2026-11-23")
    expect(localDayString(at(2026, 1, 5, 0, 0))).toBe("2026-01-05")
  })

  it("localLastDays：近 n 天含今天，起止均为本地 00:00", () => {
    const r = localLastDays(at(2026, 11, 23), 7)
    expect(localDayString(r.to)).toBe("2026-11-23")
    expect(localDayString(r.from)).toBe("2026-11-17")
    expect(r.from.getHours()).toBe(0)
    expect(r.to.getHours()).toBe(0)
    expect(localLastDays(at(2026, 11, 23), 0).from.getTime()).toBe(localLastDays(at(2026, 11, 23), 0).to.getTime())
  })

  it("localDaySpan：两端含的天数，跨月跨年正确", () => {
    expect(localDaySpan(at(2026, 11, 23), at(2026, 11, 23))).toBe(1)
    expect(localDaySpan(at(2026, 10, 1), at(2026, 10, 31))).toBe(31)
    expect(localDaySpan(at(2026, 10, 1), at(2026, 11, 1))).toBe(32)
    expect(localDaySpan(at(2025, 12, 20), at(2026, 1, 10))).toBe(22)
  })

  it("localAddDays：截到第 31 天（起始日 + 30 天），跨月正确", () => {
    expect(localDayString(localAddDays(at(2026, 10, 1, 9, 30), 30))).toBe("2026-10-31")
    expect(localDaySpan(at(2026, 10, 1), localAddDays(at(2026, 10, 1), 30))).toBe(31)
    expect(localDayString(localAddDays(at(2026, 12, 20), 14))).toBe("2027-01-03")
  })
})
