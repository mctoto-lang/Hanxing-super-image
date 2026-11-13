import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID, createHash } from "node:crypto"
import { and, eq, count, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, permissionGroups, users, type ModuleName, MODULE_NAMES } from "@/db/schema"
import { temuApps, temuStores, temuProducts, temuSalesOverviews, temuShipOrders } from "@/db/schema/temu"
import {
  ensureDemoStores,
  cleanupDemoStores,
  DEMO_STORE_NAME,
} from "@/server/services/temu-demo"
import { isTemuDemoMode, getDemoCredential } from "@/lib/temu-api/app-config"
import { getTemuOverviewAction, syncTemuStoreAction } from "@/server/actions/temu"
import { loadTemuNetStockBySn } from "@/server/services/inventory-core"
import { callTemuApi } from "@/lib/temu-api/client"
import {
  buildDemoProducts,
  buildDemoSalesRows,
  DEMO_PRODUCT_COUNT,
  DEMO_MIN_PRICE_YUAN,
  DEMO_MIN_DAILY_QTY,
} from "@/lib/temu-api/demo-data"

/**
 * TEMU 演示模式集成测试（2026-11-11 起为内置虚拟数据）：
 * 1. 虚拟数据生成器口径：100 款、售价 ≥100 元、单日销量 ≥100、确定性
 * 2. 生命周期：无应用无店铺=演示模式；ensure 幂等创建演示店铺（不参与同步）
 *    + 落库虚拟数据（100 商品/90 天快照/30 发货单）；出现真实应用时清理
 * 3. callTemuApi 虚拟拦截层：demo 凭证返回虚拟响应（不发网络）
 * 4. 手动同步拒绝演示店铺；库存联动排除演示店铺
 */

const mockSession = vi.hoisted(() => ({ userId: null as string | null }))

vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/server/services/temu-cache", () => ({
  temuCached: (_key: string, load: () => Promise<unknown>) => load(),
  invalidateTemuCache: () => {},
}))

let entId: string
let userId: string

const hash = (s: string) => createHash("sha1").update(s).digest("hex")

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "演示模式测试企业",
      slug: `demo-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      enabledModules: [...MODULE_NAMES] as ModuleName[],
    })
    .returning()
  entId = ent!.id
  const [group] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entId, name: "演示权限组", allowedPages: ["settings", "temu", "inventory"] })
    .returning()
  const [user] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      groupId: group!.id,
      username: `demo-${randomUUID().slice(0, 8)}`,
      email: `demo-${randomUUID().slice(0, 8)}@test.local`,
      name: "演示用户",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  userId = user!.id
  mockSession.userId = userId
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

describe("虚拟数据生成器口径", () => {
  const today = "2026-11-11"
  const products = buildDemoProducts()

  it("100 款、售价 ≥100 元、日销 ≥100、确定性", () => {
    expect(products.length).toBe(DEMO_PRODUCT_COUNT)
    expect(DEMO_PRODUCT_COUNT).toBe(100)
    for (const p of products) {
      expect(p.priceFen).toBeGreaterThanOrEqual(DEMO_MIN_PRICE_YUAN * 100)
      expect(p.dailyQty.length).toBe(90)
      for (const q of p.dailyQty) expect(q).toBeGreaterThanOrEqual(DEMO_MIN_DAILY_QTY)
      expect(p.sn).toMatch(/^B\d{3}$/)
    }
    // 确定性：两次生成完全一致
    expect(buildDemoProducts()).toEqual(products)
  })

  it("销量快照 90 天 × 100 且尾批为今天", () => {
    const rows = buildDemoSalesRows(products, today)
    expect(rows.length).toBe(90 * 100)
    const last = rows.filter((r) => r.capturedDay === today)
    expect(last.length).toBe(100)
  })
})

describe("演示模式判定与生命周期", () => {
  it("无应用无店铺 = 演示模式；ensure 创建演示店铺+虚拟数据且幂等", async () => {
    expect(await isTemuDemoMode(entId)).toBe(true)
    expect(await ensureDemoStores(entId)).toBe(true)

    const [demo] = await db
      .select()
      .from(temuStores)
      .where(and(eq(temuStores.enterpriseId, entId), eq(temuStores.isDemo, true)))
    expect(demo).toBeDefined()
    expect(demo!.name).toBe(DEMO_STORE_NAME)
    expect(demo!.syncEnabled).toBe(false)
    expect(demo!.appId).toBeNull()

    // 虚拟数据落库：商品 100 / 销量 9000 / 发货单 30
    const [prodN] = await db
      .select({ n: count() })
      .from(temuProducts)
      .where(eq(temuProducts.storeId, demo!.id))
    expect(Number(prodN!.n)).toBe(100)
    const [salesN] = await db
      .select({ n: count() })
      .from(temuSalesOverviews)
      .where(eq(temuSalesOverviews.storeId, demo!.id))
    expect(Number(salesN!.n)).toBe(9000)
    const [shipN] = await db
      .select({ n: count() })
      .from(temuShipOrders)
      .where(eq(temuShipOrders.storeId, demo!.id))
    expect(Number(shipN!.n)).toBe(30)

    // F11 回归：商品表 productSkcId 为数字串口径，发货单（bigint）经 cast join
    // 商品表必须带出商品名/主图（join 条件同 getTemuShipOrdersAction）
    const prodIds = await db
      .select({ skcId: temuProducts.productSkcId })
      .from(temuProducts)
      .where(eq(temuProducts.storeId, demo!.id))
    expect(prodIds.length).toBe(100)
    expect(prodIds.every((p) => /^\d+$/.test(p.skcId))).toBe(true)
    const shipJoin = await db
      .select({
        productName: temuProducts.productName,
        mainImageUrl: temuProducts.mainImageUrl,
      })
      .from(temuShipOrders)
      .leftJoin(
        temuProducts,
        and(
          eq(temuProducts.storeId, temuShipOrders.storeId),
          sql`cast(${temuShipOrders.productSkcId} as varchar) = ${temuProducts.productSkcId}`,
        ),
      )
      .where(eq(temuShipOrders.storeId, demo!.id))
    expect(shipJoin.length).toBe(30)
    expect(shipJoin.every((r) => !!r.productName && !!r.mainImageUrl)).toBe(true)

    // 再跑一次：幂等（店铺不重复、数据不翻倍）
    expect(await ensureDemoStores(entId)).toBe(true)
    const [prodN2] = await db
      .select({ n: count() })
      .from(temuProducts)
      .where(eq(temuProducts.storeId, demo!.id))
    expect(Number(prodN2!.n)).toBe(100)
  })

  it("getTemuOverviewAction：demoMode=true 且演示店铺入列表", async () => {
    const overview = await getTemuOverviewAction(undefined)
    expect(overview.demoMode).toBe(true)
    expect(overview.stores.some((s) => s.isDemo && s.name === DEMO_STORE_NAME)).toBe(true)
  })

  it("手动同步拒绝演示店铺", async () => {
    const [demo] = await db
      .select({ id: temuStores.id })
      .from(temuStores)
      .where(and(eq(temuStores.enterpriseId, entId), eq(temuStores.isDemo, true)))
    await expect(syncTemuStoreAction({ id: demo!.id })).rejects.toThrow("演示店铺")
  })

  it("出现真实应用后：退出演示模式并清理演示店铺与数据", async () => {
    const [app] = await db
      .insert(temuApps)
      .values({ enterpriseId: entId, name: "正式应用", appKey: "ak", appSecretEncrypted: "enc:v1:s" })
      .returning()
    expect(await isTemuDemoMode(entId)).toBe(false)
    expect(await ensureDemoStores(entId)).toBe(false)

    const demos = await db
      .select({ id: temuStores.id })
      .from(temuStores)
      .where(and(eq(temuStores.enterpriseId, entId), eq(temuStores.isDemo, true)))
    expect(demos.length).toBe(0)

    await cleanupDemoStores(entId)
    await db.delete(temuApps).where(eq(temuApps.id, app!.id))
  })
})

describe("callTemuApi 虚拟拦截层", () => {
  it("demo 凭证：备货单/核价/发货单返回虚拟数据（不发网络）", async () => {
    const demo = getDemoCredential()
    expect(demo.appKey).toBe("__demo_virtual__")
    const ctx = { ...demo, rateKey: "test-demo", qps: 3 }

    const purchase = await callTemuApi<{ total: number; subOrderForSupplierList: unknown[] }>(
      "bg.purchaseorderv2.get",
      { pageNo: 1, pageSize: 50, statusList: [0, 1] },
      ctx,
    )
    expect(purchase.success).toBe(true)
    expect(purchase.result.subOrderForSupplierList.length).toBeGreaterThan(0)

    const review = await callTemuApi<{ total: number }>(
      "bg.price.review.page.query",
      { pageNo: 1, pageSize: 20 },
      ctx,
    )
    expect(review.result.total).toBe(30)

    // 调价虚拟数据：字段对齐真实接口（list/priceOrderSn），服务端过滤生效
    const adjust = await callTemuApi<{ total: number; list: Array<{ priceOrderSn: string }> }>(
      "bg.full.adjust.price.page.query",
      { pageNo: 1, pageSize: 20, status: 1 },
      ctx,
    )
    expect(adjust.result.total).toBe(20)
    expect(adjust.result.list[0]?.priceOrderSn).toBe("DEMOAJ0001")
    const adjustF = await callTemuApi<{ total: number }>(
      "bg.full.adjust.price.page.query",
      { pageNo: 1, pageSize: 20, status: 1, extCodes: ["B031"], extCodeType: 1 },
      ctx,
    )
    expect(adjustF.result.total).toBe(1)

    const ships = await callTemuApi<{ total: number; list: unknown[] }>(
      "bg.shiporderv2.get",
      { pageNo: 1, pageSize: 20 },
      ctx,
    )
    expect(ships.result.total).toBe(30)

    // 未登记端点返回空成功
    const other = await callTemuApi<Record<string, unknown>>("bg.unknown.endpoint", {}, ctx)
    expect(other.success).toBe(true)
  })
})

describe("库存联动排除演示店铺", () => {
  it("演示店铺的 TEMU 净库存不计入（真实店计入）", async () => {
    // 重进演示模式（上一 describe 已清理）
    expect(await ensureDemoStores(entId)).toBe(true)
    const [demo] = await db
      .select()
      .from(temuStores)
      .where(and(eq(temuStores.enterpriseId, entId), eq(temuStores.isDemo, true)))
    const [real] = await db
      .insert(temuStores)
      .values({ enterpriseId: entId, appId: null, name: "真实店", tokenState: "active", mallType: "full" })
      .returning()

    const day = new Date().toISOString().slice(0, 10)
    const now = new Date()
    await db.insert(temuSalesOverviews).values([
      {
        storeId: demo!.id,
        skcId: "DEMOSKC",
        capturedAt: now,
        capturedDay: day,
        contentHash: hash("d"),
        productSn: "B8001",
        warehouseAvailableStock: 5,
        waitDeliveryStock: 0,
      },
      {
        storeId: real!.id,
        skcId: "REALSKC",
        capturedAt: now,
        capturedDay: day,
        contentHash: hash("r"),
        productSn: "B8002",
        warehouseAvailableStock: 3,
        waitDeliveryStock: 0,
      },
    ])

    const net = await loadTemuNetStockBySn(entId)
    expect(net.get("B8001")).toBeUndefined()
    expect(net.get("B8002")).toBe(3)
  })
})
