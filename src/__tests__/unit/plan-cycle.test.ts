import { describe, it, expect } from "vitest"
import { computeDuePeriods, nextGrantAt } from "@/lib/plans/cycle"

/**
 * 订阅周期发放计算单测（纯函数，无 DB）。
 *
 * 语义要点：
 *   - 周期窗口从 startsAt 按 cycleDays 滚动切分；
 *   - periodStart <= now 的周期视为已到期应发放；
 *   - 最后一期 periodEnd 被 expiresAt 截断（额度仍按整期）；
 *   - lastGrantPeriodEnd 为锚点（null = 首期未发），跨期补发返回多窗口。
 */

const DAY = 24 * 60 * 60 * 1000
const d = (base: Date, days: number) => new Date(base.getTime() + days * DAY)

describe("computeDuePeriods", () => {
  const startsAt = new Date("2026-01-01T00:00:00Z")

  it("首期未发：now 到达 startsAt 后返回首期窗口", () => {
    const due = computeDuePeriods(
      { startsAt, expiresAt: d(startsAt, 90), lastGrantPeriodEnd: null, cycleDays: 30 },
      d(startsAt, 1),
    )
    expect(due).toHaveLength(1)
    expect(due[0]!.periodStart.getTime()).toBe(startsAt.getTime())
    expect(due[0]!.periodEnd.getTime()).toBe(d(startsAt, 30).getTime())
  })

  it("首期未发且 now 早于 startsAt：不发放", () => {
    const due = computeDuePeriods(
      { startsAt, expiresAt: d(startsAt, 90), lastGrantPeriodEnd: null, cycleDays: 30 },
      d(startsAt, -1),
    )
    expect(due).toHaveLength(0)
  })

  it("本期已发（now < 锚点）：不发放", () => {
    const due = computeDuePeriods(
      { startsAt, expiresAt: d(startsAt, 90), lastGrantPeriodEnd: d(startsAt, 30), cycleDays: 30 },
      d(startsAt, 29),
    )
    expect(due).toHaveLength(0)
  })

  it("周期边界：now 恰好等于下一周期起点时发放", () => {
    const due = computeDuePeriods(
      { startsAt, expiresAt: d(startsAt, 90), lastGrantPeriodEnd: d(startsAt, 30), cycleDays: 30 },
      d(startsAt, 30),
    )
    expect(due).toHaveLength(1)
    expect(due[0]!.periodStart.getTime()).toBe(d(startsAt, 30).getTime())
    expect(due[0]!.periodEnd.getTime()).toBe(d(startsAt, 60).getTime())
  })

  it("末期被 expiresAt 截断：periodEnd = expiresAt", () => {
    // 到期日 45 天：第二期 [30, 60) 被截为 [30, 45)
    const due = computeDuePeriods(
      { startsAt, expiresAt: d(startsAt, 45), lastGrantPeriodEnd: d(startsAt, 30), cycleDays: 30 },
      d(startsAt, 31),
    )
    expect(due).toHaveLength(1)
    expect(due[0]!.periodEnd.getTime()).toBe(d(startsAt, 45).getTime())
  })

  it("worker 停机跨期：按锚点逐期补发多个窗口", () => {
    // 已发到 [0,30)，now = 95 天，到期 120 天 → 补发 [30,60) [60,90) [90,120截断)
    const due = computeDuePeriods(
      { startsAt, expiresAt: d(startsAt, 120), lastGrantPeriodEnd: d(startsAt, 30), cycleDays: 30 },
      d(startsAt, 95),
    )
    expect(due).toHaveLength(3)
    expect(due[0]!.periodStart.getTime()).toBe(d(startsAt, 30).getTime())
    expect(due[1]!.periodStart.getTime()).toBe(d(startsAt, 60).getTime())
    expect(due[2]!.periodStart.getTime()).toBe(d(startsAt, 90).getTime())
    expect(due[2]!.periodEnd.getTime()).toBe(d(startsAt, 120).getTime())
  })

  it("已到期：锚点之后不再有 periodStart < expiresAt 的窗口", () => {
    // 到期 60 天，已发到 60；now 任意晚 → 无可发窗口
    const due = computeDuePeriods(
      { startsAt, expiresAt: d(startsAt, 60), lastGrantPeriodEnd: d(startsAt, 60), cycleDays: 30 },
      d(startsAt, 200),
    )
    expect(due).toHaveLength(0)
  })

  it("到期后才处理末期（迟到发放）：periodStart < expiresAt 仍可补发", () => {
    // 到期 45 天，已发到 30；now = 100（已过期），末期 [30,45) 属应得权益
    const due = computeDuePeriods(
      { startsAt, expiresAt: d(startsAt, 45), lastGrantPeriodEnd: d(startsAt, 30), cycleDays: 30 },
      d(startsAt, 100),
    )
    expect(due).toHaveLength(1)
    expect(due[0]!.periodStart.getTime()).toBe(d(startsAt, 30).getTime())
    expect(due[0]!.periodEnd.getTime()).toBe(d(startsAt, 45).getTime())
  })

  it("cycleDays 非法（<=0）：返回空", () => {
    const due = computeDuePeriods(
      { startsAt, expiresAt: d(startsAt, 90), lastGrantPeriodEnd: null, cycleDays: 0 },
      d(startsAt, 10),
    )
    expect(due).toHaveLength(0)
  })
})

describe("nextGrantAt", () => {
  const startsAt = new Date("2026-01-01T00:00:00Z")

  it("未过期：锚点 + cycleDays，且不超过 expiresAt", () => {
    const next = nextGrantAt(
      { startsAt, expiresAt: d(startsAt, 90), lastGrantPeriodEnd: d(startsAt, 30), cycleDays: 30 },
      d(startsAt, 10),
    )
    expect(next?.getTime()).toBe(d(startsAt, 60).getTime())
  })

  it("下一期起点超过 expiresAt（末期已发完）：返回 null", () => {
    const next = nextGrantAt(
      { startsAt, expiresAt: d(startsAt, 45), lastGrantPeriodEnd: d(startsAt, 30), cycleDays: 30 },
      d(startsAt, 10),
    )
    expect(next).toBeNull()
  })

  it("已到期：返回 null", () => {
    const next = nextGrantAt(
      { startsAt, expiresAt: d(startsAt, 45), lastGrantPeriodEnd: d(startsAt, 30), cycleDays: 30 },
      d(startsAt, 100),
    )
    expect(next).toBeNull()
  })

  it("首期未发：下次发放即 startsAt（已过则也返回该时刻）", () => {
    const next = nextGrantAt(
      { startsAt, expiresAt: d(startsAt, 90), lastGrantPeriodEnd: null, cycleDays: 30 },
      d(startsAt, 10),
    )
    expect(next?.getTime()).toBe(d(startsAt, 30).getTime())
  })
})
