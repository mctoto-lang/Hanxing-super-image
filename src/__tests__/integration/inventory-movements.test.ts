import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, permissionGroups } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import {
  inventoryMovements,
  inventoryProducts,
  inventoryStocks,
  inventoryWarehouses,
} from "@/db/schema/inventory"
import { getInventoryMovementProductsAction } from "@/server/actions/inventory"

/**
 * 库存出入视图（按日期范围聚合有变动的商品）：范围过滤 / 笔数与入出净聚合 /
 * 当前库存合计 / 无变动商品不出现 / 权限与入参（真实 PG 测试库）
 */

const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

/** 北京时间日期串（与 action 日界同口径） */
function bjDay(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }
  )
}

let entId: string
let ownerId: string
let memberId: string
let productIdA: string
let productIdB: string
let productIdC: string
let warehouseId: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "库存出入测试企业",
      slug: `invmv-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      enabledModules: [...MODULE_NAMES],
    })
    .returning()
  entId = ent!.id

  const [invGroup] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entId, name: "库存权限组", allowedPages: ["settings", "inventory"] })
    .returning()
  const [noInvGroup] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entId, name: "无库存权限组", allowedPages: ["settings"] })
    .returning()

  const users = (await import("@/db/schema")).users
  const [owner] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      groupId: invGroup!.id,
      username: `invmv-o-${randomUUID().slice(0, 8)}`,
      email: `invmv-o-${randomUUID().slice(0, 8)}@test.local`,
      name: "出入 owner",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  ownerId = owner!.id
  const [member] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      groupId: noInvGroup!.id,
      username: `invmv-m-${randomUUID().slice(0, 8)}`,
      email: `invmv-m-${randomUUID().slice(0, 8)}@test.local`,
      name: "无权限成员",
      passwordHash: "x",
      enterpriseRole: "member",
    })
    .returning()
  memberId = member!.id

  const [wh] = await db
    .insert(inventoryWarehouses)
    .values({ enterpriseId: entId, code: "mvmain", name: "出入主仓", sort: 0 })
    .returning()
  warehouseId = wh!.id

  // A=今日两笔（+100/-30）；B=昨日一笔（不入今日窗口）；C=无变动
  const products = await db
    .insert(inventoryProducts)
    .values([
      { enterpriseId: entId, productCode: "MV001", name: "流水测试 A" },
      { enterpriseId: entId, productCode: "MV002", name: "流水测试 B" },
      { enterpriseId: entId, productCode: "MV003", name: "流水测试 C" },
    ])
    .returning()
  productIdA = products[0]!.id
  productIdB = products[1]!.id
  productIdC = products[2]!.id

  await db.insert(inventoryMovements).values([
    {
      enterpriseId: entId, productId: productIdA, warehouseId,
      type: "manual_in", qtyChange: 100, qtyBefore: 0, qtyAfter: 100,
      refType: "manual", reason: "其他入库：测试", createdBy: ownerId,
    },
    {
      enterpriseId: entId, productId: productIdA, warehouseId,
      type: "manual_out", qtyChange: -30, qtyBefore: 100, qtyAfter: 70,
      refType: "manual", reason: "报损：测试", createdBy: ownerId,
    },
    {
      enterpriseId: entId, productId: productIdB, warehouseId,
      type: "manual_out", qtyChange: -10, qtyBefore: 50, qtyAfter: 40,
      refType: "manual", reason: "昨日应计入跨日范围", createdBy: ownerId,
      createdAt: new Date(Date.now() - 30 * 3600_000),
    },
  ])

  // 当前库存（单仓）：A=70、B=40、C=5
  await db.insert(inventoryStocks).values([
    { enterpriseId: entId, productId: productIdA, warehouseId, qty: 70 },
    { enterpriseId: entId, productId: productIdB, warehouseId, qty: 40 },
    { enterpriseId: entId, productId: productIdC, warehouseId, qty: 5 },
  ])
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

describe("库存出入聚合 getInventoryMovementProductsAction", () => {
  it("单日（今日）：聚合笔数/入/出/净 + 当前库存合计，无变动商品不出现", { timeout: 30_000 }, async () => {
    mockSession.userId = ownerId
    const today = bjDay(new Date())
    const r = await getInventoryMovementProductsAction({ from: today, to: today })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 今日只有 A 有变动；B（昨日）、C（无变动）不在列
    expect(r.rows.map((x) => x.productCode)).toEqual(["MV001"])
    const a = r.rows[0]!
    expect(a.count).toBe(2)
    expect(a.inQty).toBe(100)
    expect(a.outQty).toBe(30)
    expect(a.netQty).toBe(70)
    expect(a.currentQty).toBe(70)
    expect(r.summary).toEqual({ products: 1, inQty: 100, outQty: 30 })
  })

  it("跨日范围（含昨日）：昨日变动计入聚合", { timeout: 30_000 }, async () => {
    mockSession.userId = ownerId
    const yesterday = bjDay(new Date(Date.now() - 30 * 3600_000))
    const today = bjDay(new Date())
    const r = await getInventoryMovementProductsAction({ from: yesterday, to: today })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.map((x) => x.productCode)).toEqual(["MV001", "MV002"])
    const b = r.rows.find((x) => x.productCode === "MV002")!
    expect(b.count).toBe(1)
    expect(b.outQty).toBe(10)
    expect(b.netQty).toBe(-10)
    expect(b.currentQty).toBe(40)
    expect(r.summary).toEqual({ products: 2, inQty: 100, outQty: 40 })
  })

  it("权限与入参：无库存权限/from>to 被拒", { timeout: 30_000 }, async () => {
    mockSession.userId = memberId
    const denied = await getInventoryMovementProductsAction({
      from: "2026-11-03",
      to: "2026-11-03",
    })
    expect(isOk(denied)).toBe(false)

    mockSession.userId = ownerId
    const bad = await getInventoryMovementProductsAction({ from: "2026-11-05", to: "2026-11-03" })
    expect(isOk(bad)).toBe(false)
    const badFmt = await getInventoryMovementProductsAction({ from: "2026/11/03", to: "2026-11-03" })
    expect(isOk(badFmt)).toBe(false)
  })
})

/** ok 判定收紧（r.ok=false 时 error 必有值） */
function isOk(r: { ok: boolean; error?: string }): boolean {
  if (!r.ok) expect(typeof r.error).toBe("string")
  return r.ok
}
