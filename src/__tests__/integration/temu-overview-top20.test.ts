import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, users } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import { temuStores, temuProducts, temuSalesOverviews } from "@/db/schema/temu"
import { encrypt } from "@/lib/crypto"
import { temuDayStr } from "@/server/services/temu-time"
import { getTemuSalesTopBySnAction } from "@/server/actions/temu"

/**
 * TOP20 按货号聚合主图口径回归：组主图 =「该口径销量最高的有图 SKC」的图
 * （原 max(url) 按字典序任意选图，非最高销量链接）。纯本地库，无官方请求。
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

let entId = ""
let ownerId = ""
let storeId = ""

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "temu top20 测试企业",
      slug: `t20-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      enabledModules: [...MODULE_NAMES],
    })
    .returning()
  entId = ent!.id

  const [owner] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `t20-${randomUUID().slice(0, 8)}`,
      email: `t20-${randomUUID().slice(0, 8)}@test.local`,
      name: "top20 管理员",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  ownerId = owner!.id
  mockSession.userId = ownerId

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "top20 测试店铺",
      accessTokenEncrypted: encrypt("t20-test-token"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeId = store!.id

  // B82 组两 SKC：A 今日榜首（图 URL 字典序小）、B 七日/三十日榜首（字典序大）——
  // 旧 max(url) 实现三口径都会选 B 的图，正是本次修复的对照场景
  // B90 组：榜首 C 无图，次位 D 有图 → 主图顺延取 D 的图
  await db.insert(temuProducts).values([
    { storeId, productSkcId: "T20A", productId: "P20A", productSn: "B82", productName: "B82 甲", mainImageUrl: "https://kwcdn/aaa-today.jpg" },
    { storeId, productSkcId: "T20B", productId: "P20B", productSn: "B82", productName: "B82 乙", mainImageUrl: "https://kwcdn/zzz-7d.jpg" },
    { storeId, productSkcId: "T20C", productId: "P20C", productSn: "B90", productName: "B90 无图款" },
    { storeId, productSkcId: "T20D", productId: "P20D", productSn: "B90", productName: "B90 有图款", mainImageUrl: "https://kwcdn/b90-fallback.jpg" },
  ])

  const day = temuDayStr()
  const now = new Date()
  await db.insert(temuSalesOverviews).values([
    { storeId, skcId: "T20A", capturedAt: now, capturedDay: day, contentHash: "t20-a", productSn: "B82", todaySalesVolume: 99, last7DaysSalesVolume: 5, last30DaysSalesVolume: 5 },
    { storeId, skcId: "T20B", capturedAt: now, capturedDay: day, contentHash: "t20-b", productSn: "B82", todaySalesVolume: 1, last7DaysSalesVolume: 50, last30DaysSalesVolume: 50 },
    { storeId, skcId: "T20C", capturedAt: now, capturedDay: day, contentHash: "t20-c", productSn: "B90", todaySalesVolume: 30, last7DaysSalesVolume: 30, last30DaysSalesVolume: 30 },
    { storeId, skcId: "T20D", capturedAt: now, capturedDay: day, contentHash: "t20-d", productSn: "B90", todaySalesVolume: 2, last7DaysSalesVolume: 2, last30DaysSalesVolume: 2 },
  ])
}, 60_000)

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
  vi.unstubAllGlobals()
})

describe("TOP20 按货号聚合主图", () => {
  it(
    "各口径主图 = 该口径销量最高 SKC 的图；榜首无图顺延次位有图 SKC",
    { timeout: 30_000 },
    async () => {
      const rows = await getTemuSalesTopBySnAction(storeId)
      const b82 = rows.find((r) => r.sn === "B82")
      const b90 = rows.find((r) => r.sn === "B90")
      expect(b82).toBeTruthy()
      expect(b90).toBeTruthy()
      if (!b82 || !b90) return

      // B82：今日榜首是 A（字典序小的图），七日/三十日榜首是 B（字典序大的图）
      expect(b82.todayMainImageUrl).toBe("https://kwcdn/aaa-today.jpg")
      expect(b82.last7MainImageUrl).toBe("https://kwcdn/zzz-7d.jpg")
      expect(b82.last30MainImageUrl).toBe("https://kwcdn/zzz-7d.jpg")
      expect(b82.todayMainImageCosUrl).toBeNull()
      expect(b82.last7MainImageCosUrl).toBeNull()

      // B90：榜首 C 无图 → 主图顺延取次位 D 的图（三口径同）
      expect(b90.todayMainImageUrl).toBe("https://kwcdn/b90-fallback.jpg")
      expect(b90.last7MainImageUrl).toBe("https://kwcdn/b90-fallback.jpg")

      // 汇总口径不受选图影响
      expect(b82.todaySalesVolume).toBe(100)
      expect(b82.last7DaysSalesVolume).toBe(55)
      expect(b90.last30DaysSalesVolume).toBe(32)
    },
  )
})
