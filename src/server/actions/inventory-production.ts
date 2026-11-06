"use server"

import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  inventoryDirectShips,
  inventoryFactories,
  inventoryMovements,
  inventoryProducts,
  inventoryProductionOrders,
  inventoryWarehouses,
} from "@/db/schema"
import {
  inventoryFactorySchema,
  inventoryFactoryUpdateSchema,
  productionDeleteSchema,
  productionDirectShipSchema,
  productionFactoryShipSchema,
  productionListQuerySchema,
  productionOrderCreateSchema,
  productionReceiptSchema,
  productionSendMaterialsSchema,
} from "@/server/schemas/inventory"
import {
  applyMovements,
  getMainWarehouseId,
  requireInventory,
} from "@/server/services/inventory-core"
import { temuDayStr } from "@/server/services/temu-time"

/**
 * 生产规划 action 层：工厂档案 + 生产单五态流转 + 直发（先行扣量）+ 分批入库 +
 * 删除自动冲正。生产单数学：待入库 = 数量 − Σ直发 − Σ入库；
 * Σ直发+Σ入库 ≥ 数量自动转「已入库」。
 */

type OrderStatus =
  | "materials_pending"
  | "producing"
  | "factory_shipped"
  | "received"
  | "finished"

const OPEN_STATUSES: OrderStatus[] = ["materials_pending", "producing", "factory_shipped"]

function addDays(dateStr: string, days: number | null | undefined): string | null {
  if (!days) return null
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 取本企业生产单（含归属校验） */
async function loadOrder(enterpriseId: string, orderId: string) {
  const [row] = await db
    .select()
    .from(inventoryProductionOrders)
    .where(
      and(
        eq(inventoryProductionOrders.id, orderId),
        eq(inventoryProductionOrders.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  return row ?? null
}

/** Σ直发+Σ入库 ≥ 数量 → 自动转已入库（仅进行中态触发） */
async function maybeAutoReceived(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orderId: string,
  directQty: number,
  shippedQty: number,
  quantity: number,
  status: string,
) {
  if (
    (status === "producing" || status === "factory_shipped") &&
    directQty + shippedQty >= quantity
  ) {
    await tx
      .update(inventoryProductionOrders)
      .set({ status: "received", updatedAt: new Date() })
      .where(eq(inventoryProductionOrders.id, orderId))
    return true
  }
  return false
}

// ---------- 工厂档案 ----------

export async function listFactoriesAction() {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const rows = await db
    .select()
    .from(inventoryFactories)
    .where(eq(inventoryFactories.enterpriseId, g.enterpriseId))
    .orderBy(asc(inventoryFactories.code))
  return { ok: true as const, rows }
}

export async function saveFactoryAction(
  input: unknown,
  factoryId?: string,
) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = inventoryFactorySchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }

  if (factoryId) {
    // 更新用无默认 schema：enabled 缺省不写入（防把已停用工厂静默重启用）
    const u = inventoryFactoryUpdateSchema.safeParse(input)
    if (!u.success) return { ok: false as const, error: u.error.issues[0]?.message ?? "参数错误" }
    // 重码预检（排除自身；撞 inv_factory_ent_code 唯一约束前先给出可读错误）
    const [dup] = await db
      .select({ id: inventoryFactories.id })
      .from(inventoryFactories)
      .where(
        and(
          eq(inventoryFactories.enterpriseId, g.enterpriseId),
          eq(inventoryFactories.code, u.data.code),
          ne(inventoryFactories.id, factoryId),
        ),
      )
      .limit(1)
    if (dup) return { ok: false as const, error: `工厂代号 ${u.data.code} 已存在` }
    const [row] = await db
      .update(inventoryFactories)
      .set({ ...u.data, note: u.data.note ?? null, updatedAt: new Date() })
      .where(
        and(
          eq(inventoryFactories.id, factoryId),
          eq(inventoryFactories.enterpriseId, g.enterpriseId),
        ),
      )
      .returning()
    if (!row) return { ok: false as const, error: "工厂不存在" }
    return { ok: true as const, factory: row }
  }

  const [dup] = await db
    .select({ id: inventoryFactories.id })
    .from(inventoryFactories)
    .where(
      and(
        eq(inventoryFactories.enterpriseId, g.enterpriseId),
        eq(inventoryFactories.code, q.data.code),
      ),
    )
    .limit(1)
  if (dup) return { ok: false as const, error: `工厂代号 ${q.data.code} 已存在` }

  const [row] = await db
    .insert(inventoryFactories)
    .values({ ...q.data, note: q.data.note ?? null, enterpriseId: g.enterpriseId })
    .returning()
  return { ok: true as const, factory: row! }
}

export async function deleteFactoryAction(factoryId: string) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const [ref] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryProductionOrders)
    .where(eq(inventoryProductionOrders.factoryId, factoryId))
  if (ref!.n > 0) {
    return { ok: false as const, error: `该工厂已有 ${ref!.n} 张生产单，不可删除（可停用）` }
  }
  await db
    .delete(inventoryFactories)
    .where(
      and(
        eq(inventoryFactories.id, factoryId),
        eq(inventoryFactories.enterpriseId, g.enterpriseId),
      ),
    )
  return { ok: true as const }
}

// ---------- 生产单：建单 / 编辑 ----------

export async function createProductionOrderAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = productionOrderCreateSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }

  const [product] = await db
    .select({ id: inventoryProducts.id, leadTimeDays: inventoryProducts.leadTimeDays })
    .from(inventoryProducts)
    .where(
      and(
        eq(inventoryProducts.id, q.data.productId),
        eq(inventoryProducts.enterpriseId, g.enterpriseId),
      ),
    )
    .limit(1)
  if (!product) return { ok: false as const, error: "商品档案不存在" }
  const [factory] = await db
    .select({ id: inventoryFactories.id })
    .from(inventoryFactories)
    .where(
      and(
        eq(inventoryFactories.id, q.data.factoryId),
        eq(inventoryFactories.enterpriseId, g.enterpriseId),
      ),
    )
    .limit(1)
  if (!factory) return { ok: false as const, error: "工厂不存在" }

  const [row] = await db
    .insert(inventoryProductionOrders)
    .values({
      enterpriseId: g.enterpriseId,
      productId: q.data.productId,
      factoryId: q.data.factoryId,
      quantity: q.data.quantity,
      productionDate: q.data.productionDate,
      packaged: q.data.packaged,
      auxBarcode: q.data.auxBarcode,
      auxManual: q.data.auxManual,
      auxBubble: q.data.auxBubble,
      auxWarn: q.data.auxWarn,
      expectedDate: addDays(q.data.productionDate, product.leadTimeDays),
      note: q.data.note ?? null,
      createdBy: g.ctx.user.id,
    })
    .returning()
  return { ok: true as const, order: row! }
}

/** 编辑（仅进行中前三态可改；数量/日期改动会重算预计交期） */
export async function updateProductionOrderAction(orderId: string, input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = productionOrderCreateSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  const order = await loadOrder(g.enterpriseId, orderId)
  if (!order) return { ok: false as const, error: "生产单不存在" }
  if (!OPEN_STATUSES.includes(order.status as OrderStatus)) {
    return { ok: false as const, error: "已入库/已结束的生产单不可编辑" }
  }
  // 余量不可为负：数量下限 = Σ直发+Σ入库（否则后续直发/入库全被超余量拦截）
  if (q.data.quantity < order.directQty + order.shippedQty) {
    return {
      ok: false as const,
      error: `数量不可低于已直发+已入库累计 ${order.directQty + order.shippedQty} 件`,
    }
  }
  const [product] = await db
    .select({ id: inventoryProducts.id, leadTimeDays: inventoryProducts.leadTimeDays })
    .from(inventoryProducts)
    .where(
      and(
        eq(inventoryProducts.id, q.data.productId),
        eq(inventoryProducts.enterpriseId, g.enterpriseId),
      ),
    )
    .limit(1)
  if (!product) return { ok: false as const, error: "商品档案不存在" }
  const [factory] = await db
    .select({ id: inventoryFactories.id })
    .from(inventoryFactories)
    .where(
      and(
        eq(inventoryFactories.id, q.data.factoryId),
        eq(inventoryFactories.enterpriseId, g.enterpriseId),
      ),
    )
    .limit(1)
  if (!factory) return { ok: false as const, error: "工厂不存在" }

  const [row] = await db
    .update(inventoryProductionOrders)
    .set({
      productId: q.data.productId,
      factoryId: q.data.factoryId,
      quantity: q.data.quantity,
      productionDate: q.data.productionDate,
      packaged: q.data.packaged,
      auxBarcode: q.data.auxBarcode,
      auxManual: q.data.auxManual,
      auxBubble: q.data.auxBubble,
      auxWarn: q.data.auxWarn,
      expectedDate: addDays(q.data.productionDate, product?.leadTimeDays ?? null),
      note: q.data.note ?? null,
      updatedAt: new Date(),
    })
    .where(eq(inventoryProductionOrders.id, orderId))
    .returning()
  return { ok: true as const, order: row! }
}

// ---------- 状态流转 ----------

/** 发材料：待出材料 → 生产中（可顺带改辅料勾选） */
export async function sendMaterialsAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = productionSendMaterialsSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: "参数错误" }
  const order = await loadOrder(g.enterpriseId, q.data.orderId)
  if (!order) return { ok: false as const, error: "生产单不存在" }
  if (order.status !== "materials_pending") {
    return { ok: false as const, error: "仅「待出材料」状态可发材料" }
  }
  await db
    .update(inventoryProductionOrders)
    .set({
      status: "producing",
      ...(q.data.auxBarcode != null ? { auxBarcode: q.data.auxBarcode } : {}),
      ...(q.data.auxManual != null ? { auxManual: q.data.auxManual } : {}),
      ...(q.data.auxBubble != null ? { auxBubble: q.data.auxBubble } : {}),
      ...(q.data.auxWarn != null ? { auxWarn: q.data.auxWarn } : {}),
      updatedAt: new Date(),
    })
    .where(eq(inventoryProductionOrders.id, q.data.orderId))
  return { ok: true as const }
}

/** 登记工厂发货：生产中 → 工厂已发（重复登记覆盖箱数/日期） */
export async function registerFactoryShipAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = productionFactoryShipSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  const order = await loadOrder(g.enterpriseId, q.data.orderId)
  if (!order) return { ok: false as const, error: "生产单不存在" }
  if (order.status !== "producing" && order.status !== "factory_shipped") {
    return { ok: false as const, error: "仅「生产中」状态可登记工厂发货" }
  }
  await db
    .update(inventoryProductionOrders)
    .set({
      status: "factory_shipped",
      factoryBoxQty: q.data.boxQty ?? null,
      factoryShipDate: q.data.shipDate,
      updatedAt: new Date(),
    })
    .where(eq(inventoryProductionOrders.id, q.data.orderId))
  return { ok: true as const }
}

/** 完结：已入库 → 已结束 */
export async function finishProductionOrderAction(orderId: string) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const order = await loadOrder(g.enterpriseId, orderId)
  if (!order) return { ok: false as const, error: "生产单不存在" }
  if (order.status !== "received") {
    return { ok: false as const, error: "仅「已入库」状态可完结（未满量请继续收货或删单）" }
  }
  await db
    .update(inventoryProductionOrders)
    .set({ status: "finished", updatedAt: new Date() })
    .where(eq(inventoryProductionOrders.id, orderId))
  return { ok: true as const }
}

// ---------- 直发 / 入库 ----------

/**
 * 直发登记（一单多次，可与入库交错）：
 * destType=temu 仅记备注不动库存；destType=warehouse → 入仓（单仓制固定主仓）+「工厂直发」流水。
 * 余量校验：qty ≤ 数量 − Σ直发 − Σ入库。
 */
export async function addDirectShipAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = productionDirectShipSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  const order = await loadOrder(g.enterpriseId, q.data.orderId)
  if (!order) return { ok: false as const, error: "生产单不存在" }
  if (order.status === "materials_pending" || order.status === "finished") {
    return { ok: false as const, error: "「待出材料/已结束」状态不可登记直发" }
  }
  const remaining = order.quantity - order.directQty - order.shippedQty
  if (q.data.qty > remaining) {
    return {
      ok: false as const,
      error: `直发量超余量：剩余待发/待入库 ${remaining} 件，本次 ${q.data.qty} 件`,
    }
  }
  // 单仓制：入仓固定主仓
  const mainWhId =
    q.data.destType === "warehouse" ? await getMainWarehouseId(g.enterpriseId) : null
  if (q.data.destType === "warehouse" && !mainWhId) {
    return { ok: false as const, error: "库存未初始化，请先访问库存总览" }
  }

  return db.transaction(async (tx) => {
    // 带余量条件的原子自增（并发防线：0 行受影响=并发已超量，事务尚无副作用）
    const [bumped] = await tx
      .update(inventoryProductionOrders)
      .set({
        directQty: sql`${inventoryProductionOrders.directQty} + ${q.data.qty}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventoryProductionOrders.id, order.id),
          sql`${inventoryProductionOrders.directQty} + ${inventoryProductionOrders.shippedQty} + ${q.data.qty} <= ${order.quantity}`,
        ),
      )
      .returning({
        directQty: inventoryProductionOrders.directQty,
        shippedQty: inventoryProductionOrders.shippedQty,
      })
    if (!bumped) {
      return {
        ok: false as const,
        error: `直发量超余量：剩余待发/待入库 ${remaining} 件，本次 ${q.data.qty} 件`,
      }
    }

    const [ds] = await tx
      .insert(inventoryDirectShips)
      .values({
        enterpriseId: g.enterpriseId,
        orderId: order.id,
        productId: order.productId,
        shipDate: q.data.shipDate,
        boxQty: q.data.boxQty ?? null,
        qty: q.data.qty,
        destType: q.data.destType,
        warehouseId: q.data.destType === "warehouse" ? mainWhId! : null,
        temuRef: q.data.temuRef ?? null,
        note: q.data.note ?? null,
        createdBy: g.ctx.user.id,
      })
      .returning()

    if (q.data.destType === "warehouse") {
      await applyMovements(tx, [
        {
          enterpriseId: g.enterpriseId,
          productId: order.productId,
          warehouseId: mainWhId!,
          type: "factory_direct",
          qtyChange: q.data.qty,
          boxQty: q.data.boxQty ?? null,
          refType: "direct_ship",
          refId: ds!.id,
          reason: `工厂直发入仓${q.data.temuRef ? `（${q.data.temuRef}）` : ""}`,
          createdBy: g.ctx.user.id,
        },
      ])
    }

    await maybeAutoReceived(
      tx,
      order.id,
      bumped.directQty,
      bumped.shippedQty,
      order.quantity,
      order.status,
    )
    return { ok: true as const }
  })
}

/**
 * 分批入库：箱+件双输入件数为准；余量校验同直发；
 * Σ直发+Σ入库 ≥ 数量自动转「已入库」。
 */
export async function receiveProductionAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = productionReceiptSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  const order = await loadOrder(g.enterpriseId, q.data.orderId)
  if (!order) return { ok: false as const, error: "生产单不存在" }
  if (order.status === "materials_pending" || order.status === "finished") {
    return { ok: false as const, error: "「待出材料/已结束」状态不可入库" }
  }
  const remaining = order.quantity - order.directQty - order.shippedQty
  if (q.data.qty > remaining) {
    return {
      ok: false as const,
      error: `入库量超余量：剩余待入库 ${remaining} 件，本次 ${q.data.qty} 件`,
    }
  }
  // 单仓制：入库固定主仓
  const mainWhId = await getMainWarehouseId(g.enterpriseId)
  if (!mainWhId) return { ok: false as const, error: "库存未初始化，请先访问库存总览" }

  return db.transaction(async (tx) => {
    // 带余量条件的原子自增（并发防线：0 行受影响=并发已超收，事务尚无副作用）
    const [bumped] = await tx
      .update(inventoryProductionOrders)
      .set({
        shippedQty: sql`${inventoryProductionOrders.shippedQty} + ${q.data.qty}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventoryProductionOrders.id, order.id),
          sql`${inventoryProductionOrders.directQty} + ${inventoryProductionOrders.shippedQty} + ${q.data.qty} <= ${order.quantity}`,
        ),
      )
      .returning({
        directQty: inventoryProductionOrders.directQty,
        shippedQty: inventoryProductionOrders.shippedQty,
      })
    if (!bumped) {
      return {
        ok: false as const,
        error: `入库量超余量：剩余待入库 ${remaining} 件，本次 ${q.data.qty} 件`,
      }
    }

    await applyMovements(tx, [
      {
        enterpriseId: g.enterpriseId,
        productId: order.productId,
        warehouseId: mainWhId,
        type: "production_in",
        qtyChange: q.data.qty,
        boxQty: q.data.boxQty ?? null,
        refType: "production_order",
        refId: order.id,
        reason: q.data.note ?? null,
        createdBy: g.ctx.user.id,
      },
    ])
    await maybeAutoReceived(
      tx,
      order.id,
      bumped.directQty,
      bumped.shippedQty,
      order.quantity,
      order.status,
    )
    return { ok: true as const }
  })
}

/**
 * 删除生产单（错单直接删，无作废态）：
 * 无直发/入库记录 → 物理删；有记录 → 自动生成反向冲正流水（reversal，
 * 允许冲负——负库存需盘点修正）后删除；删除原因必填记入冲正流水。
 */
export async function deleteProductionOrderAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = productionDeleteSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }
  const order = await loadOrder(g.enterpriseId, q.data.orderId)
  if (!order) return { ok: false as const, error: "生产单不存在" }

  // 本单关联的库存变动流水：生产入库（refId=orderId）+ 直发入仓（refId=直发记录 id）
  const dsIds = (
    await db
      .select({ id: inventoryDirectShips.id })
      .from(inventoryDirectShips)
      .where(eq(inventoryDirectShips.orderId, order.id))
  ).map((r) => r.id)

  const related = await db
    .select()
    .from(inventoryMovements)
    .where(
      or(
        and(
          eq(inventoryMovements.refType, "production_order"),
          eq(inventoryMovements.refId, order.id),
        ),
        dsIds.length > 0
          ? and(
              eq(inventoryMovements.refType, "direct_ship"),
              inArray(inventoryMovements.refId, dsIds),
            )
          : undefined,
      ),
    )

  await db.transaction(async (tx) => {
    if (related.length > 0) {
      await applyMovements(
        tx,
        related.map((m) => ({
          enterpriseId: g.enterpriseId,
          productId: m.productId,
          warehouseId: m.warehouseId,
          type: "reversal" as const,
          qtyChange: -m.qtyChange,
          boxQty: null,
          refType: "production_order",
          refId: order.id,
          reason: `删单冲正：${q.data.reason}`,
          createdBy: g.ctx.user.id,
          allowNegative: true,
        })),
      )
    }
    await tx.delete(inventoryProductionOrders).where(eq(inventoryProductionOrders.id, order.id))
  })

  return { ok: true as const, reversed: related.length }
}

// ---------- 列表 / 详情 / 统计 ----------

export type ProductionOrderRow = {
  id: string
  productId: string
  factoryId: string
  productCode: string
  productName: string
  imageUrl: string | null
  factoryCode: string
  factoryName: string
  quantity: number
  productionDate: string
  packaged: boolean
  aux: { barcode: boolean; manual: boolean; bubble: boolean; warn: boolean }
  expectedDate: string | null
  status: OrderStatus
  shippedQty: number
  directQty: number
  remainQty: number
  factoryBoxQty: number | null
  factoryShipDate: string | null
  note: string | null
  createdAt: Date
  /** 耗时天数 = 今天 − 生产日期 */
  daysElapsed: number
  /** 是否超期（预计交期 < 今天且未完结） */
  overdue: boolean
}

export async function listProductionOrdersAction(input: unknown = {}) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = productionListQuerySchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: "参数错误" }

  const statuses =
    q.data.group === "open" ? OPEN_STATUSES : (["received", "finished"] as OrderStatus[])
  const conds = [
    eq(inventoryProductionOrders.enterpriseId, g.enterpriseId),
    inArray(inventoryProductionOrders.status, statuses),
  ]
  if (q.data.factoryId) conds.push(eq(inventoryProductionOrders.factoryId, q.data.factoryId))

  const rows = await db
    .select({
      order: inventoryProductionOrders,
      productCode: inventoryProducts.productCode,
      productName: inventoryProducts.name,
      imageUrl: inventoryProducts.imageUrl,
      factoryCode: inventoryFactories.code,
      factoryName: inventoryFactories.name,
    })
    .from(inventoryProductionOrders)
    .innerJoin(inventoryProducts, eq(inventoryProductionOrders.productId, inventoryProducts.id))
    .innerJoin(inventoryFactories, eq(inventoryProductionOrders.factoryId, inventoryFactories.id))
    .where(
      q.data.q
        ? and(
            ...conds,
            or(
              ilike(inventoryProducts.productCode, `%${q.data.q}%`),
              ilike(inventoryProducts.name, `%${q.data.q}%`),
            ),
          )
        : and(...conds),
    )
    .orderBy(desc(inventoryProductionOrders.productionDate), desc(inventoryProductionOrders.createdAt))

  const today = temuDayStr()
  // 已入库/已结束单的耗时定格：完成时间 = 该单最后一条生产入库流水
  //（type=production_in + ref 关联本单）；无流水（历史/异常）回落 now 口径
  const doneIds = rows
    .filter((r) => r.order.status === "received" || r.order.status === "finished")
    .map((r) => r.order.id)
  const doneAtMap = new Map<string, Date>()
  if (doneIds.length > 0) {
    const doneRows = await db
      .select({
        refId: inventoryMovements.refId,
        last: sql<string>`max(${inventoryMovements.createdAt})`,
      })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.enterpriseId, g.enterpriseId),
          eq(inventoryMovements.type, "production_in"),
          eq(inventoryMovements.refType, "production_order"),
          inArray(inventoryMovements.refId, doneIds),
        ),
      )
      .groupBy(inventoryMovements.refId)
    for (const d of doneRows) {
      if (d.refId && d.last) doneAtMap.set(d.refId, new Date(d.last))
    }
  }
  const mapped: ProductionOrderRow[] = rows.map((r) => ({
    id: r.order.id,
    productId: r.order.productId,
    factoryId: r.order.factoryId,
    productCode: r.productCode,
    productName: r.productName,
    imageUrl: r.imageUrl,
    factoryCode: r.factoryCode,
    factoryName: r.factoryName,
    quantity: r.order.quantity,
    productionDate: r.order.productionDate,
    packaged: r.order.packaged,
    aux: {
      barcode: r.order.auxBarcode,
      manual: r.order.auxManual,
      bubble: r.order.auxBubble,
      warn: r.order.auxWarn,
    },
    expectedDate: r.order.expectedDate,
    status: r.order.status as OrderStatus,
    shippedQty: r.order.shippedQty,
    directQty: r.order.directQty,
    remainQty: r.order.quantity - r.order.directQty - r.order.shippedQty,
    factoryBoxQty: r.order.factoryBoxQty,
    factoryShipDate: r.order.factoryShipDate,
    note: r.order.note,
    createdAt: r.order.createdAt,
    // 耗时基准：received/finished 定格在完成时点（最后一条生产入库流水），否则随 now 累计
    daysElapsed: Math.max(
      0,
      Math.floor(
        ((doneAtMap.get(r.order.id) ?? Date.now()).valueOf() -
          new Date(`${r.order.productionDate}T00:00:00Z`).getTime()) /
          86400000,
      ),
    ),
    overdue:
      Boolean(r.order.expectedDate) &&
      r.order.expectedDate! < today &&
      r.order.status !== "finished" &&
      r.order.status !== "received",
  }))

  return { ok: true as const, rows: mapped }
}

export async function getProductionOrderDetailAction(orderId: string) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const order = await loadOrder(g.enterpriseId, orderId)
  if (!order) return { ok: false as const, error: "生产单不存在" }

  const [product] = await db
    .select()
    .from(inventoryProducts)
    .where(eq(inventoryProducts.id, order.productId))
    .limit(1)
  const [factory] = await db
    .select()
    .from(inventoryFactories)
    .where(eq(inventoryFactories.id, order.factoryId))
    .limit(1)
  const [ships, movements] = await Promise.all([
    db
      .select()
      .from(inventoryDirectShips)
      .where(eq(inventoryDirectShips.orderId, orderId))
      .orderBy(desc(inventoryDirectShips.createdAt)),
    db
      .select({
        id: inventoryMovements.id,
        warehouseName: inventoryWarehouses.name,
        type: inventoryMovements.type,
        qtyChange: inventoryMovements.qtyChange,
        boxQty: inventoryMovements.boxQty,
        reason: inventoryMovements.reason,
        createdAt: inventoryMovements.createdAt,
      })
      .from(inventoryMovements)
      .innerJoin(
        inventoryWarehouses,
        eq(inventoryMovements.warehouseId, inventoryWarehouses.id),
      )
      .where(
        or(
          and(
            eq(inventoryMovements.refType, "production_order"),
            eq(inventoryMovements.refId, orderId),
          ),
          and(
            eq(inventoryMovements.refType, "direct_ship"),
            inArray(
              inventoryMovements.refId,
              (
                await db
                  .select({ id: inventoryDirectShips.id })
                  .from(inventoryDirectShips)
                  .where(eq(inventoryDirectShips.orderId, orderId))
              ).map((r) => r.id),
            ),
          ),
        ),
      )
      .orderBy(desc(inventoryMovements.createdAt)),
  ])

  return { ok: true as const, order, product: product!, factory: factory!, ships, movements }
}

/** 生产规划统计条四卡 */
export async function getProductionStatsAction() {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const [open] = await db
    .select({
      batches: sql<number>`count(*)::int`,
      qty: sql<number>`coalesce(sum(${inventoryProductionOrders.quantity}), 0)::int`,
      shipped: sql<number>`coalesce(sum(${inventoryProductionOrders.shippedQty}), 0)::int`,
      direct: sql<number>`coalesce(sum(${inventoryProductionOrders.directQty}), 0)::int`,
      waitReceive: sql<number>`coalesce(sum(case when ${inventoryProductionOrders.status} = 'factory_shipped' then ${inventoryProductionOrders.quantity} - ${inventoryProductionOrders.directQty} - ${inventoryProductionOrders.shippedQty} else 0 end), 0)::int`,
    })
    .from(inventoryProductionOrders)
    .where(
      and(
        eq(inventoryProductionOrders.enterpriseId, g.enterpriseId),
        inArray(inventoryProductionOrders.status, OPEN_STATUSES),
      ),
    )
  const [monthIn] = await db
    .select({ n: sql<number>`coalesce(sum(${inventoryMovements.qtyChange}), 0)::int` })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.enterpriseId, g.enterpriseId),
        eq(inventoryMovements.type, "production_in"),
        sql`${inventoryMovements.createdAt} >= date_trunc('month', now())`,
      ),
    )
  return {
    ok: true as const,
    stats: {
      openBatches: open!.batches,
      openQty: open!.qty,
      waitReceiveQty: open!.waitReceive,
      monthReceivedQty: monthIn!.n,
    },
  }
}
