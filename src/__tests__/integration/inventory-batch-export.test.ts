import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, permissionGroups } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import { inventoryMovements, inventoryProducts, inventoryWarehouses } from "@/db/schema/inventory"
import { manualMovementAction } from "@/server/actions/inventory"
import {
  batchMovementAction,
  exportInventoryOverviewExcelAction,
  exportProductionExcelAction,
} from "@/server/actions/inventory-batch-export"

/**
 * 批量操作 + Excel 导出回归（批次6）：批量出入库单事务原子性（不足整批回滚）、
 * 两张导出（base64 xlsx 非空且 zip 魔数）
 */

const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

let entId: string
let userId: string
let mainWhId: string
let p1: string
let p2: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "批量导出测试企业",
      slug: `bat-${randomUUID().slice(0, 8)}`,
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
      username: `bat-${randomUUID().slice(0, 8)}`,
      email: `bat-${randomUUID().slice(0, 8)}@test.local`,
      name: "批量测试用户",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  userId = user!.id
  mockSession.userId = userId

  await db
    .insert(inventoryWarehouses)
    .values([{ enterpriseId: entId, code: "main", name: "主仓", sort: 0 }])
  const whs = await db
    .select()
    .from(inventoryWarehouses)
    .where(eq(inventoryWarehouses.enterpriseId, entId))
  mainWhId = whs.find((w) => w.code === "main")!.id

  for (const code of ["X9001", "X9002"]) {
    const [row] = await db
      .insert(inventoryProducts)
      .values({ enterpriseId: entId, productCode: code, name: `${code} 款`, createdBy: userId })
      .returning()
    if (code === "X9001") p1 = row!.id
    else p2 = row!.id
    const r = await manualMovementAction({
      productId: row!.id,
      type: "manual_in",
      qty: 100,
      reason: "建账",
    })
    expect(r.ok).toBe(true)
  }
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

describe("批量操作 + Excel 导出", () => {
  it("批量入库：两货号各+50，流水前中后值正确", async () => {
    const r = await batchMovementAction({
      mode: "in",
      reason: "批量测试入库",
      items: [
        { productId: p1, qty: 50 },
        { productId: p2, qty: 50 },
      ],
    })
    expect(r.ok).toBe(true)
    const mvs = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.enterpriseId, entId))
    const batchIns = mvs.filter((m) => m.reason?.includes("批量测试入库"))
    expect(batchIns).toHaveLength(2)
    expect(batchIns.every((m) => m.qtyBefore === 100 && m.qtyAfter === 150)).toBe(true)
  })

  it("批量出库不足整批回滚（X9001 够、X9002 不够 → 全回滚）", async () => {
    const r = await batchMovementAction({
      mode: "out",
      reason: "批量超量",
      items: [
        { productId: p1, qty: 10 },
        { productId: p2, qty: 9999 },
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("整批已回滚")
    // X9001 的 10 件也没有出（原子性）
    const mvs = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.refType, "manual"))
    const batchOuts = mvs.filter((m) => m.reason?.includes("批量超量"))
    expect(batchOuts).toHaveLength(0)
  })

  it("两张 Excel 导出：非空 base64 且 xlsx zip 魔数", async () => {
    for (const r of [
      await exportInventoryOverviewExcelAction(),
      await exportProductionExcelAction(),
    ]) {
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.base64.length).toBeGreaterThan(500)
        const head = Buffer.from(r.base64.slice(0, 8), "base64")
        expect(head[0]).toBe(0x50) // 'P' (PK zip 头)
        expect(head[1]).toBe(0x4b) // 'K'
        expect(r.filename.endsWith(".xlsx")).toBe(true)
      }
    }
  })
})
