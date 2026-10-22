import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, users } from "@/db/schema"
import { temuStores } from "@/db/schema/temu"
import { encrypt } from "@/lib/crypto"
import {
  getTemuPurchaseOrdersAction,
  cancelTemuPurchaseOrdersAction,
  getStockableProductsAction,
  batchApplyTemuStockingAction,
  getTemuQualityInspectionsAction,
  getTemuQualityInspectionDetailAction,
  autoStockingLinkAction,
} from "@/server/actions/temu-fulfillment"

/**
 * 备货工作台（M5-A）实时链路回归：采购单查询映射/状态过滤/取消参数组装
 * （官方 API mock fetch 按 type 分发；企业鉴权走真库）。
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

const PURCHASE_PAGE = {
  total: 2,
  subOrderForSupplierList: [
    {
      subPurchaseOrderSn: "WB2610210001",
      originalPurchaseOrderSn: "WP2610210001",
      productSkcId: 2282117255,
      productId: 611535736,
      productSn: "B120",
      productName: "测试鸟笼 PROBE",
      productSkcPicture: "https://img.example.com/cage.jpg",
      category: "宠物用品",
      status: 1,
      isCustomProduct: false,
      urgencyType: 1,
      todayCanDeliver: true,
      supportIncreaseNum: false,
      purchaseTime: 1792542873030,
      deliverInfo: {
        receiveWarehouseName: null,
        expectLatestDeliverTimeOrDefault: 1792802072958,
        expectLatestArrivalTimeOrDefault: 1793061272958,
      },
      skuQuantityDetailList: [
        {
          productSkuId: 6184223696,
          className: "黑色",
          adviceQuantity: 3,
          purchaseQuantity: 2,
          deliverQuantity: 1,
          purchaseUpLimit: 10,
          thumbUrlList: ["https://img.example.com/sku1.jpg"],
        },
        {
          productSkuId: 6184223697,
          className: "白色",
          adviceQuantity: 4,
          purchaseQuantity: 0,
          deliverQuantity: 0,
          purchaseUpLimit: 10,
          thumbUrlList: [],
        },
      ],
      lackOrSoldoutTagList: [{ isLack: true, skuDisplay: "黑色" }],
    },
    {
      subPurchaseOrderSn: "WB2610210002",
      originalPurchaseOrderSn: "WP2610210002",
      productSkcId: 4483447916,
      productName: "定制手链",
      status: 0,
      isCustomProduct: true,
      urgencyType: 0,
      todayCanDeliver: false,
      supportIncreaseNum: true,
      purchaseTime: 1792540000000,
      skuQuantityDetailList: [
        { productSkuId: 70001, className: "均码", adviceQuantity: 1, purchaseQuantity: 1, deliverQuantity: 0 },
      ],
    },
  ],
}

/** mock fetch：按 body.type 分发 */
function mockFulfillmentFetch(overrides: Record<string, unknown> = {}, failTypes: Record<string, { errorCode: number; errorMsg: string }> = {}) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string }
    if (body.type in failTypes) {
      const f = failTypes[body.type]!
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: null, success: false, errorCode: f.errorCode, errorMsg: f.errorMsg }),
      } as unknown as Response
    }
    const result =
      body.type in overrides
        ? overrides[body.type]
        : body.type === "bg.purchaseorderv2.get"
          ? PURCHASE_PAGE
          : {}
    return {
      ok: true,
      status: 200,
      json: async () => ({ result, success: true, errorCode: 1000000, errorMsg: "" }),
    } as unknown as Response
  })
}

let entId: string
let ownerId: string
let memberId: string
let storeId: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({ name: "temu 备货测试企业", slug: `po-${randomUUID().slice(0, 8)}`, creditsBalance: 0 })
    .returning()
  entId = ent!.id

  const [owner] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `po-${randomUUID().slice(0, 8)}`,
      email: `po-${randomUUID().slice(0, 8)}@test.local`,
      name: "备货管理员",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  ownerId = owner!.id

  const [member] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `pom-${randomUUID().slice(0, 8)}`,
      email: `pom-${randomUUID().slice(0, 8)}@test.local`,
      name: "备货普通成员",
      passwordHash: "x",
      enterpriseRole: "member",
    })
    .returning()
  memberId = member!.id

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "备货测试店铺",
      accessTokenEncrypted: encrypt("po-test-token"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeId = store!.id
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
  vi.unstubAllGlobals()
})

describe("备货单查询", () => {
  it("映射状态/SKU 明细/合计/标记，statusList 预设随请求下发", async () => {
    mockSession.userId = ownerId
    const fn = mockFulfillmentFetch()
    vi.stubGlobal("fetch", fn)
    const r = await getTemuPurchaseOrdersAction({ store: storeId, status: "todo" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.total).toBe(2)
    expect(r.rows).toHaveLength(2)
    const first = r.rows[0]
    expect(first.subPurchaseOrderSn).toBe("WB2610210001")
    expect(first.productSn).toBe("B120")
    expect(first.statusLabel).toBe("已接单待发货")
    expect(first.skuRows).toHaveLength(2)
    expect(first.adviceTotal).toBe(7)
    expect(first.purchaseTotal).toBe(2)
    expect(first.deliverTotal).toBe(1)
    expect(first.lackTag).toBe(true)
    expect(first.urgencyType).toBe(1)
    expect(first.expectLatestDeliverTime).toBe(1792802072958)
    expect(r.rows[1]?.statusLabel).toBe("待接单")
    // 状态预设 → statusList（todo=[0,1]）
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(body.statusList).toEqual([0, 1])
    expect(body.pageNo).toBe(1)
  })

  it("all 预设不下发 statusList", async () => {
    mockSession.userId = ownerId
    const fn = mockFulfillmentFetch()
    vi.stubGlobal("fetch", fn)
    const r = await getTemuPurchaseOrdersAction({ store: storeId, status: "all" })
    expect(r.ok).toBe(true)
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(body.statusList).toBeUndefined()
  })

  it("权限错误（7000019）转友好提示；跨企业店铺隔离", async () => {
    mockSession.userId = ownerId
    vi.stubGlobal(
      "fetch",
      mockFulfillmentFetch({}, { "bg.purchaseorderv2.get": { errorCode: 7000019, errorMsg: "no scope" } }),
    )
    const r = await getTemuPurchaseOrdersAction({ store: storeId })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("未授权")

    const cross = await getTemuPurchaseOrdersAction({ store: randomUUID() })
    expect(cross.ok).toBe(false)
  })
})

describe("备货写操作（管理员）", () => {
  it("cancel：批量单号 + 官方按单失败原因透出", async () => {
    mockSession.userId = ownerId
    const fn = mockFulfillmentFetch({
      "bg.purchaseorder.cancel": {
        successInfoList: ["WB2610210001"],
        errorInfoList: [{ subPurchaseOrderSn: "WB2610210002", errorMsg: "订单状态不允许取消" }],
        isSuccess: false,
      },
    })
    vi.stubGlobal("fetch", fn)
    const r = await cancelTemuPurchaseOrdersAction({
      store: storeId,
      subPurchaseOrderSns: ["WB2610210001", "WB2610210002"],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.failed).toEqual([{ sn: "WB2610210002", reason: "订单状态不允许取消" }])
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(body.subPurchaseOrderSnList).toEqual(["WB2610210001", "WB2610210002"])
  })

  it("普通成员写操作被拒（限管理员）", async () => {
    mockSession.userId = memberId
    vi.stubGlobal("fetch", mockFulfillmentFetch())
    const r = await cancelTemuPurchaseOrdersAction({
      store: storeId,
      subPurchaseOrderSns: ["WB2610210001"],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("管理员")
  })
})

describe("可申报备货商品与批量申报", () => {
  it("本地商品池 join 销售行：canPurchase 过滤 + SKU 明细/库存映射", async () => {
    mockSession.userId = ownerId
    const { temuProducts, temuSalesOverviews } = await import("@/db/schema/temu")
    await db.insert(temuProducts).values([
      {
        storeId, productSkcId: "91001", productId: "71001",
        productName: "可备货鸟笼", productSn: "SN-91001",
        mainImageUrl: "https://img.example.com/91001.jpg",
        skcStatus: 1, last7DaysSalesVolume: 42,
      },
      {
        storeId, productSkcId: "91002", productId: "71002",
        productName: "不可备货鸟笼", productSn: "SN-91002",
        skcStatus: 1, last7DaysSalesVolume: 7,
      },
      {
        storeId, productSkcId: "91003", productId: "71003",
        productName: "已下架鸟笼", productSn: "SN-91003",
        skcStatus: 0, last7DaysSalesVolume: 99,
      },
    ])
    await db.insert(temuSalesOverviews).values([
      {
        storeId, skcId: "91001", capturedDay: "2026-10-21", capturedAt: new Date(), contentHash: "t1",
        last7DaysSalesVolume: 21, availableSaleDays: 8.4,
        // 可用库存口径 = 各 SKU inventoryNumInfo.warehouseInventoryNum 求和（50+70；
        // 官方已不在 SKC 顶层返回库存，warehouse_available_stock 列恒空已弃用）
        priceDetail: [
          { productSkuId: 111, className: "黑色", canPurchase: true, inventoryNumInfo: { warehouseInventoryNum: 50 } },
          { productSkuId: 112, className: "白色", canPurchase: false, inventoryNumInfo: { warehouseInventoryNum: 70 } },
        ],
      },
      {
        storeId, skcId: "91002", capturedDay: "2026-10-21", capturedAt: new Date(), contentHash: "t2",
        last7DaysSalesVolume: 3, availableSaleDays: 0.5,
        priceDetail: [{ productSkuId: 113, className: "均码", canPurchase: false }],
      },
    ])

    // 默认仅可备货：91001（canPurchase 任一 SKU true）
    const r = await getStockableProductsAction({ store: storeId })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.map((x) => x.productSkcId)).toEqual(["91001"])
    const row = r.rows[0]
    expect(row.canPurchase).toBe(true)
    expect(row.warehouseAvailableStock).toBe(120)
    // 近7日销量取最新销售行（商品表 last7 列是插件时代死列，42 是旧值诱饵）
    expect(row.last7DaysSalesVolume).toBe(21)
    expect(row.skus).toHaveLength(2)
    expect(row.skus[0]).toEqual({ skuId: "111", className: "黑色", canPurchase: true })

    // 全部商品：含 91002（不可备货但展示）；下架 91003 永不出现
    const all = await getStockableProductsAction({ store: storeId, onlyCanPurchase: false })
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.rows.map((x) => x.productSkcId).sort()).toEqual(["91001", "91002"])

    // 搜索命中货号
    const searched = await getStockableProductsAction({ store: storeId, q: "SN-91002", onlyCanPurchase: false })
    expect(searched.ok).toBe(true)
    if (!searched.ok) return
    expect(searched.rows.map((x) => x.productSkcId)).toEqual(["91002"])
  })

  it("批量申报：逐项展开 purchaseDetailList，官方错误按项透出", async () => {
    mockSession.userId = ownerId
    const fn = mockFulfillmentFetch({ "bg.purchaseorder.apply": { applyResult: true } })
    vi.stubGlobal("fetch", fn)
    const r = await batchApplyTemuStockingAction({
      store: storeId,
      items: [
        { productSkcId: 91001, productName: "可备货鸟笼", skuIds: ["111", "112"], quantity: 3 },
      ],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.results).toEqual([{ productSkcId: 91001, productName: "可备货鸟笼", ok: true }])
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(body.productSkcId).toBe(91001)
    expect(body.purchaseDetailList).toEqual([
      { productSkuId: 111, productSkuPurchaseQuantity: 3 },
      { productSkuId: 112, productSkuPurchaseQuantity: 3 },
    ])
  })

  it("普通成员批量申报被拒（限管理员）", async () => {
    mockSession.userId = memberId
    vi.stubGlobal("fetch", mockFulfillmentFetch())
    const r = await batchApplyTemuStockingAction({
      store: storeId,
      items: [{ productSkcId: 91001, skuIds: ["111"], quantity: 1 }],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("管理员")
  })

  it("申报失败：官方业务错（定制品 3002）按项原样透出", async () => {
    mockSession.userId = ownerId
    vi.stubGlobal(
      "fetch",
      mockFulfillmentFetch({}, { "bg.purchaseorder.apply": { errorCode: 3002, errorMsg: "定制品不支持(批量)备货" } }),
    )
    const r = await batchApplyTemuStockingAction({
      store: storeId,
      items: [{ productSkcId: 91002, productName: "定制手链", skuIds: ["113"], quantity: 1 }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.results[0]?.ok).toBe(false)
    expect(r.results[0]?.error).toContain("定制品")
  })
})

describe("质检（bg.goods.qualityinspection.*，参数表 docs §8.17）", () => {
  it("列表：pageInfo 包装分页 + skuQcResult 过滤下发，行防御式映射", async () => {
    mockSession.userId = ownerId
    const fn = mockFulfillmentFetch({
      "bg.goods.qualityinspection.get": {
        total: 1,
        skuList: [
          {
            qcBillId: 990001,
            productSkuId: 53180679207,
            productSkcId: 2282117255,
            spuId: 611535736,
            skuName: "测试鸟笼 黑色",
            spec: "黑色/大号",
            catName: "宠物用品",
            purchaseNo: "WB2610210001",
            qcResultUpdateTime: "2026-10-21 10:00:00",
            thumbUrl: "https://img.example.com/sku1.jpg",
          },
        ],
      },
    })
    vi.stubGlobal("fetch", fn)
    const r = await getTemuQualityInspectionsAction({ store: storeId, skuQcResult: 2, pageNo: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.total).toBe(1)
    expect(r.rows[0]).toMatchObject({
      qcBillId: 990001,
      productSkuId: "53180679207",
      spec: "黑色/大号",
      purchaseNo: "WB2610210001",
      qcResultUpdateTime: "2026-10-21 10:00:00",
    })
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body)) as Record<string, unknown>
    // 12+ 候选全败的破案结构：分页必须 pageInfo 包装
    expect(body.pageInfo).toEqual({ pageNo: 1, pageSize: 20 })
    expect(body.skuQcResult).toBe(2)
  })

  it("详情：真实结构（qcDetail 内嵌每条 historyVOS），疵点/尺码/SKU 行随单据映射", async () => {
    mockSession.userId = ownerId
    const fn = mockFulfillmentFetch({
      "bg.goods.qualityinspectiondetail.get": {
        historyVOS: [
          {
            qcType: 1,
            qcBillNo: "RKZJ2609070916089",
            startTime: "2026-10-20 09:00:00",
            finishTime: "2026-10-20 12:00:00",
            qcDetail: {
              qcType: 3,
              qcResult: 2,
              expectQcQuantity: 100,
              defectiveQcQuantity: 12,
              totalQuantity: 120,
              receiptNo: "RC001",
              flawDTOList: [
                {
                  flawNameDesc: "货不对版",
                  flawDegree: 2,
                  flawDegreeDesc: "中等",
                  remark: "左袖",
                  attachments: ["https://img.example.com/flaw1.jpg"],
                  productSkuId: [53180679207],
                },
              ],
              sizeDTOList: [
                { locationTypeName: "衣长", sizeName: "XL", minQcSize: "70", maxQcSize: "72", expectMinSize: "69", expectMaxSize: "73" },
              ],
              skuDTOList: [
                { productSkuId: 53180679207, sizeName: "XL", expectQcQuantity: 100, defectiveQcQuantity: 12, totalQuantity: 120 },
              ],
            },
          },
        ],
      },
    })
    vi.stubGlobal("fetch", fn)
    const r = await getTemuQualityInspectionDetailAction({ store: storeId, qcBillId: 990001 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.detail.histories).toHaveLength(1)
    const h = r.detail.histories[0]!
    expect(h.qcBillNo).toBe("RKZJ2609070916089")
    expect(h.detailQcType).toBe(3)
    expect(h.qcResult).toBe(2)
    expect(h.defectiveQcQuantity).toBe(12)
    expect(h.receiptNo).toBe("RC001")
    expect(h.flaws[0]).toMatchObject({
      name: "货不对版",
      degreeDesc: "中等",
      images: ["https://img.example.com/flaw1.jpg"],
    })
    expect(h.sizes[0]).toMatchObject({ location: "衣长", sizeName: "XL", maxQcSize: "72" })
    expect(h.skus[0]).toMatchObject({ productSkuId: "53180679207", expectQcQuantity: 100 })
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(body.qcBillId).toBe(990001)
  })
})

describe("自动备货（apply 大数值钓上限）", () => {
  /** 顺序 mock：probe（首次 apply）失败返回上限文案，正式 apply 成功 */
  function seqAutoFetch(limitMsg: string) {
    let applyCalls = 0
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type: string }
      if (body.type === "bg.purchaseorder.apply") {
        applyCalls += 1
        if (applyCalls === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ result: null, success: false, errorCode: 3000000, errorMsg: limitMsg }),
          } as unknown as Response
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: {}, success: true, errorCode: 1000000, errorMsg: "" }),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: {}, success: true, errorCode: 1000000, errorMsg: "" }),
      } as unknown as Response
    })
  }
  const applyBodies = (fn: ReturnType<typeof seqAutoFetch>) =>
    fn.mock.calls
      .filter((c) => {
        const b = JSON.parse(String(c[1]?.body)) as { type: string }
        return b.type === "bg.purchaseorder.apply"
      })
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)

  it("试跑 dryRun：错误文案解析出各 SKU 上限，不申报", async () => {
    mockSession.userId = ownerId
    const fn = seqAutoFetch("SKU 111 最多可申请300件，SKU 222 最多可申请500件")
    vi.stubGlobal("fetch", fn)
    const r = await autoStockingLinkAction({
      store: storeId,
      productSkcId: 2282117255,
      skuIds: ["111", "222"],
      minQuantity: 100,
      dryRun: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.dryRun).toBe(true)
    expect(r.result.applied).toEqual([])
    expect(r.result.skuLimits).toEqual([
      { skuId: "111", maxQuantity: 300 },
      { skuId: "222", maxQuantity: 500 },
    ])
    // dryRun 只探测一次，不发起正式申报
    expect(applyBodies(fn)).toHaveLength(1)
  })

  it("达标按最大量备满：探测失败→正式申报各 SKU 各自上限", async () => {
    mockSession.userId = ownerId
    const fn = seqAutoFetch("SKU 111 最多可申请300件，SKU 222 最多可申请500件")
    vi.stubGlobal("fetch", fn)
    const r = await autoStockingLinkAction({
      store: storeId,
      productSkcId: 2282117255,
      skuIds: ["111", "222"],
      minQuantity: 100,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.applied).toEqual([
      { skuId: "111", quantity: 300 },
      { skuId: "222", quantity: 500 },
    ])
    const bodies = applyBodies(fn)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.purchaseDetailList).toEqual([
      { productSkuId: 111, productSkuPurchaseQuantity: 100000 },
      { productSkuId: 222, productSkuPurchaseQuantity: 100000 },
    ])
    expect(bodies[1]!.purchaseDetailList).toEqual([
      { productSkuId: 111, productSkuPurchaseQuantity: 300 },
      { productSkuId: 222, productSkuPurchaseQuantity: 500 },
    ])
  })

  it("全部低于最低量：不申报并返回回填建议（各 SKU 最大量最小值）", async () => {
    mockSession.userId = ownerId
    const fn = seqAutoFetch("最大可申请50件")
    vi.stubGlobal("fetch", fn)
    const r = await autoStockingLinkAction({
      store: storeId,
      productSkcId: 2282117255,
      skuIds: ["111", "222"],
      minQuantity: 100,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.applied).toEqual([])
    expect(r.result.backfillQuantity).toBe(50)
    expect(applyBodies(fn)).toHaveLength(1)
  })

  it("探测意外被官方接受：从响应提取单号自动取消回滚", async () => {
    mockSession.userId = ownerId
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type: string }
      if (body.type === "bg.purchaseorder.apply") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: { subPurchaseOrderSn: "WB2610229999" },
            success: true,
            errorCode: 1000000,
            errorMsg: "",
          }),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: {}, success: true, errorCode: 1000000, errorMsg: "" }),
      } as unknown as Response
    })
    vi.stubGlobal("fetch", fn)
    const r = await autoStockingLinkAction({
      store: storeId,
      productSkcId: 2282117255,
      skuIds: ["111"],
      minQuantity: 100,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.rolledBack).toBe(true)
    expect(r.result.applied).toEqual([])
    const cancel = fn.mock.calls
      .map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>)
      .find((b) => b.type === "bg.purchaseorder.cancel")
    expect(cancel!.subPurchaseOrderSnList).toEqual(["WB2610229999"])
  })
})

  it("真实错误形态（1006 备货量不得超过0）：上限 0 视为不可申报，不申报不回填", async () => {
    mockSession.userId = ownerId
    let applyCalls = 0
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type: string }
      if (body.type === "bg.purchaseorder.apply") {
        applyCalls += 1
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: null,
            success: false,
            errorCode: 1006,
            errorMsg: "备货量不得超过0",
          }),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: {}, success: true, errorCode: 1000000, errorMsg: "" }),
      } as unknown as Response
    })
    vi.stubGlobal("fetch", fn)
    const r = await autoStockingLinkAction({
      store: storeId,
      productSkcId: 2282117255,
      skuIds: ["88504828480"],
      minQuantity: 100,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 错误码 1006 不被误当上限；官方文案的 0 是真上限
    expect(r.result.skuLimits).toEqual([{ skuId: "88504828480", maxQuantity: 0 }])
    expect(r.result.applied).toEqual([])
    expect(r.result.backfillQuantity).toBeUndefined()
    expect(applyCalls).toBe(1)
  })
