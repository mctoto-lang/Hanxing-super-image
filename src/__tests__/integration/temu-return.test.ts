import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, users } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import {
  temuStores,
  temuShipOrders,
  temuProducts,
  temuSkuMaps,
} from "@/db/schema/temu"
import { encrypt } from "@/lib/crypto"
import {
  getTemuReturnPackagesAction,
  getTemuReturnPackageDetailAction,
  getTemuReturnSkuDetailAction,
} from "@/server/actions/temu-return"

/**
 * 退货工作台（退供三件套）实时链路回归：supplierId 本地解析/时间窗毫秒/
 * 筛选数组映射/5 万条上限文案/本地货号反查（官方 API mock fetch 按 type 分发，
 * 企业鉴权走真库）。
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

const SUPPLIER_ID = 6340001

const RETURN_PAGE = {
  total: 2,
  openReturnPackageDTOS: [
    {
      purchaseSubOrderSn: "WB2611010001",
      returnSupplierPackageNo: "RT2611010001",
      expressDeLiverySn: "SF1234567890",
      returnSupplierQuantity: 12,
      outboundTime: 1792800000000,
      packageStatusDesc: "待提货",
      returnSupplierReasonDesc: "质量不合格",
      logisticsTypeDesc: "专线",
      payMethodDesc: "寄付",
      returnHandOverTypeDesc: "自提",
      reason: "质检不合格退回",
    },
    {
      purchaseSubOrderSn: "WB2611010002",
      returnSupplierPackageNo: "RT2611010002",
      expressDeLiverySn: null,
      returnSupplierQuantity: 3,
      outboundTime: 1792700000000,
      packageStatusDesc: "已出库",
      returnSupplierReasonDesc: '["超发退回","包装破损"]',
      logisticsTypeDesc: "快递",
      payMethodDesc: "到付",
      returnHandOverTypeDesc: "邮寄",
      reason: null,
    },
  ],
}

const RETURN_DETAIL = {
  returnPackageInfos: [
    {
      productSkcId: 91001,
      thumbUrl: "https://img.example.com/skc1.jpg",
      mainSaleSpec: "黑色",
      secondarySaleSpec: "L",
      returnSupplierQuantity: 8,
    },
    {
      productSkcId: 91002,
      thumbUrl: null,
      mainSaleSpec: "白色",
      secondarySaleSpec: null,
      returnSupplierQuantity: 4,
    },
  ],
}

const RETURN_SKU_LIST = {
  total: 1,
  packageDetailDTOList: [
    {
      productSkuId: 6184223696,
      productSpuId: 611535736,
      packageSn: "RT2611010001",
      quantity: 5,
      outboundTime: 1792800000000,
      mainSaleSpec: "黑色",
    },
  ],
}

/** mock fetch：按 body.type 分发 */
function mockReturnFetch(
  overrides: Record<string, unknown> = {},
  failTypes: Record<string, { errorCode: number; errorMsg: string }> = {},
) {
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
        : body.type === "bg.refund.returnpackage.get"
          ? RETURN_PAGE
          : body.type === "bg.refund.returnpackagedetail.get"
            ? RETURN_DETAIL
            : body.type === "bg.refund.returnpackagelist.get"
              ? RETURN_SKU_LIST
              : {}
    return {
      ok: true,
      status: 200,
      json: async () => ({ result, success: true, errorCode: 1000000, errorMsg: "" }),
    } as unknown as Response
  })
}

/** 取首个带 body 的调用的请求体（防预检/无 body 调用混入断言） */
function firstBody(fn: ReturnType<typeof mockReturnFetch>): Record<string, unknown> {
  const call = fn.mock.calls.find((c) => c[1] && c[1]!.body)
  return JSON.parse(String(call![1]!.body)) as Record<string, unknown>
}

let entId: string
let ownerId: string
let storeId: string
/** 同企业但无发货数据的店铺：supplierId 解析失败的友好错误用 */
let emptyStoreId: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "temu 退货测试企业",
      slug: `rt-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      enabledModules: [...MODULE_NAMES],
    })
    .returning()
  entId = ent!.id

  const [owner] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `rt-${randomUUID().slice(0, 8)}`,
      email: `rt-${randomUUID().slice(0, 8)}@test.local`,
      name: "退货管理员",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  ownerId = owner!.id

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "退货测试店铺",
      accessTokenEncrypted: encrypt("rt-test-token"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeId = store!.id

  const [emptyStore] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "无发货数据店铺",
      accessTokenEncrypted: encrypt("rt-test-token-2"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  emptyStoreId = emptyStore!.id

  // supplierId 来源：本地发货单最近一条非空值（shiporderv2 行级同步落库）
  await db.insert(temuShipOrders).values({
    storeId,
    deliveryOrderSn: "FH-SUP-OLD",
    status: 3,
    supplierId: 6340000,
    contentHash: "sup-old",
    capturedAt: new Date(Date.now() - 86_400_000),
  })
  await db.insert(temuShipOrders).values({
    storeId,
    deliveryOrderSn: "FH-SUP-NEW",
    status: 2,
    supplierId: SUPPLIER_ID,
    contentHash: "sup-new",
    capturedAt: new Date(),
  })

  // 本地反查数据：SKC 货号/品名 + SKU→SKC 映射
  await db.insert(temuProducts).values([
    { storeId, productSkcId: "91001", productId: "71001", productSn: "B91001", productName: "退供鸟笼黑色" },
    { storeId, productSkcId: "91002", productId: "71002", productSn: "B91002", productName: "退供鸟笼白色" },
  ])
  await db.insert(temuSkuMaps).values({ storeId, skuId: "6184223696", skcId: "91001" })
}, 60_000)

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
  vi.unstubAllGlobals()
})

describe("退供包裹列表", () => {
  it(
    "supplierId 取最近发货单 + 时间窗/分页下发 + 行映射",
  { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockReturnFetch()
      vi.stubGlobal("fetch", fn)
      const r = await getTemuReturnPackagesAction({ store: storeId })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.total).toBe(2)
      expect(r.rows).toHaveLength(2)
      const first = r.rows[0]
      expect(first.returnSupplierPackageNo).toBe("RT2611010001")
      expect(first.expressDeliverySn).toBe("SF1234567890")
      expect(first.packageStatusDesc).toBe("待提货")
      expect(first.returnSupplierQuantity).toBe(12)
      // 官方 Desc 字段实测偶发 JSON 数组串：解析拼接为「、」分隔
      expect(r.rows[1]?.returnSupplierReasonDesc).toBe("超发退回、包装破损")
      expect(r.rows[1]?.packageStatusDesc).toBe("已出库")

      const body = firstBody(fn)
      // 最近一条非空 supplierId（capturedAt 最新者）
      expect(body.supplierId).toBe(SUPPLIER_ID)
      expect(body.pageNo).toBe(1)
      expect(body.pageSize).toBe(20)
      // 默认 90 天有界时间窗（epoch 毫秒，end-start 恰为 90 天）
      expect(body.outboundTimeEnd).toBeGreaterThan(Date.now() - 60_000)
      expect(
        (body.outboundTimeEnd as number) - (body.outboundTimeStart as number),
      ).toBe(90 * 86_400_000)
    },
  )

  it(
    "状态与筛选数组映射：status 枚举 + 逗号分隔多值 → 官方数组参数",
  { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockReturnFetch()
      vi.stubGlobal("fetch", fn)
      const r = await getTemuReturnPackagesAction({
        store: storeId,
        status: "1",
        window: "30",
        expressDeliverySn: "SF1234567890",
        purchaseSubOrderSn: "WB2611010001, WB2611010002",
      })
      expect(r.ok).toBe(true)
      const body = firstBody(fn)
      expect(body.status).toBe(1)
      expect(
        (body.outboundTimeEnd as number) - (body.outboundTimeStart as number),
      ).toBe(30 * 86_400_000)
      expect(body.expressDeLiverySns).toEqual(["SF1234567890"])
      expect(body.purchaseSubOrderSns).toEqual(["WB2611010001", "WB2611010002"])
    },
  )

  it(
    "无筛选参数时数组参数不占位（undefined 不下发）",
  { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockReturnFetch()
      vi.stubGlobal("fetch", fn)
      await getTemuReturnPackagesAction({ store: storeId })
      const body = firstBody(fn)
      expect(body.expressDeLiverySns).toBeUndefined()
      expect(body.purchaseSubOrderSns).toBeUndefined()
      expect(body.returnSupplierPackageNos).toBeUndefined()
      expect(body.status).toBeUndefined()
    },
  )

  it(
    "100000001（结果超 5 万条）转缩小时间窗提示",
  { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      vi.stubGlobal(
        "fetch",
        mockReturnFetch(
          {},
          { "bg.refund.returnpackage.get": { errorCode: 100000001, errorMsg: "查询结果超过50000" } },
        ),
      )
      const r = await getTemuReturnPackagesAction({ store: storeId })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toContain("缩小出库时间窗")
    },
  )

  it(
    "无发货数据的店铺：supplierId 解析失败友好错误；跨企业店铺隔离",
  { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      vi.stubGlobal("fetch", mockReturnFetch())
      const miss = await getTemuReturnPackagesAction({ store: emptyStoreId })
      expect(miss.ok).toBe(false)
      if (miss.ok) return
      expect(miss.error).toContain("supplierId")

      const cross = await getTemuReturnPackagesAction({ store: randomUUID() })
      expect(cross.ok).toBe(false)
    },
  )
})

describe("退供包裹详情（SKC 明细）", () => {
  it(
    "入参组装 + 本地反查货号/品名",
  { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockReturnFetch()
      vi.stubGlobal("fetch", fn)
      const r = await getTemuReturnPackageDetailAction({
        store: storeId,
        returnSupplierPackageNo: "RT2611010001",
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.rows).toHaveLength(2)
      expect(r.rows[0]?.productSn).toBe("B91001")
      expect(r.rows[0]?.productName).toBe("退供鸟笼黑色")
      expect(r.rows[1]?.productSn).toBe("B91002")
      expect(r.rows[0]?.returnSupplierQuantity).toBe(8)

      const body = firstBody(fn)
      expect(body.supplierId).toBe(SUPPLIER_ID)
      expect(body.returnSupplierPackageNo).toBe("RT2611010001")
    },
  )
})

describe("退供 SKU 明细列表", () => {
  it(
    "时间窗必填下发 + sku_map 两跳反查货号",
  { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockReturnFetch()
      vi.stubGlobal("fetch", fn)
      // SKU 明细窗口上限 31 天（真实店实测 100000004），schema 拒绝 90/365
      // （类型层已非法，经参数类型断言走运行时校验）
      const badInput = { store: storeId, window: "365" } as unknown as Parameters<
        typeof getTemuReturnSkuDetailAction
      >[0]
      const rejected = await getTemuReturnSkuDetailAction(badInput)
      expect(rejected.ok).toBe(false)

      const r = await getTemuReturnSkuDetailAction({ store: storeId, window: "31" })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.rows).toHaveLength(1)
      const row = r.rows[0]
      // productSkuId 6184223696 → sku_map → skc 91001 → temu_product
      expect(row?.productSn).toBe("B91001")
      expect(row?.productName).toBe("退供鸟笼黑色")
      expect(row?.quantity).toBe(5)
      expect(row?.packageSn).toBe("RT2611010001")

      const body = firstBody(fn)
      expect(body.supplierId).toBe(SUPPLIER_ID)
      expect(
        (body.outboundTimeEnd as number) - (body.outboundTimeStart as number),
      ).toBe(31 * 86_400_000)
    },
  )
})
