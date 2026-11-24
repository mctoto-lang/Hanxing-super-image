import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { and, eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { db } from "@/db/client"
import {
  enterprises,
  permissionGroups,
  selectionMonitors,
  selectionReviews,
  selectionTasks,
  users,
} from "@/db/schema"
import {
  encryptSelectionToken,
  resetSelectionTokenCache,
  saveSelectionProvider,
} from "@/lib/selection/provider-config"
import {
  countTaskReviews,
  ingestRedditPostComments,
  ingestSelectionReviews,
  refreshMonitorSnapshot,
} from "@/server/services/selection-service"
import {
  createMonitorRunTasks,
  runDueMonitorsOnce,
} from "@/server/services/selection-monitor-service"
import { createSelectionTask } from "@/server/services/selection-task-service"
import { ingestSelectionResults } from "@/server/services/selection-service"

/**
 * 竞品监控链路集成测试（0106）：调度认领 → 任务创建+计费 → 积分不足自动
 * 暂停 → 评论入库幂等（含 reddit 内嵌评论）→ 监控快照回写。
 * 企业夹具按 TEST_SLUG 隔离，afterAll 级联清理。
 */

const TEST_SLUG = "test-selection-monitor"
let testEnterpriseId: string
let testUserId: string
let brokeUserId: string

async function insertMonitor(overrides: Partial<typeof selectionMonitors.$inferInsert> = {}) {
  const [m] = await db
    .insert(selectionMonitors)
    .values({
      enterpriseId: testEnterpriseId,
      userId: testUserId,
      platform: "amazon",
      targetUrl: `https://www.amazon.com/dp/B0TEST${randomUUID().slice(0, 4)}`,
      externalId: `B0TEST${randomUUID().slice(0, 4)}`,
      title: "测试监控目标",
      country: "US",
      intervalHours: 24,
      trackReviews: true,
      reviewMax: 50,
      status: "active",
      nextRunAt: new Date(Date.now() - 60_000),
      ...overrides,
    })
    .returning()
  return m!
}

beforeAll(async () => {
  const [enterprise] = await db
    .insert(enterprises)
    .values({
      name: "选品监控测试企业",
      slug: TEST_SLUG,
      creditsBalance: 0,
      maxConcurrent: 100,
    })
    .returning()
  testEnterpriseId = enterprise!.id

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
      username: `selmon_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyhashfortestonlyxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: testEnterpriseId,
      groupId: group!.id,
      // 多轮建任务用例（amazon 102/轮、etsy 300/轮）累计扣减，余额给足
      creditsBalance: 5000,
    })
    .returning()
  testUserId = user!.id

  const [broke] = await db
    .insert(users)
    .values({
      username: `selmon_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyhashfortestonlyxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: testEnterpriseId,
      groupId: group!.id,
      creditsBalance: 1,
    })
    .returning()
  brokeUserId = broke!.id

  // 企业凭证（假 token：只验证解析命中 provider，不真正调 Apify）
  await saveSelectionProvider(testEnterpriseId, {
    name: "测试凭证",
    tokenEncrypted: encryptSelectionToken("apify-token-test-only"),
    enabled: true,
  })
  resetSelectionTokenCache()
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

describe("竞品监控调度与计费", () => {
  it("到期认领：runDueMonitorsOnce 创建 monitor+review 双任务并预扣积分", async () => {
    const monitor = await insertMonitor()
    // 传夹具企业过滤：只认领本企业的到期监控，不产生跨租户认领/建任务/扣积分副作用
    const { ran } = await runDueMonitorsOnce({ enterpriseId: testEnterpriseId })
    expect(ran).toBeGreaterThanOrEqual(1)

    const tasks = await db
      .select()
      .from(selectionTasks)
      .where(eq(selectionTasks.monitorId, monitor.id))
    // amazon：monitor（ASIN 直抓，指标 1×2 分）+ review（50×2 分）
    const metricsTask = tasks.find((t) => t.taskType === "monitor")
    const reviewTask = tasks.find((t) => t.taskType === "review")
    expect(metricsTask).toMatchObject({
      platform: "amazon",
      actorId: "junglee/amazon-asins-scraper",
      estimatedCredits: 2,
      status: "queued",
    })
    expect(reviewTask!.searchParams).toMatchObject({ reviewSort: "recent" })
    expect(reviewTask).toMatchObject({
      actorId: "junglee/amazon-reviews-scraper",
      maxResults: 50,
      estimatedCredits: 100,
    })
    expect(reviewTask!.searchParams).toMatchObject({ targetUrl: monitor.targetUrl })

    // 调度时钟推进 + runCount
    const [after] = await db
      .select()
      .from(selectionMonitors)
      .where(eq(selectionMonitors.id, monitor.id))
    expect(after!.runCount).toBe(1)
    expect(after!.lastRunAt).not.toBeNull()
    expect(after!.nextRunAt.getTime()).toBeGreaterThan(Date.now())

    // 二轮不再重复认领本监控（nextRunAt 已推进）：任务数不增加 + runCount 未被再次推进
    await runDueMonitorsOnce({ enterpriseId: testEnterpriseId })
    const tasksAfter = await db
      .select({ id: selectionTasks.id })
      .from(selectionTasks)
      .where(eq(selectionTasks.monitorId, monitor.id))
    expect(tasksAfter).toHaveLength(2)
    const [afterAgain] = await db
      .select({ runCount: selectionMonitors.runCount })
      .from(selectionMonitors)
      .where(eq(selectionMonitors.id, monitor.id))
    expect(afterAgain!.runCount).toBe(1)
  })

  it("积分不足：自动暂停 + 不创建任务", async () => {
    const monitor = await insertMonitor({ userId: brokeUserId })
    const outcome = await createMonitorRunTasks(monitor.id)
    expect(outcome).toBe("paused")
    const [after] = await db
      .select()
      .from(selectionMonitors)
      .where(eq(selectionMonitors.id, monitor.id))
    expect(after!.status).toBe("paused")
    expect(after!.pauseReason).toContain("积分不足")
    const tasks = await db
      .select({ id: selectionTasks.id })
      .from(selectionTasks)
      .where(eq(selectionTasks.monitorId, monitor.id))
    expect(tasks).toHaveLength(0)
  })

  it("Etsy 仅评论追踪：无 metrics 任务，仅 review 任务", async () => {
    const monitor = await insertMonitor({
      platform: "etsy",
      targetUrl: "https://www.etsy.com/listing/123456",
    })
    const outcome = await createMonitorRunTasks(monitor.id)
    expect(outcome).toBe("ran")
    const tasks = await db
      .select()
      .from(selectionTasks)
      .where(eq(selectionTasks.monitorId, monitor.id))
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      taskType: "review",
      actorId: "khadinakbar/etsy-reviews-scraper",
    })
  })

  it("reddit 单任务带回评论：无独立 review 任务", async () => {
    const monitor = await insertMonitor({
      platform: "reddit",
      targetUrl: "https://www.reddit.com/r/test/comments/abc123/x/",
    })
    await createMonitorRunTasks(monitor.id)
    const tasks = await db
      .select()
      .from(selectionTasks)
      .where(eq(selectionTasks.monitorId, monitor.id))
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.taskType).toBe("monitor")
    expect(tasks[0]!.searchParams).toMatchObject({ reviewMax: 50 })
  })

  it("在途检查：已有 queued/processing 任务时不重复建任务（连点/调度撞车兜底）", async () => {
    const monitor = await insertMonitor()
    expect(await createMonitorRunTasks(monitor.id)).toBe("ran")
    const afterFirst = await db
      .select({ id: selectionTasks.id })
      .from(selectionTasks)
      .where(eq(selectionTasks.monitorId, monitor.id))
    expect(afterFirst).toHaveLength(2)
    // 首轮任务仍排队中：再次触发（连点「添加监控/立即抓取」、调度撞车）必须跳过，
    // 否则会再建一套任务并再扣一轮积分
    expect(await createMonitorRunTasks(monitor.id)).toBe("skipped")
    const afterSecond = await db
      .select({ id: selectionTasks.id })
      .from(selectionTasks)
      .where(eq(selectionTasks.monitorId, monitor.id))
    expect(afterSecond).toHaveLength(2)
  })

  it("入参解析失败（确定性错误）：立即暂停并写明原因，不再每轮静默丢一轮", async () => {
    const monitor = await insertMonitor({
      externalId: null,
      targetUrl: "https://www.amazon.com/gp/some-non-product-page",
    })
    expect(await createMonitorRunTasks(monitor.id)).toBe("paused")
    const [after] = await db
      .select()
      .from(selectionMonitors)
      .where(eq(selectionMonitors.id, monitor.id))
    expect(after!.status).toBe("paused")
    expect(after!.pauseReason).toContain("ASIN")
    const tasks = await db
      .select({ id: selectionTasks.id })
      .from(selectionTasks)
      .where(eq(selectionTasks.monitorId, monitor.id))
    expect(tasks).toHaveLength(0)
  })

  it("调度企业过滤：只认领传入企业的到期监控（不跨租户建任务扣积分）", async () => {
    const [other] = await db
      .insert(enterprises)
      .values({
        name: "选品监控测试企业B",
        slug: `${TEST_SLUG}-b-${randomUUID().slice(0, 6)}`,
        creditsBalance: 0,
        maxConcurrent: 100,
      })
      .returning()
    const otherId = other!.id
    const [m] = await db
      .insert(selectionMonitors)
      .values({
        enterpriseId: otherId,
        userId: testUserId,
        platform: "amazon",
        targetUrl: `https://www.amazon.com/dp/B0OTHER${randomUUID().slice(0, 3)}`,
        externalId: `B0OTHER${randomUUID().slice(0, 3)}`,
        title: "其他企业到期监控",
        country: "US",
        intervalHours: 24,
        trackReviews: false,
        reviewMax: 50,
        status: "active",
        // 排在最前（一年前到期）：若企业过滤失效，本轮必先认领它
        nextRunAt: new Date(Date.now() - 365 * 24 * 3600_000),
      })
      .returning()
    try {
      // 本企业内其他用例留下的到期监控也可能被本轮认领（有在途任务会被跳过），
      // ran 数量不在此断言——只断言其他企业的监控未被认领、未建任务
      await runDueMonitorsOnce({ enterpriseId: testEnterpriseId })
      const [after] = await db
        .select({ runCount: selectionMonitors.runCount })
        .from(selectionMonitors)
        .where(eq(selectionMonitors.id, m!.id))
      expect(after!.runCount).toBe(0)
      const tasks = await db
        .select({ id: selectionTasks.id })
        .from(selectionTasks)
        .where(eq(selectionTasks.monitorId, m!.id))
      expect(tasks).toHaveLength(0)
    } finally {
      await db.delete(selectionMonitors).where(eq(selectionMonitors.id, m!.id))
      await db.delete(enterprises).where(eq(enterprises.id, otherId))
    }
  })

  it("日限只数手动任务 + 配额不足返回可读错误", async () => {
    // 塞满当日 30 条监控自动任务（monitor/review 不应占用手动任务每日额度）
    await db.insert(selectionTasks).values(
      Array.from({ length: 30 }, (_, i) => ({
        enterpriseId: testEnterpriseId,
        userId: brokeUserId,
        taskType: "monitor" as const,
        platform: "amazon",
        actorId: "junglee/amazon-asins-scraper",
        searchParams: {},
        keyword: `自动任务占位${i}`,
        maxResults: 1,
        estimatedCredits: 1,
        status: "completed" as const,
      })),
    )
    // broke 用户余额 1 分 < 预估 2 分：若日限把自动任务算进来会先报「今日任务数
    // 已上限」；修复后应放行到扣费环节并返回可读的「个人配额不足」
    const res = await createSelectionTask({
      userId: brokeUserId,
      enterpriseId: testEnterpriseId,
      platform: "amazon",
      taskType: "market",
      params: { keyword: "phone case" },
      maxResults: 1,
      label: "Amazon",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain("个人配额不足")
      expect(res.error).not.toContain("今日任务数已达上限")
    }
  })
})

describe("评论入库与监控快照", () => {
  it("评论入库幂等 + reddit 内嵌评论抽取", async () => {
    const [task] = await db
      .insert(selectionTasks)
      .values({
        enterpriseId: testEnterpriseId,
        userId: testUserId,
        taskType: "review",
        platform: "amazon",
        actorId: "junglee/amazon-reviews-scraper",
        searchParams: { targetUrl: "https://www.amazon.com/dp/B0X" },
        keyword: "评论抓取",
        maxResults: 50,
        estimatedCredits: 100,
        status: "processing",
        startedAt: new Date(),
      })
      .returning()
    const ref = {
      id: task!.id,
      enterpriseId: testEnterpriseId,
      platform: "amazon",
      taskType: "review" as const,
      country: "US",
      monitorId: null,
      targetTitle: "目标商品",
      targetUrl: "https://www.amazon.com/dp/B0X",
    }
    const rows = [
      { id: "R1", rating: 5, text: "Great product!", userName: "Alice", verified: true, date: "2026-11-01" },
      { id: "R2", rating: 2, text: "Broke after a week", name: "Bob", helpfulVotes: 3 },
    ]
    expect(await ingestSelectionReviews(ref, rows)).toBe(2)
    expect(await ingestSelectionReviews(ref, rows)).toBe(0)
    expect(await countTaskReviews(task!.id)).toBe(2)
    const [r1] = await db
      .select()
      .from(selectionReviews)
      .where(and(eq(selectionReviews.taskId, task!.id), eq(selectionReviews.externalId, "R1")))
    expect(r1).toMatchObject({
      authorName: "Alice",
      rating: "5.00",
      content: "Great product!",
      verified: true,
      targetTitle: "目标商品",
    })

    // reddit：帖子行内嵌 comments + replies 一层展开
    const [rt] = await db
      .insert(selectionTasks)
      .values({
        enterpriseId: testEnterpriseId,
        userId: testUserId,
        taskType: "monitor",
        platform: "reddit",
        actorId: "automation-lab/reddit-scraper",
        searchParams: { targetUrl: "https://www.reddit.com/r/t/1/x/" },
        keyword: "监控重抓",
        maxResults: 1,
        estimatedCredits: 2,
        status: "processing",
        startedAt: new Date(),
      })
      .returning()
    const inserted = await ingestRedditPostComments(
      {
        id: rt!.id,
        enterpriseId: testEnterpriseId,
        platform: "reddit",
        taskType: "monitor" as const,
        country: null,
        monitorId: null,
      },
      [
        {
          id: "post1",
          title: "帖子",
          comments: [
            { id: "c1", body: "评论一", author: "u1", score: 5 },
            { id: "c2", body: "评论二", author: "u2", score: 1, replies: [{ id: "c2r1", body: "回复", author: "u3" }] },
          ],
        },
      ],
    )
    expect(inserted).toBe(3)
  })

  it("监控快照回写：按 externalId 命中目标行", async () => {
    const monitor = await insertMonitor({ trackReviews: false })
    const [task] = await db
      .insert(selectionTasks)
      .values({
        enterpriseId: testEnterpriseId,
        userId: testUserId,
        taskType: "monitor",
        platform: "amazon",
        actorId: "curious_coder/amazon-scraper",
        searchParams: { targetUrl: monitor.targetUrl },
        keyword: "监控重抓",
        maxResults: 1,
        estimatedCredits: 2,
        status: "processing",
        startedAt: new Date(),
        monitorId: monitor.id,
      })
      .returning()
    await ingestSelectionResults(
      {
        id: task!.id,
        enterpriseId: testEnterpriseId,
        platform: "amazon",
        taskType: "monitor" as const,
        country: "US",
      },
      [
        {
          asin: monitor.externalId,
          title: "目标商品改版标题",
          priceAmount: 25.5,
          priceCurrency: "USD",
          stars: 4.6,
          ratingsCount: 321,
          link: monitor.targetUrl,
        },
      ],
    )
    await refreshMonitorSnapshot(monitor.id, task!.id)
    const [after] = await db
      .select()
      .from(selectionMonitors)
      .where(eq(selectionMonitors.id, monitor.id))
    expect(after!.lastPrice).toBe("25.50")
    expect(after!.lastRating).toBe("4.60")
    expect(after!.lastReviewCount).toBe(321)
    expect(after!.title).toBe("测试监控目标")
  })
})
