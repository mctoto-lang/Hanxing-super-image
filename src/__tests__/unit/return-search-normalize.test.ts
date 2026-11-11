import { describe, expect, it } from "vitest"
import { normalizeSearchForSkuView } from "@/components/temu/return-search-normalize"

/**
 * 退供页视图切换搜索归一回归测试：
 * 退供包裹 → SKU 明细视图无运单号字段。曾把运单号关键词原样改作采购子单号
 * 过滤（field 归一为 sub 但保留关键词），SF 开头快递单号按采购子单号查几乎
 * 必然 0 行且无提示。已拍板口径：切 SKU 视图时 express 字段归一到 sub 并清空
 * 关键词；sub/pkg 两视图通用，关键词原样保留。
 */
describe("normalizeSearchForSkuView（切 SKU 视图搜索归一）", () => {
  it("运单号字段：归一到采购子单号并清空关键词（不再被当作采购子单号查询）", () => {
    expect(normalizeSearchForSkuView({ field: "express", keyword: "SF123456789" })).toEqual({
      field: "sub",
      keyword: "",
    })
  })

  it("运单号字段且关键词本为空：仅归一字段", () => {
    expect(normalizeSearchForSkuView({ field: "express", keyword: "" })).toEqual({
      field: "sub",
      keyword: "",
    })
  })

  it("采购子单号字段：两视图通用，关键词原样保留", () => {
    expect(normalizeSearchForSkuView({ field: "sub", keyword: "PO-123,PO-456" })).toEqual({
      field: "sub",
      keyword: "PO-123,PO-456",
    })
  })

  it("退供包裹号字段：两视图通用，关键词原样保留", () => {
    expect(normalizeSearchForSkuView({ field: "pkg", keyword: "RSP001" })).toEqual({
      field: "pkg",
      keyword: "RSP001",
    })
  })
})
