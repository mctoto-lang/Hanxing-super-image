import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  inventoryMovementTypeEnum,
  inventoryMovements,
  inventorySettings,
  inventoryStocks,
  temuSalesOverviews,
  temuStores,
} from "@/db/schema"
import { requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import { MODULE_LABELS } from "@/lib/modules"
import { temuDayStr } from "@/server/services/temu-time"

/**
 * 库存变动统一入口（事务核心，非 action；库存域与 TEMU 联动共用）
 *
 * 所有库存变动必须走 applyMovements：同事务内「行锁读当前量 → 更新库存明细 →
 * 写变动流水（含前/后值）」。流水不可删改，错账用反向流水冲正。
 * 并发安全：SELECT ... FOR UPDATE 行锁，两笔并发扣减不会双花。
 */

/** 库存域守卫结果：企业上下文 + inventory 模块权限（可看即可用口径） */
export type InventoryGuard =
  | { ok: true; ctx: UserContext; enterpriseId: string }
  | { ok: false; error: string }

/** 库存域守卫：企业上下文 + inventory 模块权限（各 action 文件共用） */
export async function requireInventory(): Promise<InventoryGuard> {
  let ctx: UserContext
  try {
    ctx = await requireEnterpriseContext()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "登录状态失效" }
  }
  if (!ctx.canAccess("inventory")) {
    return {
      ok: false,
      error: `当前账号没有「${MODULE_LABELS.inventory}」页面权限，无法执行该操作`,
    }
  }
  const enterpriseId = ctx.user.enterpriseId
  if (!enterpriseId) return { ok: false, error: "当前用户无企业归属" }
  return { ok: true, ctx, enterpriseId }
}

export type InventoryTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/* ─── 销速口径（六态状态/补货建议共用）─── */

/** 补货阈值兜底值（inventory_settings 无行时使用；总览页可配置） */
export const DEFAULT_RESTOCK_THRESHOLD_DAYS = 14

/** 补货阈值（inventory_settings 按企业读；无行回落默认值。总览/预警/分析共用） */
export async function getRestockThresholdDays(enterpriseId: string): Promise<number> {
  const [row] = await db
    .select({ days: inventorySettings.restockThresholdDays })
    .from(inventorySettings)
    .where(eq(inventorySettings.enterpriseId, enterpriseId))
    .limit(1)
  return row?.days ?? DEFAULT_RESTOCK_THRESHOLD_DAYS
}

/**
 * 货号归一化 key：把首个数字串的前导零去掉（B049≡B49≡B007，早期货号补零差异），
 * 保留字母前缀与其余部分（B9001 与 D9001 是不同货号，不能并）。
 * 用于 TEMU productSn/skcExtCode ↔ 档案 productCode 匹配
 * （销速聚合/装箱扣减/参考查询），展示一律用原串。
 */
export function normalizeSn(sn: string): string {
  return sn.trim().replace(/[0-9]+/, (m) => String(Number(m)))
}

export type DailySalesLoad = {
  /** 近 7 天销量合计（按归一化货号，跨店合并） */
  sum7Map: Map<string, number>
  /** 近 30 天销量合计（按归一化货号） */
  sum30Map: Map<string, number>
  /** 近 7/30 天内有数据的天集合（求均用，多店不虚增） */
  days7Set: Set<string>
  days30Set: Set<string>
}

/** 北京日界日期串回退 n 天（YYYY-MM-DD 字符串日期直接构造） */
function bjDayMinus(dayStr: string, days: number): string {
  const d = new Date(`${dayStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

/**
 * 销速底座（数据源 = temu_sales_overview，productSn 按归一化 key 聚合）：
 * 近 7 天与近 30 天两窗合计 + 全局有数据天集。企业无店铺时返回空集合（=无销速）。
 * 窗口端点按北京日界精确构造（7/30 天窗含今日：bjToday−6 / bjToday−29），
 * 与 capturedDay（北京时间数据日）同口径，不随数据库会话时区漂移。
 */
export async function loadDailySalesBySn(enterpriseId: string): Promise<DailySalesLoad> {
  const since7 = bjDayMinus(temuDayStr(), 6)
  const since30 = bjDayMinus(temuDayStr(), 29)
  const storeRows = await db
    .select({ id: temuStores.id })
    .from(temuStores)
    .where(eq(temuStores.enterpriseId, enterpriseId))
  if (storeRows.length === 0) {
    return { sum7Map: new Map(), sum30Map: new Map(), days7Set: new Set(), days30Set: new Set() }
  }
  const rows = await db
    .select({
      productSn: temuSalesOverviews.productSn,
      capturedDay: temuSalesOverviews.capturedDay,
      qty: sql<number>`coalesce(sum(coalesce(${temuSalesOverviews.todaySalesVolume}, 0)), 0)::int`,
    })
    .from(temuSalesOverviews)
    .where(
      and(
        inArray(temuSalesOverviews.storeId, storeRows.map((s) => s.id)),
        gte(temuSalesOverviews.capturedDay, since30),
        sql`${temuSalesOverviews.productSn} is not null`,
      ),
    )
    .groupBy(temuSalesOverviews.productSn, temuSalesOverviews.capturedDay)

  const sum7Map = new Map<string, number>()
  const sum30Map = new Map<string, number>()
  const days7Set = new Set<string>()
  const days30Set = new Set<string>()
  for (const r of rows) {
    const key = normalizeSn(r.productSn!)
    const day = String(r.capturedDay)
    if (day >= since7) {
      sum7Map.set(key, (sum7Map.get(key) ?? 0) + r.qty)
      days7Set.add(day)
    }
    if (day >= since30) {
      sum30Map.set(key, (sum30Map.get(key) ?? 0) + r.qty)
      days30Set.add(day)
    }
  }
  return { sum7Map, sum30Map, days7Set, days30Set }
}

/**
 * 加权日销 = 0.7×近7天均 + 0.3×近30天均（保留 1 位小数；无销速数据返回 0）。
 * 近期趋势权重高、30 天窗平滑单日波动。
 */
export function blendedDailySales(load: DailySalesLoad, productCode: string): number {
  const key = normalizeSn(productCode)
  const q7 = load.sum7Map.get(key)
  const q30 = load.sum30Map.get(key)
  if (q7 == null && q30 == null) return 0
  const rate =
    0.7 * ((q7 ?? 0) / Math.max(1, load.days7Set.size)) +
    0.3 * ((q30 ?? 0) / Math.max(1, load.days30Set.size))
  return Math.round(rate * 10) / 10
}

/** 有销速数据（30 天内存在销售行）。滞销口径=有数据但加权日销 0；
 *  无数据（未铺货/新品）不算滞销，保持正常态。 */
export function hasSalesDataOf(load: DailySalesLoad, productCode: string): boolean {
  return load.sum30Map.has(normalizeSn(productCode))
}

/**
 * TEMU 净库存（按归一化货号）：每 (店,SKC) 取最新日行，净额 = 仓内库存 − 待发货库存
 * （待发货无参考价值：TEMU 自动创建备货单会推高该值），跨店跨 SKC 求和。
 * 列 0089 起 syncing，历史行无待发货值视作 0；净额为负（备货单噪声）按 0 计。
 * 只扫近 90 天（北京日界）：超窗未同步的 SKC 本就视为 0（消费方 map.get(...) ?? 0），
 * 避免随表增长全表 selectDistinctOn 线性劣化。
 */
export async function loadTemuNetStockBySn(enterpriseId: string): Promise<Map<string, number>> {
  const storeRows = await db
    .select({ id: temuStores.id })
    .from(temuStores)
    .where(eq(temuStores.enterpriseId, enterpriseId))
  if (storeRows.length === 0) return new Map()
  const latest = await db
    .selectDistinctOn(
      [temuSalesOverviews.storeId, temuSalesOverviews.skcId],
      {
        productSn: temuSalesOverviews.productSn,
        warehouse: temuSalesOverviews.warehouseAvailableStock,
        waitDelivery: temuSalesOverviews.waitDeliveryStock,
      },
    )
    .from(temuSalesOverviews)
    .where(
      and(
        inArray(temuSalesOverviews.storeId, storeRows.map((s) => s.id)),
        gte(temuSalesOverviews.capturedDay, bjDayMinus(temuDayStr(), 90)),
        sql`${temuSalesOverviews.productSn} is not null`,
      ),
    )
    .orderBy(
      temuSalesOverviews.storeId,
      temuSalesOverviews.skcId,
      desc(temuSalesOverviews.capturedDay),
      desc(temuSalesOverviews.capturedAt),
    )

  const map = new Map<string, number>()
  for (const r of latest) {
    const net = Math.max(0, (r.warehouse ?? 0) - (r.waitDelivery ?? 0))
    if (net <= 0) continue
    const key = normalizeSn(r.productSn!)
    map.set(key, (map.get(key) ?? 0) + net)
  }
  return map
}

/* ─── 六态库存状态 ─── */

/** 六态：正常/补货/缺货/滞销/停产/清仓（详见 deriveStockStatus） */
export type StockStatus =
  | "normal"
  | "restock"
  | "out_of_stock"
  | "stagnant"
  | "discontinued"
  | "clearance"

/**
 * 六态推导（可售天数 = (仓库库存+TEMU净库存+在产余量) ÷ 加权日销）：
 * - 停止生产分支优先：库存0=停产（discontinued）、有库存=清仓（clearance）
 * - 持续生产：库存0=缺货；日销>0 且 可售天数<阈值=补货（restock）；
 *   有销量数据但日销=0（近30天零销量）且有库存=滞销（stagnant）；
 *   无销速数据（未铺货/新品）=正常
 */
export function deriveStockStatus(args: {
  productionState: "active" | "stopped"
  /** 自有仓库存合计 */
  totalQty: number
  temuNetStock: number
  producingQty: number
  dailySales: number
  /** 30 天内是否有销售行（滞销判定=有数据但零销量；无数据不算滞销） */
  hasSalesData: boolean
  thresholdDays: number
}): { status: StockStatus; availableDays: number | null } {
  const availableDays =
    args.dailySales > 0
      ? Math.round(
          ((args.totalQty + args.temuNetStock + args.producingQty) / args.dailySales) * 10,
        ) / 10
      : null
  if (args.productionState === "stopped") {
    return { status: args.totalQty <= 0 ? "discontinued" : "clearance", availableDays }
  }
  if (args.totalQty <= 0) return { status: "out_of_stock", availableDays }
  if (args.dailySales > 0) {
    return { status: availableDays! < args.thresholdDays ? "restock" : "normal", availableDays }
  }
  return { status: args.hasSalesData ? "stagnant" : "normal", availableDays }
}

export type MovementType = (typeof inventoryMovementTypeEnum.enumValues)[number]

export type MovementInput = {
  enterpriseId: string
  productId: string
  warehouseId: string
  type: MovementType
  /** 正=入库 负=出库 */
  qtyChange: number
  boxQty?: number | null
  refType?: string | null
  refId?: string | null
  reason?: string | null
  createdBy?: string | null
  /** allowNegative=true 时允许扣成负数（仅内部冲正用；常规出入库/发货扣减不允许） */
  allowNegative?: boolean
}

/** 库存不足错误（qtyChange<0 且余量不够；带货号/仓库定位信息供上层组装报错） */
export class InsufficientStockError extends Error {
  constructor(
    public readonly productId: string,
    public readonly warehouseId: string,
    public readonly needed: number,
    public readonly available: number,
  ) {
    super(
      `InsufficientStock: product=${productId} warehouse=${warehouseId} needed=${needed} available=${available}`,
    )
  }
}

/**
 * 统一变动入口。items 内多条变动同事务原子提交（调拨=两条、批量=多条）。
 * 任一条不足整批回滚（InsufficientStockError）。
 */
export async function applyMovements(tx: InventoryTx, items: MovementInput[]): Promise<void> {
  for (const m of items) {
    if (!Number.isInteger(m.qtyChange) || m.qtyChange === 0) {
      throw new Error(`变动数量必须为非零整数：${m.productId}`)
    }
    // 行锁读当前量（无行视作 0，同时锁住「插入位」由唯一约束兜底并发首插）
    const [row] = await tx
      .select({ qty: inventoryStocks.qty })
      .from(inventoryStocks)
      .where(
        and(
          eq(inventoryStocks.productId, m.productId),
          eq(inventoryStocks.warehouseId, m.warehouseId),
        ),
      )
      .for("update")

    const before = row?.qty ?? 0
    const after = before + m.qtyChange
    if (after < 0 && !m.allowNegative) {
      throw new InsufficientStockError(
        m.productId,
        m.warehouseId,
        -m.qtyChange,
        before,
      )
    }

    if (row) {
      await tx
        .update(inventoryStocks)
        .set({ qty: after, updatedAt: new Date() })
        .where(
          and(
            eq(inventoryStocks.productId, m.productId),
            eq(inventoryStocks.warehouseId, m.warehouseId),
          ),
        )
    } else {
      await tx.insert(inventoryStocks).values({
        enterpriseId: m.enterpriseId,
        productId: m.productId,
        warehouseId: m.warehouseId,
        qty: after,
      })
    }

    await tx.insert(inventoryMovements).values({
      enterpriseId: m.enterpriseId,
      productId: m.productId,
      warehouseId: m.warehouseId,
      type: m.type,
      qtyChange: m.qtyChange,
      qtyBefore: before,
      qtyAfter: after,
      boxQty: m.boxQty ?? null,
      refType: m.refType ?? null,
      refId: m.refId ?? null,
      reason: m.reason ?? null,
      createdBy: m.createdBy ?? null,
    })
  }
}

/** 汇总单仓当前量（只读，无锁；阻断预检/展示用，权威校验仍在事务内 applyMovements） */
export async function getStockQty(
  productId: string,
  warehouseId: string,
): Promise<number> {
  const [row] = await db
    .select({ qty: inventoryStocks.qty })
    .from(inventoryStocks)
    .where(
      and(
        eq(inventoryStocks.productId, productId),
        eq(inventoryStocks.warehouseId, warehouseId),
      ),
    )
    .limit(1)
  return row?.qty ?? 0
}

/** 事务版 getStockQty（FOR UPDATE 行锁，装箱硬阻断校验用） */
export async function getStockQtyForUpdate(
  tx: InventoryTx,
  productId: string,
  warehouseId: string,
): Promise<number> {
  const [row] = await tx
    .select({ qty: inventoryStocks.qty })
    .from(inventoryStocks)
    .where(
      and(
        eq(inventoryStocks.productId, productId),
        eq(inventoryStocks.warehouseId, warehouseId),
      ),
    )
    .for("update")
  return row?.qty ?? 0
}

/** 按货号数组批量取各仓库存（{productId, warehouseId, qty}[]；展示/参考列用） */
export async function getStockRows(productIds: string[]) {
  if (productIds.length === 0) return []
  return db
    .select({
      productId: inventoryStocks.productId,
      warehouseId: inventoryStocks.warehouseId,
      qty: inventoryStocks.qty,
    })
    .from(inventoryStocks)
    .where(inArray(inventoryStocks.productId, productIds))
}

/* ─── TEMU 装箱发货联动（批次4）：硬阻断校验 + 成功后扣减 ─── */

import {
  inventoryProducts as _invProducts,
  inventoryWarehouses as _invWarehouses,
  temuShipOrders,
} from "@/db/schema"
import { inArray as _inArray } from "drizzle-orm"

export interface ShipmentStockItem {
  /** 归一化货号 key（B049≡B49，匹配档案用） */
  snKey: string
  /** 货号展示串（发货单行 skcExtCode 原串） */
  productCode: string
  deliveryOrderSn: string
  qty: number
}

/** 读发货单行并按归一化货号聚合数量（skcExtCode × deliverSkcNum；未建档/无货号行跳过） */
async function loadShipmentItems(
  storeId: string,
  deliveryOrderSns: string[],
): Promise<ShipmentStockItem[]> {
  const rows = await db
    .select({
      sn: temuShipOrders.deliveryOrderSn,
      extCode: temuShipOrders.skcExtCode,
      qty: temuShipOrders.deliverSkcNum,
    })
    .from(temuShipOrders)
    .where(
      and(eq(temuShipOrders.storeId, storeId), _inArray(temuShipOrders.deliveryOrderSn, deliveryOrderSns)),
    )
  // 同单内 B049/B49 等同归一码归并到一条（qty 累加），展示串取首见原串
  const merged = new Map<string, ShipmentStockItem>()
  for (const r of rows) {
    if (!r.extCode || (r.qty ?? 0) <= 0) continue
    const snKey = normalizeSn(r.extCode)
    const mk = `${r.sn}|${snKey}`
    const cur = merged.get(mk)
    if (cur) cur.qty += r.qty!
    else merged.set(mk, { snKey, productCode: r.extCode, deliveryOrderSn: r.sn, qty: r.qty! })
  }
  return [...merged.values()]
}

/**
 * 企业档案 → 归一化码映射（装箱校验/扣减/参考查询共用）。
 * 全量按 productCode 升序读入，撞码（如同时存在 B49 与 B049 两条档案）取字典序首条，
 * 保证行为确定。
 */
export async function loadProductMapBySnKey(
  enterpriseId: string,
): Promise<Map<string, { id: string; code: string }>> {
  const products = await db
    .select({ id: _invProducts.id, code: _invProducts.productCode })
    .from(_invProducts)
    .where(eq(_invProducts.enterpriseId, enterpriseId))
    .orderBy(asc(_invProducts.productCode))
  const map = new Map<string, { id: string; code: string }>()
  for (const p of products) {
    const key = normalizeSn(p.code)
    if (!map.has(key)) map.set(key, p)
  }
  return map
}

/**
 * 装箱硬阻断校验（packing.send 前）：按所选仓逐货号核对「仓库存 ≥ 本单数量」。
 * 未建档货号不参与库存体系（跳过校验，也不扣减）；不足返回缺口明细。
 * 事务内行锁读，与扣减/手动出入库并发安全。
 */
export async function assertShipmentStock(
  tx: InventoryTx,
  enterpriseId: string,
  storeId: string,
  deliveryOrderSns: string[],
  warehouseId: string,
): Promise<{ ok: true } | { ok: false; shortages: Array<{ productCode: string; needed: number; available: number }> }> {
  const items = await loadShipmentItems(storeId, deliveryOrderSns)
  if (items.length === 0) return { ok: true }

  const productMap = await loadProductMapBySnKey(enterpriseId)

  const shortages: Array<{ productCode: string; needed: number; available: number }> = []
  // 同货号多单合并需求量（按归一化码）
  const needByCode = new Map<string, number>()
  for (const item of items) {
    if (!productMap.has(item.snKey)) continue // 未建档货号跳过
    needByCode.set(item.snKey, (needByCode.get(item.snKey) ?? 0) + item.qty)
  }
  for (const [snKey, needed] of needByCode) {
    const product = productMap.get(snKey)!
    const available = await getStockQtyForUpdate(tx, product.id, warehouseId)
    if (available < needed) shortages.push({ productCode: product.code, needed, available })
  }
  return shortages.length > 0 ? { ok: false, shortages } : { ok: true }
}

/**
 * 装箱成功后扣减（shipmentShippedHook 实装）：
 * 按货号聚合逐项扣所选仓 + 「发货扣减」流水（refId=发货单号）；
 * 幂等：已存在 ship_deduct 流水的单号跳过（回查重放不双扣）；
 * 未建档货号跳过。返回扣减条数（0=全部跳过也视为成功）。
 */
export async function deductShipmentInventory(
  enterpriseId: string,
  storeId: string,
  deliveryOrderSns: string[],
  warehouseId: string,
  userId: string | null,
): Promise<{ deducted: number; error?: string }> {
  const items = await loadShipmentItems(storeId, deliveryOrderSns)
  if (items.length === 0) return { deducted: 0 }

  const productMap = await loadProductMapBySnKey(enterpriseId)

  // 幂等：这些单号已扣过则整单跳过
  const existing = await db
    .select({ refId: inventoryMovements.refId })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.enterpriseId, enterpriseId),
        eq(inventoryMovements.type, "ship_deduct"),
        _inArray(inventoryMovements.refType, ["ship_order"]),
        _inArray(
          inventoryMovements.refId,
          deliveryOrderSns,
        ),
      ),
    )
  const deductedSns = new Set(existing.map((e) => e.refId))
  const todo = items.filter((i) => !deductedSns.has(i.deliveryOrderSn) && productMap.has(i.snKey))
  if (todo.length === 0) return { deducted: 0 }

  try {
    await db.transaction(async (tx) => {
      // 需求量按 (货号×单号) 逐单扣：每单调用一次（流水 refId=单号）；
      // 同货号多单顺序扣减，第二单不足时 InsufficientStockError 上抛
      for (const item of todo) {
        await applyMovements(tx, [
          {
            enterpriseId,
            productId: productMap.get(item.snKey)!.id,
            warehouseId,
            type: "ship_deduct",
            qtyChange: -item.qty,
            refType: "ship_order",
            refId: item.deliveryOrderSn,
            reason: "TEMU 装箱发货扣减",
            createdBy: userId,
          },
        ])
      }
    })
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      // 理论不可达（装箱前已硬阻断）；并发漏网时不上抛——官方已发货，记 warning 语义
      return { deducted: 0, error: "库存不足未能扣减（并发变动），请人工核对流水" }
    }
    throw err
  }
  return { deducted: todo.length }
}

/** 主仓 id（默认发货仓；企业无仓时返回 null=库存未初始化，联动降级跳过） */
export async function getMainWarehouseId(enterpriseId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: _invWarehouses.id })
    .from(_invWarehouses)
    .where(and(eq(_invWarehouses.enterpriseId, enterpriseId), eq(_invWarehouses.code, "main")))
    .limit(1)
  return row?.id ?? null
}
