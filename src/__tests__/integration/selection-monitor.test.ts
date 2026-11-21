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
      creditsBalance: 500,
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
    const { ran } = await runDueMonitorsOnce()
    expect(ran).toBeGreaterThanOrEqual(1)

    const tasks = await db
      .select()
      .from(selectionTasks)
      .where(eq(selectionTasks.monitorId, monitor.id))
    // amazon：monitor（指标 1×2 分）+ review（50×2 分）
    const metricsTask = tasks.find((t) => t.taskType === "monitor")
    const reviewTask = tasks.find((t) => t.taskType === "review")
    expect(metricsTask).toMatchObject({
      platform: "amazon",
      actorId: "curious_coder/amazon-scraper",
      estimatedCredits: 2,
      status: "queued",
    })
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

    // 二轮不再重复认领本监控（nextRunAt 已推进）。runDueMonitorsOnce 全库扫，
    // ran 总数受库内其他企业到期监控影响不可断言——改按本监控维度判定：
    // 任务数不增加 + runCount 未被再次推进
    await runDueMonitorsOnce()
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
