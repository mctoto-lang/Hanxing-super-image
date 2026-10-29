import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { and, desc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises } from "@/db/schema"
// 新表直接从模块文件导入：turbopack 对 * barrel 的陈旧缓存会解析为 undefined
import {
  temuStores,
  temuProducts,
  temuSkuMaps,
  temuSalesOverviews,
  temuMetricSnapshots,
  temuIngestLogs,
  temuAdsDailies,
  temuAdsProductDailies,
} from "@/db/schema/temu"
import { syncStore, verifyStoreToken } from "@/server/services/temu-sync"
import { encrypt } from "@/lib/crypto"

/**
 * TEMU 官方 API 同步集成测试（真库写读 + mock fetch 按 type 分发）
 *
 * 覆盖：
 * 1. 全源链路 upsert：goods-list → temu_product（含类目/主图）、
 *    product-image-mirror → 主图转存回写 cos 两列、product.search →
 *    hasSkcSelected、salesv2 → sales_overview + sku_map + 标识回填、
 *    soldout → metric_snapshot；temu_ingest_log 落各源审计；
 *    lastSyncStatus.ok = true；重跑幂等（已转存图不再重转）；
 * 2. token 过期（7000007）：余下源中止，店铺标记 invalid；
 * 3. verifyStoreToken：mall.info 半托回写。
 */

// app 凭证固定注入（不打真库 system_setting，也不发真实请求）
vi.mock("@/lib/temu-api/app-config", () => ({
  getTemuAppCredential: async () => ({
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    source: "test",
  }),
}))
vi.mock("@/server/services/temu-cache", () => ({
  invalidateTemuCache: () => {},
}))
// 主图转存走 mock 存储：不打真库 system_setting、不写本地 uploads 目录；
// 返回 URL 取源 URL 尾 8 字符（9001.jpg），断言可区分两张图
const storageMock = vi.hoisted(() => ({
  saveFromUrl: vi.fn(
    async (
      url: string,
      _enterpriseId: string,
      _category: string,
      _trustedHostHints?: string[],
    ) => `https://cos.example.com/temu/${url.slice(-8)}`,
  ),
}))
vi.mock("@/lib/storage", () => ({ getStorage: async () => storageMock }))

/** 官方接口响应夹具 */
const GOODS_LIST_PAGE = {
  data: [
    {
      productSkcId: 9001,
      productId: 7001,
      productName: "测试连衣裙 SKC1",
      extCode: "SN-9001",
      mainImageUrl: "https://img.example.com/9001.jpg",
      createdAt: 1760000000,
      skcSiteStatus: 11,
      categories: {
        cat1: { catId: 1, catName: "女装" },
        leafCat: { catId: 99, catName: "连衣裙" },
      },
      productSkuSummaries: [{ productSkuId: 50001 }],
    },
    {
      productSkcId: 9002,
      productId: 7001,
      productName: "测试连衣裙 SKC2",
      extCode: "SN-9002",
      mainImageUrl: "https://img.example.com/9002.jpg",
      categories: { cat1: { catId: 1, catName: "女装" }, leafCat: { catId: 99, catName: "连衣裙" } },
      productSkuSummaries: [{ productSkuId: 50002 }],
    },
  ],
  totalCount: 2,
}
const LIFECYCLE_PAGE = {
  dataList: [
    {
      productId: 7001,
      // 实测口径（probe）：bg.glo.product.search 行顶层无 skuList（键不存在），
      // 真身嵌在 skcList[].skuList——skcId 即所在 skc 项
      skcList: [
        { skcId: 9001, selectStatus: 1, skuList: [{ skuId: 50001 }] },
        { skcId: 9002, selectStatus: 0, skuList: [{ skuId: 50002 }] },
      ],
    },
  ],
  total: 1,
}
const SALES_PAGE = {
  subOrderList: [
    {
      productSkcId: 9001,
      productId: 7001,
      skcExtCode: "SN-9001",
      productName: "测试连衣裙 SKC1",
      category: "女装/连衣裙",
      productSkcPicture: "https://img.example.com/9001.jpg",
      // 实测口径（probe）：SKC 行已不返回顶层 inventoryNumInfo，
      // 仓库库存 = 各 SKU 行 inventoryNumInfo.warehouseInventoryNum 求和
      skuQuantityDetailList: [
        {
          productSkuId: 50001,
          skuExtCode: "SKU-50001",
          className: "S",
          todaySaleVolume: 3,
          lastSevenDaysSaleVolume: 21,
          lastThirtyDaysSaleVolume: 90,
          inventoryNumInfo: { warehouseInventoryNum: 42 },
          availableSaleDays: "14.0",
        },
      ],
    },
  ],
  total: 1,
}
const SOLDOUT = {
  sellOutProducts: [
    {
      sellOutProductId: "G-1",
      productName: "售罄爆款",
      productPicture: "https://img.example.com/soldout.jpg",
      categories: { leafCat: { catId: 9, catName: "卫衣" } },
      bindSites: [{ siteId: 1, siteName: "US" }],
    },
  ],
}
const PRICE_LIST = {
  // 故意只覆盖 9002：9001 无价格源（salesv2 已不返回 supplierPrice，实测 0/10）
  // → supplierPrice 为 null；9002 只能来自 price-list（2590）——单一价格源行为验证
  productSkuSupplierPriceList: [
    { productSkuId: 50002, productSkcId: 9002, productId: 7001, supplierPrice: 2590, currencyType: "CNY" },
  ],
}

/** 广告报表（四维口径指标；金额分）：mall 店铺级 + goods 商品级天级行 */
const AD_METRIC = (val: number) => ({
  total: { val: val + 8000 },
  ad: { val },
  netTotal: { val: val + 7000 },
  netAd: { val: val - 1000 },
})
const ADS_MALL = {
  reportInfo: {
    reportsItemList: [
      {
        ts: Date.now(),
        adSpend: AD_METRIC(12000),
        orderPayAmt: AD_METRIC(36000),
        imprCnt: AD_METRIC(1000),
        clkCnt: AD_METRIC(50),
        orderPayCnt: AD_METRIC(3),
        goodsNum: AD_METRIC(4),
      },
    ],
    summary: { adSpendAll: { val: 12000 } },
  },
}
const ADS_GOODS = {
  reportInfo: {
    reportsItemList: [
      {
        ts: Date.now(),
        productId: 7001,
        adSpend: AD_METRIC(12000),
        orderPayAmt: AD_METRIC(36000),
        imprCnt: AD_METRIC(1000),
        clkCnt: AD_METRIC(50),
        cartCnt: AD_METRIC(8),
        orderPayCnt: AD_METRIC(3),
        goodsNum: AD_METRIC(4),
        roas: AD_METRIC(300),
        acos: AD_METRIC(33),
        transactionCost: AD_METRIC(4000),
      },
    ],
  },
}

type AnyRecord = Record<string, unknown>

/** mock fetch：按 body.type 分发夹具；tokenExpired=true 时全部 7000007 */
function mockTemuFetch(opts: { tokenExpired?: boolean; semiMall?: boolean } = {}) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string }
    if (opts.tokenExpired) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: null, success: false, errorCode: 7000007, errorMsg: "expired" }),
      } as unknown as Response
    }
    const result: Record<string, AnyRecord | AnyRecord[] | number | boolean | undefined> =
      body.type === "bg.glo.goods.list.get"
        ? GOODS_LIST_PAGE
        : body.type === "bg.glo.product.search"
          ? LIFECYCLE_PAGE
          : body.type === "bg.goods.salesv2.get"
            ? SALES_PAGE
            : body.type === "bg.glo.goods.topselling.soldout.get"
              ? SOLDOUT
              : body.type === "bg.glo.goods.price.list.get"
                ? PRICE_LIST
                : body.type === "bg.glo.searchrec.ad.reports.mall.query"
                  ? ADS_MALL
                  : body.type === "bg.glo.searchrec.ad.reports.goods.query"
                    ? ADS_GOODS
                    : body.type === "bg.mall.info.get"
                      ? { semiManagedMall: opts.semiMall === true }
                      : {}
    return {
      ok: true,
      status: 200,
      json: async () => ({ result, success: true, errorCode: 1000000, errorMsg: "" }),
    } as unknown as Response
  })
}

let entId: string
let storeId: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "temu-sync 测试企业",
      slug: `sync-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
    })
    .returning()
  entId = ent!.id

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "sync 测试店铺",
      accessTokenEncrypted: encrypt("integration-test-token"),
      tokenState: "active",
    })
    .returning()
  storeId = store!.id
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
  vi.unstubAllGlobals()
})

describe("syncStore 全源链路", () => {
  it("upsert 四张表 + 主图转存并落审计与状态", async () => {
    vi.stubGlobal("fetch", mockTemuFetch())
    const outcome = await syncStore(storeId)
    expect(outcome.skipped).toBeUndefined()
    expect(outcome.status?.ok).toBe(true)
    expect(Object.keys(outcome.status?.sources ?? {})).toEqual([
      "api-goods-list",
      "product-image-mirror",
      "api-lifecycle",
      "api-sales-overview",
      "api-soldout",
      "api-price-list",
      "api-ads-reports",
      "api-ship-orders",
    ])

    // goods-list：temu_product 基础字段（类目叶名 / 主图 / 货号）+ SKU 映射
    const [p1] = await db
      .select()
      .from(temuProducts)
      .where(and(eq(temuProducts.storeId, storeId), eq(temuProducts.productSkcId, "9001")))
    expect(p1).toBeTruthy()
    expect(p1?.productName).toBe("测试连衣裙 SKC1")
    expect(p1?.leafCategoryName).toBe("连衣裙")
    expect(p1?.cat1Name).toBe("女装")
    expect(p1?.productSn).toBe("SN-9001")
    expect(p1?.mainImageUrl).toContain("9001")

    // 主图转存源：kwcdn/外链 → 自有存储（temu 类别 + kwcdn 可信提示），两列回写
    expect(p1?.mainImageCosUrl).toBe("https://cos.example.com/temu/9001.jpg")
    expect(p1?.mainImageCosSource).toBe("https://img.example.com/9001.jpg")
    expect(storageMock.saveFromUrl).toHaveBeenCalledTimes(2)
    const [mirroredUrl, mirroredEnt, mirroredCategory, mirroredHints] =
      storageMock.saveFromUrl.mock.calls[0]!
    expect(mirroredUrl).toContain("img.example.com")
    expect(mirroredEnt).toBe(entId)
    expect(mirroredCategory).toBe("temu")
    expect(mirroredHints).toContain("img.kwcdn.com")

    // lifecycle：selectStatus=1 → 选中
    const [p2] = await db
      .select()
      .from(temuProducts)
      .where(and(eq(temuProducts.storeId, storeId), eq(temuProducts.productSkcId, "9002")))
    expect(p2?.hasSkcSelected).toBe(false)
    expect(p1?.hasSkcSelected).toBe(true)

    // salesv2：快照行 + sku_map；仓库库存 = 各 SKU inventoryNumInfo 求和（probe 实测口径）
    const salesRows = await db
      .select()
      .from(temuSalesOverviews)
      .where(eq(temuSalesOverviews.storeId, storeId))
    expect(salesRows.length).toBeGreaterThanOrEqual(1)
    expect(salesRows[0]?.todaySalesVolume).toBe(3)
    expect(salesRows[0]?.last7DaysSalesVolume).toBe(21)
    expect(salesRows[0]?.warehouseAvailableStock).toBe(42)
    const [skuMap] = await db
      .select()
      .from(temuSkuMaps)
      .where(eq(temuSkuMaps.skuId, "50001"))
    expect(skuMap?.skcId).toBe("9001")
    // 申报价仅 price.list.get 为源（salesv2 已不返回 supplierPrice，probe 实测 0/10）：
    // 9001 无 price-list 覆盖 → null（sales 夹具不再回填）；9002 来自 price-list（2590）
    expect(p1?.supplierPrice).toBeNull()
    const [p2After] = await db
      .select()
      .from(temuProducts)
      .where(and(eq(temuProducts.storeId, storeId), eq(temuProducts.productSkcId, "9002")))
    expect(p2After?.supplierPrice).toBe(2590)

    // soldout：metric snapshot
    const [soldout] = await db
      .select()
      .from(temuMetricSnapshots)
      .where(eq(temuMetricSnapshots.storeId, storeId))
    expect(soldout?.source).toBe("api-soldout")
    expect(soldout?.alreadySoldOutNumber).toBe(1)

    // ads-reports：店铺级日表（元口径 12000 分 → 120）+ 商品级日表（分口径）
    const [adDay] = await db
      .select()
      .from(temuAdsDailies)
      .where(eq(temuAdsDailies.storeId, storeId))
    expect(adDay?.adSpend).toBe(120)
    expect(adDay?.gmv).toBe(360)
    expect(adDay?.impressions).toBe(1000)
    const [adProduct] = await db
      .select()
      .from(temuAdsProductDailies)
      .where(eq(temuAdsProductDailies.storeId, storeId))
    expect(adProduct?.productId).toBe("7001")
    expect(adProduct?.adSpend).toBe(12000)
    expect(adProduct?.orderPayAmt).toBe(36000)
    expect(adProduct?.roas).toBe(300)

    // 审计 + 店铺状态
    const logs = await db
      .select()
      .from(temuIngestLogs)
      .where(eq(temuIngestLogs.storeId, storeId))
    expect(logs.map((l) => l.source).sort()).toEqual([
      "api-ads-reports",
      "api-goods-list",
      "api-lifecycle",
      "api-price-list",
      "api-sales-overview",
      "api-ship-orders",
      "api-soldout",
      "product-image-mirror",
    ])
    const [storeAfter] = await db.select().from(temuStores).where(eq(temuStores.id, storeId))
    expect(storeAfter?.lastSyncAt).not.toBeNull()
    expect(storeAfter?.lastSyncStatus?.ok).toBe(true)
    expect(storeAfter?.tokenState).toBe("active")
  })

  it("幂等重跑不产生重复行，内容未变商品仍留在最新批次（已转存图不重转）", { timeout: 30_000 }, async () => {
    vi.stubGlobal("fetch", mockTemuFetch())
    const callsBefore = storageMock.saveFromUrl.mock.calls.length
    await syncStore(storeId)
    // 主图未变（cos_source == main_image_url）→ 转存源零调用
    expect(storageMock.saveFromUrl.mock.calls.length).toBe(callsBefore)
    const salesRows = await db
      .select()
      .from(temuSalesOverviews)
      .where(eq(temuSalesOverviews.storeId, storeId))
    // 每 (店, SKC, 日) 一行：重跑不增长
    expect(salesRows.filter((r) => r.skcId === "9001").length).toBe(1)
    // 回归（今日销量漏统计根因）：内容与上轮完全相同的行也要续期到最新批次，
    // 原 contentHash 去重会把它们从「当日最新批次」里丢掉
    const [latest] = await db
      .select({ capturedAt: temuSalesOverviews.capturedAt })
      .from(temuSalesOverviews)
      .where(eq(temuSalesOverviews.storeId, storeId))
      .orderBy(desc(temuSalesOverviews.capturedAt))
      .limit(1)
    const batchRows = await db
      .select({ skcId: temuSalesOverviews.skcId })
      .from(temuSalesOverviews)
      .where(
        and(
          eq(temuSalesOverviews.storeId, storeId),
          eq(temuSalesOverviews.capturedAt, latest!.capturedAt),
        ),
      )
    expect(batchRows.some((r) => r.skcId === "9001")).toBe(true)
  })
})

describe("token 失效路径", () => {
  it("7000007 → 标记店铺 invalid 并中止余下源", async () => {
    // 单独店铺，避免污染上面的 active 店
    const [store2] = await db
      .insert(temuStores)
      .values({
        enterpriseId: entId,
        name: "sync 失效店铺",
        accessTokenEncrypted: encrypt("expired-token"),
        tokenState: "active",
      })
      .returning()
    vi.stubGlobal("fetch", mockTemuFetch({ tokenExpired: true }))
    const outcome = await syncStore(store2!.id)
    expect(outcome.status?.ok).toBe(false)
    expect(outcome.status?.sources["api-goods-list"]?.ok).toBe(false)
    // 余下源被中止，不再出现
    expect(outcome.status?.sources["api-sales-overview"]).toBeUndefined()
    const [after] = await db.select().from(temuStores).where(eq(temuStores.id, store2!.id))
    expect(after?.tokenState).toBe("invalid")
  })
})

describe("半托店铺跳过全托销售/广告源", () => {
  it("mallType=semi 时 sales-overview 与 ads-reports 标记 skipped 且整体 ok", async () => {
    const [store3] = await db
      .insert(temuStores)
      .values({
        enterpriseId: entId,
        name: "sync 半托店铺",
        accessTokenEncrypted: encrypt("semi-store-token"),
        tokenState: "active",
        mallType: "semi",
      })
      .returning()
    vi.stubGlobal("fetch", mockTemuFetch())
    const outcome = await syncStore(store3!.id)
    expect(outcome.status?.ok).toBe(true)
    expect(outcome.status?.sources["api-sales-overview"]).toMatchObject({
      ok: true,
      skipped: true,
    })
    expect(outcome.status?.sources["api-ads-reports"]).toMatchObject({
      ok: true,
      skipped: true,
    })
    // 其余源正常执行（半托发品数据同样走货品API组）
    expect(outcome.status?.sources["api-goods-list"]?.ok).toBe(true)
    expect(outcome.status?.sources["api-soldout"]?.ok).toBe(true)
    // 销售表无半托店铺数据
    const salesRows = await db
      .select()
      .from(temuSalesOverviews)
      .where(eq(temuSalesOverviews.storeId, store3!.id))
    expect(salesRows.length).toBe(0)
    const adRows = await db
      .select()
      .from(temuAdsDailies)
      .where(eq(temuAdsDailies.storeId, store3!.id))
    expect(adRows.length).toBe(0)
  })
})

describe("verifyStoreToken", () => {
  it("半托店铺回写 mallType=semi 并置 active", async () => {
    vi.stubGlobal("fetch", mockTemuFetch({ semiMall: true }))
    const r = await verifyStoreToken(storeId)
    expect(r.ok).toBe(true)
    expect(r.mallType).toBe("semi")
    const [store] = await db.select().from(temuStores).where(eq(temuStores.id, storeId))
    expect(store?.mallType).toBe("semi")
    expect(store?.tokenState).toBe("active")
  })
})
