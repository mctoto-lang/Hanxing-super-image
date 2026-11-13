import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import {enterprises, permissionGroups, temuStores, temuApps } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import {
  inventoryMovements,
  inventoryProducts,
  inventoryStocks,
  inventoryWarehouses,
  temuShipOrders,
} from "@/db/schema"
import { encrypt } from "@/lib/crypto"
import { createHash } from "node:crypto"
import { manualMovementAction } from "@/server/actions/inventory"
import {
  getShipInventoryRefAction,
  getShipOrdersNeedingBarcodeAction,
  sendPackingAction,
} from "@/server/actions/temu-ship"

/**
 * TEMU 装箱 × 库存联动回归（批次4）：硬阻断（官方调用前拦截）/ 按发货仓扣减+
 * 流水 refId=单号 / 工厂直发跳过 / 未建档货号跳过 / 演示店铺跳过联动 /
 * 参考查询（合计+未装箱）。
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
vi.mock("@/lib/temu-api/app-config", async () => {
  // 演示店铺凭证标记取真实常量（callTemuApi 见 DEMO_APP_KEY 走虚拟拦截层）
  const { DEMO_APP_KEY } = await import("@/lib/temu-api/demo-api")
  return {
    getTemuAppCredential: async () => ({
      appKey: "test-app-key",
      appSecret: "test-app-secret",
      source: "test",
    }),
    getDemoCredential: () => ({ appKey: DEMO_APP_KEY, appSecret: "demo", accessToken: "demo-token" }),
  }
})

let entId: string
let userId: string
let storeId: string
let demoStoreId: string
let mainWhId: string

const snOf = (code: string) => `FHLINK${code}`

async function insertShipRow(sn: string, extCode: string, deliverSkcNum: number, sid: string = storeId) {
  await db
    .insert(temuShipOrders)
    .values({
      storeId: sid,
      deliveryOrderSn: sn,
      subPurchaseOrderSn: `SUB${sn}`,
      skcExtCode: extCode,
      status: 0,
      deliverSkcNum,
      contentHash: createHash("sha1").update(sn).digest("hex"),
      capturedAt: new Date(),
    })
    .onConflictDoNothing()
}

async function getMainStock(productId: string) {
  const [row] = await db
    .select()
    .from(inventoryStocks)
    .where(and(eq(inventoryStocks.productId, productId), eq(inventoryStocks.warehouseId, mainWhId)))
  return row?.qty ?? 0
}

/** mock fetch：packing.send 成功返回批次号；shiporderv2 回查空 */
let packingCalls = 0
function mockLinkFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string }
    let result: unknown = {}
    if (body.type === "bg.shiporder.packing.send") {
      packingCalls++
      result = { expressBatchSn: "EBLINKTEST" }
    } else if (body.type === "bg.shiporderv2.get") {
      result = { total: 0, list: [] }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ result, success: true, errorCode: 1000000, errorMsg: "" }),
    } as unknown as Response
  })
}

let fetchMock: ReturnType<typeof mockLinkFetch>

const SEND_PAYLOAD = {
  deliveryAddressId: 52971147310,
  payload: {
    deliverMethod: 2 as const,
    expressCompanyId: 10240006147472,
    expressCompanyName: "极兔速递",
    predictTotalPackageWeight: 3000,
    expressPackageNum: 1,
  },
}

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "联动测试企业",
      slug: `link-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      enabledModules: [...MODULE_NAMES],
    })
    .returning()
  entId = ent!.id
  // 多应用模型（0097）：凭证按「店铺→应用」取——夹具企业配一个应用
  // （店铺不挂靠时单应用宽容回落命中）
  await db
    .insert(temuApps)
    .values({ enterpriseId: entId, name: "测试应用", appKey: "test-app", appSecretEncrypted: "enc:v1:t" })
  const [group] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: entId,
      name: "联动权限组",
      allowedPages: ["settings", "temu", "temu_ship", "temu_purchase", "inventory"],
    })
    .returning()
  const [user] = await db
    .insert((await import("@/db/schema")).users)
    .values({
      enterpriseId: entId,
      groupId: group!.id,
      username: `link-${randomUUID().slice(0, 8)}`,
      email: `link-${randomUUID().slice(0, 8)}@test.local`,
      name: "联动测试用户",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  userId = user!.id
  mockSession.userId = userId

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "联动测试店",
      accessTokenEncrypted: encrypt("fake-token-for-link-test"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeId = store!.id

  // 演示店铺（isDemo：callTemuApi 走虚拟拦截层模拟成功，无须 token）
  const [demoStore] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "联动演示店",
      isDemo: true,
      mallType: "full",
      tokenState: "active",
      enabled: true,
    })
    .returning()
  demoStoreId = demoStore!.id

  await db
    .insert(inventoryWarehouses)
    .values([{ enterpriseId: entId, code: "main", name: "主仓", sort: 0 }])
  const [wh] = await db
    .select()
    .from(inventoryWarehouses)
    .where(and(eq(inventoryWarehouses.enterpriseId, entId), eq(inventoryWarehouses.code, "main")))
  mainWhId = wh!.id

  // 建档 B9001 + 主仓 100 件；B9999 不建档（未建档口径）
  const [product] = await db
    .insert(inventoryProducts)
    .values({
      enterpriseId: entId,
      productCode: "B9001",
      name: "联动测试款",
      createdBy: userId,
    })
    .returning()
  const r = await manualMovementAction({
    productId: product!.id,
    warehouseId: mainWhId,
    type: "manual_in",
    qty: 100,
    reason: "建账",
  })
  expect(r.ok).toBe(true)

  await insertShipRow(snOf("BLOCK"), "B9001", 150) // 超库存
  await insertShipRow(snOf("PASS"), "B9001", 80)
  await insertShipRow(snOf("DIRECT"), "B9001", 500)
  await insertShipRow(snOf("NOARCH"), "B9999", 999) // 未建档

  fetchMock = mockLinkFetch()
  vi.stubGlobal("fetch", fetchMock)
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

describe("装箱发货 × 库存联动", () => {
  it("库存不足硬阻断：官方 packing.send 不被调用", async () => {
    const r = await sendPackingAction({
      store: storeId,
      deliveryOrderSns: [snOf("BLOCK")],
      ...SEND_PAYLOAD,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain("库存不足")
      expect(r.error).toContain("B9001")
      expect(r.error).toContain("缺 50")
    }
    expect(packingCalls).toBe(0)
  })

  it("足额发货：成功后扣发货仓+流水 refId=单号+回写发货仓", async () => {
    const r = await sendPackingAction({
      store: storeId,
      deliveryOrderSns: [snOf("PASS")],
      ...SEND_PAYLOAD,
    })
    expect(r.ok).toBe(true)
    expect(packingCalls).toBe(1)

    const [product] = await db
      .select()
      .from(inventoryProducts)
      .where(and(eq(inventoryProducts.enterpriseId, entId), eq(inventoryProducts.productCode, "B9001")))
    expect(await getMainStock(product!.id)).toBe(20)

    const [mv] = await db
      .select()
      .from(inventoryMovements)
      .where(
        and(eq(inventoryMovements.enterpriseId, entId), eq(inventoryMovements.type, "ship_deduct")),
      )
    expect(mv).toMatchObject({
      qtyChange: -80,
      qtyBefore: 100,
      qtyAfter: 20,
      refType: "ship_order",
      refId: snOf("PASS"),
    })

    const [order] = await db
      .select()
      .from(temuShipOrders)
      .where(and(eq(temuShipOrders.storeId, storeId), eq(temuShipOrders.deliveryOrderSn, snOf("PASS"))))
    expect(order?.factoryDirect).toBe(false)
    expect(order?.sourceWarehouseId).toBe(mainWhId)
  })

  it("工厂直发单：跳过校验与扣减，回写直发标记", async () => {
    const [product] = await db
      .select()
      .from(inventoryProducts)
      .where(and(eq(inventoryProducts.enterpriseId, entId), eq(inventoryProducts.productCode, "B9001")))
    const before = await getMainStock(product!.id)

    const r = await sendPackingAction({
      store: storeId,
      deliveryOrderSns: [snOf("DIRECT")],
      factoryDirect: true,
      ...SEND_PAYLOAD,
    })
    expect(r.ok).toBe(true)
    expect(await getMainStock(product!.id)).toBe(before)

    const [order] = await db
      .select()
      .from(temuShipOrders)
      .where(
        and(eq(temuShipOrders.storeId, storeId), eq(temuShipOrders.deliveryOrderSn, snOf("DIRECT"))),
      )
    expect(order?.factoryDirect).toBe(true)
    expect(order?.sourceWarehouseId).toBeNull()
  })

  it("演示店铺：沙箱虚拟单跳过库存校验与扣减（不污染真实库存）", async () => {
    const [product] = await db
      .select()
      .from(inventoryProducts)
      .where(and(eq(inventoryProducts.enterpriseId, entId), eq(inventoryProducts.productCode, "B9001")))
    const before = await getMainStock(product!.id)

    // 超库存虚拟单（B9001 需 999 远超主仓余额）：不受硬阻断，demo 层模拟发货成功
    await insertShipRow(snOf("DEMOSHIP"), "B9001", 999, demoStoreId)
    const r = await sendPackingAction({
      store: demoStoreId,
      deliveryOrderSns: [snOf("DEMOSHIP")],
      ...SEND_PAYLOAD,
    })
    expect(r.ok).toBe(true)

    // 真实库存与 ship_deduct 流水不被虚拟单污染；虚拟单不回写直发/发货仓标记
    expect(await getMainStock(product!.id)).toBe(before)
    const [mv] = await db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.enterpriseId, entId),
          eq(inventoryMovements.type, "ship_deduct"),
          eq(inventoryMovements.refId, snOf("DEMOSHIP")),
        ),
      )
    expect(mv).toBeUndefined()
    const [order] = await db
      .select()
      .from(temuShipOrders)
      .where(
        and(
          eq(temuShipOrders.storeId, demoStoreId),
          eq(temuShipOrders.deliveryOrderSn, snOf("DEMOSHIP")),
        ),
      )
    expect(order?.factoryDirect).toBeNull()
    expect(order?.sourceWarehouseId).toBeNull()
  })

  it("未建档货号：不阻断不扣减（发货照常）", async () => {
    const [product] = await db
      .select()
      .from(inventoryProducts)
      .where(and(eq(inventoryProducts.enterpriseId, entId), eq(inventoryProducts.productCode, "B9001")))
    const before = await getMainStock(product!.id)
    const r = await sendPackingAction({
      store: storeId,
      deliveryOrderSns: [snOf("NOARCH")],
      ...SEND_PAYLOAD,
    })
    expect(r.ok).toBe(true)
    expect(await getMainStock(product!.id)).toBe(before)
  })

  it("货号归一化：B049≡B49 扣减归并到同一档案", async () => {
    // 档案 B49 主仓 30 件；同批发货单分别用 B049 与 B49 两种写法
    const [p49] = await db
      .insert(inventoryProducts)
      .values({
        enterpriseId: entId,
        productCode: "B49",
        name: "归一化测试款",
        createdBy: userId,
      })
      .returning()
    const r0 = await manualMovementAction({
      productId: p49!.id,
      warehouseId: mainWhId,
      type: "manual_in",
      qty: 30,
      reason: "建账",
    })
    expect(r0.ok).toBe(true)
    await insertShipRow(snOf("NORM1"), "B049", 10)
    await insertShipRow(snOf("NORM2"), "B49", 5)

    const r = await sendPackingAction({
      store: storeId,
      deliveryOrderSns: [snOf("NORM1"), snOf("NORM2")],
      ...SEND_PAYLOAD,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 两种写法都落到 B49 档案：30 − 10 − 5 = 15
    expect(await getMainStock(p49!.id)).toBe(15)
    const mvs = await db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.enterpriseId, entId),
          eq(inventoryMovements.productId, p49!.id),
          eq(inventoryMovements.type, "ship_deduct"),
        ),
      )
    expect(mvs).toHaveLength(2)
    expect(mvs.map((m) => m.qtyChange).sort()).toEqual([-10, -5])
  })

  it("参考查询：合计+已创建未装箱+归一化匹配", async () => {
    const ref = await getShipInventoryRefAction({
      store: storeId,
      codes: ["B9001", "B9999", "B049"],
    })
    expect(ref.ok).toBe(true)
    if (ref.ok) {
      // BLOCK/DIRECT/NOARCH 仍是 status=0 的未装箱单；PASS 已发货 status 被回查覆盖为…（回查返回空列表，
      // 本地行保持 status=0——按本地口径计入未装箱）
      expect(ref.rows.B9001!.totalQty).toBe(20)
      expect(ref.rows.B9001!.pendingUnpacked).toBeGreaterThan(0)
      expect(ref.rows.B9999!.totalQty).toBe(0)
      // B049 归一化匹配到 B49 档案（库存 15；NORM 单已发货不再计入未装箱）
      expect(ref.rows.B049!.totalQty).toBe(15)
      // 发货状态联动：建档货号默认 auto（自动发货），未建档货号 null
      expect(ref.rows.B9001!.shipState).toBe("auto")
      expect(ref.rows.B049!.shipState).toBe("auto")
      expect(ref.rows.B9999!.shipState).toBeNull()
    }
  })

  it("需要打印条码标记：档案条码为空→标记；填条码→不标记；未建档不标记", async () => {
    const r1 = await getShipOrdersNeedingBarcodeAction({
      sns: [snOf("BLOCK"), snOf("DIRECT"), snOf("NOARCH")],
    })
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      // B9001 档案条码为空（未预贴）→ 含该货号的单标记
      expect(r1.sns).toContain(snOf("BLOCK"))
      expect(r1.sns).toContain(snOf("DIRECT"))
      // B9999 未建档 → 不标记
      expect(r1.sns).not.toContain(snOf("NOARCH"))
    }

    // 档案改已预贴（出厂已贴）→ 不再标记
    await db
      .update(inventoryProducts)
      .set({ barcodePrePasted: true })
      .where(
        and(eq(inventoryProducts.enterpriseId, entId), eq(inventoryProducts.productCode, "B9001")),
      )
    const r2 = await getShipOrdersNeedingBarcodeAction({ sns: [snOf("BLOCK")] })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.sns).toHaveLength(0)
  })
})
