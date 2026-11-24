import { describe, expect, it } from "vitest"
import {
  pickLogisticsOption,
  pickPriorityLogisticsOption,
  type LogisticsOptionLike,
} from "@/components/temu/ship-logistics-select"

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

/**
 * 严格口径（自动发货）：剔除黑名单后必须命中「优先顺序」内公司，
 * 不回落平台常用 / 列表首个——保证自动发货只用企业明确配置过的公司。
 */
describe("pickPriorityLogisticsOption", () => {
  it("命中优先顺序：取名单中第一个本次可用的公司", () => {
    const r = pickPriorityLogisticsOption(
      [opt(1, "A"), opt(2, "B"), opt(3, "C")],
      [pref(3, "C"), pref(1, "A")],
      [],
    )
    expect(r.option?.expressCompanyId).toBe(3)
    expect(r.reason).toBe("priority")
  })

  it("优先名单内公司本次不可用：阻断（即使平台常用 / 列表首个可用也不回落）", () => {
    const list = [opt(1, "A"), opt(2, "B")]
    expect(pickPriorityLogisticsOption(list, [], [])).toEqual({
      option: null,
      reason: "no-priority",
    })
    expect(pickPriorityLogisticsOption(list, [pref(9, "X")], [])).toEqual({
      option: null,
      reason: "no-priority",
    })
  })

  it("优先名单内公司全被拉黑：剩余都是未配置公司 → 阻断而非选未配置公司", () => {
    const r = pickPriorityLogisticsOption(
      [opt(1, "A"), opt(2, "B")],
      [pref(1, "A")],
      [pref(1, "A")],
    )
    expect(r).toEqual({ option: null, reason: "no-priority" })
  })

  it("全部在黑名单 / 空列表：阻断", () => {
    expect(pickPriorityLogisticsOption([opt(1, "A")], [], [pref(1, "A")])).toEqual({
      option: null,
      reason: "all-blacklisted",
    })
    expect(pickPriorityLogisticsOption([], [pref(1, "A")], [])).toEqual({
      option: null,
      reason: "empty",
    })
  })
})
