/**
 * 定长拆箱（纯函数，自动创建发货 / 自动发货预览 / 单测共用）：
 * 每包件数 per → 前包满装、尾包裹余数（每 SKU 合计 = 发货数；多 SKU 第 i 箱合并为第 i 包）；
 * per 非法 / <=0 / null 视为整单一包；单包裹数 >10（官方上限）返回 null（调用方阻断）。
 */

/** 包裹内 SKU 件数：productSkuId → skuNum */
export type PackageSplit = Record<number, number>

/** 单张发货单包裹数上限（官方 bg.shiporderv3.create packageInfos） */
export const MAX_PACKAGES_PER_ORDER = 10

export function splitPackages(
  deliverNums: Record<number, number>,
  per: number | null,
): PackageSplit[] | null {
  if (per == null || per < 1) return [{ ...deliverNums }]
  let boxCount = 1
  for (const n of Object.values(deliverNums)) {
    const need = Math.ceil(n / per)
    if (need > boxCount) boxCount = need
  }
  if (boxCount > MAX_PACKAGES_PER_ORDER) return null
  const packages: PackageSplit[] = []
  for (let i = 0; i < boxCount; i++) packages.push({})
  for (const [idStr, n] of Object.entries(deliverNums)) {
    const id = Number(idStr)
    let left = n
    let i = 0
    while (left > 0) {
      const put = Math.min(per, left)
      packages[i]![id] = put
      left -= put
      i++
    }
  }
  return packages
}

/** 「每包件数」输入值 → 每包件数：空串 / 非法 / <1 视为 null（整单一包）；小数向下取整
 *  （与输入框失焦回写的 floor 口径一致） */
export function parsePerPackage(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

/** 拆包结果的「每包总件数」序列（展示用，如 10 · 10 · 5）；null（超上限）返回空数组 */
export function packageTotals(packages: PackageSplit[] | null): number[] {
  if (!packages) return []
  return packages.map((p) => Object.values(p).reduce((a, n) => a + n, 0))
}
