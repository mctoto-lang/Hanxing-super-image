import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, users } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import { temuStores, temuSalesOverviews } from "@/db/schema/temu"
import { encrypt } from "@/lib/crypto"
import { temuDayStr, previousPeriodRanges } from "@/server/services/temu-time"
import { getTemuOverviewAction } from "@/server/actions/temu"

/**
 * 概览四卡环比口径回归（2026-11-16 起）：
 * - 今日/预估销售额卡维持「对比昨日」；
 * - 七日卡 = 今日快照 last7 vs 上个自然周末日（最后一天最后一次）快照 last7；
 * - 30日卡 = 今日快照 last30 vs 上个自然月末快照 last30；
 * - 周期末日缺数据回退周期内最近有数据的一天（上月只种 15 日 → 基线取 15 日）。
 * 纯本地库，无官方请求。
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

/** 北京时间某日正午的绝对时间（trendAgg 按 captured_at AT TIME ZONE 'Asia/Shanghai' 分日） */
const cstNoon = (day: string) => new Date(`${day}T12:00:00+08:00`)

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "temu 周期环比测试企业",
      slug: `pd-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      enabledModules: [...MODULE_NAMES],
    })
    .returning()
  entId = ent!.id

  const [owner] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `pd-${randomUUID().slice(0, 8)}`,
      email: `pd-${randomUUID().slice(0, 8)}@test.local`,
      name: "周期环比管理员",
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
      name: "周期环比测试店铺",
      accessTokenEncrypted: encrypt("pd-test-token"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeId = store!.id

  const prev = previousPeriodRanges()
  const day = (d: string) => ({ capturedAt: cstNoon(d), capturedDay: d })
  const row = (
    skcId: string,
    d: string,
    v: { today?: number; last7?: number; last30?: number },
  ) => ({
    storeId,
    skcId,
    ...day(d),
    contentHash: `pd-${skcId}-${d}`,
    todaySalesVolume: v.today ?? 0,
    last7DaysSalesVolume: v.last7 ?? 0,
    last30DaysSalesVolume: v.last30 ?? 0,
  })

  await db.insert(temuSalesOverviews).values([
    // 今日：last7=100、last30=1000、today=10
    row("PD1", temuDayStr(), { today: 10, last7: 100, last30: 1000 }),
    // 昨日：today=8（今日卡基线）
    row("PD2", temuDayStr(new Date(cstNoon(temuDayStr()).getTime() - 86_400_000)), {
      today: 8,
    }),
    // 上个自然周末日：last7=80（七日卡基线=周期末快照）
    row("PD3", prev.week.end, { last7: 80, last30: 999 }),
    // 上个自然月 15 日：last30=850（30日卡基线——月末未种，回退到周期内最近有数据的一天）
    row("PD4", `${prev.month.end.slice(0, 8)}15`, { last7: 70, last30: 850 }),
  ])
}, 60_000)

afterAll(async () => {
  await db.delete(users).where(eq(users.enterpriseId, entId))
  await db.delete(enterprises).where(eq(enterprises.id, entId))
  vi.unstubAllGlobals()
})

describe("概览四卡环比口径", () => {
  it(
    "今日卡对比昨日；七日卡对比上周末日快照；30日卡月末缺失回退月内最近一天",
    { timeout: 30_000 },
    async () => {
      const o = await getTemuOverviewAction(storeId)
      const c = o.cards
      // 今日：今日 10 vs 昨日 8 = +25.0%
      expect(c.todaySales.value).toBe(10)
      expect(c.todaySales.delta).toBe(25)

      // 七日：今日 last7=100 vs 上周日快照 last7=80 = +25.0%
      expect(c.sevenDaySales.value).toBe(100)
      expect(c.sevenDaySales.delta).toBe(25)

      // 30日：今日 last30=1000 vs 上月 15 日快照 last30=850（月末未种回退）= +17.6%
      expect(c.thirtyDaySales.value).toBe(1000)
      expect(c.thirtyDaySales.delta).toBe(17.6)
    },
  )
})
