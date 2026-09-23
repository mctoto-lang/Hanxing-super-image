import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, users } from "@/db/schema"
// 新表直接从模块文件导入：turbopack 对 * barrel 的陈旧缓存会解析为 undefined
import {
  temuStores,
  temuProducts,
  temuSkuMaps,
  temuSalesOverviews,
  temuAdsDailies,
  temuMetricSnapshots,
} from "@/db/schema/temu"
import { POST } from "@/app/api/v1/ingest/route"
import { getTemuOverviewAction } from "@/server/actions/temu"
import { invalidateTemuCache } from "@/server/services/temu-cache"
import { temuDayStr } from "@/server/services/temu-time"

/**
 * Temu 插件上报端点集成测试（批量 upsert 化后的回归）
 *
 * 覆盖三个重点行为：
 * 1. sales-overview：SKC 标识回填 + SKU↔SKC 映射批量落库，contentHash 幂等
 *    （重发同 payload accepted=0），批内同 skuId 先见先得；
 * 2. products-list：单条多行 upsert，批内重复 skcId 不抛
 *    "cannot affect row a second time"，后见覆盖本源字段；
 * 3. ads-store-report：按日聚合 upsert，重发幂等（同值覆盖）。
 * 另含 overview 趋势 SQL 聚合（分日分店取最后快照再跨店求和）与读缓存行为。
 */

// overview action 走 requireEnterpriseContext → auth()；vitest 无法加载
// next-auth，mock 成可控 session（同 workspace-export / refine-guards 模式）
const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

let entId: string
let token: string

function ingestRequest(items: unknown[]) {
  return new Request("http://localhost/api/v1/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-token": token,
    },
    body: JSON.stringify({ items }),
  })
}

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "ingest 测试企业",
      slug: `ing-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
    })
    .returning()
  entId = ent!.id

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "ingest 测试店铺",
      deviceToken: `test-tok-${randomUUID()}`,
    })
    .returning()
  token = store!.deviceToken
})

afterAll(async () => {
  // overview describe 的独立企业经 globalThis 传递，这里一并清理，
  // 否则每次跑测残留企业/用户/双店/快照行
  const ovwEntId = (globalThis as { __ovwEntId?: string }).__ovwEntId
  if (ovwEntId) {
    await db.delete(enterprises).where(eq(enterprises.id, ovwEntId))
  }
  mockSession.userId = null
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

describe("sales-overview 批量回填与幂等", () => {
  const skcA = `SKC-A-${randomUUID().slice(0, 6)}`
  const skcB = `SKC-B-${randomUUID().slice(0, 6)}`
  const capturedAt = Date.now()

  const item = (items: unknown[]) => ({
    source: "sales-overview",
    capturedAt,
    normalized: { items },
  })

  it("首次上报：overview 入库、商品标识回填、SKU 映射落库", async () => {
    const res = await POST(
      ingestRequest([
        item([
          {
            skcId: skcA,
            goodsId: "G-001",
            productName: "测试商品A",
            productSn: "SN-A",
            skuIds: ["SKU-1", "SKU-2"],
          },
          // 同批第二个 SKC，SKU-2 与前者重复：先见先得归属 skcA
          {
            skcId: skcB,
            goodsId: "G-002",
            productName: "测试商品B",
            skuIds: ["SKU-2", "SKU-3"],
          },
        ]),
      ]),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; accepted: number }
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(1)

    const products = await db
      .select()
      .from(temuProducts)
      .where(eq(temuProducts.productSkcId, skcA))
    expect(products).toHaveLength(1)
    expect(products[0]!.goodsId).toBe("G-001")
    const productB = await db
      .select()
      .from(temuProducts)
      .where(eq(temuProducts.productSkcId, skcB))
    expect(productB).toHaveLength(1)
    expect(productB[0]!.goodsId).toBe("G-002")

    const maps = await db.select().from(temuSkuMaps).where(eq(temuSkuMaps.skuId, "SKU-2"))
    expect(maps).toHaveLength(1)
    expect(maps[0]!.skcId).toBe(skcA)
  })

  it("重发同 payload：contentHash 幂等，accepted=0 且不新增行", async () => {
    const res = await POST(
      ingestRequest([
        item([
          {
            skcId: skcA,
            goodsId: "G-001",
            productName: "测试商品A",
            productSn: "SN-A",
            skuIds: ["SKU-1", "SKU-2"],
          },
          {
            skcId: skcB,
            goodsId: "G-002",
            productName: "测试商品B",
            skuIds: ["SKU-2", "SKU-3"],
          },
        ]),
      ]),
    )
    const body = (await res.json()) as { ok: boolean; accepted: number }
    expect(body.accepted).toBe(0)

    const overviews = await db
      .select()
      .from(temuSalesOverviews)
      .where(eq(temuSalesOverviews.skcId, skcA))
    expect(overviews).toHaveLength(1)
  })
})

describe("products-list 批量 upsert", () => {
  const skc = `SKC-P-${randomUUID().slice(0, 6)}`

  it("批内重复 skcId 不抛错，后见覆盖本源字段", async () => {
    const res = await POST(
      ingestRequest([
        {
          source: "products-list",
          capturedAt: Date.now(),
          normalized: {
            items: [
              {
                productSkcId: skc,
                goodsId: "G-100",
                productName: "先见名",
                category: "Cat1",
                skcStatus: 11,
                mainImageUrl: "https://example.com/1.png",
              },
              {
                productSkcId: skc, // 同批重复
                goodsId: "G-100",
                productName: "后见名",
                category: "Cat2",
                skcStatus: 11,
                mainImageUrl: "https://example.com/2.png",
              },
            ],
          },
        },
      ]),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; accepted: number }
    expect(body.accepted).toBe(1)

    const rows = await db
      .select()
      .from(temuProducts)
      .where(eq(temuProducts.productSkcId, skc))
    expect(rows).toHaveLength(1)
    // 本源 set 字段后见先得（category/mainImageUrl 属 products-list 覆盖集）
    expect(rows[0]!.productName).toBe("后见名")
    expect(rows[0]!.category).toBe("Cat2")
    expect(rows[0]!.mainImageUrl).toBe("https://example.com/2.png")
  })

  it("生命周期源上报不抹掉商品列表源字段（两源字段空间隔离）", async () => {
    await POST(
      ingestRequest([
        {
          source: "newon-lifecycle",
          capturedAt: Date.now(),
          normalized: {
            items: [
              {
                productSkcId: skc,
                goodsId: "G-100",
                supplierPrice: "¥8.26",
                lifecycleStatus: 7,
              },
            ],
          },
          raw: { skcList: [] },
        },
      ]),
    )
    const rows = await db
      .select()
      .from(temuProducts)
      .where(eq(temuProducts.productSkcId, skc))
    expect(rows).toHaveLength(1)
    // 生命周期源的 set 不含 category：商品列表源先写的类目保留
    expect(rows[0]!.category).toBe("Cat2")
    expect(rows[0]!.supplierPrice).toBe(826)
    expect(rows[0]!.lifecycleStatus).toBe("价格申报中")
  })
})

describe("ads-store-report 按日聚合幂等", () => {
  it("小时行按日求和，重发同数据值不变", async () => {
    const day = new Date()
    const item = {
      source: "ads-store-report",
      capturedAt: Date.now(),
      normalized: {
        items: [
          // 同日两小时行：8:00 花费 100 分，9:00 花费 50 分 → 日合计 1.5 元
          { ts: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8).getTime(), adSpend: 100, gmv: 200 },
          { ts: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9).getTime(), adSpend: 50, gmv: 300 },
        ],
      },
    }
    const res1 = await POST(ingestRequest([item]))
    expect(res1.status).toBe(200)

    const store = (await db.select().from(temuStores).where(eq(temuStores.deviceToken, token)))[0]!
    const rows1 = await db
      .select()
      .from(temuAdsDailies)
      .where(eq(temuAdsDailies.storeId, store.id))
    expect(rows1).toHaveLength(1)
    expect(rows1[0]!.adSpend).toBe(1.5)
    expect(rows1[0]!.gmv).toBe(5)

    // 重发：同日覆盖同值（幂等，不叠加）
    await POST(ingestRequest([item]))
    const rows2 = await db
      .select()
      .from(temuAdsDailies)
      .where(eq(temuAdsDailies.storeId, store.id))
    expect(rows2).toHaveLength(1)
    expect(rows2[0]!.adSpend).toBe(1.5)
  })
})

describe("overview 趋势 SQL 聚合 + 读缓存", () => {
  // 实现按 Asia/Shanghai 分桶，期望值/夹具也按 CST 构造——
  // 用本地时区（toLocaleDateString / setHours）会在非 UTC+8 机器上错位
  const dayKey = (offsetDays: number) =>
    temuDayStr(new Date(Date.now() - offsetDays * 24 * 3600 * 1000))
  const at = (offsetDays: number, cstHour: number) => {
    const day = dayKey(offsetDays)
    return new Date(
      `${day}T${String(cstHour).padStart(2, "0")}:00:00+08:00`,
    )
  }

  let storeA: string
  let storeB: string

  beforeAll(async () => {
    // 独立企业 + 成员用户 + 双店：跨店求和与分日取最后快照需要多店多批次夹具
    const [ent2] = await db
      .insert(enterprises)
      .values({
        name: "overview 测试企业",
        slug: `ovw-${randomUUID().slice(0, 8)}`,
        creditsBalance: 0,
      })
      .returning()
    const [member] = await db
      .insert(users)
      .values({
        username: `ovw_user_${randomUUID().slice(0, 8)}`,
        passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        enterpriseId: ent2!.id,
        enterpriseRole: "member",
      })
      .returning()
    mockSession.userId = member!.id

    const [a] = await db
      .insert(temuStores)
      .values({ enterpriseId: ent2!.id, name: "ovw-A", deviceToken: `ovw-a-${randomUUID()}` })
      .returning()
    const [b] = await db
      .insert(temuStores)
      .values({ enterpriseId: ent2!.id, name: "ovw-B", deviceToken: `ovw-b-${randomUUID()}` })
      .returning()
    storeA = a!.id
    storeB = b!.id
    ;(globalThis as { __ovwEntId?: string }).__ovwEntId = ent2!.id

    const snap = (storeId: string, capturedAt: Date, saleVolume: number | null, hash: string) => ({
      storeId,
      source: "dashboard-stats",
      capturedAt,
      saleVolume,
      contentHash: hash,
      metrics: {},
    })
    await db.insert(temuMetricSnapshots).values([
      // D-2：店 A 两条，后一条（销量 2）应胜出 → 当日合计 2
      snap(storeA, at(2, 8), 1, `h-a-2-1-${storeA.slice(0, 8)}`),
      snap(storeA, at(2, 20), 2, `h-a-2-2-${storeA.slice(0, 8)}`),
      // D-1：店 A 10 + 店 B 5 → 当日合计 15
      snap(storeA, at(1, 10), 10, `h-a-1-${storeA.slice(0, 8)}`),
      snap(storeB, at(1, 12), 5, `h-b-1-${storeB.slice(0, 8)}`),
      // 今日：店 A 3 + 店 B 4 → 7
      snap(storeA, at(0, 9), 3, `h-a-0-${storeA.slice(0, 8)}`),
      snap(storeB, at(0, 9), 4, `h-b-0-${storeB.slice(0, 8)}`),
    ])
    // 每个测试组独立企业：先失效防止上一个企业的缓存串扰（不同 key 本不互扰，保险）
    invalidateTemuCache(ent2!.id)
  })

  it("趋势分日分店取最后快照再跨店求和", async () => {
    const o = await getTemuOverviewAction()
    const byDay = new Map(o.trend.map((t) => [t.date, t.saleVolume]))
    expect(byDay.get(dayKey(2))).toBe(2) // 同店同日后见胜出，不重复累加
    expect(byDay.get(dayKey(1))).toBe(15) // 跨店求和
    expect(o.cards.todaySales.value).toBe(7)
  })

  it("读缓存命中（TTL 内 DB 变化不可见），显式失效后可见", async () => {
    const before = await getTemuOverviewAction()
    expect(before.cards.todaySales.value).toBe(7)

    await db.insert(temuMetricSnapshots).values({
      storeId: storeA,
      source: "dashboard-stats",
      capturedAt: new Date(),
      saleVolume: 100,
      contentHash: `h-extra-${randomUUID().slice(0, 12)}`,
      metrics: {},
    })

    // TTL 内命中缓存：仍是旧值
    const cached = await getTemuOverviewAction()
    expect(cached.cards.todaySales.value).toBe(7)

    // 写路径失效后读到新值（7 - 3 + 100 = 104）
    invalidateTemuCache((globalThis as { __ovwEntId?: string }).__ovwEntId!)
    const fresh = await getTemuOverviewAction()
    expect(fresh.cards.todaySales.value).toBe(104)
  })
})
