import { describe, expect, it } from "vitest"
import { pickLogisticsOption, type LogisticsOptionLike } from "@/components/temu/ship-logistics-select"

/**
 * 物流公司自动选择（自动预约发货 / 更换物流弹窗共用）：
 * 黑名单剔除 → 优先顺序第一个可用 → 平台常用回落 → 比价首项兜底。
 */

const opt = (id: number, name: string): LogisticsOptionLike & { id: number } => ({
  id,
  expressCompanyId: id,
  expressCompanyName: name,
})

const pref = (id: number, name: string) => ({ expressCompanyId: id, expressCompanyName: name })

describe("pickLogisticsOption", () => {
  it("优先顺序命中：取名单中第一个本次比价可用的公司（顺序优先）", () => {
    const r = pickLogisticsOption(
      [opt(1, "A"), opt(2, "B"), opt(3, "C")],
      [pref(3, "C"), pref(1, "A")],
      [],
      null,
    )
    expect(r.option?.expressCompanyId).toBe(3)
    expect(r.reason).toBe("priority")
  })

  it("黑名单剔除：优先名单全被拉黑时按剩余候选回落", () => {
    const r = pickLogisticsOption(
      [opt(1, "A"), opt(2, "B")],
      [pref(1, "A")],
      [pref(1, "A")],
      null,
    )
    expect(r.option?.expressCompanyId).toBe(2)
    expect(r.reason).toBe("first")
  })

  it("平台常用回落：优先名单不可用时选 mostUsed", () => {
    const r = pickLogisticsOption(
      [opt(1, "A"), opt(2, "B")],
      [pref(9, "X")],
      [],
      { expressCompanyId: 2 },
    )
    expect(r.option?.expressCompanyId).toBe(2)
    expect(r.reason).toBe("most-used")
  })

  it("首项兜底：优先名单与常用均不可用，取比价列表首个公司", () => {
    const r = pickLogisticsOption(
      [opt(1, "A"), opt(2, "B")],
      [pref(9, "X")],
      [],
      { expressCompanyId: 8 },
    )
    expect(r.option?.expressCompanyId).toBe(1)
    expect(r.reason).toBe("first")
  })

  it("全部在黑名单 / 空列表：不选择", () => {
    expect(
      pickLogisticsOption([opt(1, "A")], [], [pref(1, "A")], null),
    ).toEqual({ option: null, reason: "all-blacklisted" })
    expect(pickLogisticsOption([], [pref(1, "A")], [], null)).toEqual({
      option: null,
      reason: "empty",
    })
  })

  it("expressCompanyId 缺失项不参与自动选择", () => {
    const r = pickLogisticsOption(
      [{ expressCompanyId: null, expressCompanyName: "未知" }, opt(5, "E")],
      [],
      [],
      null,
    )
    expect(r.option?.expressCompanyId).toBe(5)
  })
})
