import { describe, expect, it } from "vitest"
import { defaultPickup, type PickupSlot } from "@/components/temu/pickup-time-picker"

/** 构造槽位：bjDate=YYYY-MM-DD，窗口 start–end（HH:mm） */
const slot = (bjDate: string, start: string, end: string): PickupSlot => ({
  date: new Date(`${bjDate}T00:00`),
  bjDate,
  start,
  end,
})

describe("defaultPickup（预约取货时间 18 点默认规则）", () => {
  it("当前 <17 点：默认今日 18:00（窗口覆盖 18 时）", () => {
    const now = new Date("2026-11-11T10:00:00").getTime()
    const p = defaultPickup([slot("2026-11-11", "09:00", "19:00")], now)
    expect(p).not.toBeNull()
    expect(p!.date.getTime()).toBe(new Date("2026-11-11T00:00").getTime())
    expect(p!.hour).toBe("18")
    expect(p!.min).toBe("00")
  })

  it("当前 ≥17 点：默认次日 18:00（17:00 整归属次日）", () => {
    const now = new Date("2026-11-11T17:00:00").getTime()
    const p = defaultPickup(
      [slot("2026-11-11", "09:00", "19:00"), slot("2026-11-12", "09:00", "19:00")],
      now,
    )
    expect(p).not.toBeNull()
    expect(p!.date.getTime()).toBe(new Date("2026-11-12T00:00").getTime())
    expect(p!.hour).toBe("18")
  })

  it("16:59 仍属今日：默认今日 18:00", () => {
    const now = new Date("2026-11-11T16:59:00").getTime()
    const p = defaultPickup([slot("2026-11-11", "09:00", "19:00")], now)
    expect(p!.date.getTime()).toBe(new Date("2026-11-11T00:00").getTime())
    expect(p!.hour).toBe("18")
  })

  it("18 时超窗口上界：回落窗口内离 18 最近的小时（12 时）", () => {
    const now = new Date("2026-11-11T10:00:00").getTime()
    const p = defaultPickup([slot("2026-11-11", "09:00", "12:00")], now)
    expect(p!.hour).toBe("12")
    expect(p!.min).toBe("00")
  })

  it("18 时低于窗口下界：回落最近的小时（19 时）", () => {
    const now = new Date("2026-11-11T10:00:00").getTime()
    const p = defaultPickup([slot("2026-11-11", "19:00", "22:00")], now)
    expect(p!.hour).toBe("19")
  })

  it("目标日（次日）无槽位：回落最早未过期槽位的窗口开始", () => {
    const now = new Date("2026-11-11T18:00:00").getTime()
    const p = defaultPickup([slot("2026-11-13", "09:00", "19:00")], now)
    expect(p!.date.getTime()).toBe(new Date("2026-11-13T00:00").getTime())
    expect(p!.hour).toBe("09")
    expect(p!.min).toBe("00")
  })

  it("目标时刻已过期且无更晚槽位：返回 null（不预选）", () => {
    // now=16:30，今日窗口 9–12 → 最近小时 12 已过；今日槽位 end 12:00 亦过期
    const now = new Date("2026-11-11T16:30:00").getTime()
    const p = defaultPickup([slot("2026-11-11", "09:00", "12:00")], now)
    expect(p).toBeNull()
  })

  it("全部槽位过期：返回 null", () => {
    const now = new Date("2026-11-11T10:00:00").getTime()
    const p = defaultPickup([slot("2026-11-10", "09:00", "19:00")], now)
    expect(p).toBeNull()
  })

  it("回落路径窗口开始已过：抬到当前时刻 +1 分钟", () => {
    // ≥17 点 → 目标次日无槽位；回落今日槽位 9–19，开始 9:00 已过 → 18:01
    const now = new Date("2026-11-11T18:00:00").getTime()
    const p = defaultPickup([slot("2026-11-11", "09:00", "19:00")], now)
    expect(p!.hour).toBe("18")
    expect(p!.min).toBe("01")
  })
})
