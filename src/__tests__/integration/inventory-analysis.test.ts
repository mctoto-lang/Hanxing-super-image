import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, permissionGroups, temuStores, temuSalesOverviews } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import {
  inventoryFactories,
  inventoryProducts,
  inventoryProductionOrders,
  inventorySnapshots,
  inventoryWarehouses,
} from "@/db/schema/inventory"
import {
  getInventoryOverviewAction,
  getInventorySettingsAction,
  manualMovementAction,
  updateRestockThresholdAction,
} from "@/server/actions/inventory"
import { runDailyInventorySnapshots } from "@/server/services/inventory-snapshot"
import {
  createProductionOrdersFromAdviceAction,
  getInventoryAlertSummaryAction,
  getInventoryAnalysisAction,
  getReplenishmentAdviceAction,
} from "@/server/actions/inventory-analysis"

/**
 * 分析域回归（六态版）：日快照 upsert / 补货建议（加权日销单轨、MOQ 取整、
 * 上限卡量、停止生产排除、无销速不出建议、滞销标记）/ 批量建单 / 预警汇总
 * （六态口径）/ 总览状态（六态 + 阈值配置 + B049≡B49 归一化 + TEMU 净库存）/
 * 库存分析页一次取数（KPI/六态分布/趋势/流量/销速 TOP/待处理清单）。
 */

const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

let entId: string
let userId: string
let storeId: string
let mainWhId: string

/** 销速行（今日销量按天累计口径写入 todaySalesVolume）。
 *  opts.skcId 固定 SKC（默认每天一个独立 SKC）；warehouse/waitDelivery 落库存字段（TEMU 净库存用）。 */
async function seedSales(
  code: string,
  daily: number,
  days: number,
  opts: { skcId?: string; warehouse?: number; waitDelivery?: number } = {},
) {
  const rows = Array.from({ length: days }, (_, i) => {
    const day = new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10)
    return {
      storeId,
      skcId: opts.skcId ?? `SKC-${code}-${i}`,
      capturedAt: new Date(),
      capturedDay: day,
      productSn: code,
      todaySalesVolume: daily,
      warehouseAvailableStock: opts.warehouse ?? null,
      waitDeliveryStock: opts.waitDelivery ?? null,
      contentHash: `hash-${code}-${i}${opts.skcId ?? ""}`,
    }
  })
  await db.insert(temuSalesOverviews).values(rows).onConflictDoNothing()
}

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "分析测试企业",
      slug: `ana-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      enabledModules: [...MODULE_NAMES],
    })
    .returning()
  entId = ent!.id
  const [group] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: entId,
      name: "库存权限组",
      allowedPages: ["settings", "inventory"],
    })
    .returning()
  const [user] = await db
    .insert((await import("@/db/schema")).users)
    .values({
      enterpriseId: entId,
      groupId: group!.id,
      username: `ana-${randomUUID().slice(0, 8)}`,
      email: `ana-${randomUUID().slice(0, 8)}@test.local`,
      name: "分析测试用户",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  userId = user!.id
  mockSession.userId = userId

  const [store] = await db
    .insert(temuStores)
    .values({ enterpriseId: entId, name: "分析测试店", tokenState: "active" })
    .returning()
  storeId = store!.id

  await db.insert(inventoryWarehouses).values([
    { enterpriseId: entId, code: "main", name: "主仓", sort: 0 },
    { enterpriseId: entId, code: "yiwu", name: "义乌仓", sort: 1 },
  ])
  const whs = await db
    .select()
    .from(inventoryWarehouses)
    .where(eq(inventoryWarehouses.enterpriseId, entId))
  mainWhId = whs.find((w) => w.code === "main")!.id
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

async function createProduct(code: string, over: Partial<typeof inventoryProducts.$inferInsert> = {}) {
  const [p] = await db
    .insert(inventoryProducts)
    .values({ enterpriseId: entId, productCode: code, name: `${code} 款`, createdBy: userId, ...over })
    .returning()
  return p!
}

describe("日快照 + 补货建议 + 库存分析", () => {
  it("日快照 upsert（存在则更新为最新）", async () => {
    const p = await createProduct("A9001")
    await manualMovementAction({
      productId: p.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 100,
      reason: "建账",
    })
    const n = await runDailyInventorySnapshots()
    expect(n).toBeGreaterThanOrEqual(1)
    const [snap1] = await db
      .select()
      .from(inventorySnapshots)
      .where(eq(inventorySnapshots.productId, p.id))
    expect(snap1?.qty).toBe(100)

    await manualMovementAction({
      productId: p.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 50,
      reason: "补货",
    })
    await runDailyInventorySnapshots()
    const [snap2] = await db
      .select()
      .from(inventorySnapshots)
      .where(eq(inventorySnapshots.productId, p.id))
    expect(snap2?.qty).toBe(150)
  })

  it("补货建议：销速轨 + MOQ/装箱取整 + 上限卡量 + 停止生产排除 + 无销速不出建议 + 滞销标记", async () => {
    // B9001：销速轨。日均 10、周期 10+缓冲 7 → 目标 170；现有 150 → 建议 20 → MOQ 100 → 装箱 105 取整 → 210 → 上限 200-150=50 → 卡到 50
    const b = await createProduct("B9001", {
      leadTimeDays: 10,
      cartonQty: 105,
      moq: 100,
      stockUpper: 200,
    })
    await manualMovementAction({
      productId: b.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 150,
      reason: "建账",
    })
    await seedSales("B9001", 10, 14)

    // C9001：无销速数据（安全库存轨已移除）→ 不再出建议
    const c = await createProduct("C9001")
    await manualMovementAction({
      productId: c.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 20,
      reason: "建账",
    })

    // D9001：停止生产（有销速也排除）
    const d = await createProduct("D9001", {
      leadTimeDays: 10,
      productionState: "stopped",
    })
    await manualMovementAction({
      productId: d.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 10,
      reason: "建账",
    })
    await seedSales("D9001", 5, 14)

    // E9001：滞销（近30天有数据但 0 销量且有库存）
    const e = await createProduct("E9001")
    await manualMovementAction({
      productId: e.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 30,
      reason: "建账",
    })
    await seedSales("E9001", 0, 14)

    const r = await getReplenishmentAdviceAction({ bufferDays: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const bRow = r.rows.find((x) => x.productCode === "B9001")
    expect(bRow?.dailySales).toBe(10)
    expect(bRow?.targetQty).toBe(170)
    expect(bRow?.suggestQty).toBe(50) // 卡上限

    expect(r.rows.find((x) => x.productCode === "C9001")).toBeUndefined() // 无销速不出建议

    expect(r.rows.find((x) => x.productCode === "D9001")).toBeUndefined()

    const eRow = r.rows.find((x) => x.productCode === "E9001")
    expect(eRow?.stagnant).toBe(true)
  })

  it("预警汇总（六态）：缺货/补货/滞销；默认阈值 14 天", async () => {
    await createProduct("F9001", { productionState: "active" }) // 缺货（0 库存）
    await createProduct("G9001", { productionState: "active" }) // 0 库存 → 先算缺货
    const h = await createProduct("H9001", { productionState: "active" }) // 补货：可售 6 天 < 14
    await manualMovementAction({
      productId: h.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 30,
      reason: "建账",
    })
    await seedSales("H9001", 5, 14) // 日销 5 → 可售 30/5=6 天 < 14 → 补货

    const r = await getInventoryAlertSummaryAction()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.outOfStock).toContain("F9001")
    expect(r.outOfStock).toContain("G9001")
    expect(r.restock).toContain("H9001")
    expect(r.restock).not.toContain("B9001") // 可售 15 天 ≥ 阈值 14 → 正常
    expect(r.stagnant).toContain("E9001")
  })

  it("总览六态 + 阈值配置 + B049≡B49 归一化 + TEMU 净库存", async () => {
    // 阈值改为 20 天（企业级配置；影响后续所有六态判定）
    const upd = await updateRestockThresholdAction({ thresholdDays: 20 })
    expect(upd.ok).toBe(true)
    if (!upd.ok) return
    expect(upd.thresholdDays).toBe(20)

    const j = await createProduct("J9001", { leadTimeDays: 10 })
    const k = await createProduct("K9001", { leadTimeDays: 10 })
    await manualMovementAction({
      productId: j.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 10,
      reason: "建账",
    })
    await manualMovementAction({
      productId: k.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 10,
      reason: "建账",
    })
    await seedSales("J9001", 5, 14)
    await seedSales("K9001", 5, 14)
    const [factory] = await db
      .insert(inventoryFactories)
      .values({ enterpriseId: entId, code: "ZT", name: "状态测试工厂" })
      .returning()
    await db.insert(inventoryProductionOrders).values({
      enterpriseId: entId,
      productId: k.id,
      factoryId: factory!.id,
      quantity: 20,
      productionDate: new Date().toISOString().slice(0, 10),
    })

    // B49 档案 ↔ TEMU 货号 B049（归一化后同为 49）：销速/净库存都应匹配上；
    // TEMU 净库存 = 仓内 12 − 待发货 5 = 7
    const b49 = await createProduct("B49")
    await manualMovementAction({
      productId: b49.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 40,
      reason: "建账",
    })
    await seedSales("B049", 4, 14, { skcId: "SKC-B049-FIX", warehouse: 12, waitDelivery: 5 })

    // Q9001：停止生产 + 0 库存 → 停产（D9001 停止生产有库存 → 清仓）
    await createProduct("Q9001", { productionState: "stopped" })

    const r = await getInventoryOverviewAction({})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.thresholdDays).toBe(20)
    const byCode = (code: string) => r.rows.find((x) => x.productCode === code)
    // 可售 15 天 < 20 → 补货；TEMU 无数据 0
    expect(byCode("B9001")).toMatchObject({
      status: "restock",
      temuStock: 0,
      dailySales: 10,
      availableDays: 15,
    })
    // J 可售 2 天；K 在产计入分子可售 (10+20)/5=6 天 → 均补货
    expect(byCode("J9001")?.status).toBe("restock")
    expect(byCode("K9001")?.availableDays).toBe(6)
    // B49（TEMU 侧 B049）：日销 4、TEMU 净库存 7 → 可售 (40+7)/4=11.8 → 补货
    expect(byCode("B49")).toMatchObject({
      status: "restock",
      dailySales: 4,
      temuStock: 7,
      availableDays: 11.8,
    })
    // 停止生产分支：D9001 有库存 → 清仓；Q9001 无库存 → 停产
    expect(byCode("D9001")?.status).toBe("clearance")
    expect(byCode("Q9001")?.status).toBe("discontinued")
    // E9001 有销量数据但零销量 → 滞销
    expect(byCode("E9001")?.status).toBe("stagnant")

    const s = await getInventorySettingsAction()
    expect(s.ok).toBe(true)
    if (s.ok) expect(s.thresholdDays).toBe(20)
  })

  it("批量生成生产单（每行一单，待出材料）", async () => {
    const [c] = await db
      .select()
      .from(inventoryProducts)
      .where(and(eq(inventoryProducts.enterpriseId, entId), eq(inventoryProducts.productCode, "C9001")))
    const r = await createProductionOrdersFromAdviceAction({
      factoryId: (
        await db
          .insert((await import("@/db/schema/inventory")).inventoryFactories)
          .values({ enterpriseId: entId, code: "JS", name: "测试工厂" })
          .returning()
      )[0]!.id,
      items: [{ productId: c!.id, qty: 180 }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.created).toBe(1)
    const [order] = await db
      .select()
      .from(inventoryProductionOrders)
      .where(eq(inventoryProductionOrders.productId, c!.id))
    expect(order?.status).toBe("materials_pending")
    expect(order?.quantity).toBe(180)
  })

  it("库存分析：KPI/六态分布/趋势/流量/销速 TOP/可售天数/待处理清单一次取数", async () => {
    const r = await getInventoryAnalysisAction({ window: 14 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // KPI：六态计数与建档货号
    expect(r.thresholdDays).toBe(20)
    expect(r.cards.productCount).toBeGreaterThanOrEqual(6)
    expect(r.cards.stockedCount).toBeGreaterThanOrEqual(5)
    expect(r.cards.outOfStockCount).toBeGreaterThanOrEqual(1)
    expect(r.cards.restockCount).toBeGreaterThanOrEqual(3)
    // 六态分布合计 = 货号总数
    const statusSum = Object.values(r.statusCounts).reduce((s, v) => s + v, 0)
    expect(statusSum).toBe(r.cards.productCount)
    // 总量趋势（日快照）
    expect(r.trend.length).toBeGreaterThanOrEqual(1)
    // 出入库流量：期间手动入库流水存在（净额为正）
    expect(r.flowTypes.some((t) => t.type === "manual_in" && t.qty > 0)).toBe(true)
    expect(r.flowDaily.length).toBeGreaterThanOrEqual(1)
    // 销速 TOP：B9001 加权日销 10（seed 各天等量 → 7/30 均相同）
    const b = r.topSales.find((x) => x.productCode === "B9001")
    expect(b?.dailySales).toBe(10)
    expect(b?.availableDays).toBe(15) // 150 ÷ 10
    // 归一化：B49 走 TEMU B049 销速与净库存
    const b49 = r.topSales.find((x) => x.productCode === "B49")
    expect(b49).toMatchObject({ dailySales: 4, temuStock: 7, availableDays: 11.8 })
    // 可售天数分布：合计 = 有销速有库存 + 无销速有库存（仅有库存货号）
    const bucketSum = r.daysBuckets.reduce((s, x) => s + x.count, 0)
    expect(bucketSum).toBeGreaterThanOrEqual(1)
    // 待处理清单：补货（含缺口）→ 滞销 → 清仓
    const pB = r.pending.find((x) => x.productCode === "B9001")
    expect(pB?.status).toBe("restock")
    expect(pB?.gapQty).toBe(50) // ceil(20×10 − 150)
    expect(r.pending.some((x) => x.productCode === "E9001" && x.status === "stagnant")).toBe(true)
    expect(r.pending.some((x) => x.productCode === "D9001" && x.status === "clearance")).toBe(true)
  })
})
