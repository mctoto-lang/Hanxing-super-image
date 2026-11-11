import { describe, expect, it } from "vitest"
import { defaultDeliverNum } from "@/components/temu/ship-auto-create-default"

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
})
