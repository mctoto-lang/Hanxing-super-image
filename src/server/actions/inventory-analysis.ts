"use server"

import { and, asc, eq, gte, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db/client"
import {
  inventoryFactories,
  inventoryMovements,
  inventoryProducts,
  inventoryProductionOrders,
  inventorySnapshots,
  inventoryStocks,
} from "@/db/schema"
import {
  blendedDailySales,
  deriveStockStatus,
  getInventoryStatusConfig,
  loadDailySalesBySn,
  loadTemuNetStockBySn,
  normalizeSn,
  requireInventory,
  stagnantWindowQtyOf,
  type MovementType,
  type StockStatus,
} from "@/server/services/inventory-core"

/**
 * 库存分析 action 层：补货建议（销速单轨，仅「持续生产」货号；
 * 无销速数据不出建议）、预警汇总（六态口径）、货号趋势、
 * 库存分析页（健康驾驶舱：KPI/六态分布/趋势组合/销速 TOP/待处理清单）。
 *
 * 销速 = 加权日销（0.7×近7天均+0.3×近30天均，inventory-core blendedDailySales；
 * 数据源 temu_sales_overview，productSn 按归一化货号聚合 B049≡B49）。
 * 可售天数 = (仓库库存+TEMU净库存+在产)÷日销；补货阈值企业级配置。
 */

const adviceQuerySchema = z.object({
  bufferDays: z.number().int().min(0).max(60).default(7),
})

/** 在产量按货号：余量（数量−已入库−已直发）+ 未完结生产单总量（Σ数量，不减） */
async function loadProducingBySn(enterpriseId: string) {
  const rows = await db
    .select({
      productCode: inventoryProducts.productCode,
      remain: sql<number>`coalesce(sum(${inventoryProductionOrders.quantity} - ${inventoryProductionOrders.shippedQty} - ${inventoryProductionOrders.directQty}), 0)::int`,
      orderQty: sql<number>`coalesce(sum(${inventoryProductionOrders.quantity}), 0)::int`,
    })
    .from(inventoryProductionOrders)
    .innerJoin(inventoryProducts, eq(inventoryProductionOrders.productId, inventoryProducts.id))
    .where(
      and(
        eq(inventoryProductionOrders.enterpriseId, enterpriseId),
        inArray(inventoryProductionOrders.status, ["materials_pending", "producing", "factory_shipped"]),
      ),
    )
    .groupBy(inventoryProducts.productCode)
  return new Map(rows.map((r) => [r.productCode, r]))
}

/** 建议量取整：max(建议, MOQ) → 装箱数向上取整 → 卡库存上限 */
function roundUpSuggest(
  raw: number,
  moq: number | null,
  cartonQty: number | null,
  upper: number | null,
  have: number,
): number {
  let v = Math.max(raw, moq ?? 0)
  if (cartonQty && cartonQty > 0) v = Math.ceil(v / cartonQty) * cartonQty
  if (upper != null) v = Math.min(v, Math.max(0, upper - have))
  return Math.max(0, v)
}

export type ReplenishAdviceRow = {
  productId: string
  productCode: string
  name: string
  imageUrl: string | null
  totalQty: number
  producingQty: number
  stockUpper: number | null
  moq: number | null
  cartonQty: number | null
  leadTimeDays: number | null
  /** 加权日销（0.7×近7天均+0.3×近30天均；有销速数据时 >0） */
  dailySales: number
  /** 目标覆盖量（销速轨） */
  targetQty: number | null
  suggestQty: number
  /** 滞销（判定窗销量 ≤ 上限且有库存；与六态同口径 deriveStockStatus） */
  stagnant: boolean
  /** 预计到货（今天+生产周期） */
  expectedDate: string | null
}

export async function getReplenishmentAdviceAction(input: unknown = {}) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = adviceQuerySchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: "参数错误" }

  const products = await db
    .select()
    .from(inventoryProducts)
    .where(eq(inventoryProducts.enterpriseId, g.enterpriseId))
    .orderBy(asc(inventoryProducts.productCode))
  if (products.length === 0) return { ok: true as const, rows: [] as ReplenishAdviceRow[] }
  const ids = products.map((p) => p.id)

  const cfg = await getInventoryStatusConfig(g.enterpriseId)
  const [stockRows, producing, sales, temuNet] = await Promise.all([
    db
      .select({
        productId: inventoryStocks.productId,
        qty: sql<number>`coalesce(sum(${inventoryStocks.qty}), 0)::int`,
      })
      .from(inventoryStocks)
      .where(
        and(eq(inventoryStocks.enterpriseId, g.enterpriseId), inArray(inventoryStocks.productId, ids)),
      )
      .groupBy(inventoryStocks.productId),
    loadProducingBySn(g.enterpriseId),
    loadDailySalesBySn(g.enterpriseId, cfg.stagnantDays),
    loadTemuNetStockBySn(g.enterpriseId),
  ])
  const stockMap = new Map(stockRows.map((r) => [r.productId, r.qty]))

  const today = new Date()
  const rows: ReplenishAdviceRow[] = []
  for (const p of products) {
    const totalQty = stockMap.get(p.id) ?? 0
    const producingQty = producing.get(p.productCode)?.remain ?? 0
    const temuStock = temuNet.get(normalizeSn(p.productCode)) ?? 0
    const dailySales = blendedDailySales(sales, p.productCode)
    // 滞销标记（清仓视角）：与预警处同口径 deriveStockStatus（窗口销量 ≤ 上限即滞销）
    const stagnantQty = stagnantWindowQtyOf(sales, p.productCode)
    const stagnant =
      deriveStockStatus({
        productionState: p.productionState,
        totalQty,
        temuNetStock: temuStock,
        producingQty,
        dailySales,
        stagnantWindowQty: stagnantQty,
        stagnantMaxQty: cfg.stagnantMaxQty,
        thresholdDays: cfg.thresholdDays,
      }).status === "stagnant"

    // 仅「持续生产」货号生成建议（停止生产=售罄即停产不补货）；
    // 销速单轨——无销速数据不出建议（滞销行除外）
    if (p.productionState !== "active") continue

    let targetQty: number | null = null
    let rawSuggest = 0
    if (dailySales > 0) {
      const lead = p.leadTimeDays ?? 0
      targetQty = Math.ceil(dailySales * (lead + q.data.bufferDays))
      rawSuggest = targetQty - totalQty - producingQty - temuStock
    }
    if (rawSuggest <= 0 && !stagnant) continue

    const expected = new Date(today.getTime() + (p.leadTimeDays ?? 0) * 86400000)
      .toISOString()
      .slice(0, 10)
    rows.push({
      productId: p.id,
      productCode: p.productCode,
      name: p.name,
      imageUrl: p.imageUrl,
      totalQty,
      producingQty,
      stockUpper: p.stockUpper,
      moq: p.moq,
      cartonQty: p.cartonQty,
      leadTimeDays: p.leadTimeDays,
      dailySales,
      targetQty,
      suggestQty: roundUpSuggest(
        rawSuggest,
        p.moq,
        p.cartonQty,
        p.stockUpper,
        totalQty + producingQty + temuStock,
      ),
      stagnant,
      expectedDate: expected,
    })
  }
  return { ok: true as const, rows, bufferDays: q.data.bufferDays }
}

/** 补货建议批量生成生产单（每行一单，统一工厂；日期=今天） */
export async function createProductionOrdersFromAdviceAction(input: {
  factoryId: string
  items: Array<{ productId: string; qty: number }>
}) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  if (!input?.factoryId || !Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false as const, error: "请选择工厂并勾选建议行" }
  }
  // 工厂归属预检（防跨租户 factoryId 把生产单挂到他企业工厂）
  const [factory] = await db
    .select({ id: inventoryFactories.id })
    .from(inventoryFactories)
    .where(
      and(
        eq(inventoryFactories.id, input.factoryId),
        eq(inventoryFactories.enterpriseId, g.enterpriseId),
      ),
    )
    .limit(1)
  if (!factory) return { ok: false as const, error: "工厂不存在" }
  const today = new Date().toISOString().slice(0, 10)
  let created = 0
  for (const item of input.items.slice(0, 100)) {
    const qty = Math.floor(Number(item.qty))
    if (!Number.isInteger(qty) || qty <= 0) continue
    const [product] = await db
      .select({ id: inventoryProducts.id, leadTimeDays: inventoryProducts.leadTimeDays })
      .from(inventoryProducts)
      .where(
        and(eq(inventoryProducts.id, item.productId), eq(inventoryProducts.enterpriseId, g.enterpriseId)),
      )
      .limit(1)
    if (!product) continue
    const expected =
      product.leadTimeDays != null
        ? new Date(Date.now() + product.leadTimeDays * 86400000).toISOString().slice(0, 10)
        : null
    await db.insert(inventoryProductionOrders).values({
      enterpriseId: g.enterpriseId,
      productId: product.id,
      factoryId: input.factoryId,
      quantity: qty,
      productionDate: today,
      expectedDate: expected,
      note: "补货建议生成",
      createdBy: g.ctx.user.id,
    })
    created++
  }
  return { ok: true as const, created }
}

/** 每日预警汇总（总览顶部 Alert 条）：六态口径，与总览状态完全一致
 *  （补货=可售天数<企业阈值；滞销=窗口销量≤上限且有库存；停产/清仓不入预警） */
export async function getInventoryAlertSummaryAction() {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const products = await db
    .select({
      id: inventoryProducts.id,
      code: inventoryProducts.productCode,
      state: inventoryProducts.productionState,
    })
    .from(inventoryProducts)
    .where(eq(inventoryProducts.enterpriseId, g.enterpriseId))
  if (products.length === 0) return { ok: true as const, outOfStock: [], restock: [], stagnant: [] }
  const ids = products.map((p) => p.id)
  const cfg = await getInventoryStatusConfig(g.enterpriseId)
  const [stockRows, producing, sales, temuNet] = await Promise.all([
    db
      .select({ productId: inventoryStocks.productId, qty: sql<number>`coalesce(sum(${inventoryStocks.qty}), 0)::int` })
      .from(inventoryStocks)
      .where(and(eq(inventoryStocks.enterpriseId, g.enterpriseId), inArray(inventoryStocks.productId, ids)))
      .groupBy(inventoryStocks.productId),
    loadProducingBySn(g.enterpriseId),
    loadDailySalesBySn(g.enterpriseId, cfg.stagnantDays),
    loadTemuNetStockBySn(g.enterpriseId),
  ])
  const stockMap = new Map(stockRows.map((r) => [r.productId, r.qty]))
  const outOfStock: string[] = []
  const restock: string[] = []
  const stagnant: string[] = []
  for (const p of products) {
    const { status } = deriveStockStatus({
      productionState: p.state,
      totalQty: stockMap.get(p.id) ?? 0,
      temuNetStock: temuNet.get(normalizeSn(p.code)) ?? 0,
      producingQty: producing.get(p.code)?.remain ?? 0,
      dailySales: blendedDailySales(sales, p.code),
      stagnantWindowQty: stagnantWindowQtyOf(sales, p.code),
      stagnantMaxQty: cfg.stagnantMaxQty,
      thresholdDays: cfg.thresholdDays,
    })
    if (status === "out_of_stock") outOfStock.push(p.code)
    else if (status === "restock") restock.push(p.code)
    else if (status === "stagnant") stagnant.push(p.code)
  }
  return { ok: true as const, outOfStock, restock, stagnant }
}

/** 货号库存趋势（近 N 天两仓合计，基于日快照） */
export async function getProductTrendAction(productId: string, days = 30) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  const rows = await db
    .select({
      day: inventorySnapshots.day,
      qty: sql<number>`coalesce(sum(${inventorySnapshots.qty}), 0)::int`,
    })
    .from(inventorySnapshots)
    .where(
      and(
        eq(inventorySnapshots.enterpriseId, g.enterpriseId),
        eq(inventorySnapshots.productId, productId),
        gte(inventorySnapshots.day, since),
      ),
    )
    .groupBy(inventorySnapshots.day)
    .orderBy(asc(inventorySnapshots.day))
  return { ok: true as const, points: rows.map((r) => ({ day: String(r.day), qty: r.qty })) }
}

/* ─── 库存分析页 ─── */

const analysisQuerySchema = z.object({
  window: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(30),
})

export type AnalysisFlowTypeRow = {
  type: MovementType
  count: number
  /** 件数净额（正=入库方向 负=出库方向；调拨成对一正一负） */
  qty: number
}

export type AnalysisTopSalesRow = {
  productCode: string
  name: string
  imageUrl: string | null
  /** 加权日销（0.7×近7天均+0.3×近30天均） */
  dailySales: number
  totalQty: number
  producingQty: number
  temuStock: number
  /** 可售天数 = (仓库+TEMU净+在产)÷日销（保留 1 位小数；无销速=null） */
  availableDays: number | null
}

/** 待处理清单行（补货/滞销/清仓合并；status 对应六态之一） */
export type AnalysisPendingRow = {
  productCode: string
  name: string
  imageUrl: string | null
  status: "restock" | "stagnant" | "clearance"
  totalQty: number
  temuStock: number
  producingQty: number
  dailySales: number
  availableDays: number | null
  /** 补货缺口（仅 restock 行：阈值覆盖量 − 现有可用，向上取整） */
  gapQty: number | null
  /** 最后变动时间（滞销/清仓参考；无流水=null） */
  lastMovementAt: string | null
}

/** 库存分布树图行（全量货号；三口径值由前端树图切换展示，块面积按 √数量缩放） */
export type AnalysisTreemapRow = {
  productCode: string
  name: string
  imageUrl: string | null
  status: StockStatus
  totalQty: number
  temuStock: number
  producingQty: number
  /** 未完结生产单总量（Σ数量，不减已入库/直发；无库存大方块展示用） */
  producingOrderQty: number
}

/** 库存分析页一次取数（Bento 三卡）：总量趋势 + 出入库流量 + 库存分布树图（全量货号）。
 *  前端窗口固定近 30 天；legacy 字段（cards/statusCounts/flowTypes/daysBuckets/pending）保留。 */
export async function getInventoryAnalysisAction(input: unknown = {}) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = analysisQuerySchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: "参数错误" }
  const win = q.data.window
  const sinceDay = new Date(Date.now() - win * 86400000).toISOString().slice(0, 10)
  const sinceTs = `${sinceDay}T00:00:00.000Z`

  const products = await db
    .select()
    .from(inventoryProducts)
    .where(eq(inventoryProducts.enterpriseId, g.enterpriseId))
  if (products.length === 0) {
    return {
      ok: true as const,
      window: win,
      thresholdDays: (await getInventoryStatusConfig(g.enterpriseId)).thresholdDays,
      cards: {
        totalQty: 0,
        productCount: 0,
        stockedCount: 0,
        outOfStockCount: 0,
        restockCount: 0,
        stagnantCount: 0,
        discontinuedCount: 0,
        clearanceCount: 0,
      },
      statusCounts: { normal: 0, restock: 0, out_of_stock: 0, stagnant: 0, discontinued: 0, clearance: 0 },
      trend: [],
      flowDaily: [],
      flowTypes: [] as AnalysisFlowTypeRow[],
      topSales: [] as AnalysisTopSalesRow[],
      treemap: [] as AnalysisTreemapRow[],
      daysBuckets: [],
      pending: [] as AnalysisPendingRow[],
    }
  }
  const ids = products.map((p) => p.id)
  const cfg = await getInventoryStatusConfig(g.enterpriseId)

  const [stockRows, producing, sales, temuNet, trendRows, flowRows, typeRows] = await Promise.all([
    db
      .select({
        productId: inventoryStocks.productId,
        qty: inventoryStocks.qty,
      })
      .from(inventoryStocks)
      .where(and(eq(inventoryStocks.enterpriseId, g.enterpriseId), inArray(inventoryStocks.productId, ids))),
    loadProducingBySn(g.enterpriseId),
    loadDailySalesBySn(g.enterpriseId, cfg.stagnantDays),
    loadTemuNetStockBySn(g.enterpriseId),
    db
      .select({
        day: inventorySnapshots.day,
        qty: sql<number>`coalesce(sum(${inventorySnapshots.qty}), 0)::int`,
      })
      .from(inventorySnapshots)
      .where(and(eq(inventorySnapshots.enterpriseId, g.enterpriseId), gte(inventorySnapshots.day, sinceDay)))
      .groupBy(inventorySnapshots.day)
      .orderBy(asc(inventorySnapshots.day)),
    db.execute<{ day: string; in_qty: number; out_qty: number }>(sql`
      select to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD') as day,
             coalesce(sum(case when qty_change > 0 then qty_change else 0 end), 0)::int as in_qty,
             coalesce(sum(case when qty_change < 0 then -qty_change else 0 end), 0)::int as out_qty
      from inventory_movement
      where enterprise_id = ${g.enterpriseId} and created_at >= ${sinceTs}::timestamptz
      group by 1
      order by 1
    `),
    db
      .select({
        type: inventoryMovements.type,
        count: sql<number>`count(*)::int`,
        qty: sql<number>`coalesce(sum(${inventoryMovements.qtyChange}), 0)::int`,
      })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.enterpriseId, g.enterpriseId),
          gte(inventoryMovements.createdAt, new Date(sinceTs)),
        ),
      )
      .groupBy(inventoryMovements.type),
  ])

  // 合计（单仓制；保留按货号累加兼容历史多仓行）
  const totalMap = new Map<string, number>()
  for (const r of stockRows) {
    totalMap.set(r.productId, (totalMap.get(r.productId) ?? 0) + r.qty)
  }

  // 六态计数 + 销速 TOP + 可售天数分布 + 待处理清单（口径与总览/预警完全一致）
  let totalQtyAll = 0
  let stockedCount = 0
  const statusCounts: Record<StockStatus, number> = {
    normal: 0,
    restock: 0,
    out_of_stock: 0,
    stagnant: 0,
    discontinued: 0,
    clearance: 0,
  }
  const topSales: AnalysisTopSalesRow[] = []
  const treemapRows: AnalysisTreemapRow[] = []
  const pendingRestock: Array<AnalysisPendingRow & { id: string }> = []
  const pendingOthers: Array<AnalysisPendingRow & { id: string }> = []
  const bucketCounts = [0, 0, 0, 0, 0]
  let noSalesCount = 0
  for (const p of products) {
    const total = totalMap.get(p.id) ?? 0
    totalQtyAll += total
    if (total > 0) stockedCount++
    const producingQty = producing.get(p.productCode)?.remain ?? 0
    const temuStock = temuNet.get(normalizeSn(p.productCode)) ?? 0
    const dailySales = blendedDailySales(sales, p.productCode)
    const { status, availableDays } = deriveStockStatus({
      productionState: p.productionState,
      totalQty: total,
      temuNetStock: temuStock,
      producingQty,
      dailySales,
      stagnantWindowQty: stagnantWindowQtyOf(sales, p.productCode),
      stagnantMaxQty: cfg.stagnantMaxQty,
      thresholdDays: cfg.thresholdDays,
    })
    statusCounts[status]++
    treemapRows.push({
      productCode: p.productCode,
      name: p.name,
      imageUrl: p.imageUrl,
      status,
      totalQty: total,
      temuStock,
      producingQty,
      producingOrderQty: producing.get(p.productCode)?.orderQty ?? 0,
    })
    if (dailySales > 0) {
      topSales.push({
        productCode: p.productCode,
        name: p.name,
        imageUrl: p.imageUrl,
        dailySales,
        totalQty: total,
        producingQty,
        temuStock,
        availableDays,
      })
      // 可售天数分布仅统计有库存货号（缺货数在 KPI 卡）
      if (total > 0 && availableDays != null) {
        if (availableDays <= 7) bucketCounts[0]++
        else if (availableDays <= 14) bucketCounts[1]++
        else if (availableDays <= 30) bucketCounts[2]++
        else if (availableDays <= 60) bucketCounts[3]++
        else bucketCounts[4]++
      }
    } else if (total > 0) {
      noSalesCount++
    }
    if (status === "restock" || status === "stagnant" || status === "clearance") {
      const row = {
        id: p.id,
        productCode: p.productCode,
        name: p.name,
        imageUrl: p.imageUrl,
        status,
        totalQty: total,
        temuStock,
        producingQty,
        dailySales,
        availableDays,
        gapQty:
          status === "restock" && dailySales > 0
            ? Math.max(0, Math.ceil(cfg.thresholdDays * dailySales - (total + temuStock + producingQty)))
            : null,
        lastMovementAt: null as string | null,
      }
      if (status === "restock") pendingRestock.push(row)
      else pendingOthers.push(row)
    }
  }
  topSales.sort((a, b) => b.dailySales - a.dailySales)
  treemapRows.sort((a, b) => b.totalQty - a.totalQty)
  const daysBuckets = [
    { bucket: "≤7天", count: bucketCounts[0] },
    { bucket: "8-14天", count: bucketCounts[1] },
    { bucket: "15-30天", count: bucketCounts[2] },
    { bucket: "31-60天", count: bucketCounts[3] },
    { bucket: ">60天", count: bucketCounts[4] },
    { bucket: "无销速", count: noSalesCount },
  ]

  // 待处理清单：补货（可售天数升序=最急在前）→ 滞销/清仓（锁仓量降序），上限 50；
  // 附最后变动时间（滞销/清仓参考）
  pendingRestock.sort((a, b) => (a.availableDays ?? 0) - (b.availableDays ?? 0))
  pendingOthers.sort((a, b) => b.totalQty - a.totalQty)
  const pendingSlice = [...pendingRestock, ...pendingOthers].slice(0, 50)
  const lastMvMap = new Map<string, string>()
  if (pendingSlice.length > 0) {
    const lastMvRows = await db
      .select({
        productId: inventoryMovements.productId,
        last: sql<string>`max(${inventoryMovements.createdAt})`,
      })
      .from(inventoryMovements)
      .where(inArray(inventoryMovements.productId, pendingSlice.map((s) => s.id)))
      .groupBy(inventoryMovements.productId)
    for (const r of lastMvRows) lastMvMap.set(r.productId, String(r.last))
  }

  return {
    ok: true as const,
    window: win,
    thresholdDays: cfg.thresholdDays,
    cards: {
      totalQty: totalQtyAll,
      productCount: products.length,
      stockedCount,
      outOfStockCount: statusCounts.out_of_stock,
      restockCount: statusCounts.restock,
      stagnantCount: statusCounts.stagnant,
      discontinuedCount: statusCounts.discontinued,
      clearanceCount: statusCounts.clearance,
    },
    statusCounts,
    trend: trendRows.map((r) => ({ day: String(r.day), qty: r.qty })),
    flowDaily: flowRows.map((r) => ({ day: r.day, inQty: r.in_qty, outQty: r.out_qty })),
    flowTypes: typeRows.map((r): AnalysisFlowTypeRow => ({ type: r.type, count: r.count, qty: r.qty })),
    topSales: topSales.slice(0, 10),
    treemap: treemapRows,
    daysBuckets,
    pending: pendingSlice.map(({ id, ...row }) => ({
      ...row,
      lastMovementAt: lastMvMap.get(id) ?? null,
    })),
  }
}
