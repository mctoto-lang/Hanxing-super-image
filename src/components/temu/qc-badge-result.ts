/**
 * 质检列表行「质检结果」徽章值（纯函数，供 quality-panel 与单测共用）：
 * 官方列表接口不回每行结果值（skuQcResult 只是入参）——行值优先透传，
 * 否则按「该批数据落地时实际使用的筛选」（loadedFilter）推导；「全部结果」
 * 下行内无值则空占位。必须用 loadedFilter 而非当前选中的 filter：切换筛选后、
 * 新响应返回前，旧数据行若按新选中筛选推导会短暂错标合格/不合格。
 */
export function qcBadgeResult(
  skuQcResult: number | null,
  loadedFilter: "1" | "2" | "all",
): number | null {
  return skuQcResult ?? (loadedFilter === "all" ? null : Number(loadedFilter))
}
