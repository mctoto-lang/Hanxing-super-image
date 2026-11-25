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

  it("手动同步拒绝演示店铺（排队版 action 返回 skipped，不置排队标记）", async () => {
    const [demo] = await db
      .select({ id: temuStores.id })
      .from(temuStores)
      .where(and(eq(temuStores.enterpriseId, entId), eq(temuStores.isDemo, true)))
    const r = await syncTemuStoreAction({ id: demo!.id })
    expect(r.queued).toBeUndefined()
    expect(r.skipped).toContain("演示店铺")
    const [after] = await db
      .select({ flag: temuStores.syncRequestedAt })
      .from(temuStores)
      .where(eq(temuStores.id, demo!.id))
    expect(after?.flag).toBeNull()
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

  it("demo 凭证：广告四端点形状对齐消费端（可投性/创建/实时状态/推荐 ROAS）", async () => {
    const ctx = { ...getDemoCredential(), rateKey: "test-demo-ads", qps: 3 }
    const products = buildDemoProducts()

    // goods.create.query：灰名单语义（官方参数表），goodsInfoList[{productId,
    // grayReason}] 只返回不可投商品；条目字段官方为 productId（DPID 字符串对齐）
    const creatable = await callTemuApi<{
      goodsInfoList: Array<{ productId: string; grayReason: Array<{ reason: string }> }>
    }>("bg.glo.searchrec.ad.goods.create.query", { productIdList: [] }, ctx)
    expect(creatable.result.goodsInfoList).toHaveLength(products.length)
    // 每 10 款 1 款带演示原因（验证服务端「只返回可投」过滤可见）
    expect(
      creatable.result.goodsInfoList.filter((g) => g.grayReason.length > 0).length,
    ).toBeGreaterThan(0)

    // ad.create：成功 ID 列表回显入参（DPID 字符串原样，-1 预算口径可透传）
    const created = await callTemuApi<{
      successCreateProductNum: number
      successProductIdLists: string[]
    }>("bg.glo.searchrec.ad.create", {
      createAdReqs: [{ productId: products[0]!.productId, budget: -1, roas: 130000, roasType: 1 }],
    }, ctx)
    expect(created.result.successCreateProductNum).toBe(1)
    expect(created.result.successProductIdLists[0]).toBe(products[0]!.productId)

    // detail.query：按请求 productIdList 返回 adsDetail 实时形状（summary 四指标，
    // 条目字段官方为 productId，adShowStatus 8=推广中）
    const detail = await callTemuApi<{
      adsDetail: Array<{
        productId: string
        adShowStatus: number
        summary: Record<string, { ad: { val: number } }>
      }>
    }>("bg.glo.searchrec.ad.detail.query", { productIdList: [products[0]!.productId] }, ctx)
    expect(detail.result.adsDetail).toHaveLength(1)
    expect(detail.result.adsDetail[0]?.productId).toBe(products[0]!.productId)
    expect(detail.result.adsDetail[0]?.adShowStatus).toBe(8)
    expect(detail.result.adsDetail[0]?.summary.adSpend.ad.val).toBeGreaterThan(0)

    // roas.pred：predList 推荐档位（实际值口径 13）
    const pred = await callTemuApi<{
      queryAdBidResult: Array<{ predList: Array<{ roas: number }> }>
    }>("bg.glo.searchrec.ad.roas.pred", { goodsInfoList: [{ productId: 1 }] }, ctx)
    expect(pred.result.queryAdBidResult[0]?.predList[0]?.roas).toBe(13)
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

/* ─── 演示虚拟接口层回归（R-3-3/3-5/3-6）：
       1) 固定 30 单补齐真实字段（supplierId/收货仓/收货地址/SKU 明细）
       2) 质检/退供三端点日期窗口过滤（epoch ms 两端含）
       3) 新登记/改形读端点出参形状
       4) 发货单登记表闭环（create 每单一号 → 按号回查 → packing.send 推进 → cancel 取消）
       直调 callTemuApi + getDemoCredential()（DEMO_APP_KEY 走 demoApiEnvelope，不发网络）。
       登记表 registeredShipOrders 是模块级单例、跨用例残留：固定 30 单用例必须先于闭环
       用例跑（登记单会合并进裸查 total），闭环只对本次创建的 DEMONEW 单号断言 */
describe("演示虚拟接口层回归：发货单登记表 / 日期窗口过滤 / 新读端点形状", () => {
  let regEntId: string

  /** demo 凭证上下文（DEMO_APP_KEY 命中 callTemuApi 拦截层，不走网络不限速） */
  const demoCtx = () => ({ ...getDemoCredential(), rateKey: "test-demo-reg", qps: 3 })

  beforeAll(async () => {
    const [ent] = await db
      .insert(enterprises)
      .values({
        name: "演示虚拟层回归企业",
        slug: `demo-reg-${randomUUID().slice(0, 8)}`,
        creditsBalance: 0,
        enabledModules: [...MODULE_NAMES] as ModuleName[],
      })
      .returning()
    regEntId = ent!.id
    await ensureDemoStores(regEntId)
  }, 30_000)

  afterAll(async () => {
    await cleanupDemoStores(regEntId)
    await db.delete(enterprises).where(eq(enterprises.id, regEntId))
  })

  it("固定 30 单补齐真实字段：supplierId=88888/收货仓/收货地址/SKU 明细", async () => {
    const r = await callTemuApi<{
      total: number
      list: Array<{
        deliveryOrderSn: string
        supplierId: number
        subWarehouseId: number
        receiveAddressInfo: Record<string, unknown> | null
        packageDetailList: Array<{ productSkuId: number; skuNum: number }>
      }>
    }>("bg.shiporderv2.get", { pageNo: 1, pageSize: 50 }, demoCtx())
    expect(r.success).toBe(true)
    // 裸查（不传 deliveryOrderSnList）只含固定 30 单
    expect(r.result.total).toBe(30)
    expect(r.result.list).toHaveLength(30)
    expect(r.result.list[0]?.deliveryOrderSn).toBe("DEMOPO00001")
    for (const row of r.result.list) {
      // 缺 supplierId 会被 upsert 冲突更新抹空本地播种值（退供三接口随之全报错）
      expect(row.supplierId).toBe(88888)
      expect([501, 502]).toContain(row.subWarehouseId)
      expect(row.receiveAddressInfo?.detailAddress).toBeTruthy()
      // SKU 明细（商品条码打印/自动发货拆包预估的数据源）：skcId+1/2/3 播种格式
      expect(row.packageDetailList.length).toBe(3)
      for (const d of row.packageDetailList) {
        expect(d.productSkuId).toBeGreaterThan(0)
        expect(d.skuNum).toBeGreaterThan(0)
      }
    }
  })

  it("质检列表按 qcResultUpdateTimeBegin/End 窗口过滤（epoch ms 两端含）", async () => {
    const full = await callTemuApi<{
      total: number
      skuList: Array<{ qcBillId: number; qcResultUpdateTime: string }>
    }>("bg.goods.qualityinspection.get", { pageInfo: { pageNo: 1, pageSize: 50 } }, demoCtx())
    expect(full.result.total).toBe(25)
    // 窄窗口取全量某行的真实时间戳（演示行时间分散近 25 天，[t,t] 恰命中该行）
    const target = full.result.skuList[5]!
    const t = Date.parse(target.qcResultUpdateTime)
    expect(Number.isFinite(t)).toBe(true)
    const narrow = await callTemuApi<{
      total: number
      skuList: Array<{ qcBillId: number; qcResultUpdateTime: string }>
    }>(
      "bg.goods.qualityinspection.get",
      { pageInfo: { pageNo: 1, pageSize: 50 }, qcResultUpdateTimeBegin: t, qcResultUpdateTimeEnd: t },
      demoCtx(),
    )
    expect(narrow.result.total).toBeLessThan(full.result.total)
    expect(narrow.result.skuList).toHaveLength(1)
    expect(narrow.result.skuList[0]?.qcBillId).toBe(target.qcBillId)
    expect(Date.parse(narrow.result.skuList[0]!.qcResultUpdateTime)).toBe(t)
    // 不包含任何行的空窗口 → 0 行
    const empty = await callTemuApi<{ total: number; skuList: unknown[] }>(
      "bg.goods.qualityinspection.get",
      {
        pageInfo: { pageNo: 1, pageSize: 50 },
        qcResultUpdateTimeBegin: t - 200 * 86400_000,
        qcResultUpdateTimeEnd: t - 100 * 86400_000,
      },
      demoCtx(),
    )
    expect(empty.result.total).toBe(0)
    expect(empty.result.skuList).toHaveLength(0)
  })

  it("退供包裹列表按 outboundTimeStart/End 窗口过滤", async () => {
    const full = await callTemuApi<{
      total: number
      openReturnPackageDTOS: Array<{ returnSupplierPackageNo: string; outboundTime: number }>
    }>("bg.refund.returnpackage.get", { pageNo: 1, pageSize: 50 }, demoCtx())
    expect(full.result.total).toBe(12)
    const target = full.result.openReturnPackageDTOS[3]!
    const t = target.outboundTime
    // 演示层的出库时间按「调用时刻 − N 天」生成，两次调用之间会差几毫秒；窗口取目标行
    // 前后各 1 分钟（行与行相隔 1 天，仍只命中这一行），不要用 [t, t] 这种瞬时窗口
    const pad = 60_000
    const narrow = await callTemuApi<{
      total: number
      openReturnPackageDTOS: Array<{ returnSupplierPackageNo: string; outboundTime: number }>
    }>(
      "bg.refund.returnpackage.get",
      { pageNo: 1, pageSize: 50, outboundTimeStart: t - pad, outboundTimeEnd: t + pad },
      demoCtx(),
    )
    expect(narrow.result.total).toBeLessThan(full.result.total)
    expect(narrow.result.openReturnPackageDTOS).toHaveLength(1)
    expect(narrow.result.openReturnPackageDTOS[0]?.returnSupplierPackageNo).toBe(
      target.returnSupplierPackageNo,
    )
    const empty = await callTemuApi<{ total: number; openReturnPackageDTOS: unknown[] }>(
      "bg.refund.returnpackage.get",
      { pageNo: 1, pageSize: 50, outboundTimeStart: t - 200 * 86400_000, outboundTimeEnd: t - 100 * 86400_000 },
      demoCtx(),
    )
    expect(empty.result.total).toBe(0)
    expect(empty.result.openReturnPackageDTOS).toHaveLength(0)
  })

  it("退供包裹明细按 outboundTimeStart/End 窗口过滤", async () => {
    const full = await callTemuApi<{
      total: number
      packageDetailDTOList: Array<{ packageSn: string; outboundTime: number }>
    }>("bg.refund.returnpackagelist.get", { pageNo: 1, pageSize: 50 }, demoCtx())
    expect(full.result.total).toBe(10)
    const target = full.result.packageDetailDTOList[2]!
    const t = target.outboundTime
    // 同上：出库时间随调用时刻漂移几毫秒，窗口取目标行前后各 1 分钟
    const pad = 60_000
    const narrow = await callTemuApi<{
      total: number
      packageDetailDTOList: Array<{ packageSn: string; outboundTime: number }>
    }>(
      "bg.refund.returnpackagelist.get",
      { pageNo: 1, pageSize: 50, outboundTimeStart: t - pad, outboundTimeEnd: t + pad },
      demoCtx(),
    )
    expect(narrow.result.total).toBeLessThan(full.result.total)
    expect(narrow.result.packageDetailDTOList).toHaveLength(1)
    expect(narrow.result.packageDetailDTOList[0]?.packageSn).toBe(target.packageSn)
    const empty = await callTemuApi<{ total: number; packageDetailDTOList: unknown[] }>(
      "bg.refund.returnpackagelist.get",
      { pageNo: 1, pageSize: 50, outboundTimeStart: t - 200 * 86400_000, outboundTimeEnd: t - 100 * 86400_000 },
      demoCtx(),
    )
    expect(empty.result.total).toBe(0)
    expect(empty.result.packageDetailDTOList).toHaveLength(0)
  })

  it("退供包裹详情：returnPackageInfos 字段对齐消费端", async () => {
    const r = await callTemuApi<{
      returnPackageInfos: Array<{
        productSkcId: number
        thumbUrl: string
        mainSaleSpec: string
        secondarySaleSpec: string
        returnSupplierQuantity: number
      }>
    }>("bg.refund.returnpackagedetail.get", { returnSupplierPackageNo: "DEMORT0001" }, demoCtx())
    expect(Array.isArray(r.result.returnPackageInfos)).toBe(true)
    expect(r.result.returnPackageInfos).toHaveLength(1)
    const info = r.result.returnPackageInfos[0]!
    // DEMORT 序号 1 → 款序 1（商品表播种 skcId 纯数字串），件数与列表行同源
    expect(info.productSkcId).toBe(1)
    expect(typeof info.thumbUrl).toBe("string")
    expect(info.mainSaleSpec).toBe("均码")
    expect(info.secondarySaleSpec).toBe("白色")
    expect(info.returnSupplierQuantity).toBe(1)
  })

  it("调整包裹回显：packageInfo[{packageSn,skcNum,packageDetails}]", async () => {
    const r = await callTemuApi<{
      packageInfo: Array<{
        packageSn: string
        skcNum: number
        packageDetails: Array<{ productSkuId: number; skuNum: number }>
      }>
    }>("bg.shiporder.package.get", { deliveryOrderSn: "DEMOPO00001" }, demoCtx())
    expect(Array.isArray(r.result.packageInfo)).toBe(true)
    expect(r.result.packageInfo.length).toBeGreaterThan(0)
    // SKU 明细轮转均摊到包裹：跨包裹并集 = 该款 11/12/13 三个 SKU
    const ids = r.result.packageInfo
      .flatMap((p) => p.packageDetails.map((d) => d.productSkuId))
      .sort((a, b) => a - b)
    expect(ids).toEqual([11, 12, 13])
    for (const pkg of r.result.packageInfo) {
      expect(pkg.packageSn).toMatch(/^DEMOPKG\d{3}$/)
      expect(pkg.skcNum).toBe(pkg.packageDetails.reduce((a, d) => a + d.skuNum, 0))
    }
  })

  it("物流公司列表：result 为数组且行字段 expressCompanyId/expressCompanyName", async () => {
    const r = await callTemuApi<Array<{ expressCompanyId: number; expressCompanyName: string }>>(
      "bg.shiporder.logistics.get",
      {},
      demoCtx(),
    )
    expect(Array.isArray(r.result)).toBe(true)
    expect(r.result).toHaveLength(2)
    expect(r.result[0]?.expressCompanyId).toBe(9001)
    expect(typeof r.result[0]?.expressCompanyName).toBe("string")
  })

  it("商品条码 labelv2 两段式：裸查回显请求 SKU，dataKey 模式回字符串", async () => {
    const bare = await callTemuApi<{
      labelCodePageResult: { data: Array<{ productSkuDTO: { productSkuId: number } }> }
    }>("bg.glo.goods.labelv2.get", { productSkuIdList: ["12345", "67890"] }, demoCtx())
    expect(bare.result.labelCodePageResult.data).toHaveLength(2)
    expect(bare.result.labelCodePageResult.data[0]?.productSkuDTO.productSkuId).toBe(12345)
    expect(bare.result.labelCodePageResult.data[1]?.productSkuDTO.productSkuId).toBe(67890)
    const keyed = await callTemuApi<string>(
      "bg.glo.goods.labelv2.get",
      { productSkuIdList: ["12345"], return_data_key: "true" },
      demoCtx(),
    )
    expect(typeof keyed.result).toBe("string")
    expect(keyed.result).toMatch(/^demo-barcode-/)
  })

  it("箱唛 boxmarkinfo：dataKey 模式 result 直接为字符串", async () => {
    const keyed = await callTemuApi<string>(
      "bg.logistics.boxmarkinfo.get",
      { return_data_key: "true" },
      demoCtx(),
    )
    expect(typeof keyed.result).toBe("string")
    expect(keyed.result).toMatch(/^demo-boxmark-/)
  })

  it(
    "演示发货单闭环：create 每单一号 → 按号回查待装箱 → packing.send 推进已发货 → cancel 置已取消",
    async () => {
      // 入参形状对齐 createShipOrderAction（deliveryOrderCreateGroupList 嵌套，一单一 info）
      const create = await callTemuApi<{ deliveryOrders: Array<{ deliveryOrderSn: string }> }>(
        "bg.shiporderv3.create",
        {
          deliveryOrderCreateGroupList: [
            {
              subWarehouseId: 501,
              receiveAddressInfo: { detailAddress: "义乌市XXX路1号" },
              deliveryOrderCreateInfos: [
                {
                  subPurchaseOrderSn: "DEMOSUB00001",
                  deliveryAddressId: 501,
                  deliverOrderDetailInfos: [
                    { productSkuId: 11, deliverSkuNum: 3 },
                    { productSkuId: 12, deliverSkuNum: 2 },
                  ],
                  packageInfos: [{ packageDetail: [] }, { packageDetail: [] }],
                },
                {
                  subPurchaseOrderSn: "DEMOSUB00002",
                  deliveryAddressId: 501,
                  deliverOrderDetailInfos: [{ productSkuId: 21, deliverSkuNum: 4 }],
                  packageInfos: [{ packageDetail: [] }],
                },
              ],
            },
          ],
        },
        demoCtx(),
      )
      expect(create.success).toBe(true)
      // 一单一个发货单号：号数 = 订单数、唯一、DEMONEW 前缀
      const sns = create.result.deliveryOrders.map((o) => o.deliveryOrderSn)
      expect(sns).toHaveLength(2)
      expect(new Set(sns).size).toBe(2)
      for (const sn of sns) expect(sn).toMatch(/^DEMONEW\d+$/)

      // 按单号回查：只回名单内的单（缺席 = 官方侧已移除），登记单状态 0=待装箱，
      // 回显入参（备货单号/收货仓/包裹数/SKU 明细件数）
      const ghost = "DEMONEW-GHOST" // 永不生成的格式（生成号为 DEMONEW+纯数字）
      const back = await callTemuApi<{
        total: number
        list: Array<{
          deliveryOrderSn: string
          subPurchaseOrderSn: string
          status: number
          subWarehouseId: number
          deliverSkcNum: number
          deliverPackageNum: number
          packageDetailList: Array<{ productSkuId: number; skuNum: number }>
        }>
      }>(
        "bg.shiporderv2.get",
        { pageNo: 1, pageSize: 20, deliveryOrderSnList: [...sns, ghost] },
        demoCtx(),
      )
      expect(back.result.total).toBe(2)
      expect(back.result.list.map((r) => r.deliveryOrderSn).sort()).toEqual([...sns].sort())
      expect(back.result.list.map((r) => r.deliveryOrderSn)).not.toContain(ghost)
      const bySn = new Map(back.result.list.map((r) => [r.deliveryOrderSn, r]))
      expect(bySn.get(sns[0]!)?.subPurchaseOrderSn).toBe("DEMOSUB00001")
      expect(bySn.get(sns[0]!)?.status).toBe(0)
      expect(bySn.get(sns[0]!)?.subWarehouseId).toBe(501)
      expect(bySn.get(sns[0]!)?.deliverSkcNum).toBe(5)
      expect(bySn.get(sns[0]!)?.deliverPackageNum).toBe(2)
      expect(bySn.get(sns[0]!)?.packageDetailList).toEqual([
        { productSkuId: 11, skuNum: 3 },
        { productSkuId: 12, skuNum: 2 },
      ])
      expect(bySn.get(sns[1]!)?.status).toBe(0)
      expect(bySn.get(sns[1]!)?.deliverSkcNum).toBe(4)

      // 装箱发货（入参形状对齐 sendPackingAction 方式3）：返回批次号并推进 0→2 已发货
      const send = await callTemuApi<{ expressBatchSn: string }>(
        "bg.shiporder.packing.send",
        {
          deliveryOrderSnList: [sns[0]!],
          deliveryAddressId: 501,
          deliverMethod: 3,
          thirdPartyExpressDeliveryInfoVO: {
            expressCompanyId: 9001,
            expressCompanyName: "演示物流",
            expressDeliverySn: "DEMOWB0001",
            expressPackageNum: 1,
          },
        },
        demoCtx(),
      )
      expect(send.result.expressBatchSn).toMatch(/^DEMOBATCH/)
      const afterSend = await callTemuApi<{
        list: Array<{ deliveryOrderSn: string; status: number; expressBatchSn: string | null; deliverTime: number | null }>
      }>("bg.shiporderv2.get", { deliveryOrderSnList: [sns[0]!] }, demoCtx())
      expect(afterSend.result.list).toHaveLength(1)
      expect(afterSend.result.list[0]?.status).toBe(2)
      expect(afterSend.result.list[0]?.expressBatchSn).toBe(send.result.expressBatchSn)
      expect(afterSend.result.list[0]?.deliverTime).toBeGreaterThan(0)

      // 取消（入参形状同 cancelShipOrderAction：单号字符串）：2→5 已取消，且只作用于本单
      await callTemuApi("bg.shiporder.cancel", { deliveryOrderSn: sns[0]! }, demoCtx())
      const afterCancel = await callTemuApi<{
        list: Array<{ deliveryOrderSn: string; status: number }>
      }>("bg.shiporderv2.get", { deliveryOrderSnList: sns }, demoCtx())
      expect(afterCancel.result.list).toHaveLength(2)
      expect(afterCancel.result.list.find((r) => r.deliveryOrderSn === sns[0])?.status).toBe(5)
      // 未发货的另一单不受影响，仍待装箱
      expect(afterCancel.result.list.find((r) => r.deliveryOrderSn === sns[1])?.status).toBe(0)
    },
  )
})
