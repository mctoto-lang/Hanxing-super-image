import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { and, eq, inArray, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import ExcelJS from "exceljs"
import { db } from "@/db/client"
import {
  creditTransactions,
  enterprises,
  permissionGroups,
  selectionBookmarks,
  selectionMonitors,
  selectionResults,
  selectionTasks,
  users,
} from "@/db/schema"
import {
  encryptSelectionToken,
  resetSelectionTokenCache,
  saveSelectionProvider,
} from "@/lib/selection/provider-config"
import { createMonitorRunTasks } from "@/server/services/selection-monitor-service"
import {
  exportSelectionBookmarksExcelAction,
  getSelectionPoolMetaAction,
  retrySelectionTaskAction,
} from "@/server/actions/selection"
import {
  removeSelectionMonitorAction,
  scrapeResultReviewsAction,
  updateSelectionMonitorAction,
} from "@/server/actions/selection-monitor"

/**
 * 选品服务端修复回归集成测试（真实本地 PG）：
 * R-10-2 监控操作权限：非发起人普通成员改/停/删被拒，发起人与企业管理员放行；
 *        无指标重抓平台（etsy）关闭评论追踪被拒
 * R-10-6 暂停/删除监控：queued 任务全部取消并按预扣额全额退款，余额复原
 * R-10-8 一次性抓评论并发：advisory 锁串行化，只建一个任务只扣一次费
 * R-15-1 monitor/review 失败任务不可一键重试，market 可重试
 * R-9-4  来源任务下拉只列会写入数据池的 discover/market 完成任务
 * R-9-7  收藏导出带筛选（按平台），不筛导出全部
 * 登录态经 mock auth() 注入夹具用户；revalidatePath mock 为空操作。
 * 企业夹具按 TEST_SLUG 隔离，afterAll 级联清理。
 */
const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

const TEST_SLUG = "test-selection-actions"
let testEnterpriseId: string
/** 监控/任务发起人（普通成员角色，重抓费用从其个人配额扣） */
let initUserId: string
/** 企业管理员角色用户 */
let adminUserId: string
/** 非发起人普通成员（权限拒绝用例用） */
let memberUserId: string

async function insertMonitor(overrides: Partial<typeof selectionMonitors.$inferInsert> = {}) {
  const [m] = await db
    .insert(selectionMonitors)
    .values({
      enterpriseId: testEnterpriseId,
      userId: initUserId,
      platform: "amazon",
      targetUrl: `https://www.amazon.com/dp/B0TEST${randomUUID().slice(0, 4)}`,
      externalId: `B0TEST${randomUUID().slice(0, 4)}`,
      title: "测试监控目标",
      country: "US",
      intervalHours: 24,
      trackReviews: true,
      reviewMax: 50,
      status: "active",
      nextRunAt: new Date(Date.now() + 3600_000),
      ...overrides,
    })
    .returning()
  return m!
}

/** 任务夹具：默认 temu market 失败行，按 overrides 覆盖 */
async function insertTask(overrides: Partial<typeof selectionTasks.$inferInsert> = {}) {
  const [t] = await db
    .insert(selectionTasks)
    .values({
      enterpriseId: testEnterpriseId,
      userId: initUserId,
      taskType: "market",
      platform: "temu",
      actorId: "crw/temu-products-scraper",
      searchParams: { keyword: "phone case", sort: "relevance" },
      keyword: "夹具任务",
      country: "US",
      maxResults: 1,
      estimatedCredits: 2,
      status: "failed",
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
      taskType: "market",
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

/** 把 action 返回的 base64 工作簿读回来（ExcelJS 类型声明里的 Buffer 与当前 @types/node 不同源，经其自身签名收窄） */
async function loadWorkbook(base64: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(base64, "base64") as unknown as Parameters<typeof wb.xlsx.load>[0])
  return wb
}

/** 读成员个人配额余额（退款/预扣断言用） */
async function balanceOf(userId: string): Promise<number> {
  const [u] = await db
    .select({ balance: users.creditsBalance })
    .from(users)
    .where(eq(users.id, userId))
  return u!.balance
}

beforeAll(async () => {
  const [enterprise] = await db
    .insert(enterprises)
    .values({
      name: "选品 action 测试企业",
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

  const mkUser = (role: "member" | "admin", credits: number) =>
    db
      .insert(users)
      .values({
        username: `selact_${randomUUID().slice(0, 8)}`,
        passwordHash: "$2a$10$dummyhashfortestonlyxxxxxxxxxxxxxxxxxxxxxx",
        enterpriseId: testEnterpriseId,
        groupId: group!.id,
        enterpriseRole: role,
        creditsBalance: credits,
      })
      .returning()
  const [init] = await mkUser("member", 5000)
  const [admin] = await mkUser("admin", 5000)
  const [member] = await mkUser("member", 5000)
  initUserId = init!.id
  adminUserId = admin!.id
  memberUserId = member!.id

  // 企业凭证（假 token：只验证解析命中 provider，不真正调 Apify；任务停在 queued）
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

describe("监控操作权限（R-10-2）", () => {
  it(
    "非发起人普通成员改周期/暂停/删除被拒且监控行不动；发起人与企业管理员放行",
    { timeout: 30_000 },
    async () => {
      const monitor = await insertMonitor()
      const monitorB = await insertMonitor({ title: "管理员删除目标" })
      const monitorC = await insertMonitor({ title: "发起人删除目标" })

      // ── 普通成员（非发起人）三种操作全部拒绝 ──
      mockSession.userId = memberUserId
      const denyInterval = await updateSelectionMonitorAction({
        id: monitor.id,
        intervalHours: 48,
      })
      expect(denyInterval.ok).toBe(false)
      if (!denyInterval.ok) {
        expect(denyInterval.error).toContain("仅监控发起人或企业管理员可修改监控")
      }
      const denyPause = await updateSelectionMonitorAction({
        id: monitor.id,
        status: "paused",
      })
      expect(denyPause.ok).toBe(false)
      if (!denyPause.ok) {
        expect(denyPause.error).toContain("仅监控发起人或企业管理员可修改监控")
      }
      const denyRemove = await removeSelectionMonitorAction(monitor.id)
      expect(denyRemove.ok).toBe(false)
      if (!denyRemove.ok) {
        expect(denyRemove.error).toContain("仅监控发起人或企业管理员可删除监控")
      }
      // 三次被拒后监控行原样（周期未改、仍是 active、行还在）
      const [afterDeny] = await db
        .select()
        .from(selectionMonitors)
        .where(eq(selectionMonitors.id, monitor.id))
      expect(afterDeny!.intervalHours).toBe(24)
      expect(afterDeny!.status).toBe("active")

      // ── 发起人本人与企业管理员修改放行 ──
      mockSession.userId = initUserId
      const selfUpdate = await updateSelectionMonitorAction({
        id: monitor.id,
        intervalHours: 48,
      })
      expect(selfUpdate.ok).toBe(true)
      const [afterSelf] = await db
        .select({ intervalHours: selectionMonitors.intervalHours })
        .from(selectionMonitors)
        .where(eq(selectionMonitors.id, monitor.id))
      expect(afterSelf!.intervalHours).toBe(48)

      mockSession.userId = adminUserId
      const adminUpdate = await updateSelectionMonitorAction({
        id: monitor.id,
        intervalHours: 72,
        status: "paused",
      })
      expect(adminUpdate.ok).toBe(true)
      const [afterAdmin] = await db
        .select()
        .from(selectionMonitors)
        .where(eq(selectionMonitors.id, monitor.id))
      expect(afterAdmin!.intervalHours).toBe(72)
      expect(afterAdmin!.status).toBe("paused")
      // 发起人可恢复自己被管理员暂停的监控
      mockSession.userId = initUserId
      const resume = await updateSelectionMonitorAction({
        id: monitor.id,
        status: "active",
      })
      expect(resume.ok).toBe(true)
      const [afterResume] = await db
        .select({ status: selectionMonitors.status, pauseReason: selectionMonitors.pauseReason })
        .from(selectionMonitors)
        .where(eq(selectionMonitors.id, monitor.id))
      expect(afterResume!.status).toBe("active")
      expect(afterResume!.pauseReason).toBeNull()

      // ── 删除：企业管理员与发起人都放行 ──
      mockSession.userId = adminUserId
      expect((await removeSelectionMonitorAction(monitorB.id)).ok).toBe(true)
      const bGone = await db
        .select({ id: selectionMonitors.id })
        .from(selectionMonitors)
        .where(eq(selectionMonitors.id, monitorB.id))
      expect(bGone).toHaveLength(0)
      mockSession.userId = initUserId
      expect((await removeSelectionMonitorAction(monitorC.id)).ok).toBe(true)
      const cGone = await db
        .select({ id: selectionMonitors.id })
        .from(selectionMonitors)
        .where(eq(selectionMonitors.id, monitorC.id))
      expect(cGone).toHaveLength(0)
    },
  )

  it("etsy 无指标重抓能力：关闭评论追踪被拒且开关未被改动", async () => {
    const monitor = await insertMonitor({
      platform: "etsy",
      targetUrl: "https://www.etsy.com/listing/123456",
    })
    mockSession.userId = initUserId
    const deny = await updateSelectionMonitorAction({
      id: monitor.id,
      trackReviews: false,
    })
    expect(deny.ok).toBe(false)
    if (!deny.ok) {
      expect(deny.error).toContain("该平台无指标重抓能力")
    }
    const [after] = await db
      .select({ trackReviews: selectionMonitors.trackReviews })
      .from(selectionMonitors)
      .where(eq(selectionMonitors.id, monitor.id))
    expect(after!.trackReviews).toBe(true)
  })
})

describe("取消排队任务并退款（R-10-6）", () => {
  it(
    "暂停监控：queued 任务全部 cancelled，退款等于预扣额，余额复原",
    { timeout: 30_000 },
    async () => {
      const monitor = await insertMonitor()
      const before = await balanceOf(initUserId)
      // 建排队任务并预扣积分（amazon：monitor 1×2 + review 50×2 = 102）
      expect(await createMonitorRunTasks(monitor.id)).toBe("ran")
      const tasks = await db
        .select()
        .from(selectionTasks)
        .where(eq(selectionTasks.monitorId, monitor.id))
      expect(tasks).toHaveLength(2)
      expect(tasks.map((t) => t.status)).toEqual(["queued", "queued"])
      const preDeduct = tasks.reduce((s, t) => s + t.estimatedCredits, 0)
      expect(preDeduct).toBe(102)
      expect(await balanceOf(initUserId)).toBe(before - preDeduct)

      mockSession.userId = initUserId
      const res = await updateSelectionMonitorAction({ id: monitor.id, status: "paused" })
      expect(res.ok).toBe(true)

      // 排队任务全部被取消并按 0 条结算（actualCredits = 0）
      const after = await db
        .select()
        .from(selectionTasks)
        .where(eq(selectionTasks.monitorId, monitor.id))
      expect(after.map((t) => t.status)).toEqual(["cancelled", "cancelled"])
      for (const t of after) expect(t.actualCredits).toBe(0)

      // 每个任务一条 selection_refund 流水，金额等于该任务预扣额
      const refunds = await db
        .select()
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.enterpriseId, testEnterpriseId),
            eq(creditTransactions.type, "selection_refund"),
            inArray(creditTransactions.taskId, after.map((t) => t.id)),
          ),
        )
      expect(refunds.map((r) => r.amount).sort((a, b) => a - b)).toEqual([2, 100])
      expect(refunds.reduce((s, r) => s + r.amount, 0)).toBe(preDeduct)
      // 余额回到扣费前
      expect(await balanceOf(initUserId)).toBe(before)
    },
  )

  it(
    "删除监控：同样取消 queued 任务并全额退款，余额复原，监控行删掉",
    { timeout: 30_000 },
    async () => {
      const monitor = await insertMonitor()
      const before = await balanceOf(initUserId)
      expect(await createMonitorRunTasks(monitor.id)).toBe("ran")
      const tasks = await db
        .select({ id: selectionTasks.id, estimatedCredits: selectionTasks.estimatedCredits })
        .from(selectionTasks)
        .where(eq(selectionTasks.monitorId, monitor.id))
      expect(tasks).toHaveLength(2)
      const preDeduct = tasks.reduce((s, t) => s + t.estimatedCredits, 0)
      expect(await balanceOf(initUserId)).toBe(before - preDeduct)
      // 删监控后 selection_task.monitor_id 被 FK 置空（迁移 0106：ON DELETE SET NULL），
      // 删前先记下任务 id，事后按 id 断言
      const taskIds = tasks.map((t) => t.id)

      mockSession.userId = initUserId
      const res = await removeSelectionMonitorAction(monitor.id)
      expect(res.ok).toBe(true)

      const after = await db
        .select()
        .from(selectionTasks)
        .where(inArray(selectionTasks.id, taskIds))
      expect(after.map((t) => t.status)).toEqual(["cancelled", "cancelled"])
      const refunds = await db
        .select()
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.enterpriseId, testEnterpriseId),
            eq(creditTransactions.type, "selection_refund"),
            inArray(creditTransactions.taskId, taskIds),
          ),
        )
      expect(refunds.reduce((s, r) => s + r.amount, 0)).toBe(preDeduct)
      expect(await balanceOf(initUserId)).toBe(before)
      // 监控行已删（历史任务行保留）
      const gone = await db
        .select({ id: selectionMonitors.id })
        .from(selectionMonitors)
        .where(eq(selectionMonitors.id, monitor.id))
      expect(gone).toHaveLength(0)
    },
  )
})

describe("一次性抓评论并发（R-10-8）", () => {
  it(
    "并发两次只建一个任务只扣一次费，慢的那次返回「正在抓取中」",
    { timeout: 30_000 },
    async () => {
      // 载体任务用 amazon（避免 temu 完成任务混进 R-9-4 的来源任务下拉）
      const task = await insertTask({
        platform: "amazon",
        actorId: "junglee/Amazon-crawler",
        status: "completed",
        fetchedCount: 1,
      })
      const result = await insertResult({ taskId: task.id })
      const before = await balanceOf(initUserId)

      mockSession.userId = initUserId
      const input = { resultId: result.id, maxReviews: 1 }
      const [a, b] = await Promise.all([
        scrapeResultReviewsAction(input),
        scrapeResultReviewsAction(input),
      ])
      const okResults = [a, b].filter((r) => r.ok)
      expect(okResults).toHaveLength(1)
      const denied = a.ok ? b : a
      expect(denied.ok).toBe(false)
      if (!denied.ok) {
        expect(denied.error).toContain("正在抓取中")
      }
      // 该目标只建了 1 个评论任务
      const created = await db
        .select({ id: selectionTasks.id })
        .from(selectionTasks)
        .where(
          and(
            eq(selectionTasks.enterpriseId, testEnterpriseId),
            eq(selectionTasks.taskType, "review"),
            sql`${selectionTasks.searchParams}->>'targetUrl' = ${result.sourceUrl}`,
          ),
        )
      expect(created).toHaveLength(1)
      // 积分只少了一次（amazon 评论费率 2 分 × 1 条）
      expect(await balanceOf(initUserId)).toBe(before - 2)
    },
  )
})

describe("失败任务重试守卫（R-15-1）", () => {
  it(
    "monitor/review 失败任务不可重试（文案+任务数+积分均不动），market 可重试",
    { timeout: 30_000 },
    async () => {
      const monitorTask = await insertTask({
        taskType: "monitor",
        platform: "amazon",
        actorId: "junglee/amazon-asins-scraper",
        searchParams: { targetUrl: "https://www.amazon.com/dp/B0RETRYTEST" },
        keyword: "监控重抓失败",
        estimatedCredits: 2,
        status: "failed",
        errorMessage: "测试失败",
      })
      const reviewTask = await insertTask({
        taskType: "review",
        platform: "amazon",
        actorId: "junglee/amazon-reviews-scraper",
        searchParams: { targetUrl: "https://www.amazon.com/dp/B0RETRYTEST" },
        keyword: "评论抓取失败",
        estimatedCredits: 100,
        status: "failed",
        errorMessage: "测试失败",
      })
      const marketTask = await insertTask({ status: "failed", errorMessage: "测试失败" })

      const countBefore = await db
        .select({ id: selectionTasks.id })
        .from(selectionTasks)
        .where(eq(selectionTasks.enterpriseId, testEnterpriseId))
      const before = await balanceOf(initUserId)

      mockSession.userId = initUserId
      const rMon = await retrySelectionTaskAction(monitorTask.id)
      expect(rMon.ok).toBe(false)
      if (!rMon.ok) {
        expect(rMon.error).toContain("监控任务不支持重试")
      }
      const rRev = await retrySelectionTaskAction(reviewTask.id)
      expect(rRev.ok).toBe(false)
      if (!rRev.ok) {
        expect(rRev.error).toContain("评论任务不支持重试")
      }
      // 两次被拒：任务总数与发起人余额都不动
      const countAfter = await db
        .select({ id: selectionTasks.id })
        .from(selectionTasks)
        .where(eq(selectionTasks.enterpriseId, testEnterpriseId))
      expect(countAfter).toHaveLength(countBefore.length)
      expect(await balanceOf(initUserId)).toBe(before)

      // 对照：market 失败任务可重试，新任务建成并按原量重新预扣
      const rMkt = await retrySelectionTaskAction(marketTask.id)
      expect(rMkt.ok).toBe(true)
      if (!rMkt.ok) return
      const [newTask] = await db
        .select()
        .from(selectionTasks)
        .where(eq(selectionTasks.id, rMkt.taskId))
      expect(newTask).toMatchObject({
        status: "queued",
        taskType: "market",
        platform: "temu",
        estimatedCredits: 2,
      })
      expect(await balanceOf(initUserId)).toBe(before - 2)
    },
  )
})

describe("数据池筛选与收藏导出（R-9-4 / R-9-7）", () => {
  it("来源任务下拉只含会写入数据池的 market 完成任务（R-9-4）", async () => {
    await insertTask({
      taskType: "review",
      status: "completed",
      fetchedCount: 5,
      completedAt: new Date(),
    })
    await insertTask({
      taskType: "monitor",
      status: "completed",
      fetchedCount: 5,
      completedAt: new Date(),
    })
    const marketTask = await insertTask({
      taskType: "market",
      status: "completed",
      fetchedCount: 5,
      completedAt: new Date(),
    })

    mockSession.userId = initUserId
    const meta = await getSelectionPoolMetaAction({ platform: "temu" })
    expect(meta.ok).toBe(true)
    if (!meta.ok) return
    // 夹具企业内 temu 完成任务只有这 3 个：下拉只留 market，review/monitor 被滤掉
    expect(meta.tasks.map((t) => t.id)).toEqual([marketTask.id])
    expect(meta.tasks[0]!.taskType).toBe("market")
  })

  it("收藏导出按平台筛选只含该平台收藏，不筛导出全部（R-9-7）", async () => {
    const temuTask = await insertTask({ keyword: "导出夹具 TEMU" })
    const amazonTask = await insertTask({
      platform: "amazon",
      actorId: "junglee/Amazon-crawler",
      keyword: "导出夹具 Amazon",
    })
    const temuA = await insertResult({
      taskId: temuTask.id,
      platform: "temu",
      title: "TEMU 收藏A",
    })
    const temuB = await insertResult({
      taskId: temuTask.id,
      platform: "temu",
      title: "TEMU 收藏B",
    })
    const amzA = await insertResult({ taskId: amazonTask.id, title: "Amazon 收藏A" })
    await db.insert(selectionBookmarks).values([
      { userId: initUserId, resultId: temuA.id },
      { userId: initUserId, resultId: temuB.id },
      { userId: initUserId, resultId: amzA.id },
    ])

    mockSession.userId = initUserId
    // 按 temu 导出：只有 2 条 TEMU 收藏
    const byPlatform = await exportSelectionBookmarksExcelAction({ platform: "temu" })
    expect(byPlatform.ok).toBe(true)
    if (!byPlatform.ok) return
    const ws1 = (await loadWorkbook(byPlatform.base64)).worksheets[0]!
    expect(ws1.rowCount - 1).toBe(2)
    const platforms1 = Array.from({ length: 2 }, (_, i) => ws1.getRow(i + 2).getCell(1).value)
    expect(platforms1).toEqual(["TEMU", "TEMU"])

    // 不带筛选：全部 3 条收藏
    const all = await exportSelectionBookmarksExcelAction()
    expect(all.ok).toBe(true)
    if (!all.ok) return
    const ws2 = (await loadWorkbook(all.base64)).worksheets[0]!
    expect(ws2.rowCount - 1).toBe(3)
    const platforms2 = Array.from({ length: 3 }, (_, i) => ws2.getRow(i + 2).getCell(1).value)
    expect(platforms2.sort()).toEqual(["Amazon", "TEMU", "TEMU"])
  })
})
