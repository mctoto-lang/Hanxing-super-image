import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, permissionGroups } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import {
  inventoryFactories,
  inventoryMovements,
  inventoryProducts,
  inventoryProductionOrders,
  inventoryStocks,
  inventoryWarehouses,
} from "@/db/schema/inventory"
import {
  addDirectShipAction,
  createProductionOrderAction,
  deleteFactoryAction,
  deleteProductionOrderAction,
  finishProductionOrderAction,
  listProductionOrdersAction,
  receiveProductionAction,
  registerFactoryShipAction,
  saveFactoryAction,
  sendMaterialsAction,
} from "@/server/actions/inventory-production"

/**
 * 生产规划回归：五态流转 / 直发（TEMU 不动库存、入仓=固定主仓）/ 余量校验 /
 * 分批入库自动转已入库 / 删除自动冲正 / 工厂档案（真实 PG 测试库）
 */

const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

let entId: string
let userId: string
let productId: string
let factoryId: string
let mainWhId: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "生产测试企业",
      slug: `prod-${randomUUID().slice(0, 8)}`,
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
      username: `prod-${randomUUID().slice(0, 8)}`,
      email: `prod-${randomUUID().slice(0, 8)}@test.local`,
      name: "生产测试用户",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  userId = user!.id
  mockSession.userId = userId

  const [product] = await db
    .insert(inventoryProducts)
    .values({
      enterpriseId: entId,
      productCode: "P9001",
      name: "生产测试款",
      leadTimeDays: 10,
      createdBy: userId,
    })
    .returning()
  productId = product!.id

  const [factory] = await db
    .insert(inventoryFactories)
    .values({ enterpriseId: entId, code: "JS", name: "测试工厂" })
    .returning()
  factoryId = factory!.id

  await db.insert(inventoryWarehouses).values([
    { enterpriseId: entId, code: "main", name: "主仓", sort: 0 },
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

async function getStock(pid: string, wid: string) {
  const [row] = await db
    .select()
    .from(inventoryStocks)
    .where(and(eq(inventoryStocks.productId, pid), eq(inventoryStocks.warehouseId, wid)))
  return row?.qty ?? 0
}

describe("生产单五态 + 直发 + 入库 + 冲正", () => {
  let orderId: string

  it("建单自动算预计交期（生产日期+生产周期）", async () => {
    const r = await createProductionOrderAction({
      productId,
      factoryId,
      quantity: 1000,
      productionDate: "2026-10-01",
      packaged: true,
      auxBarcode: true,
      note: "测试单",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      orderId = r.order.id
      expect(r.order.status).toBe("materials_pending")
      expect(r.order.expectedDate).toBe("2026-10-11")
    }
  })

  it("发材料 → 登记工厂发货 → 状态流转守卫", async () => {
    const send = await sendMaterialsAction({ orderId, auxBarcode: true })
    expect(send.ok).toBe(true)
    const ship = await registerFactoryShipAction({
      orderId,
      boxQty: 10,
      shipDate: "2026-10-10",
    })
    expect(ship.ok).toBe(true)
    const [order] = await db
      .select()
      .from(inventoryProductionOrders)
      .where(eq(inventoryProductionOrders.id, orderId))
    expect(order?.status).toBe("factory_shipped")
    expect(order?.factoryBoxQty).toBe(10)

    // 待出材料态不可入库（守卫）
    const r2 = await createProductionOrderAction({
      productId,
      factoryId,
      quantity: 100,
      productionDate: "2026-10-01",
    })
    expect(r2.ok).toBe(true)
    if (r2.ok) {
      const early = await receiveProductionAction({
        orderId: r2.order.id,
        qty: 10,
      })
      expect(early.ok).toBe(false)
      await deleteProductionOrderAction({ orderId: r2.order.id, reason: "测试清理" })
    }
  })

  it("直发 TEMU 不动库存；直发入仓固定主仓；超余量拒绝", async () => {
    const temu = await addDirectShipAction({
      orderId,
      shipDate: "2026-10-12",
      qty: 300,
      boxQty: 3,
      destType: "temu",
      temuRef: "WB2610测试",
    })
    expect(temu.ok).toBe(true)

    const wh = await addDirectShipAction({
      orderId,
      shipDate: "2026-10-12",
      qty: 200,
      destType: "warehouse",
    })
    expect(wh.ok).toBe(true)
    expect(await getStock(productId, mainWhId)).toBe(200)

    // 超余量（剩 500）
    const over = await addDirectShipAction({
      orderId,
      shipDate: "2026-10-13",
      qty: 501,
      destType: "temu",
    })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toContain("余量")

    const [order] = await db
      .select()
      .from(inventoryProductionOrders)
      .where(eq(inventoryProductionOrders.id, orderId))
    expect(order?.directQty).toBe(500)
  })

  it("分批入库累计满量自动转已入库 → 完结", async () => {
    const r1 = await receiveProductionAction({
      orderId,
      qty: 300,
      boxQty: 3,
    })
    expect(r1.ok).toBe(true)
    let [order] = await db
      .select()
      .from(inventoryProductionOrders)
      .where(eq(inventoryProductionOrders.id, orderId))
    expect(order?.status).toBe("factory_shipped") // 300+500 < 1000 未满
    expect(order?.shippedQty).toBe(300)

    const r2 = await receiveProductionAction({
      orderId,
      qty: 200,
    })
    expect(r2.ok).toBe(true)
    ;[order] = await db
      .select()
      .from(inventoryProductionOrders)
      .where(eq(inventoryProductionOrders.id, orderId))
    expect(order?.status).toBe("received") // 直发500+入库500=1000 自动转
    expect(await getStock(productId, mainWhId)).toBe(700) // 直发入仓200 + 入库500

    const fin = await finishProductionOrderAction(orderId)
    expect(fin.ok).toBe(true)
    ;[order] = await db
      .select()
      .from(inventoryProductionOrders)
      .where(eq(inventoryProductionOrders.id, orderId))
    expect(order?.status).toBe("finished")

    // 已完结不可再入库
    const r3 = await receiveProductionAction({
      orderId,
      qty: 10,
    })
    expect(r3.ok).toBe(false)
  })

  it("删除有记录生产单 → 自动冲正流水 + 库存回退", async () => {
    const beforeMain = await getStock(productId, mainWhId)
    expect(beforeMain).toBe(700) // 入库 500 + 直发入仓 200

    const r = await deleteProductionOrderAction({ orderId, reason: "建错单测试" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.reversed).toBe(3) // 直发入仓1 + 两笔入库2

    // 库存回退清零（本企业无其他来源）
    expect(await getStock(productId, mainWhId)).toBe(0)

    const reversals = await db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.enterpriseId, entId),
          eq(inventoryMovements.type, "reversal"),
        ),
      )
    expect(reversals).toHaveLength(3)
    expect(reversals.every((r2) => r2.reason?.includes("建错单测试"))).toBe(true)

    const [gone] = await db
      .select()
      .from(inventoryProductionOrders)
      .where(eq(inventoryProductionOrders.id, orderId))
    expect(gone).toBeUndefined()
  })

  it("列表分组 + 工厂删除保护", async () => {
    // 新建两张单：一张进行中、一张完结，验证分组
    const r1 = await createProductionOrderAction({
      productId,
      factoryId,
      quantity: 50,
      productionDate: "2026-10-20",
    })
    expect(r1.ok).toBe(true)
    const open = await listProductionOrdersAction({ group: "open" })
    expect(open.ok).toBe(true)
    if (open.ok) {
      expect(open.rows.some((r) => r.id === r1.order!.id)).toBe(true)
      const row = open.rows.find((r) => r.remainQty === 50)
      expect(row?.status).toBe("materials_pending")
    }
    if (r1.ok) {
      await deleteProductionOrderAction({ orderId: r1.order.id, reason: "清理" })
    }

    const del = await deleteFactoryAction(factoryId)
    expect(del.ok).toBe(true)
  })
})
