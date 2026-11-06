"use server"

import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  inventoryMovements,
  inventoryProductLogs,
  inventoryProducts,
  inventoryProductionOrders,
  inventorySettings,
  inventoryStocks,
  inventoryWarehouses,
  users,
} from "@/db/schema"
import {
  inventoryManualMovementSchema,
  inventoryMovementsQuerySchema,
  inventoryOverviewQuerySchema,
  inventoryProductCreateSchema,
  inventoryProductSearchSchema,
  inventoryProductUpdateSchema,
} from "@/server/schemas/inventory"
import {
  applyMovements,
  blendedDailySales,
  getMainWarehouseId,
  getRestockThresholdDays,
  hasSalesDataOf,
  InsufficientStockError,
  loadDailySalesBySn,
  loadTemuNetStockBySn,
  deriveStockStatus,
  normalizeSn,
  requireInventory,
  type MovementType,
  type StockStatus,
} from "@/server/services/inventory-core"
import { temuDayStr } from "@/server/services/temu-time"

/**
 * 库存管理 action 层（单权限 key inventory，可看即可用；危险操作 UI 层二次确认）
 *
 * 全部写操作走 inventory-core.applyMovements 事务入口（行锁+前/后值流水）。
 * 生产域（生产单/工厂/直发）在 inventory-production；分析/补货在 inventory-analysis。
 */

/** 单仓制：唯一仓库=主仓（幂等播种；义乌仓历史行保留仅不使用） */
async function ensureDefaultWarehouses(enterpriseId: string) {
  await db
    .insert(inventoryWarehouses)
    .values([{ enterpriseId, code: "main", name: "主仓", sort: 0 }])
    .onConflictDoNothing()
}

/** 单仓制：确保主仓存在并返回其 id（写入侧统一固定主仓；null=库存未初始化） */
async function resolveMainWarehouseId(enterpriseId: string): Promise<string | null> {
  await ensureDefaultWarehouses(enterpriseId)
  return getMainWarehouseId(enterpriseId)
}

// ---------- 商品档案 ----------

const PRODUCT_FIELDS = [
  "name",
  "imageUrl",
  "cartonQty",
  "leadTimeDays",
  "stockUpper",
  "moq",
  "barcodePrePasted",
  "productionState",
  "shipState",
  "note",
] as const

export async function createProductAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = inventoryProductCreateSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }

  const [existing] = await db
    .select({ id: inventoryProducts.id })
    .from(inventoryProducts)
    .where(
      and(
        eq(inventoryProducts.enterpriseId, g.enterpriseId),
        eq(inventoryProducts.productCode, q.data.productCode),
      ),
    )
    .limit(1)
  if (existing) return { ok: false as const, error: `货号 ${q.data.productCode} 已存在` }

  const [row] = await db
    .insert(inventoryProducts)
    .values({
      enterpriseId: g.enterpriseId,
      productCode: q.data.productCode,
      name: q.data.name,
      imageUrl: q.data.imageUrl ?? null,
      cartonQty: q.data.cartonQty ?? null,
      leadTimeDays: q.data.leadTimeDays ?? null,
      stockUpper: q.data.stockUpper ?? null,
      moq: q.data.moq ?? null,
      barcodePrePasted: q.data.barcodePrePasted,
      productionState: q.data.productionState,
      shipState: q.data.shipState,
      note: q.data.note ?? null,
      createdBy: g.ctx.user.id,
    })
    .returning()
  return { ok: true as const, product: row! }
}

export async function updateProductAction(productId: string, input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = inventoryProductUpdateSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }

  const [row] = await db
    .select()
    .from(inventoryProducts)
    .where(
      and(eq(inventoryProducts.id, productId), eq(inventoryProducts.enterpriseId, g.enterpriseId)),
    )
    .limit(1)
  if (!row) return { ok: false as const, error: "商品档案不存在" }

  // 字段级 diff → 变更日志（每次修改留痕：字段/旧值→新值/操作人/时间）
  const logs: Array<typeof inventoryProductLogs.$inferInsert> = []
  const patch: Record<string, unknown> = {}
  for (const field of PRODUCT_FIELDS) {
    // 未传入的字段跳过（update schema 无默认，q.data 只含显式传入键；部分更新不重置）
    if (!(field in q.data)) continue
    const next = q.data[field]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prev = (row as any)[field]
    const same = next === prev || (next == null && prev == null)
    if (!same) {
      patch[field] = next ?? null
      logs.push({
        enterpriseId: g.enterpriseId,
        productId,
        field,
        oldValue: prev == null ? null : String(prev),
        newValue: next == null ? null : String(next),
        createdBy: g.ctx.user.id,
      })
    }
  }
  if (Object.keys(patch).length === 0) return { ok: true as const, changed: 0 }

  await db.transaction(async (tx) => {
    await tx
      .update(inventoryProducts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(inventoryProducts.id, productId))
    if (logs.length > 0) await tx.insert(inventoryProductLogs).values(logs)
  })
  return { ok: true as const, changed: logs.length }
}

export async function deleteProductAction(productId: string) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }

  const [row] = await db
    .select({ id: inventoryProducts.id, productCode: inventoryProducts.productCode })
    .from(inventoryProducts)
    .where(
      and(eq(inventoryProducts.id, productId), eq(inventoryProducts.enterpriseId, g.enterpriseId)),
    )
    .limit(1)
  if (!row) return { ok: false as const, error: "商品档案不存在" }

  const [mv] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.productId, productId))
  if (mv!.n > 0) {
    return {
      ok: false as const,
      error: `货号 ${row.productCode} 已有 ${mv!.n} 条库存流水，不可删除（流水不可删改）`,
    }
  }
  const [po] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryProductionOrders)
    .where(eq(inventoryProductionOrders.productId, productId))
  if (po!.n > 0) {
    return { ok: false as const, error: `货号 ${row.productCode} 已有生产单，不可删除` }
  }

  await db
    .delete(inventoryProducts)
    .where(
      and(eq(inventoryProducts.id, productId), eq(inventoryProducts.enterpriseId, g.enterpriseId)),
    )
  return { ok: true as const }
}

// ---------- 库存总览 ----------

export type InventoryOverviewRow = {
  id: string
  productCode: string
  name: string
  imageUrl: string | null
  cartonQty: number | null
  leadTimeDays: number | null
  stockUpper: number | null
  moq: number | null
  barcodePrePasted: boolean
  productionState: "active" | "stopped"
  shipState: "auto" | "manual"
  note: string | null
  totalQty: number
  /** 在产余量 = Σ(数量−已入库−直发) 未完结生产单 */
  producingQty: number
  /** TEMU 净库存（仓内−待发货；归一化货号聚合，0089 起有值） */
  temuStock: number
  /** 加权日销 = 0.7×近7天均 + 0.3×近30天均（无销速=0） */
  dailySales: number
  /** 可售天数 = (仓库+TEMU净+在产)÷日销（无销速=null） */
  availableDays: number | null
  /** 六态：正常/补货/缺货/滞销/停产/清仓（详见 inventory-core deriveStockStatus） */
  status: StockStatus
}

export async function getInventoryOverviewAction(input: unknown = {}) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = inventoryOverviewQuerySchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: "参数错误" }
  await ensureDefaultWarehouses(g.enterpriseId)

  const products = await db
    .select()
    .from(inventoryProducts)
    .where(
      q.data.q
        ? and(
            eq(inventoryProducts.enterpriseId, g.enterpriseId),
            or(
              ilike(inventoryProducts.productCode, `%${q.data.q}%`),
              ilike(inventoryProducts.name, `%${q.data.q}%`),
            ),
          )
        : eq(inventoryProducts.enterpriseId, g.enterpriseId),
    )
    .orderBy(asc(inventoryProducts.productCode))
  if (q.data.productionState) {
    // productionState 过滤（zod 已枚举校验，安全拼接）
    const filtered = products.filter((p) => p.productionState === q.data.productionState)
    products.length = 0
    products.push(...filtered)
  }
  if (products.length === 0) {
    return {
      ok: true as const,
      rows: [] as InventoryOverviewRow[],
      thresholdDays: await getRestockThresholdDays(g.enterpriseId),
    }
  }

  const ids = products.map((p) => p.id)
  const [stockRows, producingRows, sales, temuNet, thresholdDays] = await Promise.all([
    db
      .select({
        productId: inventoryStocks.productId,
        total: sql<number>`coalesce(sum(${inventoryStocks.qty}), 0)::int`,
      })
      .from(inventoryStocks)
      .where(
        and(
          eq(inventoryStocks.enterpriseId, g.enterpriseId),
          inArray(inventoryStocks.productId, ids),
        ),
      )
      .groupBy(inventoryStocks.productId),
    db
      .select({
        productId: inventoryProductionOrders.productId,
        remain: sql<number>`coalesce(sum(${inventoryProductionOrders.quantity} - ${inventoryProductionOrders.shippedQty} - ${inventoryProductionOrders.directQty}), 0)::int`,
      })
      .from(inventoryProductionOrders)
      .where(
        and(
          eq(inventoryProductionOrders.enterpriseId, g.enterpriseId),
          inArray(inventoryProductionOrders.status, [
            "materials_pending",
            "producing",
            "factory_shipped",
          ]),
          inArray(inventoryProductionOrders.productId, ids),
        ),
      )
      .groupBy(inventoryProductionOrders.productId),
    loadDailySalesBySn(g.enterpriseId),
    loadTemuNetStockBySn(g.enterpriseId),
    getRestockThresholdDays(g.enterpriseId),
  ])

  const stockMap = new Map(stockRows.map((r) => [r.productId, r.total]))
  const producingMap = new Map(producingRows.map((r) => [r.productId, r.remain]))

  const rows: InventoryOverviewRow[] = products.map((p) => {
    const totalQty = stockMap.get(p.id) ?? 0
    const producingQty = producingMap.get(p.id) ?? 0
    const snKey = normalizeSn(p.productCode)
    const temuStock = temuNet.get(snKey) ?? 0
    const dailySales = blendedDailySales(sales, p.productCode)
    const { status, availableDays } = deriveStockStatus({
      productionState: p.productionState,
      totalQty,
      temuNetStock: temuStock,
      producingQty,
      dailySales,
      hasSalesData: hasSalesDataOf(sales, p.productCode),
      thresholdDays,
    })
    return {
      id: p.id,
      productCode: p.productCode,
      name: p.name,
      imageUrl: p.imageUrl,
      cartonQty: p.cartonQty,
      leadTimeDays: p.leadTimeDays,
      stockUpper: p.stockUpper,
      moq: p.moq,
      barcodePrePasted: p.barcodePrePasted,
      productionState: p.productionState,
      shipState: p.shipState,
      note: p.note,
      totalQty,
      producingQty,
      temuStock,
      dailySales,
      availableDays,
      status,
    }
  })

  const filtered = q.data.status ? rows.filter((r) => r.status === q.data.status) : rows
  return { ok: true as const, rows: filtered, thresholdDays }
}

// ---------- 库存设置（补货阈值统一配置） ----------

/** 读库存设置（无行回落默认；thresholdDays 供状态徽章 Tooltip/分析页副文案） */
export async function getInventorySettingsAction() {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const thresholdDays = await getRestockThresholdDays(g.enterpriseId)
  return { ok: true as const, thresholdDays }
}

/** 更新补货阈值（总览页配置弹窗；upsert 每企业一行） */
export async function updateRestockThresholdAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const days = Number((input as { thresholdDays?: unknown })?.thresholdDays)
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return { ok: false as const, error: "补货阈值须为 1-365 的整数（天）" }
  }
  await db
    .insert(inventorySettings)
    .values({
      enterpriseId: g.enterpriseId,
      restockThresholdDays: days,
      updatedBy: g.ctx.user.id,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: inventorySettings.enterpriseId,
      set: {
        restockThresholdDays: days,
        updatedBy: g.ctx.user.id,
        updatedAt: new Date(),
      },
    })
  return { ok: true as const, thresholdDays: days }
}

// ---------- 手动出入库（单仓制固定主仓） ----------

export async function manualMovementAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = inventoryManualMovementSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }

  const [product] = await db
    .select({ id: inventoryProducts.id, code: inventoryProducts.productCode })
    .from(inventoryProducts)
    .where(
      and(
        eq(inventoryProducts.id, q.data.productId),
        eq(inventoryProducts.enterpriseId, g.enterpriseId),
      ),
    )
    .limit(1)
  if (!product) return { ok: false as const, error: "商品档案不存在" }
  // 单仓制：仓库固定主仓
  const mainWhId = await resolveMainWarehouseId(g.enterpriseId)
  if (!mainWhId) return { ok: false as const, error: "库存未初始化，请先访问库存总览" }

  const qtyChange = q.data.type === "manual_out" ? -q.data.qty : q.data.qty
  try {
    await db.transaction(async (tx) => {
      await applyMovements(tx, [
        {
          enterpriseId: g.enterpriseId,
          productId: q.data.productId,
          warehouseId: mainWhId,
          type: q.data.type as MovementType,
          qtyChange,
          boxQty: q.data.boxQty ?? null,
          refType: "manual",
          reason: q.data.reason,
          createdBy: g.ctx.user.id,
        },
      ])
    })
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return {
        ok: false as const,
        error: `库存不足：货号 ${product.code} 当前仅 ${err.available} 件，无法出库 ${err.needed} 件`,
      }
    }
    throw err
  }
  return { ok: true as const }
}

// ---------- 货号详情 / 搜索 ----------

export async function getProductDetailAction(productId: string) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }

  const [product] = await db
    .select()
    .from(inventoryProducts)
    .where(
      and(eq(inventoryProducts.id, productId), eq(inventoryProducts.enterpriseId, g.enterpriseId)),
    )
    .limit(1)
  if (!product) return { ok: false as const, error: "商品档案不存在" }

  const [stockAgg, movements, logs] = await Promise.all([
    db
      .select({ total: sql<number>`coalesce(sum(${inventoryStocks.qty}), 0)::int` })
      .from(inventoryStocks)
      .where(eq(inventoryStocks.productId, productId)),
    db
      .select({
        id: inventoryMovements.id,
        warehouseName: inventoryWarehouses.name,
        type: inventoryMovements.type,
        qtyChange: inventoryMovements.qtyChange,
        qtyBefore: inventoryMovements.qtyBefore,
        qtyAfter: inventoryMovements.qtyAfter,
        reason: inventoryMovements.reason,
        refType: inventoryMovements.refType,
        refId: inventoryMovements.refId,
        createdAt: inventoryMovements.createdAt,
      })
      .from(inventoryMovements)
      .innerJoin(inventoryWarehouses, eq(inventoryMovements.warehouseId, inventoryWarehouses.id))
      .where(eq(inventoryMovements.productId, productId))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(20),
    db
      .select({
        id: inventoryProductLogs.id,
        field: inventoryProductLogs.field,
        oldValue: inventoryProductLogs.oldValue,
        newValue: inventoryProductLogs.newValue,
        createdAt: inventoryProductLogs.createdAt,
        operatorName: users.name,
        operatorUsername: users.username,
      })
      .from(inventoryProductLogs)
      .leftJoin(users, eq(inventoryProductLogs.createdBy, users.id))
      .where(eq(inventoryProductLogs.productId, productId))
      .orderBy(desc(inventoryProductLogs.createdAt))
      .limit(30),
  ])

  return {
    ok: true as const,
    product,
    totalQty: stockAgg[0]?.total ?? 0,
    movements,
    logs: logs.map((l) => ({
      ...l,
      operator: l.operatorName || l.operatorUsername,
    })),
  }
}

export async function searchProductsAction(input: unknown = {}) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = inventoryProductSearchSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: "参数错误" }

  const where = q.data.q
    ? and(
        eq(inventoryProducts.enterpriseId, g.enterpriseId),
        or(
          ilike(inventoryProducts.productCode, `%${q.data.q}%`),
          ilike(inventoryProducts.name, `%${q.data.q}%`),
        ),
      )
    : eq(inventoryProducts.enterpriseId, g.enterpriseId)

  const products = await db
    .select({
      id: inventoryProducts.id,
      productCode: inventoryProducts.productCode,
      name: inventoryProducts.name,
      imageUrl: inventoryProducts.imageUrl,
      barcodePrePasted: inventoryProducts.barcodePrePasted,
    })
    .from(inventoryProducts)
    .where(where)
    .orderBy(asc(inventoryProducts.productCode))
    .limit(q.data.limit)

  if (products.length === 0) return { ok: true as const, rows: [] }

  const sums = await db
    .select({
      productId: inventoryStocks.productId,
      total: sql<number>`coalesce(sum(${inventoryStocks.qty}), 0)::int`,
    })
    .from(inventoryStocks)
    .where(
      and(
        eq(inventoryStocks.enterpriseId, g.enterpriseId),
        inArray(inventoryStocks.productId, products.map((p) => p.id)),
      ),
    )
    .groupBy(inventoryStocks.productId)
  const sumMap = new Map(sums.map((s) => [s.productId, s.total]))

  return {
    ok: true as const,
    rows: products.map((p) => ({ ...p, totalQty: sumMap.get(p.id) ?? 0 })),
  }
}

// ---------- 库存出入（按日期范围聚合有变动的商品；独立 tab 视图） ----------

export interface InventoryMovementProductRow {
  productId: string
  productCode: string
  name: string
  imageUrl: string | null
  /** 变动笔数 */
  count: number
  /** 入库件数合计（正向变动） */
  inQty: number
  /** 出库件数合计（负向变动取正） */
  outQty: number
  /** 净变动 = 入 − 出 */
  netQty: number
  /** 当前库存（各仓合计） */
  currentQty: number
}

/** 北京时间日期范围 [from 00:00, to+1d) 内有变动的商品聚合（笔数/入/出/净）+ 当前库存 */
export async function getInventoryMovementProductsAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = inventoryMovementsQuerySchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: "参数错误" }

  // 北京时间日界（与 TEMU 日口径同源，和服务器部署时区解耦）
  const start = new Date(`${q.data.from}T00:00:00+08:00`)
  const end = new Date(`${q.data.to}T00:00:00+08:00`)
  end.setUTCDate(end.getUTCDate() + 1)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false as const, error: "日期格式 YYYY-MM-DD" }
  }

  const rows = await db
    .select({
      productId: inventoryMovements.productId,
      productCode: inventoryProducts.productCode,
      name: inventoryProducts.name,
      imageUrl: inventoryProducts.imageUrl,
      count: sql<number>`count(*)::int`,
      inQty: sql<number>`coalesce(sum(${inventoryMovements.qtyChange}) filter (where ${inventoryMovements.qtyChange} > 0), 0)::int`,
      outQty: sql<number>`coalesce(-sum(${inventoryMovements.qtyChange}) filter (where ${inventoryMovements.qtyChange} < 0), 0)::int`,
    })
    .from(inventoryMovements)
    .innerJoin(inventoryProducts, eq(inventoryMovements.productId, inventoryProducts.id))
    .where(
      and(
        eq(inventoryMovements.enterpriseId, g.enterpriseId),
        gte(inventoryMovements.createdAt, start),
        lt(inventoryMovements.createdAt, end),
      ),
    )
    .groupBy(
      inventoryMovements.productId,
      inventoryProducts.productCode,
      inventoryProducts.name,
      inventoryProducts.imageUrl,
    )

  // 当前库存：各仓合计（同 searchProductsAction 的 sums 模式）
  const sums =
    rows.length > 0
      ? await db
          .select({
            productId: inventoryStocks.productId,
            total: sql<number>`coalesce(sum(${inventoryStocks.qty}), 0)::int`,
          })
          .from(inventoryStocks)
          .where(
            and(
              eq(inventoryStocks.enterpriseId, g.enterpriseId),
              inArray(inventoryStocks.productId, rows.map((r) => r.productId)),
            ),
          )
          .groupBy(inventoryStocks.productId)
      : []
  const sumMap = new Map(sums.map((s) => [s.productId, s.total]))

  const mapped: InventoryMovementProductRow[] = rows
    .map((r) => ({
      productId: r.productId,
      productCode: r.productCode,
      name: r.name,
      imageUrl: r.imageUrl,
      count: r.count,
      inQty: r.inQty,
      outQty: r.outQty,
      netQty: r.inQty - r.outQty,
      currentQty: sumMap.get(r.productId) ?? 0,
    }))
    .sort((a, b) => a.productCode.localeCompare(b.productCode))

  return {
    ok: true as const,
    rows: mapped,
    summary: {
      products: mapped.length,
      inQty: mapped.reduce((acc, r) => acc + r.inQty, 0),
      outQty: mapped.reduce((acc, r) => acc + r.outQty, 0),
    },
  }
}
