/**
 * 发货单列表重查口径（纯函数，供 ship-panel 与单测共用）：
 * 1) shipListLoadOpts——进「发货单列表」视图拉实时单（fresh），视图内翻页/筛选/
 *    搜索/操作后 reloadTick、以及切店引起的 load 身份变化走本地重查（不打官方）；
 * 2) pickPrintLockedRows——「批量装箱/自动预约」遇未打印单直弹锁定确认后，
 *    用刷新返回的最新行按单号挑出目标单继续打开原弹窗（打印前快照 packageSns
 *    为空、deliverPackageNum 常为 0，会让箱数预填与比价 totalPackageNum 低估）。
 */

/** load 触发时的查询参数：null=本视图不需要列表数据；fresh=true 打官方实时核对 */
export function shipListLoadOpts(
  prevView: "staging" | "orders" | null,
  view: "staging" | "orders",
): { fresh: boolean } | null {
  if (view !== "orders") return null
  // 进入/切回本视图（含首次）拉实时单；视图内触发（身份变化）只查本地库
  return { fresh: prevView !== view }
}

/** 从刷新后的行里挑直弹续接单：须已锁定打印（isPrintBoxMark）且仍待装箱（status 0）；
 *  返回缺失单号（不在当前页 / 未锁定成功 / 已非待装箱）供调用方提示 */
export function pickPrintLockedRows<
  T extends { deliveryOrderSn: string; status: number; isPrintBoxMark: boolean | null },
>(rows: T[], sns: string[]): { rows: T[]; missingSns: string[] } {
  const want = new Set(sns)
  const picked = rows.filter(
    (r) => want.has(r.deliveryOrderSn) && r.status === 0 && r.isPrintBoxMark === true,
  )
  const got = new Set(picked.map((r) => r.deliveryOrderSn))
  return { rows: picked, missingSns: sns.filter((sn) => !got.has(sn)) }
}
