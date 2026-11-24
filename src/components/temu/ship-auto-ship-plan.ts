/**
 * 自动发货预览计划（纯函数，供 ship-auto-ship-dialog 与单测共用）：
 * 按收货仓分组 / 未打印单的包裹推算 / 扣减后库存累计 / 切片与有界并发。
 */
import { packageTotals, splitPackages } from "./ship-package-split"

/** 计划所需的发货单字段（TemuShipOrderRow 的子集） */
export interface AutoShipPlanRow {
  deliveryOrderSn: string
  skcExtCode: string | null
  deliverSkcNum: number | null
  isPrintBoxMark: boolean | null
  /** 本地包表包裹号（打印商品打包标签前为空；服务端截断 10 个） */
  packageSns: string[]
  /** 官方应发包裹数（待装箱阶段常为 0） */
  deliverPackageNum: number | null
  /** 每 SKU 件数（raw.packageDetailList；缺货号的整单件数兜底用） */
  skuQtys: ReadonlyArray<{ productSkuId: number; skuNum: number | null }>
  subWarehouseId: number | null
  subWarehouseName: string | null
}

export interface WarehouseGroup<T> {
  /** 分组键（收货仓 id；缺失收货仓用哨兵） */
  key: string
  subWarehouseId: number | null
  name: string
  rows: T[]
}

/** 缺收货仓信息的单归入此组（缺收货地址无法比价发货，界面阻断） */
export const UNKNOWN_WAREHOUSE_KEY = "__unknown__"
export const UNKNOWN_WAREHOUSE_NAME = "未知收货仓"

/** 每单包裹数：官方应发包裹数 deliverPackageNum 优先（packageSns 服务端截断 10 个会低估；
 *  待装箱阶段官方字段常为 0，回落打印箱唛拆分出的包裹号数，最后兜底 1） */
export function packageCountOf(row: Pick<AutoShipPlanRow, "deliverPackageNum" | "packageSns">): number {
  return row.deliverPackageNum && row.deliverPackageNum > 0
    ? row.deliverPackageNum
    : row.packageSns.length > 0
      ? row.packageSns.length
      : 1
}

/** 统一取包裹数口径（比价 totalPackageNum / 发送 expressPackageNum / 界面组头与行内共用）：
 *  真实（官方包裹查询条数，>0 才算）→ 官方应发包裹数 / 本地包裹号（>0）→ 未打印按
 *  装箱数推算（planPackageTotals）→ 兜底整单一包。官方查询返回空数组（索引延迟）不置 0，
 *  刚打印的单回落推算值而非 1，保证报给官方的包裹数与界面展示一致 */
export function effectivePackageCount(
  row: Pick<
    AutoShipPlanRow,
    "deliverPackageNum" | "packageSns" | "skcExtCode" | "deliverSkcNum" | "skuQtys"
  >,
  liveCount: number | null | undefined,
  cartonQty: number | null | undefined,
): number {
  if (liveCount != null && liveCount > 0) return liveCount
  if (row.deliverPackageNum != null && row.deliverPackageNum > 0) return row.deliverPackageNum
  if (row.packageSns.length > 0) return row.packageSns.length
  const plan = planPackageTotals(row, cartonQty ?? null)
  return plan ? plan.length : 1
}

/** 按收货仓分组（保持首现顺序、组内原顺序；同仓单合并成一次发货） */
export function groupRowsByWarehouse<
  T extends Pick<AutoShipPlanRow, "deliveryOrderSn" | "subWarehouseId" | "subWarehouseName">,
>(rows: readonly T[]): WarehouseGroup<T>[] {
  const groups: WarehouseGroup<T>[] = []
  const byKey = new Map<string, WarehouseGroup<T>>()
  for (const r of rows) {
    const key = r.subWarehouseId != null ? String(r.subWarehouseId) : UNKNOWN_WAREHOUSE_KEY
    let g = byKey.get(key)
    if (!g) {
      g = {
        key,
        subWarehouseId: r.subWarehouseId,
        name:
          r.subWarehouseId != null
            ? (r.subWarehouseName ?? `收货仓${r.subWarehouseId}`)
            : UNKNOWN_WAREHOUSE_NAME,
        rows: [],
      }
      byKey.set(key, g)
      groups.push(g)
    }
    g.rows.push(r)
  }
  return groups
}

/** 未打印单的包裹推算：按库存档案装箱数 cartonQty 定长拆箱（无档案 / 非法 = 整单一包）。
 *  返回每包总件数序列（如 [10, 10, 5]）；超 10 包（官方上限）返回 null。
 *  已打印单不推算——包裹号与件数已由官方锁定，直接读包裹数据 */
export function planPackageTotals(
  row: Pick<AutoShipPlanRow, "deliverSkcNum" | "skuQtys">,
  cartonQty: number | null | undefined,
): number[] | null {
  const perSku: Record<number, number> = {}
  for (const s of row.skuQtys) {
    if (s.skuNum != null && s.skuNum > 0) perSku[s.productSkuId] = s.skuNum
  }
  // 无 SKU 明细（旧行 / 同步缺口）：按整单件数当作一个 SKU
  if (Object.keys(perSku).length === 0) perSku[0] = row.deliverSkcNum ?? 0
  const packages = splitPackages(perSku, cartonQty != null && cartonQty > 0 ? cartonQty : null)
  // 不经 packageTotals(null)→[] 的转换：null（超上限）必须原样透出给界面
  return packages ? packageTotals(packages) : null
}

export interface StockProjection {
  /** 本单扣减前库存（同货号前序单扣减后的余量） */
  before: number
  /** 本单扣减后库存（负数=不足） */
  after: number
  short: boolean
}

/** 扣减后库存预览：按显示顺序（组序 → 组内行序）对同货号累计扣减。
 *  未建档货号不参与库存联动，值为 null——getShipInventoryRefAction 对未建档货号同样
 *  返回行（totalQty=0、shipState=null），故以 shipState==null 判未建档（仅缺键不算），
 *  与服务端 assertShipmentStock「未建档货号跳过校验也不扣减」同口径。
 *  累计键用归一码 snKey（B049≡B49 命中同一档案；服务端按归一码合并需求量），缺失回落原串 */
export function projectStock<
  T extends Pick<AutoShipPlanRow, "deliveryOrderSn" | "skcExtCode" | "deliverSkcNum">,
>(
  rows: readonly T[],
  stockByCode: Readonly<
    Record<string, { totalQty: number; shipState?: "auto" | "manual" | null; snKey?: string } | undefined>
  >,
): Map<string, StockProjection | null> {
  const out = new Map<string, StockProjection | null>()
  const remainByKey = new Map<string, number>()
  for (const r of rows) {
    const code = r.skcExtCode
    const ref = code ? stockByCode[code] : undefined
    if (!code || !ref || ref.shipState == null) {
      out.set(r.deliveryOrderSn, null)
      continue
    }
    const accKey = ref.snKey ?? code
    const before = remainByKey.get(accKey) ?? ref.totalQty
    const after = before - (r.deliverSkcNum ?? 0)
    remainByKey.set(accKey, after)
    out.set(r.deliveryOrderSn, { before, after, short: after < 0 })
  }
  return out
}

/** 按固定大小切片（官方接口单次名单上限分批用） */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 有界并发执行（结果按下标回位；单项异常向上抛）；limit<1 兜底为 1（否则 0 个
 *  worker 会静默返回全空槽数组） */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}
