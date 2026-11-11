/**
 * 退供页切到 SKU 明细视图时搜索条件的归一（纯函数，供 return-panel 与单测共用）：
 * SKU 视图无运单号字段——运单号关键词若原样改作采购子单号过滤几乎必然查空且无提示，
 * 故归一到采购子单号字段并清空关键词；sub/pkg 两视图通用，原样保留（含关键词）。
 */
export function normalizeSearchForSkuView(d: { field: string; keyword: string }): {
  field: string
  keyword: string
} {
  return d.field === "express" ? { field: "sub", keyword: "" } : d
}
