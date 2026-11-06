import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, permissionGroups } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import {
  inventoryMovements,
  inventoryProductLogs,
  inventoryProducts,
  inventoryStocks,
  inventoryWarehouses,
} from "@/db/schema/inventory"
import {
  createProductAction,
  deleteProductAction,
  getInventoryOverviewAction,
  manualMovementAction,
  searchProductsAction,
  updateProductAction,
} from "@/server/actions/inventory"

/**
 * 库存底座回归：权限拦截 / 建档唯一 / 出入库流水前中后值 /
 * 删除保护 / 档案变更日志 / 期初仓幂等（单仓） / 总览状态徽章（真实 PG 测试库）
 */

const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

let entId: string
/** 有 inventory 权限（owner） */
let ownerId: string
/** 无 inventory 权限成员（权限组只开 settings） */
let memberId: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "库存测试企业",
      slug: `inv-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      enabledModules: [...MODULE_NAMES],
    })
    .returning()
  entId = ent!.id

  const [noInvGroup] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entId, name: "无库存权限组", allowedPages: ["settings"] })
    .returning()
  const [invGroup] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: entId,
      name: "库存权限组",
      allowedPages: ["settings", "inventory"],
    })
    .returning()

  const users = (await import("@/db/schema")).users
  const [owner] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      groupId: invGroup!.id,
      username: `inv-o-${randomUUID().slice(0, 8)}`,
      email: `inv-o-${randomUUID().slice(0, 8)}@test.local`,
      name: "库存 owner",
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
      username: `inv-m-${randomUUID().slice(0, 8)}`,
      email: `inv-m-${randomUUID().slice(0, 8)}@test.local`,
      name: "库存 member",
      passwordHash: "x",
      enterpriseRole: "member",
    })
    .returning()
  memberId = member!.id
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

describe("库存底座", () => {
  it("无 inventory 权限的成员被拦截", async () => {
    mockSession.userId = memberId
    const r = await createProductAction({
      productCode: "T001",
      name: "测试",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("库存管理")
  })

  it("建档 + 货号唯一校验 + 期初仓幂等", async () => {
    mockSession.userId = ownerId
    const r = await createProductAction({
      productCode: "B9001",
      name: "测试扑克",
      cartonQty: 105,
      barcodePrePasted: true,
    })
    expect(r.ok).toBe(true)

    const dup = await createProductAction({ productCode: "B9001", name: "重复" })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error).toContain("已存在")

    // 首次访问补建期初仓（单仓制只播主仓），重复调用幂等
    const w1 = await getInventoryOverviewAction({})
    expect(w1.ok).toBe(true)
    const whs = await db
      .select()
      .from(inventoryWarehouses)
      .where(eq(inventoryWarehouses.enterpriseId, entId))
    expect(whs).toHaveLength(1)
    expect(whs[0]).toMatchObject({ code: "main", name: "主仓" })
  })

  it("入库流水前中后值 + 出库不足阻断", async () => {
    mockSession.userId = ownerId
    const [product] = await db
      .select()
      .from(inventoryProducts)
      .where(and(eq(inventoryProducts.enterpriseId, entId), eq(inventoryProducts.productCode, "B9001")))
      .limit(1)

    const in1 = await manualMovementAction({
      productId: product!.id,
      type: "manual_in",
      qty: 100,
      boxQty: 1,
      reason: "其他入库：测试",
    })
    expect(in1.ok).toBe(true)
    const in2 = await manualMovementAction({
      productId: product!.id,
      type: "return_in",
      qty: 30,
      reason: "退货入库：测试",
    })
    expect(in2.ok).toBe(true)

    const mvs = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.productId, product!.id))
      .orderBy(inventoryMovements.createdAt)
    expect(mvs).toHaveLength(2)
    expect(mvs[0]).toMatchObject({ qtyBefore: 0, qtyAfter: 100, qtyChange: 100, boxQty: 1 })
    expect(mvs[1]).toMatchObject({ qtyBefore: 100, qtyAfter: 130, qtyChange: 30 })

    // 出库超出余量 → 阻断（不允许负库存）
    const outFail = await manualMovementAction({
      productId: product!.id,
      type: "manual_out",
      qty: 999,
      reason: "报损：超量",
    })
    expect(outFail.ok).toBe(false)
    if (!outFail.ok) expect(outFail.error).toContain("库存不足")

    const outOk = await manualMovementAction({
      productId: product!.id,
      type: "manual_out",
      qty: 80,
      reason: "其他渠道出库：亚马逊",
    })
    expect(outOk.ok).toBe(true)
    const [stock] = await db
      .select()
      .from(inventoryStocks)
      .where(eq(inventoryStocks.productId, product!.id))
    expect(stock?.qty).toBe(50)
  })

  it("档案更新记变更日志；有流水货号禁删、无流水可删", async () => {
    mockSession.userId = ownerId
    const [product] = await db
      .select()
      .from(inventoryProducts)
      .where(and(eq(inventoryProducts.enterpriseId, entId), eq(inventoryProducts.productCode, "B9001")))
      .limit(1)

    const upd = await updateProductAction(product!.id, {
      name: "测试扑克改名",
      productionState: "active",
      barcodePrePasted: false,
    })
    expect(upd.ok).toBe(true)
    if (upd.ok) expect(upd.changed).toBeGreaterThanOrEqual(1)

    const logs = await db
      .select()
      .from(inventoryProductLogs)
      .where(eq(inventoryProductLogs.productId, product!.id))
    const fields = logs.map((l) => l.field)
    expect(fields).toContain("name")
    expect(fields).toContain("barcodePrePasted")

    const del = await deleteProductAction(product!.id)
    expect(del.ok).toBe(false)
    if (!del.ok) expect(del.error).toContain("流水")

    // 建一个无流水货号 → 可删
    const fresh = await createProductAction({ productCode: "B9002", name: "临时" })
    expect(fresh.ok).toBe(true)
    if (fresh.ok) {
      const del2 = await deleteProductAction(fresh.product.id)
      expect(del2.ok).toBe(true)
    }
  })

  it("总览状态徽章 + 搜索带库存合计", async () => {
    mockSession.userId = ownerId
    const r = await getInventoryOverviewAction({})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const row = r.rows.find((x) => x.productCode === "B9001")
    // 库存 50（100+30−80）；企业无销速数据 → 销速口径不判低库存，仅正常态
    expect(row).toMatchObject({ totalQty: 50, status: "normal" })

    const s = await searchProductsAction({ q: "B9001" })
    expect(s.ok).toBe(true)
    if (s.ok) {
      expect(s.rows).toHaveLength(1)
      expect(s.rows[0]!.totalQty).toBe(50)
    }
  })
})
