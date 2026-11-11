/**
 * 自动创建发货的发货数默认值（纯函数，供 ship-auto-create-dialog 与单测共用）：
 * 发货台行内调整值优先，否则官方可发上限（可超备货数），缺上限回落备货数、再兜底 1。
 */
export function defaultDeliverNum(
  sku: { skuDeliveryQuantityMaxLimit: number | null; productSkuPurchaseQuantity: number | null },
  adjusted: number | undefined,
): number {
  return adjusted ?? sku.skuDeliveryQuantityMaxLimit ?? sku.productSkuPurchaseQuantity ?? 1
}
