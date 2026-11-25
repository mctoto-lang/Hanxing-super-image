import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { eq, type SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { randomUUID } from "node:crypto"
import { db } from "@/db/client"
import {
  enterprises,
  permissionGroups,
  selectionMonitors,
  selectionResults,
  selectionReviews,
  selectionTasks,
  users,
} from "@/db/schema"
import { resolveMonitorTarget } from "@/lib/selection/monitor-target"
import {
  getResultReviewsAction,
  getSelectionMonitorTrendAction,
  getSelectionReviewsAction,
} from "@/server/actions/selection-monitor"
import { getSelectionResultsPoolAction } from "@/server/actions/selection"

/**
 * 选品数据池与评论读取修复回归集成测试（真实本地 PG）：
 * R-9-2  数据池分页：同批 createdAt 完全相同的结果行翻页不重不漏（id 兜底键）
 * R-10-3 评论读取双形态：结果行原始链接 ↔ 评论规范化 target_url 仍能命中
 * R-10-4 读取侧去重：跨任务同 dedupe_key 只留最新一条
 * R-10-9 监控趋势：倒序取最新 200 点再反转（超 200 次重抓后最新数据仍进趋势）
 * R-13-3 评论日期按北京日界（UTC 0~8 点归入北京时间当天）
 * 登录态经 mock auth() 注入夹具用户；revalidatePath mock 为空操作。
 * 企业夹具按 TEST_SLUG 隔离，afterAll 级联清理。
 */
const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

const TEST_SLUG = "test-selection-pool-reviews"
let testEnterpriseId: string
let viewerUserId: string

async function insertMonitor(overrides: Partial<typeof selectionMonitors.$inferInsert> = {}) {
  const [m] = await db
    .insert(selectionMonitors)
    .values({
      enterpriseId: testEnterpriseId,
      userId: viewerUserId,
      platform: "amazon",
      targetUrl: `https://www.amazon.com/dp/B0TEST${randomUUID().slice(0, 4)}`,
      externalId: `B0TEST${randomUUID().slice(0, 4)}`,
      title: "测试监控目标",
      country: "US",
      intervalHours: 24,
      trackReviews: false,
      reviewMax: 50,
      status: "active",
      nextRunAt: new Date(Date.now() + 3600_000),
      ...overrides,
    })
    .returning()
  return m!
}

/** 任务夹具：默认 temu review 行（仅作结果/评论行的归属载体），按 overrides 覆盖 */
async function insertTask(overrides: Partial<typeof selectionTasks.$inferInsert> = {}) {
  const [t] = await db
    .insert(selectionTasks)
    .values({
      enterpriseId: testEnterpriseId,
      userId: viewerUserId,
      taskType: "review",
      platform: "temu",
      actorId: "hypebridge/temu-scraper",
      searchParams: { targetUrl: "https://www.temu.com/goods.html?goods_id=1" },
      keyword: "夹具任务",
      maxResults: 1,
      estimatedCredits: 2,
      status: "completed",
      ...overrides,
    })
    .returning()
  return t!
}

/** 结果行夹具：taskId 必传，平台默认 amazon，dedupeKey/rawData 给占位 */
async function insertResult(
  overrides: Partial<typeof selectionResults.$inferInsert> & { taskId: string },
) {
  const [r] = await db
    .insert(selectionResults)
    .values({
      enterpriseId: testEnterpriseId,
      platform: "amazon",
      taskType: "monitor",
      externalId: `B0${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      dedupeKey: `rk-${randomUUID().slice(0, 8)}`,
      sourceUrl: `https://www.amazon.com/dp/B0${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      title: "测试结果行",
      rawData: {},
      ...overrides,
    })
    .returning()
  return r!
}

/** 评论行夹具：taskId 必传，dedupeKey/rawData 给占位，按 overrides 覆盖 */
async function insertReview(
  overrides: Partial<typeof selectionReviews.$inferInsert> & { taskId: string },
) {
  const [r] = await db
    .insert(selectionReviews)
    .values({
      enterpriseId: testEnterpriseId,
      platform: "amazon",
      dedupeKey: `rv-${randomUUID().slice(0, 8)}`,
      authorName: "测试评论人",
      content: "测试评论内容",
      rawData: {},
      ...overrides,
    })
    .returning()
  return r!
}

beforeAll(async () => {
  const [enterprise] = await db
    .insert(enterprises)
    .values({
      name: "选品数据池测试企业",
      slug: TEST_SLUG,
      creditsBalance: 0,
      maxConcurrent: 100,
    })
    .returning()
  testEnterpriseId = enterprise!.id

  // allowedPages 缺省为空 = 放行企业全部已开通模块（enabledModules 默认含 selection）
  const [group] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: testEnterpriseId,
      name: "测试组",
      isDefault: true,
      maxConcurrent: 100,
    })
    .returning()

  const [user] = await db
    .insert(users)
    .values({
      username: `selpool_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyhashfortestonlyxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: testEnterpriseId,
      groupId: group!.id,
      creditsBalance: 0,
    })
    .returning()
  viewerUserId = user!.id

  // 本文件只测读取链路：不需要抓取凭证，所有用例先注入登录态
  mockSession.userId = viewerUserId
})

afterAll(async () => {
  if (testEnterpriseId) {
    await db.delete(users).where(eq(users.enterpriseId, testEnterpriseId))
    await db
      .delete(permissionGroups)
      .where(eq(permissionGroups.enterpriseId, testEnterpriseId))
    await db.delete(enterprises).where(eq(enterprises.id, testEnterpriseId))
  }
})

describe("数据池翻页稳定（R-9-2）", () => {
  it(
    "同一任务 5 行 createdAt 完全相同：翻 3 页不重不漏并集正好 5 个",
    { timeout: 30_000 },
    async () => {
      const task = await insertTask({
        platform: "temu",
        taskType: "market",
        status: "completed",
        fetchedCount: 5,
      })
      // 整批入库的行 createdAt/scraped_at 完全相同：无 id 兜底键时每页排序不稳定
      const sameTime = new Date("2026-05-01T00:00:00Z")
      const rows = await db
        .insert(selectionResults)
        .values(
          Array.from({ length: 5 }, (_, i) => ({
            taskId: task.id,
            enterpriseId: testEnterpriseId,
            platform: "temu",
            taskType: "market",
            externalId: `pool-${i}`,
            dedupeKey: `pool-${i}`,
            title: `翻页夹具${i}`,
            rawData: {},
            createdAt: sameTime,
            scrapedAt: sameTime,
          })),
        )
        .returning({ id: selectionResults.id })
      const expectedIds = rows.map((r) => r.id).sort()

      // 行为断言之外再锁结构：并列排序的抖动取决于数据量与执行计划（小数据集下没有兜底键
      // 的旧代码也可能碰巧不重不漏），所以同时拦下每页实际执行的 SQL，断言排序以唯一键收尾
      const executed: string[] = []
      const runExecute = db.execute.bind(db) as (...args: unknown[]) => unknown
      const spy = vi
        .spyOn(db, "execute")
        .mockImplementation(((query: unknown, ...rest: unknown[]) => {
          const text = new PgDialect().sqlToQuery(query as SQL).sql
          if (/\border by\b/i.test(text)) executed.push(text)
          return runExecute(query, ...rest)
        }) as typeof db.execute)

      const seen: string[] = []
      try {
        for (const page of [1, 2, 3]) {
          const res = await getSelectionResultsPoolAction({
            platform: "temu",
            taskId: task.id,
            pageSize: 2,
            page,
          })
          expect(res.ok).toBe(true)
          if (!res.ok) return
          expect(res.total).toBe(5)
          seen.push(...res.items.map((i) => i.id))
        }
      } finally {
        spy.mockRestore()
      }
      // 无重复、并集正好 5 个
      expect(new Set(seen).size).toBe(5)
      expect(seen.sort()).toEqual(expectedIds)
      // 三页三条查询，排序都以 t.id 兜底（同 created_at 的行在任何分页下顺序确定）
      expect(executed).toHaveLength(3)
      for (const text of executed) {
        const orderBy = /order by([\s\S]*?)\blimit\b/i.exec(text)?.[1] ?? ""
        expect(orderBy.trim().replace(/\s+/g, " ")).toMatch(/, t\.id$/)
      }
    },
  )
})

describe("评论读取双形态与去重（R-10-3 / R-10-4）", () => {
  it("结果行原始链接（带 slug+追踪参数）能命中规范化 target_url 的评论（R-10-3）", async () => {
    // 夹具链接形态照 selection-monitor-target 单测：原始链接带 slug 与追踪参数
    const rawUrl =
      "https://www.etsy.com/listing/1255225544/handmade-necklace?ref=share&tracking=param"
    const resolved = resolveMonitorTarget(rawUrl)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const canonical = resolved.target.url

    const task = await insertTask({ platform: "etsy" })
    const result = await insertResult({
      taskId: task.id,
      platform: "etsy",
      sourceUrl: rawUrl,
      externalId: "1255225544",
    })
    // 监控/评论任务落库的是规范化链接（监控 target_url 与结果行 sourceUrl 不同形）
    await insertReview({
      taskId: task.id,
      platform: "etsy",
      targetUrl: canonical,
      authorName: "规范链接评论",
      content: "双形态命中",
    })

    const res = await getResultReviewsAction(result.id)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.total).toBe(1)
    expect(res.items).toHaveLength(1)
    const hit = res.items[0]!
    expect(hit.authorName).toBe("规范链接评论")
    expect("targetUrl" in hit ? hit.targetUrl : null).toBe(canonical)
  })

  it("跨任务同 dedupeKey 评论读取侧去重：total 为 1 且只留最新一条（R-10-4）", async () => {
    const rawUrl =
      "https://old.reddit.com/r/BuyItForLife/comments/1xdlvjo/what_is_the_best/?sort=top"
    const resolved = resolveMonitorTarget(rawUrl)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const canonical = resolved.target.url

    const task1 = await insertTask({ platform: "reddit" })
    const task2 = await insertTask({ platform: "reddit" })
    const result = await insertResult({
      taskId: task1.id,
      platform: "reddit",
      sourceUrl: rawUrl,
      externalId: "1xdlvjo",
    })
    // 两个任务各存一份同一评论（同 dedupeKey 同 targetUrl，入库时间一早一晚）
    const dupKey = `dup-${randomUUID().slice(0, 8)}`
    await insertReview({
      taskId: task1.id,
      platform: "reddit",
      targetUrl: canonical,
      dedupeKey: dupKey,
      authorName: "旧一轮抓取",
      scrapedAt: new Date("2026-11-20T10:00:00Z"),
    })
    const newer = await insertReview({
      taskId: task2.id,
      platform: "reddit",
      targetUrl: canonical,
      dedupeKey: dupKey,
      authorName: "新一轮抓取",
      scrapedAt: new Date("2026-11-20T12:00:00Z"),
    })

    const byResult = await getResultReviewsAction(result.id)
    expect(byResult.ok).toBe(true)
    if (!byResult.ok) return
    expect(byResult.total).toBe(1)
    expect(byResult.items).toHaveLength(1)
    expect(byResult.items[0]!.id).toBe(newer.id)
    expect(byResult.items[0]!.authorName).toBe("新一轮抓取")

    const byPlatform = await getSelectionReviewsAction({ platform: "reddit" })
    expect(byPlatform.ok).toBe(true)
    if (!byPlatform.ok) return
    expect(byPlatform.total).toBe(1)
    expect(byPlatform.items[0]!.id).toBe(newer.id)
  })
})

describe("监控趋势取最新 200 点（R-10-9）", () => {
  it(
    "205 个 scraped_at 递增的结果行：恰好 200 点、升序、末点最新",
    { timeout: 30_000 },
    async () => {
      const monitor = await insertMonitor()
      const task = await insertTask({
        taskType: "monitor",
        platform: "amazon",
        actorId: "junglee/amazon-asins-scraper",
        monitorId: monitor.id,
        status: "completed",
        fetchedCount: 1,
      })
      const base = new Date("2026-01-01T00:00:00Z").getTime()
      await db.insert(selectionResults).values(
        Array.from({ length: 205 }, (_, i) => ({
          taskId: task.id,
          enterpriseId: testEnterpriseId,
          platform: "amazon",
          taskType: "monitor",
          externalId: `B0TREND${String(i).padStart(3, "0")}`,
          dedupeKey: `trend-${i}`,
          price: String(10 + i),
          rawData: {},
          scrapedAt: new Date(base + i * 60_000),
        })),
      )

      const res = await getSelectionMonitorTrendAction(monitor.id)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      // 倒序 limit 200 再反转：超过 200 次重抓后最新数据仍进趋势
      expect(res.points).toHaveLength(200)
      const times = res.points.map((p) => new Date(p.date).getTime())
      for (let i = 1; i < times.length; i++) {
        expect(times[i]!).toBeGreaterThan(times[i - 1]!)
      }
      // 首点是第 6 早的样本（最旧 5 个被截掉），末点是最新那条
      expect(times[0]).toBe(base + 5 * 60_000)
      expect(times[times.length - 1]).toBe(base + 204 * 60_000)
    },
  )
})

describe("评论日期按北京日界（R-13-3）", () => {
  it("UTC 傍晚（北京已是次日）的评论归入北京日期：按前一天（UTC 口径）查不到", async () => {
    const task = await insertTask({ platform: "temu" })
    // 北京时间 2026-11-24 01:00；按 UTC 日界会被算到 11-23
    const eveningUtc = await insertReview({
      taskId: task.id,
      platform: "temu",
      scrapedAt: new Date("2026-11-23T17:00:00Z"),
      authorName: "北京次日凌晨的评论",
    })
    // 北京时间 2026-11-24 09:30（两种日界下都在 11-24）
    const morningUtc = await insertReview({
      taskId: task.id,
      platform: "temu",
      scrapedAt: new Date("2026-11-24T01:30:00Z"),
      authorName: "北京当日上午的评论",
    })

    const sameDay = await getSelectionReviewsAction({
      platform: "temu",
      dateFrom: "2026-11-24",
      dateTo: "2026-11-24",
    })
    expect(sameDay.ok).toBe(true)
    if (!sameDay.ok) return
    expect(sameDay.total).toBe(2)
    expect(sameDay.items.map((r) => r.id).sort()).toEqual([eveningUtc.id, morningUtc.id].sort())

    // 按 UTC 日界时傍晚那条会落在 11-23：北京日界下前一天一条都没有
    const prevDay = await getSelectionReviewsAction({
      platform: "temu",
      dateFrom: "2026-11-23",
      dateTo: "2026-11-23",
    })
    expect(prevDay.ok).toBe(true)
    if (!prevDay.ok) return
    expect(prevDay.total).toBe(0)
    expect(prevDay.items).toHaveLength(0)
  })
})
