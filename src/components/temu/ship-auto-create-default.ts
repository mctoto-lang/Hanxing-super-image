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

/**
 * 官方明确返回可发上限 ≤0（含 0：官方判定「不可发」）：
 * 该 SKU 所在单整单阻断、不参与创建——deliverSkuNum schema min(1)，0 件只会换来
 * 无字段的「参数错误」；上限 null（官方未返回）不算，仍回落备货数。
 */
export function isOfficiallyUndeliverable(
  sku: { skuDeliveryQuantityMaxLimit: number | null },
): boolean {
  return sku.skuDeliveryQuantityMaxLimit != null && sku.skuDeliveryQuantityMaxLimit <= 0
}

/**
 * 组级创建结果展开为逐单结果（成功/失败统一按「单」计）：
 * 创建按收货仓分组调用，失败只回组级 error——逐单展开保证「部分成功 x/y」的
 * 分母 y 与成功侧同为张数口径、失败单号逐单可见。
 */
export function expandGroupOutcome(
  sns: string[],
  ok: boolean,
  msg?: string,
): Array<{ sn: string; ok: boolean; msg?: string }> {
  return sns.map((sn) => ({ sn, ok, msg }))
}
