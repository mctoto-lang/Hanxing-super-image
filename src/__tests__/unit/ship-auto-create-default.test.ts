import { describe, expect, it } from "vitest"
import {
  defaultDeliverNum,
  expandGroupOutcome,
  isOfficiallyUndeliverable,
} from "@/components/temu/ship-auto-create-default"

describe("defaultDeliverNum（自动创建发货默认发货数）", () => {
  it("未手动调整：默认取官方可发上限（可超备货数，如 26/36 场景取 36）", () => {
    expect(
      defaultDeliverNum({ skuDeliveryQuantityMaxLimit: 36, productSkuPurchaseQuantity: 26 }, undefined),
    ).toBe(36)
  })

  it("发货台行内手动调整值优先于上限", () => {
    expect(
      defaultDeliverNum({ skuDeliveryQuantityMaxLimit: 36, productSkuPurchaseQuantity: 26 }, 10),
    ).toBe(10)
  })

  it("官方未返回上限：回落备货数", () => {
    expect(
      defaultDeliverNum({ skuDeliveryQuantityMaxLimit: null, productSkuPurchaseQuantity: 26 }, undefined),
    ).toBe(26)
  })

  it("上限与备货数均缺失：兜底 1", () => {
    expect(
      defaultDeliverNum({ skuDeliveryQuantityMaxLimit: null, productSkuPurchaseQuantity: null }, undefined),
    ).toBe(1)
  })

  it("口径锁定：官方上限为 0 时默认值就是 0（?? 不跳 0）——故必须靠 isOfficiallyUndeliverable 整单阻断，而非默认出 ≥1", () => {
    expect(
      defaultDeliverNum({ skuDeliveryQuantityMaxLimit: 0, productSkuPurchaseQuantity: 5 }, undefined),
    ).toBe(0)
  })
})

describe("isOfficiallyUndeliverable（官方可发上限 ≤0 → 整单阻断）", () => {
  it("上限 0 / 负数：官方判定不可发，阻断", () => {
    expect(
      isOfficiallyUndeliverable({ skuDeliveryQuantityMaxLimit: 0 }),
    ).toBe(true)
    expect(
      isOfficiallyUndeliverable({ skuDeliveryQuantityMaxLimit: -1 }),
    ).toBe(true)
  })

  it("上限 null（官方未返回）或正数：不阻断（null 回落备货数）", () => {
    expect(
      isOfficiallyUndeliverable({ skuDeliveryQuantityMaxLimit: null }),
    ).toBe(false)
    expect(
      isOfficiallyUndeliverable({ skuDeliveryQuantityMaxLimit: 3 }),
    ).toBe(false)
  })
})

describe("expandGroupOutcome（部分成功汇总分母按单计）", () => {
  it("组失败也逐单展开：A 组 10 单成功、B 组 5 单失败 → 分母 15，而非按组记 1 条的 11", () => {
    const okSns = Array.from({ length: 10 }, (_, i) => `A${i + 1}`)
    const failSns = ["B1", "B2", "B3", "B4", "B5"]
    const results = [
      ...expandGroupOutcome(okSns, true),
      ...expandGroupOutcome(failSns, false, "参数错误"),
    ]
    const okCount = results.filter((r) => r.ok).length
    expect(results.length).toBe(15)
    expect(okCount).toBe(10)
    // 失败明细逐单可见：每条 sn 都是单个单号，不再是一组单号的拼接
    for (const r of results.filter((x) => !x.ok)) {
      expect(failSns).toContain(r.sn)
      expect(r.msg).toBe("参数错误")
    }
  })
})
