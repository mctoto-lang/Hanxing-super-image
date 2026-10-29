import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises } from "@/db/schema"
import { temuStores, temuSalesOverviews, temuProducts, temuSkuMaps } from "@/db/schema/temu"
import {
  getTemuProductSalesInfoAction,
  getTemuProductsAction,
  getTemuProductsPageAction,
} from "@/server/actions/temu"
import { temuDayStr } from "@/server/services/temu-time"

/**
 * 商品信息页数据链路回归：getTemuProductsPageAction / getTemuProductSalesInfoAction
 * （覆盖 salesInfo 子查询 raw SQL 别名坑——hotFlag 未 .as() 曾在页面渲染时抛
 * "raw SQL field doesn't have an alias"；本测试走真实 DB 查询路径防回归）。
 */

// action 走 requireEnterpriseContext → auth()；vitest 无法加载 next-auth，mock 成可控 session
const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
// 缓存透传：绕过 TTL 直接执行 loader，测的就是真实查询
vi.mock("@/server/services/temu-cache", () => ({
  temuCached: (_key: string, load: () => Promise<unknown>) => load(),
  invalidateTemuCache: () => {},
}))

let entId: string
let storeId: string
const SKC_A = "990001"
const SKC_B = "990002"

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "temu 商品页测试企业",
      slug: `pg-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
    })
    .returning()
  entId = ent!.id

  const [user] = await db
    .insert((await import("@/db/schema")).users)
    .values({
      enterpriseId: entId,
      username: `pg-${randomUUID().slice(0, 8)}`,
      email: `pg-${randomUUID().slice(0, 8)}@test.local`,
      name: "pg 测试用户",
      passwordHash: "x",
    })
    .returning()
  mockSession.userId = user!.id

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "pg 测试店铺",
      accessTokenEncrypted: null,
      tokenState: "none",
    })
    .returning()
  storeId = store!.id

  const capturedAt = new Date()
  const capturedDay = temuDayStr(capturedAt)
  const hash = (s: string) => s.padEnd(40, "0")
  await db.insert(temuSalesOverviews).values([
    {
      storeId,
      skcId: SKC_A,
      capturedAt,
      capturedDay,
      productName: "热销测试商品",
      category: "算命玩具",
      todaySalesVolume: 5,
      last7DaysSalesVolume: 35,
      last30DaysSalesVolume: 120,
      warehouseAvailableStock: 42,
      availableSaleDays: 8.5,
      overview: {
        hotTag: true,
        isFirst: true,
        onSalesDurationOffline: 45,
        pictureAuditStatus: 2,
      },
      priceDetail: [
        {
          productSkuId: 80001,
          skuExtCode: "SKU-80001",
          className: "M",
          todaySaleVolume: 5,
          lastSevenDaysSaleVolume: 35,
          lastThirtyDaysSaleVolume: 120,
          totalSaleVolume: 900,
          supplierPrice: 1990,
          warehouseGroupName: "广东仓组1",
          purchaseConfig: "4 + 3",
          lackQuantity: 0,
          inCartNumber7d: 12,
          inCardNumber: 5,
          safeInventoryDays: 7,
          canPurchase: true,
          priceReviewStatus: 2,
          isVerifyPrice: false,
          // 细分库存实测随 SKU 行返回（SKC 级 overview 不带）
          inventoryNumInfo: {
            waitOnShelfNum: 3,
            warehouseInventoryNum: 46,
            expectedOccupiedInventoryNum: 5,
            waitApproveInventoryNum: 0,
            waitInStock: 10,
            waitReceiveNum: 2,
            waitDeliveryInventoryNum: 7,
            waitQcNum: 1,
            unavailableWarehouseInventoryNum: 0,
          },
        },
        {
          // salesv2 不再返回 SKU 价格（supplierPrice null）→ 由 sku_map 合并
          productSkuId: 80002,
          skuExtCode: "SKU-80002",
          className: "L",
          todaySaleVolume: 0,
          supplierPrice: null,
        },
      ],
      contentHash: hash("a"),
    },
    {
      storeId,
      skcId: SKC_B,
      capturedAt,
      capturedDay,
      productName: "非热销测试商品",
      todaySalesVolume: 0,
      warehouseAvailableStock: 3,
      overview: { hotTag: false },
      priceDetail: [],
      contentHash: hash("b"),
    },
  ])

  // SKU 级价格（price.list.get 回填 sku_map）
  await db.insert(temuSkuMaps).values([
    { storeId, skuId: "80001", skcId: SKC_A, supplierPrice: 1990 },
    { storeId, skuId: "80002", skcId: SKC_A, supplierPrice: 2590 },
  ])

  // 排序用商品行：货号 B2/B10/空 + 上架时间错开；销售行给 today 排序口径
  await db.insert(temuProducts).values([
    { storeId, productSkcId: "990101", productId: "7101", productSn: "B10", skcCreatedAt: 1000 },
    { storeId, productSkcId: "990102", productId: "7102", productSn: "B2", skcCreatedAt: 3000 },
    { storeId, productSkcId: "990103", productId: "7103", productSn: null, skcCreatedAt: 2000 },
  ])
  await db.insert(temuSalesOverviews).values([
    { storeId, skcId: "990101", capturedAt, capturedDay, todaySalesVolume: 5, priceDetail: [], contentHash: hash("s1") },
    { storeId, skcId: "990102", capturedAt, capturedDay, todaySalesVolume: 9, priceDetail: [], contentHash: hash("s2") },
  ])
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

describe("商品信息页 salesInfo 链路", () => {
  it("getTemuProductSalesInfoAction：hotTag、SKU 明细与展开面板字段提取正确", async () => {
    const info = await getTemuProductSalesInfoAction(storeId, [SKC_A, SKC_B])
    expect(info.latest[SKC_A]?.hotTag).toBe(true)
    expect(info.latest[SKC_A]?.skus.length).toBe(2)
    expect(info.latest[SKC_A]?.skus[0]?.className).toBe("M")
    expect(info.latest[SKC_A]?.skus[0]?.supplierPrice).toBe(1990)
    // 叶子类目透传（salesv2 category 口径，goods-list leafCat 不返回）
    expect(info.latest[SKC_A]?.leafCategory).toBe("算命玩具")
    expect(info.latest[SKC_B]?.hotTag).toBe(false)
    expect(info.latest[SKC_B]?.skus.length).toBe(0)

    const a = info.latest[SKC_A]?.extra
    expect(a?.isFirst).toBe(true)
    expect(a?.last7DaysSalesVolume).toBe(35)
    expect(a?.last30DaysSalesVolume).toBe(120)
    expect(a?.onSalesDurationDays).toBe(45)
    expect(a?.inCartNumber7d).toBe(12)
    expect(a?.inCardNumber).toBe(5)
    expect(a?.stockDays).toBe(7) // stockDays 缺失时回退 safeInventoryDays
    expect(a?.canPurchase).toBe(true)
    expect(a?.pictureAuditStatus).toBe(2)
    expect(a?.illegalReason).toBeNull()
    expect(a?.inventoryInfo?.waitQcNum).toBe(1)
    expect(a?.inventoryInfo?.waitInStock).toBe(10)
    // 九项恒定齐全（官方 inventoryNumInfo 全量口径）：主值仓内库存 + 预计占用也聚合
    expect(a?.inventoryInfo).toMatchObject({
      waitOnShelfNum: 3,
      warehouseInventoryNum: 46,
      expectedOccupiedInventoryNum: 5,
      waitApproveInventoryNum: 0,
      waitInStock: 10,
      waitReceiveNum: 2,
      waitDeliveryInventoryNum: 7,
      waitQcNum: 1,
      unavailableWarehouseInventoryNum: 0,
    })
    expect(a?.priceReview).toEqual({ verified: false, reviewStatus: 2 })

    // SKU 级价格合并：salesv2 行内 null 的价格由 sku_map（price.list.get）补齐
    const sku2 = info.latest[SKC_A]?.skus.find((s) => String(s.productSkuId) === "80002")
    expect(sku2?.supplierPrice).toBe(2590)
    const sku1 = info.latest[SKC_A]?.skus.find((s) => String(s.productSkuId) === "80001")
    expect(sku1?.supplierPrice).toBe(1990)
    // 仓组/备货配置透传（其他信息组聚合源）
    expect(sku1?.warehouseGroupName).toBe("广东仓组1")
    expect(sku1?.purchaseConfig).toBe("4 + 3")

    // 无 SKU 明细的商品：extra 走默认值（0/false/null），不抛错
    const b = info.latest[SKC_B]?.extra
    expect(b?.isFirst).toBe(false)
    expect(b?.last7DaysSalesVolume).toBe(0)
    expect(b?.canPurchase).toBe(false)
    expect(b?.inventoryInfo).toBeNull()
  })

  it("getTemuProductsPageAction：整链路（行 + salesInfo 子查询）不抛别名错误", async () => {
    const r = await getTemuProductsPageAction(storeId, undefined, "on", 1)
    // fixture 未写 temu_product 行（sale=on 空集），但不抛错即验证了子查询链路；
    // salesInfo 独立于 sale 过滤按 skcIds 查询——这里直接补验（空 ids 走短路）
    expect(Array.isArray(r.rows)).toBe(true)
    const info2 = await getTemuProductsPageAction(storeId, undefined, undefined, 1)
    expect(Array.isArray(info2.rows)).toBe(true)
    void temuDayStr
  })

  it("商品排序：货号空值最上 + B 后数字自然序", async () => {
    const r = await getTemuProductsAction(storeId, undefined, 1, undefined, "sn")
    // 空货号最上，B2 在 B10 前（数字自然序，非字典序）
    expect(r.rows.map((x) => x.productSn)).toEqual([null, "B2", "B10"])
  })

  it("商品排序：今日销量高→低（无销售数据沉底）", async () => {
    const r = await getTemuProductsAction(storeId, undefined, 1, undefined, "today")
    expect(r.rows.map((x) => x.productSkcId)).toEqual(["990102", "990101", "990103"])
  })

  it("商品排序：默认上架时间新→旧", async () => {
    const r = await getTemuProductsAction(storeId, undefined, 1, undefined)
    expect(r.rows.map((x) => x.productSkcId)).toEqual(["990102", "990103", "990101"])
  })
})
