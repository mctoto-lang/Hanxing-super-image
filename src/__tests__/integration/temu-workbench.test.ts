import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises } from "@/db/schema"
import { temuStores, temuProducts, temuSkuMaps, temuAds } from "@/db/schema/temu"
import { encrypt } from "@/lib/crypto"
import {
  getTemuPriceReviewsAction,
  getTemuAdjustOrdersAction,
  getTemuAdPlansAction,
  listTemuAdProductsAction,
  createTemuAdsAction,
  modifyTemuAdAction,
} from "@/server/actions/temu-workbench"

/**
 * 运营工作台实时链路回归：核价单/调价单/广告
 * （官方 API mock fetch 按 type 分发；企业鉴权与 sku_map 商品反查走真库）。
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
vi.mock("@/lib/temu-api/app-config", () => ({
  getTemuAppCredential: async () => ({
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    source: "test",
  }),
}))

const PRICE_REVIEWS = {
  total: 1,
  reviewSamplePriceList: [
    {
      orderId: 40211,
      orderStatus: 0,
      supplyPrice: 5000,
      priceCurrency: "CNY",
      suggestSupplyPrice: 4500,
      suggestPriceCurrency: "CNY",
      productSkuIdList: [50001],
      siteIds: [1, 2],
      siteNameList: ["US", "EU"],
      canBargain: true,
    },
  ],
}

const ADJUST_ORDERS = {
  total: 1,
  list: [
    {
      priceOrderSn: "TP20261019001",
      // 行内不返回 status（2026-10-22 探针实证 13 键无 status），行状态由查询入参回填
      skcId: 9001,
      skcExtCode: "SN-9001",
      productId: 7001,
      productName: "测试连衣裙 SKC1",
      orderCreateTime: 1760000000000,
      priceType: 0,
      adjustReason: "爆款降价",
      source: "1",
      // 实测 number（num() 兼容 string 口径）
      newSupplyPrice: 4590,
      priceCurrency: "CNY",
      imageList: ["https://img.example.com/9001.jpg"],
      skuInfoItemList: [
        { productSkuId: 50001, price: 4590, skuExtCode: "SKU-50001", spec: "S" },
      ],
    },
  ],
}

type FetchOverrides = Record<string, unknown>

/** mock fetch：按 body.type 分发（overrides 优先），permissionDenied 时全 7000019 */
function mockWorkbenchFetch(overrides: FetchOverrides = {}, permissionDenied = false) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string }
    if (permissionDenied) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: null, success: false, errorCode: 7000019, errorMsg: "no scope" }),
      } as unknown as Response
    }
    const result =
      body.type in overrides
        ? overrides[body.type]
        : body.type === "bg.price.review.page.query"
          ? PRICE_REVIEWS
          : body.type === "bg.full.adjust.price.page.query"
            ? ADJUST_ORDERS
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
      name: "temu 工作台测试企业",
      slug: `wb-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
    })
    .returning()
  entId = ent!.id

  const [user] = await db
    .insert((await import("@/db/schema")).users)
    .values({
      enterpriseId: entId,
      username: `wb-${randomUUID().slice(0, 8)}`,
      email: `wb-${randomUUID().slice(0, 8)}@test.local`,
      name: "wb 测试用户",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  mockSession.userId = user!.id

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "wb 测试店铺",
      accessTokenEncrypted: encrypt("wb-test-token"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeId = store!.id

  await db.insert(temuProducts).values({
    storeId,
    productSkcId: "9001",
    productId: "7001",
    productName: "测试连衣裙 SKC1",
    productSn: "SN-9001",
    mainImageUrl: "https://img.example.com/9001.jpg",
    supplierPrice: 4990,
  })
  await db.insert(temuSkuMaps).values({ storeId, skuId: "50001", skcId: "9001" })
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
  vi.unstubAllGlobals()
})

describe("核价单实时拉取", () => {
  it("映射状态/价差/站点并经 sku_map 反查商品", async () => {
    vi.stubGlobal("fetch", mockWorkbenchFetch())
    const r = await getTemuPriceReviewsAction({ store: storeId, status: "pending" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.length).toBe(1)
    const row = r.rows[0]
    expect(row.orderId).toBe(40211)
    expect(row.statusLabel).toBe("待核价")
    expect(row.deltaPct).toBe(10)
    expect(row.siteNames).toEqual(["US", "EU"])
    // siteNameList 官方实测不返回，站点展示走 siteIds → TEMU_SITES 字典
    expect(row.siteIds).toEqual([1, 2])
    expect(row.canBargain).toBe(true)
    expect(row.products[0]?.productSkcId).toBe("9001")
    expect(row.products[0]?.productName).toBe("测试连衣裙 SKC1")
  })

  it("权限错误（7000019）转友好提示", async () => {
    vi.stubGlobal("fetch", mockWorkbenchFetch({}, true))
    const r = await getTemuPriceReviewsAction({ store: storeId })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("未授权")
  })

  it("跨企业店铺隔离：不存在店铺报错", async () => {
    vi.stubGlobal("fetch", mockWorkbenchFetch())
    const r = await getTemuPriceReviewsAction({ store: randomUUID() })
    expect(r.ok).toBe(false)
  })
})

describe("调价单实时拉取", () => {
  it("STRING 金额数值化 + SKU 明细展开", async () => {
    vi.stubGlobal("fetch", mockWorkbenchFetch())
    const r = await getTemuAdjustOrdersAction({ store: storeId, status: "pending" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const row = r.rows[0]
    expect(row.priceOrderSn).toBe("TP20261019001")
    expect(row.statusLabel).toBe("待调价")
    expect(row.newSupplyPrice).toBe(4590)
    // 当前申报价：接口不返回，按 skcId 反查 temu_products.supplierPrice
    expect(row.currentSupplyPrice).toBe(4990)
    expect(row.priceType).toBe(0)
    expect(row.skuItems[0]?.skuId).toBe("50001")
    expect(row.image).toContain("9001")
  })
})

/* ─── 广告工作台（注册表 temu_ad + bg.glo.searchrec.ad.* 实时） ─── */

const AD_DETAIL = {
  adsDetail: [
    {
      goodsId: 7001,
      adShowStatus: 2,
      adPhase: 1,
      budget: 1000,
      roas: 350,
      summary: {
        adSpend: { ad: { val: 5000 } },
        orderPayAmt: { ad: { val: 15000 } },
        roas: { ad: { val: 3 } },
      },
    },
  ],
}

const AD_CREATABLE = { goodsInfoList: [{ goodsId: 7001, grayReason: [] }] }

// 官方口径响应（doc-bg.glo.searchrec.ad.create.json）：成功商品 ID 列表是
// successProductIdLists、成功数是 successCreateProductNum（无 alreadyCreatedGoodsNum）
const AD_CREATE_RESULT = {
  successProductIdLists: [7001],
  successCreateProductNum: 1,
  createGoodsFailObjList: [],
}

describe("广告工作台", () => {
  it("候选商品合并官方可投性标记", async () => {
    vi.stubGlobal(
      "fetch",
      mockWorkbenchFetch({ "bg.glo.searchrec.ad.goods.create.query": AD_CREATABLE }),
    )
    const r = await listTemuAdProductsAction({ store: storeId })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.length).toBe(1)
    expect(r.rows[0]?.productId).toBe("7001")
    expect(r.rows[0]?.eligible).toBe(true)
    expect(r.rows[0]?.advertised).toBe(false)
  })

  it("创建广告按官方口径发 productId/roas×10000 并登记注册表", async () => {
    const fetchMock = mockWorkbenchFetch({ "bg.glo.searchrec.ad.create": AD_CREATE_RESULT })
    vi.stubGlobal("fetch", fetchMock)
    const r = await createTemuAdsAction({
      store: storeId,
      items: [{ productId: "7001", budget: 1000, roas: 3.5 }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.successCount).toBe(1)
    // 请求口径：createAdReqs[{productId, budget, roas(实际值×10000), roasType}]——
    // 官方无 goodsId 请求字段、roas 须为整数（乘 10000 后取整）
    const reqBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as {
      createAdReqs: { productId: number; budget: number; roas: number; roasType: number }[]
    }
    expect(reqBody.createAdReqs?.[0]).toEqual({
      productId: 7001,
      budget: 1000,
      roas: 35000,
      roasType: 1,
    })
    const [row] = await db.select().from(temuAds).where(eq(temuAds.productId, "7001"))
    expect(row?.budget).toBe(1000)
    expect(row?.roas).toBe(3.5)
  })

  it("我的广告 = 注册表 + detail.query 实时状态/指标", async () => {
    vi.stubGlobal(
      "fetch",
      mockWorkbenchFetch({ "bg.glo.searchrec.ad.detail.query": AD_DETAIL }),
    )
    const r = await getTemuAdPlansAction({ store: storeId })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.length).toBe(1)
    const row = r.rows[0]
    // detail 实时值优先于注册表快照
    expect(row.budget).toBe(1000)
    expect(row.spendFen).toBe(5000)
    expect(row.orderPayAmtFen).toBe(15000)
    expect(row.roasSummary).toBe(3)
    // 枚举官方未文档化：回退状态码展示
    expect(row.adShowStatusLabel).toBe("状态码 2")
    expect(row.productName).toBe("测试连衣裙 SKC1")
  })

  it("修改广告（改预算）按官方 modifyAdDTO 包装并更新注册表", async () => {
    const fetchMock = mockWorkbenchFetch({})
    vi.stubGlobal("fetch", fetchMock)
    const r = await modifyTemuAdAction({
      store: storeId,
      productId: "7001",
      action: "budget",
      budget: 2000,
    })
    expect(r.ok).toBe(true)
    // 请求口径：{modifyAdDTO:{productId, budget, roas}, status}——商品字段必须
    // 包在 modifyAdDTO 对象内且名为 productId（非顶层平铺 goodsId）
    const reqBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as {
      modifyAdDTO: { productId: number; budget: number; roas: number }
      status: number
    }
    expect(reqBody.modifyAdDTO?.productId).toBe(7001)
    expect(reqBody.modifyAdDTO?.budget).toBe(2000)
    expect(reqBody.status).toBe(4)
    const [row] = await db.select().from(temuAds).where(eq(temuAds.productId, "7001"))
    expect(row?.budget).toBe(2000)
  })

  it("权限错误（7000019）转友好提示", async () => {
    vi.stubGlobal("fetch", mockWorkbenchFetch({}, true))
    const r = await listTemuAdProductsAction({ store: storeId })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("未授权")
  })
})

describe("广告候选搜索下推 SQL（>60 行店铺规模）", () => {
  it("按商品名搜索命中 60 行窗口外的目标商品并按 productId 去重", async () => {
    // 旧实现取 DB 任意 60 行后才在应用层过滤——真实店铺单店全量上千 SKC，
    // 窗口外的目标商品永远搜不到；目标商品插在 80 条填充行之后模拟该场景
    const fillers = Array.from({ length: 80 }, (_, i) => ({
      storeId,
      productSkcId: `8${String(i).padStart(3, "0")}`,
      productId: `6${String(i).padStart(3, "0")}`,
      productName: `填充商品 ${i}`,
      productSn: `SN-8${String(i).padStart(3, "0")}`,
    }))
    await db.insert(temuProducts).values(fillers)
    // 同 productId 双 SKC：验证去重后只出一行候选
    await db.insert(temuProducts).values([
      {
        storeId,
        productSkcId: "9900",
        productId: "9901",
        productName: "目标商品-金色皇冠项链",
        productSn: "SN-9901",
      },
      {
        storeId,
        productSkcId: "9901",
        productId: "9901",
        productName: "目标商品-金色皇冠项链 B 款",
        productSn: "SN-9902",
      },
    ])
    vi.stubGlobal(
      "fetch",
      mockWorkbenchFetch({
        "bg.glo.searchrec.ad.goods.create.query": {
          goodsInfoList: [{ goodsId: 9901, grayReason: [] }],
        },
      }),
    )
    const r = await listTemuAdProductsAction({ store: storeId, q: "金色皇冠" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.length).toBe(1)
    expect(r.rows[0]?.productId).toBe("9901")
    // 同 productId 双 SKC 去重后保留排序最前的一条（lastSeenAt/skcId 倒序）
    expect(r.rows[0]?.productName).toContain("金色皇冠")
    expect(r.rows[0]?.eligible).toBe(true)
    expect(r.rows[0]?.advertised).toBe(false)
  })

  it("货号前缀搜索同样下推命中（SN-9901 精确段）", async () => {
    vi.stubGlobal(
      "fetch",
      mockWorkbenchFetch({
        "bg.glo.searchrec.ad.goods.create.query": {
          goodsInfoList: [{ goodsId: 9901, grayReason: [] }],
        },
      }),
    )
    const r = await listTemuAdProductsAction({ store: storeId, q: "SN-9901" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.length).toBe(1)
    expect(r.rows[0]?.productId).toBe("9901")
  })
})
