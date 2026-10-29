import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq, inArray, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, permissionGroups, users } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import { temuShipOrders, temuShipPackages, temuStores, temuProducts, temuSalesOverviews } from "@/db/schema/temu"
import { encrypt } from "@/lib/crypto"
import {
  getTemuShipOrdersAction,
  getShipStagingAction,
  addShipStagingAction,
  createShipOrderAction,
  packingMatchAction,
  getLogisticsMatchAction,
  sendPackingAction,
  cancelShipOrderAction,
  getShipPackagesAction,
  editShipPackagesAction,
  changeShipLogisticsAction,
  getShipBoxMarkPrintUrlAction,
  getShipPredictVolumeAction,
  getShipBarcodePrintUrlAction,
  getTemuShipStatsAction,
} from "@/server/actions/temu-ship"
import { syncStore, upsertShipOrderRows } from "@/server/services/temu-sync"
import { temuDayStr, temuStartOfToday, temuStartOfWeek } from "@/server/services/temu-time"

/**
 * 发货域（M5-B）批次一回归：同步源 api-ship-orders 落库/upsert 覆盖、
 * 列表 action 状态预设/货号过滤/分页/店铺归属守卫。
 * 官方 API mock fetch 按 type 分发；企业鉴权与落库走真库。
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

/** shiporderv2 响应行（真实店字段结构，2026-10-23 探针实证） */
const SHIP_ROW = (over: Partial<Record<string, unknown>> = {}) => ({
  deliveryOrderSn: "FH2610232950871",
  subPurchaseOrderSn: "WB2610185064077",
  productSkcId: 51458492005,
  skcExtCode: "B094",
  subWarehouseId: 168719306067,
  subWarehouseName: "南海宝湾19号子仓",
  status: 1,
  urgencyType: 0,
  isCustomProduct: false,
  inventoryRegion: 1,
  purchaseStockType: 0,
  deliveryMethod: 2,
  expressBatchSn: "EB2610231096455",
  expressCompanyId: 10240006147472,
  expressCompany: "申通快递",
  expressDeliverySn: "772083914547575",
  deliveryAddressId: 52971147310,
  receiveAddressInfo: {
    receiverName: "南海宝湾19号子仓",
    phone: "16621635338",
    provinceName: "广东省",
    cityName: "佛山市",
    districtName: "南海区",
    detailAddress: "广东省佛山市南海区狮山镇金荣路宝湾南海产业园",
    provinceCode: 43000000000006,
    cityCode: 43000000000080,
    districtCode: 43000000000747,
  },
  deliverPackageNum: 1,
  otherDeliveryPackageNum: 0,
  predictTotalPackageWeight: 3485,
  deliveryOrderCreateTime: 1792739779183,
  deliverTime: 1792739824082,
  receiveTime: null,
  inboundTime: null,
  purchaseTime: 1792309720286,
  expectPickUpGoodsTime: 1792749600000,
  expectLatestPickTime: 1792771199999,
  latestFeedbackStatus: 0,
  expressWeightFeedbackStatus: 0,
  expressRejectStatus: 0,
  exceptionFeedBackTotalCount: 0,
  receiveSkcNum: 0,
  defectiveSkcNum: 0,
  receivePackageNum: 0,
  skcPurchaseNum: 39,
  deliverSkcNum: 41,
  isPrintBoxMark: true,
  supplierId: 634418211196072,
  isClothCategory: false,
  ifCanOperateDeliver: false,
  driverName: "",
  plateNumber: "",
  packageList: [{ packageSn: "PC2610233880027", skcNum: 41 }],
  packageReceiveInfoVOList: [{ packageSn: "PC2610233880027", receiveTime: null }],
  ...over,
})

/** mock fetch：shiporderv2 分发固定页，其余源一律空成功（空数组即停止翻页） */
function mockShipSyncFetch(rows: Record<string, unknown>[]) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string }
    let result: unknown = {}
    if (body.type === "bg.shiporderv2.get") {
      result = { total: rows.length, list: rows }
    } else if (body.type === "bg.glo.goods.list.get") {
      result = { data: [], totalCount: 0 }
    } else if (body.type === "bg.goods.salesv2.get") {
      result = { subOrderList: [], total: 0 }
    }
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
let shipMemberId: string
let storeId: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "temu 发货测试企业",
      slug: `ship-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      enabledModules: [...MODULE_NAMES],
    })
    .returning()
  entId = ent!.id

  const [group] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: entId,
      name: "发货权限组",
      allowedPages: ["settings", "temu", "temu_ship", "temu_purchase"],
    })
    .returning()
  const [noShipGroup] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entId, name: "无发货权限组", allowedPages: ["settings", "temu"] })
    .returning()

  const [owner] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `ship-${randomUUID().slice(0, 8)}`,
      email: `ship-${randomUUID().slice(0, 8)}@test.local`,
      name: "发货管理员",
      passwordHash: "x",
      enterpriseRole: "owner",
      groupId: group!.id,
    })
    .returning()
  ownerId = owner!.id

  const [member] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `shipm-${randomUUID().slice(0, 8)}`,
      email: `shipm-${randomUUID().slice(0, 8)}@test.local`,
      name: "无发货页成员",
      passwordHash: "x",
      enterpriseRole: "member",
      groupId: noShipGroup!.id,
    })
    .returning()
  memberId = member!.id

  const [shipMember] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `ships-${randomUUID().slice(0, 8)}`,
      email: `ships-${randomUUID().slice(0, 8)}@test.local`,
      name: "发货页成员",
      passwordHash: "x",
      enterpriseRole: "member",
      groupId: group!.id,
    })
    .returning()
  shipMemberId = shipMember!.id

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "发货测试店铺",
      accessTokenEncrypted: encrypt("ship-test-token"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeId = store!.id
}, 60_000)

afterAll(async () => {
  if (entId) await db.delete(enterprises).where(eq(enterprises.id, entId))
  vi.unstubAllGlobals()
})

describe("同步源 api-ship-orders", () => {
  it(
    "shiporderv2 行落库（含包裹/地址/毫秒时间），重复同步 upsert 覆盖不重复",
    { timeout: 60_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockShipSyncFetch([
        SHIP_ROW(),
        SHIP_ROW({ deliveryOrderSn: "FH2610232865304", skcExtCode: "B007", status: 0, deliverTime: null, packageList: [], packageReceiveInfoVOList: [] }),
      ])
      vi.stubGlobal("fetch", fn)
      await syncStore(storeId)

      const orders = await db.select().from(temuShipOrders).where(eq(temuShipOrders.storeId, storeId))
      expect(orders).toHaveLength(2)
      const main = orders.find((o) => o.deliveryOrderSn === "FH2610232950871")
      expect(main).toBeTruthy()
      expect(main?.status).toBe(1)
      expect(main?.skcExtCode).toBe("B094")
      expect(main?.expressCompany).toBe("申通快递")
      expect(main?.deliverSkcNum).toBe(41)
      expect(main?.supplierId).toBe(634418211196072)
      expect(main?.isPrintBoxMark).toBe(true)
      expect(main?.deliverTime?.toISOString()).toBe(new Date(1792739824082).toISOString())
      expect(main?.deliveryOrderCreateTime?.toISOString()).toBe(new Date(1792739779183).toISOString())
      expect(main?.receiveAddressInfo?.districtName).toBe("南海区")

      const pkgs = await db.select().from(temuShipPackages).where(eq(temuShipPackages.storeId, storeId))
      expect(pkgs).toHaveLength(1)
      expect(pkgs[0]?.packageSn).toBe("PC2610233880027")
      expect(pkgs[0]?.skcNum).toBe(41)

      // 请求体：deliverTime 窗口 + sortType 下发
      const shipCalls = fn.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.body && JSON.parse(String((c[1] as RequestInit).body)).type === "bg.shiporderv2.get",
      ) as unknown as Array<[string, RequestInit]>
      expect(shipCalls.length).toBeGreaterThan(0)
      const reqBody = JSON.parse(String(shipCalls[0]![1].body))
      expect(reqBody.deliverTimeFrom).toBeGreaterThan(0)
      expect(reqBody.deliverTimeTo).toBeGreaterThan(reqBody.deliverTimeFrom)
      expect(reqBody.sortType).toBe(0)
      expect(reqBody.pageNo).toBe(1)

      // 第二轮：状态推进（已收货+签收时间）→ upsert 覆盖而非新增；另带一张新的待收货单
      const fn2 = mockShipSyncFetch([
        SHIP_ROW({ status: 2, receiveTime: 1792800000000, receiveSkcNum: 41, receivePackageNum: 1 }),
        SHIP_ROW({
          deliveryOrderSn: "FH2610239990001",
          skcExtCode: "B094",
          status: 1,
          packageList: [],
          packageReceiveInfoVOList: [],
        }),
      ])
      vi.stubGlobal("fetch", fn2)
      await syncStore(storeId)
      const after = await db.select().from(temuShipOrders).where(eq(temuShipOrders.storeId, storeId))
      expect(after).toHaveLength(3)
      const updated = after.find((o) => o.deliveryOrderSn === "FH2610232950871")
      expect(updated?.status).toBe(2)
      expect(updated?.receiveTime?.toISOString()).toBe(new Date(1792800000000).toISOString())
      expect(updated?.receiveSkcNum).toBe(41)
      vi.unstubAllGlobals()
    },
  )
})

describe("发货单列表 action", () => {
  it(
    "状态预设过滤 + 货号过滤 + 分页 + 待装箱按创建时间排序 + 店铺归属守卫",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      // 追加一条其他货号、其他状态的确定性数据（同步测试已落 2 条）
      await db.insert(temuShipOrders).values({
        storeId,
        deliveryOrderSn: "FH-SEED-3",
        skcExtCode: "B150",
        status: 4,
        deliveryOrderCreateTime: new Date(1792900000000),
        contentHash: "seed3",
        capturedAt: new Date(),
      })
      // 部分收货（状态 6）单列预设
      await db.insert(temuShipOrders).values({
        storeId,
        deliveryOrderSn: "FH-SEED-6",
        skcExtCode: "B160",
        status: 6,
        deliveryOrderCreateTime: new Date(1792800000000),
        contentHash: "seed6",
        capturedAt: new Date(),
      })

      const all = await getTemuShipOrdersAction({ store: storeId, statusPreset: "all" })
      expect(all.ok).toBe(true)
      if (!all.ok) return
      expect(all.total).toBe(5)
      // 排序：status=0 的单（deliverTime 空）按创建时间进 coalesce 序列（最新创建在最前）
      expect(all.rows[0]?.deliveryOrderSn).toBe("FH-SEED-3")

      // 部分收货(6) 单列；已收货(2,3) 不再包含 6
      const partial = await getTemuShipOrdersAction({ store: storeId, statusPreset: "partial" })
      expect(partial.ok).toBe(true)
      if (!partial.ok) return
      expect(partial.total).toBe(1)
      expect(partial.rows[0]?.deliveryOrderSn).toBe("FH-SEED-6")

      const done = await getTemuShipOrdersAction({ store: storeId, statusPreset: "done" })
      expect(done.ok).toBe(true)
      if (!done.ok) return
      expect(done.total).toBe(1)
      expect(done.rows[0]?.deliveryOrderSn).toBe("FH2610232950871")
      expect(done.rows[0]?.subWarehouseId).toBe(168719306067)

      const shipping = await getTemuShipOrdersAction({ store: storeId, statusPreset: "shipping" })
      expect(shipping.ok).toBe(true)
      if (!shipping.ok) return
      expect(shipping.total).toBe(1)
      expect(shipping.rows[0]?.skcExtCode).toBe("B094")
      expect(shipping.rows[0]?.deliveryOrderSn).toBe("FH2610239990001")

      const pending = await getTemuShipOrdersAction({ store: storeId, statusPreset: "pending" })
      expect(pending.ok).toBe(true)
      if (!pending.ok) return
      expect(pending.total).toBe(1)
      expect(pending.rows[0]?.deliveryOrderSn).toBe("FH2610232865304")

      const byExt = await getTemuShipOrdersAction({ store: storeId, statusPreset: "all", skcExtCode: "B150" })
      expect(byExt.ok).toBe(true)
      if (!byExt.ok) return
      expect(byExt.total).toBe(1)
      expect(byExt.rows[0]?.status).toBe(4)

      const page2 = await getTemuShipOrdersAction({ store: storeId, statusPreset: "all", page: 2, pageSize: 2 })
      expect(page2.ok).toBe(true)
      if (!page2.ok) return
      expect(page2.total).toBe(5)
      expect(page2.rows).toHaveLength(2)

      // 店铺归属守卫：不存在/跨企业的店铺 id 被拒
      const guard = await getTemuShipOrdersAction({ store: randomUUID(), statusPreset: "all" })
      expect(guard.ok).toBe(false)
      if (guard.ok) return
      expect(guard.error).toContain("店铺")
    },
  )

  it(
    "fresh 实时核对：官方回查落库新状态；官方已移除的单置为已取消；官方失败降级返回本地",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      // 两张本地待装箱单：FH-FRESH-1 官方已取消（回查更新）、FH-FRESH-2 官方已不存在（置 5）
      await db.insert(temuShipOrders).values([
        {
          storeId,
          deliveryOrderSn: "FH-FRESH-1",
          skcExtCode: "B901",
          status: 0,
          deliveryOrderCreateTime: new Date(1793010000000),
          contentHash: "fresh1",
          capturedAt: new Date(),
        },
        {
          storeId,
          deliveryOrderSn: "FH-FRESH-2",
          skcExtCode: "B902",
          status: 0,
          deliveryOrderCreateTime: new Date(1793000000000),
          contentHash: "fresh2",
          capturedAt: new Date(),
        },
      ])

      const fn = mockWizardFetch({
        "bg.shiporderv2.get": {
          total: 1,
          list: [SHIP_ROW({ deliveryOrderSn: "FH-FRESH-1", status: 5, expressBatchSn: "" })],
        },
      })
      vi.stubGlobal("fetch", fn)

      // pageSize 2 → 当前页恰好是两张新插入单（创建时间最新排前）
      const r = await getTemuShipOrdersAction({ store: storeId, statusPreset: "pending", pageSize: 2, fresh: true })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.freshStats).toEqual({ fetched: 1, missing: 1 })
      // 官方请求按当前页单号回查
      const body = bodiesOfType(fn, "bg.shiporderv2.get")[0]!
      expect(body.deliveryOrderSnList).toEqual(["FH-FRESH-1", "FH-FRESH-2"])
      // 回查后两张单都不再是待装箱：FH-FRESH-1 官方 status=5 落库、FH-FRESH-2 缺席被置 5
      // （分页内只剩更早已有的待装箱单，新插入的两张已移出）
      expect(r.rows.map((x) => x.deliveryOrderSn)).not.toContain("FH-FRESH-1")
      expect(r.rows.map((x) => x.deliveryOrderSn)).not.toContain("FH-FRESH-2")
      const after = await db.select().from(temuShipOrders).where(inArray(temuShipOrders.deliveryOrderSn, ["FH-FRESH-1", "FH-FRESH-2"]))
      expect(after.find((o) => o.deliveryOrderSn === "FH-FRESH-1")?.status).toBe(5)
      expect(after.find((o) => o.deliveryOrderSn === "FH-FRESH-2")?.status).toBe(5)
      vi.unstubAllGlobals()

      // 官方回查失败：降级返回本地数据 + freshWarning，不整体失败（不用 7000007，避免 tokenState 副作用污染后续用例）
      await db.insert(temuShipOrders).values({
        storeId,
        deliveryOrderSn: "FH-FRESH-3",
        skcExtCode: "B903",
        status: 0,
        deliveryOrderCreateTime: new Date(1793020000000),
        contentHash: "fresh3",
        capturedAt: new Date(),
      })
      const fnFail = mockWizardFetch(
        {},
        { "bg.shiporderv2.get": { errorCode: 1000000, errorMsg: "system busy" } },
      )
      vi.stubGlobal("fetch", fnFail)
      const degraded = await getTemuShipOrdersAction({ store: storeId, statusPreset: "pending", pageSize: 1, fresh: true })
      expect(degraded.ok).toBe(true)
      if (!degraded.ok) return
      expect(degraded.rows[0]?.deliveryOrderSn).toBe("FH-FRESH-3")
      expect(degraded.freshWarning).toContain("实时核对")
      vi.unstubAllGlobals()
    },
  )
})


/* ─── 批次二：五步向导写操作 ─── */

/** mock fetch：向导各接口按 type 分发（默认空成功）；failures 模拟官方业务失败包络 */
function mockWizardFetch(
  overrides: Record<string, unknown> = {},
  failures: Record<string, { errorCode: number; errorMsg: string }> = {},
) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string }
    if (body.type in failures) {
      const f = failures[body.type]!
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: null, success: false, errorCode: f.errorCode, errorMsg: f.errorMsg }),
      } as unknown as Response
    }
    const defaults: Record<string, unknown> = {
      "bg.shiporder.staging.get": {
        total: 1,
        list: [
          {
            subPurchaseOrderBasicVO: {
              subPurchaseOrderSn: "WB2610185064077",
              productName: "测试菜谱本 PROBE",
              productSkcId: 51458492005,
              skcExtCode: "B094",
              subWarehouseName: "南海宝湾19号子仓",
              purchaseQuantity: 39,
              purchaseTime: 1792309720286,
              urgencyType: 0,
              purchaseStockType: 0,
              isCustomProduct: false,
              expectLatestDeliverTimeOrDefault: 1792802072958,
              expectLatestArrivalTimeOrDefault: 1793061272958,
              deliverDisplayCountdownMillis: 21 * 3_600_000 + 5 * 60_000,
              autoRemoveFromDeliveryPlatformTime: 1792890120286,
              productSkcPicture: "https://img.example.com/skc.jpg",
            },
            orderDetailVOList: [
              {
                productSkuId: 94907922203,
                skuDeliveryQuantityMaxLimit: 60,
                productSkuPurchaseQuantity: 39,
                productSkuImgUrlList: ["https://img.example.com/sku1.jpg"],
              },
            ],
          },
        ],
      },
      "bg.shiporder.staging.add": { joinErrorList: [], existJoinErrorSubPurchase: false },
      "bg.shiporder.receiveaddressv2.get": {
        subPurchaseReceiveAddressGroups: [
          {
            subWarehouseId: 168719306067,
            receiveAddressInfo: SHIP_ROW().receiveAddressInfo,
            subPurchaseOrderSnList: ["WB2610185064077"],
          },
        ],
      },
      "bg.mall.address.get": [
        { id: 52971147310, addressLabel: "发货仓", isDefault: true, provinceName: "广东省", cityName: "广州市", districtName: "白云区", addressDetail: "某某路 1 号" },
      ],
      "bg.shiporderv3.create": { deliveryOrders: ["FH-NEW-CREATE-1"], isUrgencyType: false, cancelUrgencyType: false },
      "bg.shiporderv2.get": { total: 1, list: [SHIP_ROW({ deliveryOrderSn: "FH-NEW-CREATE-1" })] },
      "bg.shiporder.packing.match": {
        shouldAddDeliveryOrderInfoList: [{ deliveryOrderSn: "FH-OTHER-2", supplierId: 634418211196072 }],
        deliveryOrderSnNotPrintBox: [],
        skuSumWeight: 3485,
        ableUsePlatformExpress: true,
      },
      "bg.shiporderv3.logisticsmatch.get": {
        mostUsedExpressCompany: { expressCompanyId: 44, expressCompanyName: "顺丰", canSaveChargeAmount: "12.5" },
        usePricePrivileges: true,
        list: [
          {
            expressCompanyId: 115,
            expressCompanyName: "中通",
            // 金额官方实测返回数字（2026-10-27 探针 4.55/4.78），映射须兼容数字/字符串
            minSupplierChargeAmount: 4.55,
            maxSupplierChargeAmount: 4.78,
            courierTimeType: 1,
            channelScheduleTimeList: [1792749600000, 1792753200000],
            pickupMethod: 0,
            predictId: 7788,
            advantageDescList: ["更快"],
          },
        ],
      },
      "bg.shiporder.packing.send": { expressBatchSn: "EB-NEW-1" },
      "bg.logistics.boxmarkinfo.get": "DK-TEST-KEY-123",
      "bg.predict.volume.get": { predictVolume: 0.1407 },
      "bg.shiporder.cancel": { result: [] },
      "bg.shiporder.package.get": {
        packageInfo: [{ packageSn: "PC-1", skcNum: 41, packageDetails: [{ productSkuId: 94907922203, skuNum: 41 }] }],
      },
      "bg.shiporder.package.edit": {},
      "bg.shiporder.logistics.get": [{ expressCompanyId: 44, expressCompanyName: "顺丰" }],
      "bg.shiporder.logistics.change": { expressBatchSn: "EB-CHANGED" },
      "bg.shiporder.logisticsorder.match": { checkResultMsg: "" },
    }
    const result = body.type in overrides ? overrides[body.type] : (defaults[body.type] ?? {})
    return {
      ok: true,
      status: 200,
      json: async () => ({ result, success: true, errorCode: 1000000, errorMsg: "" }),
    } as unknown as Response
  })
}

/** 取下发官方的指定 type 请求体列表 */
function bodiesOfType(fn: ReturnType<typeof mockWizardFetch>, type: string) {
  return fn.mock.calls
    .filter((c) => {
      const init = c[1] as RequestInit | undefined
      if (!init?.body) return false
      return JSON.parse(String(init.body)).type === type
    })
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>)
}

const CREATE_INPUT = {
  store: "",
  groups: [
    {
      subWarehouseId: 168719306067,
      receiveAddressInfo: {
        receiverName: "南海宝湾19号子仓",
        phone: "16621635338",
        provinceName: "广东省",
        provinceCode: 43000000000006,
        cityName: "佛山市",
        cityCode: 43000000000080,
        districtName: "南海区",
        districtCode: 43000000000747,
        detailAddress: "广东省佛山市南海区狮山镇金荣路",
      },
      deliveryAddressId: 52971147310,
      orders: [
        {
          subPurchaseOrderSn: "WB2610185064077",
          deliverOrderDetailInfos: [{ productSkuId: 94907922203, deliverSkuNum: 41 }],
          packageInfos: [
            { packageDetailSaveInfos: [{ productSkuId: 94907922203, skuNum: 30 }] },
            { packageDetailSaveInfos: [{ productSkuId: 94907922203, skuNum: 11 }] },
          ],
        },
      ],
    },
  ],
}

describe("发货五步向导写操作", () => {
  it(
    "加入发货台：deliveryAddressType=4 + 失败明细过滤",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockWizardFetch({
        "bg.shiporder.staging.add": {
          joinErrorList: [
            { joinErrorSubPurchaseOrderSn: "WB-FAIL-1", errorCode: 2000000, errorMsg: "查询备货单标签信息失败" },
          ],
          existJoinErrorSubPurchase: true,
        },
      })
      vi.stubGlobal("fetch", fn)
      const r = await addShipStagingAction({ store: storeId, subPurchaseOrderSns: ["WB-OK-1", "WB-FAIL-1"] })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.joined).toEqual(["WB-OK-1"])
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]?.sn).toBe("WB-FAIL-1")
      const body = bodiesOfType(fn, "bg.shiporder.staging.add")[0]!
      expect(body.joinInfoList).toEqual([
        { subPurchaseOrderSn: "WB-OK-1", deliveryAddressType: 4 },
        { subPurchaseOrderSn: "WB-FAIL-1", deliveryAddressType: 4 },
      ])
      vi.unstubAllGlobals()
    },
  )

  it(
    "创建发货单：三级嵌套结构下发 + 回查落库；分箱合计不符则不发请求",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      // 校验拦截：第二箱只放 10 件，合计 40 ≠ 41
      const bad = {
        ...CREATE_INPUT,
        store: storeId,
        groups: [
          {
            ...CREATE_INPUT.groups[0]!,
            orders: [
              {
                ...CREATE_INPUT.groups[0]!.orders[0]!,
                packageInfos: [
                  { packageDetailSaveInfos: [{ productSkuId: 94907922203, skuNum: 30 }] },
                  { packageDetailSaveInfos: [{ productSkuId: 94907922203, skuNum: 10 }] },
                ],
              },
            ],
          },
        ],
      }
      const fnGuard = mockWizardFetch()
      vi.stubGlobal("fetch", fnGuard)
      const rejected = await createShipOrderAction(bad)
      expect(rejected.ok).toBe(false)
      if (rejected.ok) return
      expect(rejected.error).toContain("分箱合计")
      expect(bodiesOfType(fnGuard, "bg.shiporderv3.create")).toHaveLength(0)

      // 正常创建：嵌套结构 + 单号提取 + 回查 shiporderv2 落库
      const fn = mockWizardFetch()
      vi.stubGlobal("fetch", fn)
      const r = await createShipOrderAction({ ...CREATE_INPUT, store: storeId })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.deliveryOrderSns).toEqual(["FH-NEW-CREATE-1"])
      const body = bodiesOfType(fn, "bg.shiporderv3.create")[0]!
      const group = (body.deliveryOrderCreateGroupList as Record<string, unknown>[])[0]!
      expect(group.subWarehouseId).toBe(168719306067)
      const info = (group.deliveryOrderCreateInfos as Record<string, unknown>[])[0]!
      expect(info.subPurchaseOrderSn).toBe("WB2610185064077")
      expect(info.deliveryAddressId).toBe(52971147310)
      expect(info.packageInfos).toHaveLength(2)
      // 回查请求带了新单号，且本地库落了行
      const back = bodiesOfType(fn, "bg.shiporderv2.get").find((b) => b.deliveryOrderSnList)
      expect(back?.deliveryOrderSnList).toEqual(["FH-NEW-CREATE-1"])
      const cnt = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(temuShipOrders)
        .where(eq(temuShipOrders.deliveryOrderSn, "FH-NEW-CREATE-1"))
      expect(cnt[0]?.n).toBe(1)
      vi.unstubAllGlobals()
    },
  )

  it(
    "装箱发货：方式2 整千克+predictId/时段/网点四件套透传；非整千克拒；方式3 结构",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      // 非整千克 → zod 拒，未发请求
      const fnGuard = mockWizardFetch()
      vi.stubGlobal("fetch", fnGuard)
      const bad = await sendPackingAction({
        store: storeId,
        deliveryOrderSns: ["FH-NEW-CREATE-1"],
        deliveryAddressId: 52971147310,
        payload: {
          deliverMethod: 2,
          expressCompanyId: 115,
          predictTotalPackageWeight: 1500,
          expressPackageNum: 1,
        },
      })
      expect(bad.ok).toBe(false)
      expect(bodiesOfType(fnGuard, "bg.shiporder.packing.send")).toHaveLength(0)

      // 方式 2：送网点（pickupMethod=1）+ 网点四件套 + 预约时段/predictId 透传
      const fn = mockWizardFetch()
      vi.stubGlobal("fetch", fn)
      const r = await sendPackingAction({
        store: storeId,
        deliveryOrderSns: ["FH-NEW-CREATE-1"],
        deliveryAddressId: 52971147310,
        predictPackageVolume: "1.2",
        payload: {
          deliverMethod: 2,
          expressCompanyId: 115,
          predictTotalPackageWeight: 4000,
          expectPickUpGoodsTime: 1792749600000,
          pickupMethod: 1,
          predictId: 7788,
          expressPackageNum: 2,
          selfDeliverSitePhone: "020-12345678",
          selfDeliverSiteAddress: "白云区某网点",
          selfDeliverSiteUserCode: "U001",
          selfDeliverSiteCompanyCode: "C001",
        },
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.expressBatchSn).toBe("EB-NEW-1")
      const body = bodiesOfType(fn, "bg.shiporder.packing.send")[0]!
      expect(body.deliveryOrderSnList).toEqual(["FH-NEW-CREATE-1"])
      expect(body.deliveryAddressId).toBe(52971147310)
      expect(body.deliverMethod).toBe(2)
      expect(body.predictPackageVolume).toBe("1.2")
      const info = body.thirdPartyDeliveryInfo as Record<string, unknown>
      expect(info.expressCompanyId).toBe(115)
      expect(info.predictTotalPackageWeight).toBe(4000)
      expect(info.expectPickUpGoodsTime).toBe(1792749600000)
      expect(info.pickupMethod).toBe(1)
      expect(info.predictId).toBe(7788)
      expect(info.selfDeliverSiteCompanyCode).toBe("C001")
      expect(body.selfDeliveryInfo).toBeUndefined()
      expect(body.thirdPartyExpressDeliveryInfoVO).toBeUndefined()

      // 方式 3：三方结构
      const fn3 = mockWizardFetch()
      vi.stubGlobal("fetch", fn3)
      const r3 = await sendPackingAction({
        store: storeId,
        deliveryOrderSns: ["FH-NEW-CREATE-1"],
        deliveryAddressId: 52971147310,
        payload: {
          deliverMethod: 3,
          expressCompanyId: 44,
          expressCompanyName: "顺丰",
          expressDeliverySn: "SF123456",
          expressPackageNum: 1,
        },
      })
      expect(r3.ok).toBe(true)
      const body3 = bodiesOfType(fn3, "bg.shiporder.packing.send")[0]!
      expect(body3.deliverMethod).toBe(3)
      expect(body3.thirdPartyExpressDeliveryInfoVO).toEqual({
        expressCompanyId: 44,
        expressCompanyName: "顺丰",
        expressDeliverySn: "SF123456",
        expressPackageNum: 1,
      })
      vi.unstubAllGlobals()
    },
  )

  it(
    "取消/调整包裹/改物流：请求体口径",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockWizardFetch()
      vi.stubGlobal("fetch", fn)

      const cancel = await cancelShipOrderAction({ store: storeId, deliveryOrderSn: "FH-NEW-CREATE-1" })
      expect(cancel.ok).toBe(true)
      expect(bodiesOfType(fn, "bg.shiporder.cancel")[0]!.deliveryOrderSn).toBe("FH-NEW-CREATE-1")

      const pkgs = await getShipPackagesAction({ store: storeId, deliveryOrderSn: "FH-NEW-CREATE-1" })
      expect(pkgs.ok).toBe(true)
      if (pkgs.ok) expect(pkgs.rows[0]?.packageSn).toBe("PC-1")

      const edit = await editShipPackagesAction({
        store: storeId,
        deliveryOrderSn: "FH-NEW-CREATE-1",
        deliverOrderDetailInfos: [{ productSkuId: 94907922203, deliverSkuNum: 41 }],
        packageInfos: [
          { packageDetailSaveInfos: [{ productSkuId: 94907922203, skuNum: 20 }] },
          { packageDetailSaveInfos: [{ productSkuId: 94907922203, skuNum: 21 }] },
        ],
      })
      expect(edit.ok).toBe(true)
      const editBody = bodiesOfType(fn, "bg.shiporder.package.edit")[0]!
      expect(editBody.deliveryOrderSn).toBe("FH-NEW-CREATE-1")
      expect(editBody.packageInfos).toHaveLength(2)

      const change = await changeShipLogisticsAction({
        store: storeId,
        expressBatchSn: "EB-NEW-1",
        deliveryAddressId: 52971147310,
        payload: {
          deliverMethod: 3,
          expressCompanyId: 44,
          expressCompanyName: "顺丰",
          expressDeliverySn: "SF999",
          expressPackageNum: 1,
        },
      })
      expect(change.ok).toBe(true)
      const changeBody = bodiesOfType(fn, "bg.shiporder.logistics.change")[0]!
      expect(changeBody.expressBatchSn).toBe("EB-NEW-1")
      expect(changeBody.deliverMethod).toBe(3)
      vi.unstubAllGlobals()
    },
  )

  it(
    "发货台筛选：多备货单号/SKC/货号映射官方入参，fresh 走实时",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockWizardFetch()
      vi.stubGlobal("fetch", fn)
      const r = await getShipStagingAction({
        store: storeId,
        subPurchaseOrderSn: "WB-1，WB-2",
        skcId: "51458492005",
        skcExtCode: "B094",
        fresh: true,
      })
      expect(r.ok).toBe(true)
      const body = bodiesOfType(fn, "bg.shiporder.staging.get")[0]!
      expect(body.subPurchaseOrderSnList).toEqual(["WB-1", "WB-2"])
      expect(body.productSkcIdList).toEqual([51458492005])
      expect(body.skcExtCode).toEqual(["B094"])
      vi.unstubAllGlobals()
    },
  )

  it(
    "创建守卫：返回未解析到单号判失败；官方标签类报错附超时移除提示",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      // 官方受理但无单号 → 判失败，防止带空单号进装箱步或重复创建
      const fnEmpty = mockWizardFetch({ "bg.shiporderv3.create": { isUrgencyType: false } })
      vi.stubGlobal("fetch", fnEmpty)
      const empty = await createShipOrderAction({ ...CREATE_INPUT, store: storeId })
      expect(empty.ok).toBe(false)
      if (empty.ok) return
      expect(empty.error).toContain("未解析到发货单号")
      expect(bodiesOfType(fnEmpty, "bg.shiporderv2.get")).toHaveLength(0)

      // 官方业务失败（2000000 标签类）→ 透传官方文案 + 追加超时移除提示
      const fnErr = mockWizardFetch(
        { "bg.shiporderv3.create": {} },
        { "bg.shiporderv3.create": { errorCode: 2000000, errorMsg: "备货子单标签信息为空，请刷新页面后再操作" } },
      )
      vi.stubGlobal("fetch", fnErr)
      const err = await createShipOrderAction({ ...CREATE_INPUT, store: storeId })
      expect(err.ok).toBe(false)
      if (err.ok) return
      expect(err.error).toContain("2000000")
      expect(err.error).toContain("备货子单标签信息为空")
      expect(err.error).toContain("已超时被自动移出发货台")
      vi.unstubAllGlobals()
    },
  )

  it(
    "箱唛打印直出：return_data_key 换 dataKey 拼官方打印页 URL；result 非字符串判失败",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockWizardFetch()
      vi.stubGlobal("fetch", fn)
      const r = await getShipBoxMarkPrintUrlAction({ store: storeId, deliveryOrderSns: ["FH-NEW-CREATE-1"] })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.url).toBe("https://openapi.kuajingmaihuo.com/tool/print?dataKey=DK-TEST-KEY-123")
      }
      const body = bodiesOfType(fn, "bg.logistics.boxmarkinfo.get")[0]!
      expect(body.deliveryOrderSnList).toEqual(["FH-NEW-CREATE-1"])
      expect(body.return_data_key).toBe("true")
      vi.unstubAllGlobals()

      // return_data_key 模式下 result 应为 dataKey 字符串；对象/空结果判失败
      const fnEmpty = mockWizardFetch({ "bg.logistics.boxmarkinfo.get": { list: [] } })
      vi.stubGlobal("fetch", fnEmpty)
      const empty = await getShipBoxMarkPrintUrlAction({ store: storeId, deliveryOrderSns: ["FH-NEW-CREATE-1"] })
      expect(empty.ok).toBe(false)
      if (!empty.ok) expect(empty.error).toContain("dataKey")
      vi.unstubAllGlobals()
    },
  )

  it(
    "发货台/预检/比价映射 + 权限三段式（无 tab 拒 / 有 tab 放行）",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const fn = mockWizardFetch()
      vi.stubGlobal("fetch", fn)

      const staging = await getShipStagingAction({ store: storeId })
      expect(staging.ok).toBe(true)
      if (staging.ok) {
        expect(staging.rows[0]?.subPurchaseOrderSn).toBe("WB2610185064077")
        expect(staging.rows[0]?.skus[0]?.skuDeliveryQuantityMaxLimit).toBe(60)
        expect(staging.rows[0]?.productName).toBe("测试菜谱本 PROBE")
        expect(staging.rows[0]?.skcExtCode).toBe("B094")
        expect(staging.rows[0]?.subWarehouseName).toBe("南海宝湾19号子仓")
        expect(staging.rows[0]?.purchaseQuantity).toBe(39)
        expect(staging.rows[0]?.deliverDisplayCountdownMillis).toBe(21 * 3_600_000 + 5 * 60_000)
        // 实际发货数：本地发货单按子单号汇总（本测试店已有多张同子单号的发货单）
        expect(staging.rows[0]!.actualDeliveredNum).toBeGreaterThanOrEqual(41)
      }

      const match = await packingMatchAction({ store: storeId, deliveryOrderSns: ["FH-NEW-CREATE-1"] })
      expect(match.ok).toBe(true)
      if (match.ok) {
        expect(match.skuSumWeight).toBe(3485)
        expect(match.shouldAdd[0]?.deliveryOrderSn).toBe("FH-OTHER-2")
      }

      const lm = await getLogisticsMatchAction({
        store: storeId,
        deliveryOrderSns: ["FH-NEW-CREATE-1"],
        receiveAddressInfo: CREATE_INPUT.groups[0]!.receiveAddressInfo,
        deliveryAddressId: 52971147310,
        predictTotalPackageWeight: 4000,
        subWarehouseId: 168719306067,
        totalPackageNum: 1,
        predictVolume: "0.1407",
      })
      expect(lm.ok).toBe(true)
      if (lm.ok) {
        expect(lm.list[0]?.expressCompanyName).toBe("中通")
        expect(lm.list[0]?.minSupplierChargeAmount).toBe("4.55")
        expect(lm.list[0]?.maxSupplierChargeAmount).toBe("4.78")
        expect(lm.list[0]?.channelScheduleTimeList).toHaveLength(2)
        expect(lm.mostUsed?.canSaveChargeAmount).toBe("12.5")
      }
      const lmBody = bodiesOfType(fn, "bg.shiporderv3.logisticsmatch.get")[0]!
      expect(lmBody.subWarehouseId).toBe(168719306067)
      expect(lmBody.predictTotalPackageWeight).toBe(4000)
      expect(lmBody.totalPackageNum).toBe(1)
      expect(lmBody.predictVolume).toBe("0.1407")

      // 官方预估体积映射（predict.volume.get 真实回参是数字；logisticsmatch 缺体积会报 2000000 请填写发货总体积）
      const pv = await getShipPredictVolumeAction({ store: storeId, deliveryOrderSns: ["FH-NEW-CREATE-1"] })
      expect(pv.ok).toBe(true)
      if (pv.ok) expect(pv.predictVolume).toBe("0.1407")
      const pvBody = bodiesOfType(fn, "bg.predict.volume.get")[0]!
      expect(pvBody.deliveryOrderSnList).toEqual(["FH-NEW-CREATE-1"])
      // 官方未返回体积时 predictVolume 为 null（不报错）
      const fnNoVol = mockWizardFetch({ "bg.predict.volume.get": {} })
      vi.stubGlobal("fetch", fnNoVol)
      const pvEmpty = await getShipPredictVolumeAction({ store: storeId, deliveryOrderSns: ["FH-NEW-CREATE-1"] })
      expect(pvEmpty.ok).toBe(true)
      if (pvEmpty.ok) expect(pvEmpty.predictVolume).toBeNull()
      vi.stubGlobal("fetch", fn)

      // 无 temu_ship tab 的成员：写操作被拒
      mockSession.userId = memberId
      const denied = await addShipStagingAction({ store: storeId, subPurchaseOrderSns: ["WB-1"] })
      expect(denied.ok).toBe(false)
      if (denied.ok) return
      expect(denied.error).toContain("页面权限")

      // 有 temu_ship tab 的成员：放行（可看页面即可用按钮口径）
      mockSession.userId = shipMemberId
      const allowed = await addShipStagingAction({ store: storeId, subPurchaseOrderSns: ["WB-1"] })
      expect(allowed.ok).toBe(true)
      vi.unstubAllGlobals()
    },
  )

  it(
    "官方块状列数据面：BasicVO 图/易碎标提取、cancelDeadline 绝对换算、包裹号联查、发货仓库标签映射",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const leftMs = 18 * 3_600_000
      const before = Date.now()
      await upsertShipOrderRows(storeId, new Date(), [
        SHIP_ROW({
          deliveryOrderSn: "FH-OFFICIAL-1",
          subPurchaseOrderSn: "WB-OFFICIAL-1",
          status: 0,
          deliveryOrderCancelLeftTime: leftMs,
          packageList: [
            { packageSn: "PC-OFF-A", skcNum: 20 },
            { packageSn: "PC-OFF-B", skcNum: 19 },
          ],
          subPurchaseOrderBasicVO: {
            productSkcId: 51458492005,
            productSkcPicture: "https://img.kwcdn.com/product/fancy/test-official.jpg",
            fragileTag: true,
            skcExtCode: "B094",
          },
        }),
      ])

      const fn = mockWizardFetch({
        "bg.mall.address.get": [{ id: 52971147310, addressLabel: "默认发货仓", isDefault: true }],
      })
      vi.stubGlobal("fetch", fn)
      const r = await getTemuShipOrdersAction({ store: storeId, statusPreset: "pending" })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const row = r.rows.find((x) => x.deliveryOrderSn === "FH-OFFICIAL-1")
      expect(row).toBeDefined()
      if (!row) return
      expect(row.productImageUrl).toBe("https://img.kwcdn.com/product/fancy/test-official.jpg")
      expect(row.fragileTag).toBe(true)
      expect(row.isCustomProduct).toBe(false)
      expect(row.packageSns).toEqual(["PC-OFF-A", "PC-OFF-B"])
      expect(row.deliveryAddressLabel).toBe("默认发货仓")
      // cancelDeadline = 落库时刻 + 官方剩余毫秒（容差 ±60s 吸收测试耗时）
      const deadline = row.cancelDeadline ? new Date(row.cancelDeadline).getTime() : null
      expect(deadline).not.toBeNull()
      if (deadline != null) {
        expect(Math.abs(deadline - (before + leftMs))).toBeLessThan(60_000)
      }
      vi.unstubAllGlobals()

      // 无取消剩余毫秒（已发货单）→ cancelDeadline null（不造假）
      await upsertShipOrderRows(storeId, new Date(), [
        SHIP_ROW({ deliveryOrderSn: "FH-OFFICIAL-2", subPurchaseOrderSn: "WB-OFFICIAL-2", status: 1, deliveryOrderCancelLeftTime: "" }),
      ])
      const shipped = await getTemuShipOrdersAction({ store: storeId, statusPreset: "shipping" })
      expect(shipped.ok).toBe(true)
      if (shipped.ok) {
        const row2 = shipped.rows.find((x) => x.deliveryOrderSn === "FH-OFFICIAL-2")
        expect(row2?.cancelDeadline).toBeNull()
      }
    },
  )

  it("商品条码打印直出：labelv2 productSkcIdList + return_data_key → dataKey 拼 URL；非字符串判失败", { timeout: 30_000 }, async () => {
    mockSession.userId = ownerId
    const fn = mockWizardFetch({ "bg.glo.goods.labelv2.get": "DK-BARCODE-XYZ" })
    vi.stubGlobal("fetch", fn)
    const r = await getShipBarcodePrintUrlAction({ store: storeId, productSkcIds: [51458492005, 51458492005] })
    expect(r.ok).toBe(true)
    // 条码打印页走 PA 域名（官方《条码打印说明》；CN 域名会报「异常访问」），箱唛才是 CN 域名
    if (r.ok) expect(r.url).toBe("https://openapi-b-partner.temu.com/tool/print?dataKey=DK-BARCODE-XYZ")
    const body = bodiesOfType(fn, "bg.glo.goods.labelv2.get")[0]!
    // 官方只认列表参数，且重复 SKC 去重后下发
    expect(body.productSkcIdList).toEqual([51458492005])
    expect(body.return_data_key).toBe("true")
    vi.unstubAllGlobals()

    const fnBad = mockWizardFetch({ "bg.glo.goods.labelv2.get": { data: [] } })
    vi.stubGlobal("fetch", fnBad)
    const bad = await getShipBarcodePrintUrlAction({ store: storeId, productSkcIds: [51458492005] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain("dataKey")
    vi.unstubAllGlobals()
  })

  it(
    "create 回查落空（官方索引延迟）→ 用入参播种本地待装箱行，待装箱列表立即可见",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      // create 正常返回两个单号，但按单号回查返回空（真实店 2026-10-27 实证的索引延迟形态）
      const fn = mockWizardFetch({
        "bg.shiporderv3.create": { deliveryOrders: ["FH-SEED-1", "FH-SEED-2"] },
        "bg.shiporderv2.get": { total: 0, list: [] },
      })
      vi.stubGlobal("fetch", fn)
      const input = {
        ...CREATE_INPUT,
        store: storeId,
        groups: [
          CREATE_INPUT.groups[0]!,
          {
            ...CREATE_INPUT.groups[0]!,
            orders: [
              { ...CREATE_INPUT.groups[0]!.orders[0]!, subPurchaseOrderSn: "WB-SEED-2" },
            ],
          },
        ],
      }
      const r = await createShipOrderAction(input)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.deliveryOrderSns).toEqual(["FH-SEED-1", "FH-SEED-2"])

      const rows = await db
        .select()
        .from(temuShipOrders)
        .where(inArray(temuShipOrders.deliveryOrderSn, ["FH-SEED-1", "FH-SEED-2"]))
      expect(rows).toHaveLength(2)
      const s1 = rows.find((x) => x.deliveryOrderSn === "FH-SEED-1")
      expect(s1?.status).toBe(0)
      expect(s1?.subPurchaseOrderSn).toBe("WB2610185064077")
      expect(s1?.deliverSkcNum).toBe(41)
      expect(s1?.deliverPackageNum).toBe(2)
      expect(s1?.deliveryAddressId).toBe(52971147310)
      expect(s1?.subWarehouseId).toBe(168719306067)
      expect(s1?.deliveryOrderCreateTime).not.toBeNull()
      const s2 = rows.find((x) => x.deliveryOrderSn === "FH-SEED-2")
      expect(s2?.subPurchaseOrderSn).toBe("WB-SEED-2")
      // 播种行直接出现在待装箱列表
      const list = await getTemuShipOrdersAction({ store: storeId, statusPreset: "pending", pageSize: 5 })
      expect(list.ok).toBe(true)
      if (list.ok) {
        expect(list.rows.map((x) => x.deliveryOrderSn)).toContain("FH-SEED-1")
      }
      vi.unstubAllGlobals()
    },
  )

  it(
    "fresh 防误杀：创建未满 30 分钟的单不因官方回查缺席置已取消；超 30 分钟的照置",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      const now = Date.now()
      await db.insert(temuShipOrders).values([
        {
          storeId,
          deliveryOrderSn: "FH-GUARD-YOUNG",
          skcExtCode: "B911",
          status: 0,
          deliveryOrderCreateTime: new Date(now - 5 * 60_000),
          contentHash: "guard-young",
          capturedAt: new Date(),
        },
        {
          storeId,
          deliveryOrderSn: "FH-GUARD-OLD",
          skcExtCode: "B912",
          status: 0,
          deliveryOrderCreateTime: new Date(now - 2 * 3_600_000),
          contentHash: "guard-old",
          capturedAt: new Date(),
        },
      ])
      // 官方回查两张都不返回：YOUNG 受保护保持待装箱，OLD 判已取消
      const fn = mockWizardFetch({ "bg.shiporderv2.get": { total: 0, list: [] } })
      vi.stubGlobal("fetch", fn)
      const r = await getTemuShipOrdersAction({
        store: storeId,
        statusPreset: "pending",
        // 前一用例播种的 FH-SEED-* 创建时间最新，页要足够大把两张 GUARD 单也带上
        pageSize: 4,
        fresh: true,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.freshStats).toEqual({ fetched: 0, missing: 1 })
      const after = await db
        .select()
        .from(temuShipOrders)
        .where(inArray(temuShipOrders.deliveryOrderSn, ["FH-GUARD-YOUNG", "FH-GUARD-OLD"]))
      expect(after.find((o) => o.deliveryOrderSn === "FH-GUARD-YOUNG")?.status).toBe(0)
      expect(after.find((o) => o.deliveryOrderSn === "FH-GUARD-OLD")?.status).toBe(5)
      vi.unstubAllGlobals()
    },
  )
})

describe("发货统计 action（概览三卡）", () => {
  it(
    "按预约取货时间归日/归周聚合（无预约回落装箱时间），排除待装箱/已取消，未来天带已预约量 + 仓库筛选",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      // 独立店铺：前面同步用例落的行 deliverTime 是探针数据的未来时间，会污染周窗口
      const [statsStore] = await db
        .insert(temuStores)
        .values({
          enterpriseId: entId,
          name: "发货统计测试店铺",
          accessTokenEncrypted: encrypt("ship-stats-token"),
          tokenState: "active",
          mallType: "full",
        })
        .returning()
      const sid = statsStore!.id

      const weekStart = temuStartOfWeek()
      const todayStart = temuStartOfToday()
      // 周内序号（0=周一…6=周日）：周一运行时「本周早些」只能落今日；
      // 周日运行时「预约明日」落到下周一（出本周 7 天窗但仍计 week 合计）
      const dayIdx = Math.round((todayStart.getTime() - weekStart.getTime()) / 86_400_000)
      const mondayRun = dayIdx === 0
      const sundayRun = dayIdx === 6
      await db.insert(temuProducts).values([
        { storeId: sid, productSkcId: "880001", productSn: "T1", mainImageUrl: "https://img.test/t1-low.jpg" },
        { storeId: sid, productSkcId: "880002", productSn: "T1", mainImageUrl: "https://img.test/t1-high.jpg", mainImageCosUrl: "https://cos.test/t1-high.jpg" },
      ])
      await db.insert(temuSalesOverviews).values([
        { storeId: sid, skcId: "880001", capturedAt: new Date(), capturedDay: temuDayStr(), productSn: "T1", todaySalesVolume: 3, last7DaysSalesVolume: 30, last30DaysSalesVolume: 300, contentHash: "ship-img-1".padEnd(40, "0") },
        { storeId: sid, skcId: "880002", capturedAt: new Date(), capturedDay: temuDayStr(), productSn: "T1", todaySalesVolume: 9, last7DaysSalesVolume: 20, last30DaysSalesVolume: 200, contentHash: "ship-img-2".padEnd(40, "0") },
      ])
      await db.insert(temuShipOrders).values([
        // 今日 A：待仓库收货，2 包 10 件，地址 1001，今日 6 点取货
        {
          storeId: sid, deliveryOrderSn: "FH-STAT-A", skcExtCode: "T1", status: 1,
          deliveryAddressId: 1001, deliverPackageNum: 2, deliverSkcNum: 10,
          deliverTime: new Date(todayStart.getTime() + 60_000),
          expectPickUpGoodsTime: new Date(todayStart.getTime() + 6 * 3600_000),
          contentHash: "stat-a", capturedAt: new Date(),
        },
        // 今日 B：已收货照计，1 包 5 件，地址 1002，今日 12 点取货
        {
          storeId: sid, deliveryOrderSn: "FH-STAT-B", skcExtCode: "T2", status: 2,
          deliveryAddressId: 1002, deliverPackageNum: 1, deliverSkcNum: 5,
          deliverTime: new Date(todayStart.getTime() + 120_000),
          expectPickUpGoodsTime: new Date(todayStart.getTime() + 12 * 3600_000),
          contentHash: "stat-b", capturedAt: new Date(),
        },
        // 本周早些 C：部分收货，3 包 7 件，地址 1001（非周一取昨日 12 点取货；周一运行回落今日）
        {
          storeId: sid, deliveryOrderSn: "FH-STAT-C", skcExtCode: "T3", status: 6,
          deliveryAddressId: 1001, deliverPackageNum: 3, deliverSkcNum: 7,
          deliverTime: new Date(mondayRun ? todayStart.getTime() + 60_000 : todayStart.getTime() - 60_000),
          expectPickUpGoodsTime: new Date(
            (mondayRun ? todayStart.getTime() : todayStart.getTime() - 86_400_000) + 12 * 3600_000,
          ),
          contentHash: "stat-c", capturedAt: new Date(),
        },
        // 上周 D：已入库，4 包 20 件（环比基数），上周日 12 点取货
        {
          storeId: sid, deliveryOrderSn: "FH-STAT-D", skcExtCode: "T1", status: 3,
          deliveryAddressId: 1001, deliverPackageNum: 4, deliverSkcNum: 20,
          deliverTime: new Date(weekStart.getTime() - 86_400_000),
          expectPickUpGoodsTime: new Date(weekStart.getTime() - 86_400_000 + 12 * 3600_000),
          contentHash: "stat-d", capturedAt: new Date(),
        },
        // 今日 E：已取消 → 排除
        {
          storeId: sid, deliveryOrderSn: "FH-STAT-E", skcExtCode: "T1", status: 5,
          deliveryAddressId: 1001, deliverPackageNum: 9, deliverSkcNum: 99,
          deliverTime: new Date(todayStart.getTime() + 60_000), contentHash: "stat-e", capturedAt: new Date(),
        },
        // 今日 F：待装箱 → 排除（即便带 deliverTime）
        {
          storeId: sid, deliveryOrderSn: "FH-STAT-F", skcExtCode: "T2", status: 0,
          deliveryAddressId: 1002, deliverPackageNum: 8, deliverSkcNum: 88,
          deliverTime: new Date(todayStart.getTime() + 60_000), contentHash: "stat-f", capturedAt: new Date(),
        },
        // 今日 G：自送单（无预约取货时间）→ 回落 deliverTime 归今日；地址空且无货号 →
        // 计入合计、不进仓库选项、归「无货号」组
        {
          storeId: sid, deliveryOrderSn: "FH-STAT-G", status: 1,
          deliverPackageNum: 1, deliverSkcNum: 3,
          deliverTime: new Date(todayStart.getTime() + 90_000), contentHash: "stat-g", capturedAt: new Date(),
        },
        // 今日 H：今日装箱、预约明日 10 点取货（T4，2 包 6 件，地址 1001）→ 记明日桶 future=true
        {
          storeId: sid, deliveryOrderSn: "FH-STAT-H", skcExtCode: "T4", status: 1,
          deliveryAddressId: 1001, deliverPackageNum: 2, deliverSkcNum: 6,
          deliverTime: new Date(todayStart.getTime() + 60_000),
          expectPickUpGoodsTime: new Date(todayStart.getTime() + 86_400_000 + 10 * 3600_000),
          contentHash: "stat-h", capturedAt: new Date(),
        },
      ])

      vi.stubGlobal(
        "fetch",
        mockWizardFetch({
          "bg.mall.address.get": [
            { id: 1001, addressLabel: "一号仓" },
            { id: 1002, addressLabel: "二号仓" },
          ],
        }),
      )
      const stats = await getTemuShipStatsAction(sid, null)
      // 今日按货号聚合（今日=预约取货日为今天：T1=A10、T2=B5、G 自送回落归今日「无货号」3；
      // H 记明日桶不进今日；E/F 排除），降序
      expect(stats.today.map(({ name, num }) => ({ name, num }))).toEqual(
        mondayRun
          ? [
              { name: "T1", num: 10 },
              { name: "T3", num: 7 },
              { name: "T2", num: 5 },
              { name: "无货号", num: 3 },
            ]
          : [
              { name: "T1", num: 10 },
              { name: "T2", num: 5 },
              { name: "无货号", num: 3 },
            ],
      )
      expect(stats.today.find((row) => row.name === "T1")).toMatchObject({
        imageUrl: "https://img.test/t1-high.jpg",
        imageCosUrl: "https://cos.test/t1-high.jpg",
      })
      // 本周 = A+B+C+G+H（H 预约明日仍计本周合计）
      expect(stats.week).toEqual({ packageNum: 9, skcNum: 31 })
      expect(stats.lastWeek).toEqual({ packageNum: 4, skcNum: 20 })
      // 仓库选项：近两周有发货记录的地址 + mall.address 标签映射（按 addrId 去重，label 拼音序不稳定按 key 断言）
      expect(stats.warehouses).toHaveLength(2)
      const labelByKey = Object.fromEntries(stats.warehouses.map((w) => [w.key, w.label]))
      expect(labelByKey["1001"]).toBe("一号仓")
      expect(labelByKey["1002"]).toBe("二号仓")
      // 本周逐日（固定 7 桶、周一为首、预约取货日归桶）：今日桶 = A+B+G（周一运行时 C 也落今日）
      const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
      const mondayStr = temuDayStr(weekStart)
      const sundayStr = temuDayStr(new Date(weekStart.getTime() + 6 * 86_400_000))
      expect(stats.weekDaily).toHaveLength(7)
      expect(stats.weekDaily[0]?.day).toBe(mondayStr)
      const todayBucket = stats.weekDaily.find((d) => d.day === todayStr)
      expect(todayBucket).toEqual(
        mondayRun
          ? { day: todayStr, packageNum: 7, skcNum: 25, future: false }
          : { day: todayStr, packageNum: 4, skcNum: 18, future: false },
      )
      for (const d of stats.weekDaily) {
        expect(d.day >= mondayStr && d.day <= sundayStr).toBe(true)
        expect(d.future).toBe(d.day > todayStr)
      }
      // H（今日装箱预约明日取货）落明日桶带已预约量；周日运行预约到下周一出本周 7 天窗
      const tomorrowStr = temuDayStr(new Date(todayStart.getTime() + 86_400_000))
      const tomorrowBucket = stats.weekDaily.find((d) => d.day === tomorrowStr)
      expect(tomorrowBucket).toEqual(
        sundayRun ? undefined : { day: tomorrowStr, packageNum: 2, skcNum: 6, future: true },
      )
      const weekDailySum = stats.weekDaily.reduce(
        (acc, d) => ({ packageNum: acc.packageNum + d.packageNum, skcNum: acc.skcNum + d.skcNum }),
        { packageNum: 0, skcNum: 0 },
      )
      expect(weekDailySum).toEqual(sundayRun ? { packageNum: 7, skcNum: 25 } : stats.week)

      // 地址筛选（addrId 直传）：仅 1001 → A+C+H（B/G 排除）
      const filtered = await getTemuShipStatsAction(sid, "1001")
      expect(filtered.today.map(({ name, num }) => ({ name, num }))).toEqual(
        mondayRun ? [{ name: "T1", num: 10 }, { name: "T3", num: 7 }] : [{ name: "T1", num: 10 }],
      )
      expect(filtered.week).toEqual({ packageNum: 7, skcNum: 23 })
      expect(filtered.lastWeek).toEqual({ packageNum: 4, skcNum: 20 })
      const filteredToday = filtered.weekDaily.find((d) => d.day === todayStr)
      expect(filteredToday?.skcNum).toBe(mondayRun ? 17 : 10)

      // 非法仓库键静默忽略（按未筛选返回）
      const bogus = await getTemuShipStatsAction(sid, "bogus")
      expect(bogus.week).toEqual({ packageNum: 9, skcNum: 31 })

      vi.unstubAllGlobals()
    },
  )

  it(
    "全部店铺跨店去重：同一发货单两店各落一行只计一次；单店视角不受影响",
    { timeout: 30_000 },
    async () => {
      mockSession.userId = ownerId
      // 兄弟双店（同企业）+ 独立仓库地址 990001：与其他用例数据完全隔离，断言可做死值
      const dupStores = await db
        .insert(temuStores)
        .values([
          {
            enterpriseId: entId,
            name: "去重测试甲店",
            accessTokenEncrypted: encrypt("dedup-token-a"),
            tokenState: "active",
            mallType: "full",
          },
          {
            enterpriseId: entId,
            name: "去重测试乙店",
            accessTokenEncrypted: encrypt("dedup-token-b"),
            tokenState: "active",
            mallType: "full",
          },
        ])
        .returning()
      const [storeA, storeB] = dupStores
      const todayStart = temuStartOfToday()
      // 今日 6 点取货（预约取货轴归今日）
      const pickup = new Date(todayStart.getTime() + 6 * 3600_000)
      const delivered = new Date(todayStart.getTime() + 60_000)
      const base = {
        skcExtCode: "T9", status: 1, deliveryAddressId: 990001,
        deliverPackageNum: 2, deliverSkcNum: 8,
        deliverTime: delivered, expectPickUpGoodsTime: pickup, capturedAt: new Date(),
      }
      await db.insert(temuShipOrders).values([
        // DUP 对：同一发货单+备货单在甲乙两店各一行（官方 shiporderv2 跨店可见）
        { ...base, storeId: storeA!.id, deliveryOrderSn: "FH-DEDUP-1", subPurchaseOrderSn: "WB-DEDUP-1", contentHash: "dedup-a1" },
        { ...base, storeId: storeB!.id, deliveryOrderSn: "FH-DEDUP-1", subPurchaseOrderSn: "WB-DEDUP-1", contentHash: "dedup-b1" },
        // 对照：仅甲店一单（1 包 5 件，货号 T8）
        {
          ...base, skcExtCode: "T8", deliverPackageNum: 1, deliverSkcNum: 5,
          storeId: storeA!.id, deliveryOrderSn: "FH-DEDUP-2", subPurchaseOrderSn: "WB-DEDUP-2", contentHash: "dedup-a2",
        },
      ])

      vi.stubGlobal("fetch", mockWizardFetch({
        "bg.mall.address.get": [{ id: 990001, addressLabel: "去重测试仓" }],
      }))

      // 全部店铺 × 独立仓库：DUP 只计一次 → 3 包 13 件（未去重为 5 包 21 件）
      const all = await getTemuShipStatsAction(null, "990001")
      expect(all.week).toEqual({ packageNum: 3, skcNum: 13 })
      expect(all.today.map(({ name, num }) => ({ name, num }))).toEqual([
        { name: "T9", num: 8 },
        { name: "T8", num: 5 },
      ])
      expect(all.lastWeek).toEqual({ packageNum: 0, skcNum: 0 })
      const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
      expect(all.weekDaily.find((d) => d.day === todayStr)).toEqual({
        day: todayStr, packageNum: 3, skcNum: 13, future: false,
      })

      // 单店视角：乙店自己的 DUP 行照常计入（单店模式不走去重条件）
      const bOnly = await getTemuShipStatsAction(storeB!.id, "990001")
      expect(bOnly.week).toEqual({ packageNum: 2, skcNum: 8 })
      expect(bOnly.today.map(({ name, num }) => ({ name, num }))).toEqual([{ name: "T9", num: 8 }])

      vi.unstubAllGlobals()
    },
  )
})
