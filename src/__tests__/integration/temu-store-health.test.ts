import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises } from "@/db/schema"
import {
  temuStores,
  temuProducts,
  temuSkuMaps,
  temuSalesOverviews,
  temuShipOrders,
  temuApps,
} from "@/db/schema/temu"
import { encrypt } from "@/lib/crypto"
import {
  setTemuStoreTokenAction,
  detectTemuResidualDataAction,
  cleanTemuResidualDataAction,
  getTemuProductsAction,
} from "@/server/actions/temu"
import { normalizeAdRoas } from "@/lib/temu-api/workbench-labels"

/**
 * 店铺 token 防错绑 + 错绑残留治理 + 商品页跨店去重（2026-11-18 批次）：
 *
 * 1. setTemuStoreTokenAction 先探测后保存：新 token 归属 mall 与店铺当前身份
 *    不一致 / mall 已被其他店铺占用 → needConfirm（token 不落库），确认后落库；
 *    探测失败不落库（修掉乐观置 active 缺口）；
 * 2. detectTemuResidualDataAction / cleanTemuResidualDataAction：同 skcId 跨店
 *    双落 + lastSeenAt 冻结（>48h 落后）= 残留行，清理只删残留店一侧；
 *    同 mallId 多店绑定预警；
 * 3. loadTemuProducts 全店视图跨店去重（NOT EXISTS 保留 lastSeenAt 最新行）；
 * 4. normalizeAdRoas 万倍口径归一（120000→12）。
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
  MAX_STORES_PER_APP: 20,
  getTemuAppCredential: async () => ({
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    source: "test",
  }),
}))

/** 探测链路 fetch mock：mall.info + accesstoken.info（mallId 可控；invalid 时 7000007） */
function mockProbeFetch(opts: { mallId: string; mallName: string; invalid?: boolean } ) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string }
    if (opts.invalid) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: null, success: false, errorCode: 7000007, errorMsg: "expired" }),
      } as unknown as Response
    }
    const result =
      body.type === "bg.mall.info.get"
        ? { semiManagedMall: false }
        : body.type === "bg.open.accesstoken.info.get.global"
          ? { uniqueId: opts.mallId, mallName: opts.mallName }
          : {}
    return {
      ok: true,
      status: 200,
      json: async () => ({ result, success: true, errorCode: 1000000, errorMsg: "" }),
    } as unknown as Response
  })
}

let entId: string
/** 店铺 A：先绑 mall-old，后被确认绑到 mall-B（复刻错绑-确认链路） */
let storeAId: string
/** 店铺 B：一直正确持有 mall-B */
let storeBId: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "temu 店铺体检测试企业",
      slug: `health-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
    })
    .returning()
  entId = ent!.id
  await db
    .insert(temuApps)
    .values({ enterpriseId: entId, name: "测试应用", appKey: "test-app", appSecretEncrypted: "enc:v1:t" })
  const [user] = await db
    .insert((await import("@/db/schema")).users)
    .values({
      enterpriseId: entId,
      username: `health-${randomUUID().slice(0, 8)}`,
      email: `health-${randomUUID().slice(0, 8)}@test.local`,
      name: "health 测试用户",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  mockSession.userId = user!.id

  const [a] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "店铺A",
      mallId: "mall-old",
      mallName: "A 原 mall",
      accessTokenEncrypted: encrypt("old-token-of-store-a-32chars-minimum"),
      tokenState: "active",
    })
    .returning()
  storeAId = a!.id
  const [b] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "店铺B",
      mallId: "mall-B",
      mallName: "B 的 mall",
      accessTokenEncrypted: encrypt("real-token-of-store-b-32chars-minimum"),
      tokenState: "active",
    })
    .returning()
  storeBId = b!.id
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
  vi.unstubAllGlobals()
})

describe("setTemuStoreTokenAction 防错绑", () => {
  it("② 新 token 归属 mall 已被其他店铺占用 → needConfirm 且不落库", { timeout: 30_000 }, async () => {
    const [before] = await db.select().from(temuStores).where(eq(temuStores.id, storeAId))
    vi.stubGlobal("fetch", mockProbeFetch({ mallId: "mall-B", mallName: "B 的 mall" }))
    const r = await setTemuStoreTokenAction({
      id: storeAId,
      accessToken: "brandnewtokena32charsminimumaa0001",
    })
    expect(r.ok).toBe(false)
    if (!r.ok && "needConfirm" in r && r.needConfirm) {
      expect(r.mismatch.conflictStoreName).toBe("店铺B")
      expect(r.mismatch.newMallId).toBe("mall-B")
    } else {
      throw new Error("应返回 needConfirm")
    }
    // token 未落库：密文与身份保持原值（AES-GCM 非确定性，按前后快照比对）
    const [a] = await db.select().from(temuStores).where(eq(temuStores.id, storeAId))
    expect(a?.accessTokenEncrypted).toBe(before?.accessTokenEncrypted)
    expect(a?.mallId).toBe("mall-old")
  })

  it("① 店铺已绑 mallId 与新 token 归属不一致（无他店占用）→ needConfirm", { timeout: 30_000 }, async () => {
    vi.stubGlobal("fetch", mockProbeFetch({ mallId: "mall-C", mallName: "第三家店" }))
    const r = await setTemuStoreTokenAction({
      id: storeAId,
      accessToken: "brandnewtokena32charsminimumbb0002",
    })
    expect(r.ok).toBe(false)
    if (!r.ok && "needConfirm" in r && r.needConfirm) {
      expect(r.mismatch.currentMallId).toBe("mall-old")
      expect(r.mismatch.newMallId).toBe("mall-C")
    } else {
      throw new Error("应返回 needConfirm")
    }
  })

  it("探测失败（token 无效）→ 报错且不落库（不再乐观置 active）", { timeout: 30_000 }, async () => {
    const [before] = await db.select().from(temuStores).where(eq(temuStores.id, storeAId))
    vi.stubGlobal("fetch", mockProbeFetch({ mallId: "mall-B", mallName: "B 的 mall", invalid: true }))
    const r = await setTemuStoreTokenAction({
      id: storeAId,
      accessToken: "invalidtoken32charsminimumcccc0003",
    })
    expect(r.ok).toBe(false)
    if (!r.ok && !("needConfirm" in r && r.needConfirm)) {
      expect(r.error).toContain("无效或已过期")
    } else {
      throw new Error("应返回普通错误")
    }
    const [after] = await db.select().from(temuStores).where(eq(temuStores.id, storeAId))
    expect(after?.accessTokenEncrypted).toBe(before?.accessTokenEncrypted)
    expect(after?.tokenState).toBe(before?.tokenState)
  })

  it("确认后落库：身份随 token 更新为归属 mall（复刻错绑-确认场景）", { timeout: 30_000 }, async () => {
    vi.stubGlobal("fetch", mockProbeFetch({ mallId: "mall-B", mallName: "B 的 mall" }))
    const r = await setTemuStoreTokenAction({
      id: storeAId,
      accessToken: "brandnewtokena32charsminimumaa0001",
      confirmIdentityMismatch: true,
    })
    expect(r.ok).toBe(true)
    const [a] = await db.select().from(temuStores).where(eq(temuStores.id, storeAId))
    expect(a?.mallId).toBe("mall-B")
    expect(a?.tokenState).toBe("active")
  })
})

describe("错绑残留检测与清理", () => {
  // 顺序契约：检测/清理用例依赖前置用例播种的库状态（token 确认后 A/B 同
  // mall、91001/91002 残留已清理等，负例按 hasResidual=false 断言全量无残留）。
  // vitest 同文件内按序执行——勿单独 -t 跑本组后段用例。

  /** 双落构造：skc 在 A（冻结 3 天）/ B（持续新鲜）各一行 + A 侧销售/SKU 残留 */
  const seedPollution = async (skcId: string, sn: string) => {
    const stale = new Date(Date.now() - 3 * 86400_000)
    const fresh = new Date()
    await db.insert(temuProducts).values([
      {
        storeId: storeAId,
        productSkcId: skcId,
        productSn: sn,
        skcStatus: 11,
        lastSeenAt: stale,
        firstSeenAt: stale,
      },
      {
        storeId: storeBId,
        productSkcId: skcId,
        productSn: sn,
        skcStatus: 11,
        lastSeenAt: fresh,
        firstSeenAt: fresh,
      },
    ])
    await db.insert(temuSalesOverviews).values([
      {
        storeId: storeAId,
        skcId,
        capturedAt: stale,
        capturedDay: "2026-11-01",
        contentHash: `stale-${skcId}`,
        todaySalesVolume: 5,
      },
      {
        storeId: storeBId,
        skcId,
        capturedAt: fresh,
        capturedDay: "2026-11-18",
        contentHash: `fresh-${skcId}`,
        todaySalesVolume: 7,
      },
    ])
    await db.insert(temuSkuMaps).values({
      storeId: storeAId,
      skuId: `sku-${skcId}`,
      skcId,
    })
  }

  it("商品页全店视图跨店去重：冻结行不出现、总量不双计", { timeout: 30_000 }, async () => {
    await seedPollution("91001", "SN-91001")
    const { rows, total } = await getTemuProductsAction(undefined, undefined, 1)
    const hit = rows.filter((r) => r.productSkcId === "91001")
    expect(hit.length).toBe(1)
    expect(hit[0]!.storeId).toBe(storeBId)
    expect(total).toBeGreaterThanOrEqual(1)
  })

  it("检测：残留行按店汇总 + 同 mall 多店预警", { timeout: 30_000 }, async () => {
    await seedPollution("91002", "SN-91002")
    const report = await detectTemuResidualDataAction()
    expect(report.hasResidual).toBe(true)
    const a = report.stores.find((s) => s.storeId === storeAId)
    expect(a).toBeDefined()
    expect(a!.productCount).toBe(2)
    expect(a!.sampleSns).toContain("SN-91001")
    // 前一步确认绑定后 A/B 同 mall → 预警出现
    expect(
      report.mallConflicts.some((c) => c.mallId === "mall-B" && c.stores.length === 2),
    ).toBe(true)
  })

  it("清理：只删残留店一侧（A 删 B 留），销售/SKU 映射连带清理", { timeout: 30_000 }, async () => {
    const r = await cleanTemuResidualDataAction()
    expect(r.ok).toBe(true)
    expect((r.counts?.["temu_product"] ?? 0)).toBe(2)
    expect((r.counts?.["temu_sales_overview"] ?? 0)).toBe(2)
    expect((r.counts?.["temu_sku_map"] ?? 0)).toBe(2)

    const remainA = await db
      .select()
      .from(temuProducts)
      .where(and(eq(temuProducts.storeId, storeAId), eq(temuProducts.productSkcId, "91001")))
    expect(remainA.length).toBe(0)
    const remainB = await db
      .select()
      .from(temuProducts)
      .where(and(eq(temuProducts.storeId, storeBId), eq(temuProducts.productSkcId, "91001")))
    expect(remainB.length).toBe(1)

    const salesA = await db
      .select()
      .from(temuSalesOverviews)
      .where(and(eq(temuSalesOverviews.storeId, storeAId), eq(temuSalesOverviews.skcId, "91001")))
    expect(salesA.length).toBe(0)
    const skuA = await db
      .select()
      .from(temuSkuMaps)
      .where(and(eq(temuSkuMaps.storeId, storeAId), eq(temuSkuMaps.skcId, "91001")))
    expect(skuA.length).toBe(0)

    // 清理后再检测：无残留（mall 同绑预警仍在——需人工处理，不自动清理）
    const after = await detectTemuResidualDataAction()
    expect(after.hasResidual).toBe(false)
    expect(after.mallConflicts.length).toBeGreaterThan(0)
  })

  it("负例：两店同 skcId 且 lastSeenAt 均新鲜（当前时间）→ 不判残留", { timeout: 30_000 }, async () => {
    const now = new Date()
    await db.insert(temuProducts).values([
      {
        storeId: storeAId,
        productSkcId: "91010",
        productSn: "SN-91010",
        skcStatus: 11,
        lastSeenAt: now,
        firstSeenAt: now,
      },
      {
        storeId: storeBId,
        productSkcId: "91010",
        productSn: "SN-91010",
        skcStatus: 11,
        lastSeenAt: now,
        firstSeenAt: now,
      },
    ])
    const report = await detectTemuResidualDataAction()
    expect(report.hasResidual).toBe(false)
  })

  it("负例：两店同 skcId 且均冻结 3 天（maxSeen 相等）→ 不判残留（宁漏勿删）", { timeout: 30_000 }, async () => {
    const frozen = new Date(Date.now() - 3 * 86400_000)
    await db.insert(temuProducts).values([
      {
        storeId: storeAId,
        productSkcId: "91011",
        productSn: "SN-91011",
        skcStatus: 11,
        lastSeenAt: frozen,
        firstSeenAt: frozen,
      },
      {
        storeId: storeBId,
        productSkcId: "91011",
        productSn: "SN-91011",
        skcStatus: 11,
        lastSeenAt: frozen,
        firstSeenAt: frozen,
      },
    ])
    const report = await detectTemuResidualDataAction()
    expect(report.hasResidual).toBe(false)
  })

  it("负例：两店各落一行同单号发货单 → clean 后两行均在（官方同主体跨店可见，不清理）", { timeout: 30_000 }, async () => {
    await db.insert(temuShipOrders).values([
      {
        storeId: storeAId,
        deliveryOrderSn: "FH-HEALTH-CROSS",
        skcExtCode: "SN-91010",
        status: 0,
        deliveryOrderCreateTime: new Date(),
        contentHash: "health-cross-a",
        capturedAt: new Date(),
      },
      {
        storeId: storeBId,
        deliveryOrderSn: "FH-HEALTH-CROSS",
        skcExtCode: "SN-91010",
        status: 0,
        deliveryOrderCreateTime: new Date(),
        contentHash: "health-cross-b",
        capturedAt: new Date(),
      },
    ])
    const r = await cleanTemuResidualDataAction()
    expect(r.ok).toBe(true)
    const remain = await db
      .select()
      .from(temuShipOrders)
      .where(eq(temuShipOrders.deliveryOrderSn, "FH-HEALTH-CROSS"))
    expect(remain.length).toBe(2)
    expect(new Set(remain.map((x) => x.storeId)).size).toBe(2)
  })

  it("跨企业隔离：他企业同 skcId 更新鲜行不抬 maxSeen——本企业行不误判、他企业行不被清", { timeout: 30_000 }, async () => {
    // 修复 A1 回归锁：skcId 是平台全局编号，残留判定须限定本企业店集——否则
    // 他企业同 skcId 的更新鲜行会抬高 maxSeen，把本企业正常行误判成冻结残留
    const [otherEnt] = await db
      .insert(enterprises)
      .values({
        name: "temu 店铺体检隔离企业",
        slug: `health-iso-${randomUUID().slice(0, 8)}`,
        creditsBalance: 0,
      })
      .returning()
    try {
      const [otherStore] = await db
        .insert(temuStores)
        .values({ enterpriseId: otherEnt!.id, name: "他企业店铺", tokenState: "active" })
        .returning()
      // 两店同刻冻结（相差 0 < 48h，本企业口径双侧均正常）；他企业行更新鲜
      // （领先 3 天 > 48h）——若未隔离会反向压过本企业 maxSeen
      const localSeen = new Date(Date.now() - 3 * 86400_000)
      await db.insert(temuProducts).values([
        {
          storeId: storeAId,
          productSkcId: "91013",
          productSn: "SN-91013",
          skcStatus: 11,
          lastSeenAt: localSeen,
          firstSeenAt: localSeen,
        },
        {
          storeId: storeBId,
          productSkcId: "91013",
          productSn: "SN-91013",
          skcStatus: 11,
          lastSeenAt: localSeen,
          firstSeenAt: localSeen,
        },
        {
          storeId: otherStore!.id,
          productSkcId: "91013",
          productSn: "SN-91013",
          skcStatus: 11,
          lastSeenAt: new Date(),
          firstSeenAt: new Date(),
        },
      ])
      const report = await detectTemuResidualDataAction()
      expect(report.hasResidual).toBe(false)
      const r = await cleanTemuResidualDataAction()
      expect(r.ok).toBe(true)
      // 本企业两行原样保留（未误判 → 未误删）
      const localRemain = await db
        .select()
        .from(temuProducts)
        .where(
          and(eq(temuProducts.productSkcId, "91013"), inArray(temuProducts.storeId, [storeAId, storeBId])),
        )
      expect(localRemain.length).toBe(2)
      // 他企业行原样保留
      const foreignRemain = await db
        .select()
        .from(temuProducts)
        .where(and(eq(temuProducts.storeId, otherStore!.id), eq(temuProducts.productSkcId, "91013")))
      expect(foreignRemain.length).toBe(1)
    } finally {
      await db.delete(enterprises).where(eq(enterprises.id, otherEnt!.id))
    }
  })
})

describe("normalizeAdRoas 目标 ROAS 万倍口径归一", () => {
  it("120000→12、17100→1.71、实值 14/13.5 原样、null 透传", { timeout: 30_000 }, () => {
    expect(normalizeAdRoas(120000)).toBe(12)
    expect(normalizeAdRoas(17100)).toBe(1.71)
    expect(normalizeAdRoas(14)).toBe(14)
    expect(normalizeAdRoas(13.5)).toBe(13.5)
    expect(normalizeAdRoas(null)).toBeNull()
  })

  it("官方除零哨兵归一后仍巨值 → null（花费 0 行 ROAS 显示「—」而非 500000000000）", { timeout: 30_000 }, () => {
    // 2026-11-18 实测：summary.roas total 维 / netRoas 花费 0 时返回 5e15
    expect(normalizeAdRoas(5e15)).toBeNull()
    expect(normalizeAdRoas(500000000000)).toBeNull()
    // 边界：万倍口径真实值 990 万倍（9900000 → 990）保留
    expect(normalizeAdRoas(9_900_000)).toBe(990)
  })
})
