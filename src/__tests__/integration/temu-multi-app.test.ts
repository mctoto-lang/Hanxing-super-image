import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID, createHash } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, permissionGroups, users, type ModuleName, MODULE_NAMES } from "@/db/schema"
// 新表直接从模块文件导入：turbopack 对 * barrel 的陈旧缓存会解析为 undefined
import { temuApps, temuStores, temuProducts, temuSalesOverviews } from "@/db/schema/temu"
import { encrypt } from "@/lib/crypto"
import { getTemuCallContext } from "@/server/services/temu-sync"
import {
  createTemuStoreAction,
  updateTemuStoreAction,
  deleteTemuStoreAction,
  listTemuAppsBriefAction,
  getTemuProductsPageAction,
} from "@/server/actions/temu"

/**
 * TEMU 多应用（多主体，0097）集成测试：
 * 1. getTemuCallContext 三分支：demo 店铺走官方沙箱凭证（不读密文/应用表）；
 *    真实店铺按 appId 取凭证；未关联应用报错
 * 2. createTemuStoreAction：appId 必填（zod）、应用归属校验、单应用 20 店铺上限
 * 3. 演示店铺写操作守卫：编辑/删除拒绝
 * 4. listTemuAppsBriefAction 店铺数统计
 * 5. 聚合查询 app 维度过滤（resolveStoreIds 交集口径）
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
// 仅替换凭证获取（app 维度真实走库）；其余（MAX_STORES_PER_APP 等）用真实现
vi.mock("@/lib/temu-api/app-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/temu-api/app-config")>()
  return {
    ...actual,
    getTemuAppCredential: async () => ({
      appKey: "test-app-key",
      appSecret: "test-app-secret",
      source: "test" as const,
    }),
  }
})

let entId: string
let otherEntId: string
let userId: string
let appA: string
let appB: string
let otherEntApp: string
let storeA: string
let storeB: string

const hash = (s: string) => createHash("sha1").update(s).digest("hex")

beforeAll(async () => {
  const mkEnt = async (name: string) => {
    const [ent] = await db
      .insert(enterprises)
      .values({
        name,
        slug: `tma-${randomUUID().slice(0, 8)}`,
        creditsBalance: 0,
        enabledModules: [...MODULE_NAMES] as ModuleName[],
      })
      .returning()
    return ent!.id
  }
  entId = await mkEnt("多应用测试企业")
  otherEntId = await mkEnt("多应用他企")

  const [group] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entId, name: "多应用权限组", allowedPages: ["settings", "temu"] })
    .returning()
  const [user] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      groupId: group!.id,
      username: `tma-${randomUUID().slice(0, 8)}`,
      email: `tma-${randomUUID().slice(0, 8)}@test.local`,
      name: "多应用用户",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  userId = user!.id
  mockSession.userId = userId

  const [a] = await db
    .insert(temuApps)
    .values({ enterpriseId: entId, name: "主体A", appKey: "ak-a", appSecretEncrypted: "enc:v1:x" })
    .returning()
  appA = a!.id
  const [b] = await db
    .insert(temuApps)
    .values({ enterpriseId: entId, name: "主体B", appKey: "ak-b", appSecretEncrypted: "enc:v1:y" })
    .returning()
  appB = b!.id
  const [oa] = await db
    .insert(temuApps)
    .values({ enterpriseId: otherEntId, name: "他企应用", appKey: "ak-o", appSecretEncrypted: "enc:v1:z" })
    .returning()
  otherEntApp = oa!.id

  // 两应用各一店（带 token）+ 各一条商品/销售行（app 过滤断言用）
  const [sa] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      appId: appA,
      name: "A 店",
      accessTokenEncrypted: encrypt("tok-a"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeA = sa!.id
  const [sb] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      appId: appB,
      name: "B 店",
      accessTokenEncrypted: encrypt("tok-b"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeB = sb!.id

  const day = new Date().toISOString().slice(0, 10)
  await db.insert(temuProducts).values([
    { storeId: storeA, productSkcId: "MA1", productId: "PA", productSn: "B7001", productName: "A 店款", skcStatus: 1 },
    { storeId: storeB, productSkcId: "MB1", productId: "PB", productSn: "B7002", productName: "B 店款", skcStatus: 1 },
  ])
  const now = new Date()
  await db.insert(temuSalesOverviews).values([
    { storeId: storeA, skcId: "MA1", capturedAt: now, capturedDay: day, contentHash: hash("a1"), productSn: "B7001", todaySalesVolume: 3 },
    { storeId: storeB, skcId: "MB1", capturedAt: now, capturedDay: day, contentHash: hash("b1"), productSn: "B7002", todaySalesVolume: 5 },
  ])
})

afterAll(async () => {
  // 企业级联清理（temu_app/temu_store/数据表随企业删）
  await db.delete(enterprises).where(inArray(enterprises.id, [entId, otherEntId]))
})

describe("getTemuCallContext 多应用分支", () => {
  it("演示店铺：走虚拟数据凭证标记（callTemuApi 拦截层接管，不读密文）", async () => {
    const [demo] = await db
      .insert(temuStores)
      .values({ enterpriseId: entId, appId: null, isDemo: true, name: "演示店", tokenState: "active", mallType: "full" })
      .returning()
    const ctx = await getTemuCallContext(demo!)
    expect("error" in ctx).toBe(false)
    if (!("error" in ctx)) {
      expect(ctx.appKey).toBe("__demo_virtual__")
    }
    await db.delete(temuStores).where(eq(temuStores.id, demo!.id))
  })

  it("真实店铺按 appId 取凭证（mock 注入）", async () => {
    const [s] = await db.select().from(temuStores).where(eq(temuStores.id, storeA))
    const ctx = await getTemuCallContext(s!)
    expect("error" in ctx).toBe(false)
    if (!("error" in ctx)) {
      expect(ctx.appKey).toBe("test-app-key")
      expect(ctx.accessToken).toBe("tok-a")
    }
  })

  it("未关联应用的店铺：报错且不炸", async () => {
    const [orphan] = await db
      .insert(temuStores)
      .values({
        enterpriseId: entId,
        appId: null,
        name: "无应用店",
        accessTokenEncrypted: encrypt("tok-x"),
        tokenState: "active",
        mallType: "full",
      })
      .returning()
    const ctx = await getTemuCallContext(orphan!)
    expect("error" in ctx).toBe(true)
    if ("error" in ctx) expect(ctx.error).toContain("未关联 TEMU 应用")
    await db.delete(temuStores).where(eq(temuStores.id, orphan!.id))
  })
})

describe("createTemuStoreAction（appId 必填/归属/20 上限）", () => {
  it("缺 appId 被 zod 拒绝", async () => {
    await expect(
      createTemuStoreAction({ name: "无应用店" } as never),
    ).rejects.toThrow()
  })

  it("他企应用拒绝", async () => {
    const r = await createTemuStoreAction({ appId: otherEntApp, name: "越权店" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("不存在")
  })

  it("正常创建并计入应用店铺数", async () => {
    const r = await createTemuStoreAction({ appId: appB, name: "B 店二号" })
    expect(r.ok).toBe(true)
    const apps = await listTemuAppsBriefAction()
    const b = apps.find((a) => a.id === appB)
    expect(b?.storeCount).toBe(2)
  })

  it("单应用 20 店铺上限", async () => {
    // 直插 19 家到主体B（已有 2 家 → 21 超限）
    const rows = Array.from({ length: 19 }, (_, i) => ({
      enterpriseId: entId,
      appId: appB,
      name: `B 批量店 ${i}`,
    }))
    await db.insert(temuStores).values(rows)
    const r = await createTemuStoreAction({ appId: appB, name: "超限店" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("上限")
    // 上限内仍可创建（主体A）
    const r2 = await createTemuStoreAction({ appId: appA, name: "A 店二号" })
    expect(r2.ok).toBe(true)
  })
})

describe("演示店铺写操作守卫", () => {
  it("编辑/删除演示店铺被拒", async () => {
    const [demo] = await db
      .insert(temuStores)
      .values({ enterpriseId: entId, appId: null, isDemo: true, name: "守卫演示店", tokenState: "active", mallType: "full" })
      .returning()
    await expect(
      updateTemuStoreAction({ id: demo!.id, name: "改名" }),
    ).rejects.toThrow("演示店铺")
    await expect(deleteTemuStoreAction({ id: demo!.id })).rejects.toThrow("演示店铺")
    await db.delete(temuStores).where(eq(temuStores.id, demo!.id))
  })
})

describe("聚合查询 app 维度过滤", () => {
  it("商品列表按应用过滤（A 店只见 A 店款）", async () => {
    const all = await getTemuProductsPageAction(undefined, undefined, undefined, 1, undefined, undefined)
    const snsAll = all.rows.map((r) => r.productSn)
    expect(snsAll).toContain("B7001")
    expect(snsAll).toContain("B7002")

    const onlyA = await getTemuProductsPageAction(undefined, undefined, undefined, 1, undefined, undefined, appA)
    const snsA = onlyA.rows.map((r) => r.productSn)
    expect(snsA).toContain("B7001")
    expect(snsA).not.toContain("B7002")
  })
})
