import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { and, eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { db } from "@/db/client"
import {
  creditTransactions,
  enterprises,
  permissionGroups,
  selectionResults,
  selectionTasks,
  users,
} from "@/db/schema"
import {
  deductUserCredits,
} from "@/server/services/credits-service"
import {
  countTaskResults,
  ingestSelectionResults,
  settleSelectionTask,
} from "@/server/services/selection-service"

/**
 * 选品任务结算集成测试（计费红线：预扣 → 入库幂等 → 按实际结算/退款，
 * 认领防并发双退——对齐 credits-concurrency 测试口径）
 */

const TEST_SLUG = "test-selection-lifecycle"
let testEnterpriseId: string
let testUserId: string
/** 入库幂等用例创建的任务 id（足额结算/级联删除复用，杜绝按 keyword 跨企业误取） */
let lifecycleTaskId: string

/** CRW/temu-products-scraper 输出形状（2026-11-20 切换后） */
function temuRow(goodsId: string) {
  return {
    goods_id: Number(goodsId),
    title: `Product ${goodsId}`,
    price: 9.99,
    market_price: 19.99,
    currency: "USD",
    rating: 4.5,
    review_count: 100,
    sales_num: "1K+",
    link_url: `https://www.temu.com/goods-${goodsId}.html`,
    image_url: "https://img.temu.com/a.jpg",
  }
}

async function insertTask(estimatedCredits: number) {
  const [t] = await db
    .insert(selectionTasks)
    .values({
      enterpriseId: testEnterpriseId,
      userId: testUserId,
      taskType: "market",
      platform: "temu",
      actorId: "crw/temu-products-scraper",
      searchParams: { keyword: "phone case", sort: "relevance" },
      keyword: "phone case",
      country: "US",
      maxResults: estimatedCredits / 2, // temu 费率 2 积分/条
      estimatedCredits,
      status: "processing",
      startedAt: new Date(), // 防 dev worker 收割循环把无 startedAt 行按 epoch 误判超时回收
    })
    .returning()
  return t!
}

beforeAll(async () => {
  const [enterprise] = await db
    .insert(enterprises)
    .values({
      name: "选品测试企业",
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
      username: `sel_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyhashfortestonlyxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: testEnterpriseId,
      groupId: group!.id,
      creditsBalance: 1000,
    })
    .returning()
  testUserId = user!.id
})

afterAll(async () => {
  if (testEnterpriseId) {
    await db
      .delete(creditTransactions)
      .where(eq(creditTransactions.enterpriseId, testEnterpriseId))
    await db.delete(users).where(eq(users.enterpriseId, testEnterpriseId))
    await db
      .delete(permissionGroups)
      .where(eq(permissionGroups.enterpriseId, testEnterpriseId))
    await db.delete(enterprises).where(eq(enterprises.id, testEnterpriseId))
  }
})

describe("选品任务积分结算", () => {
  it("selection_deduct 流水类型 + 预扣", async () => {
    const { balanceAfter } = await deductUserCredits({
      enterpriseId: testEnterpriseId,
      userId: testUserId,
      amount: 300,
      type: "selection_deduct",
      remark: "选品任务：TEMU「phone case」×100",
    })
    expect(balanceAfter).toBe(700)
    const [tx] = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.enterpriseId, testEnterpriseId),
          eq(creditTransactions.type, "selection_deduct"),
        ),
      )
    expect(tx).toMatchObject({ amount: -300, balanceAfter: 700, userId: testUserId })
  })

  it("入库幂等：重复 ingest 同一批行不产生重复结果", async () => {
    const task = await insertTask(200)
    lifecycleTaskId = task.id
    const ref = {
      id: task.id,
      enterpriseId: testEnterpriseId,
      platform: "temu",
      taskType: "market" as const,
      country: "US",
    }
    const rows = Array.from({ length: 100 }, (_, i) => temuRow(String(600_000 + i)))
    const first = await ingestSelectionResults(ref, rows)
    expect(first).toBe(100)
    const second = await ingestSelectionResults(ref, rows)
    expect(second).toBe(0)
    expect(await countTaskResults(task.id)).toBe(100)
  })

  it("足额结算：实际=预估，无退款", async () => {
    await settleSelectionTask({
      taskId: lifecycleTaskId,
      finalStatus: "completed",
      fetchedCount: 100,
    })
    const [after] = await db
      .select()
      .from(selectionTasks)
      .where(eq(selectionTasks.id, lifecycleTaskId))
    expect(after!.status).toBe("completed")
    expect(after!.actualCredits).toBe(200) // 100 × 2
    expect(after!.progress).toBe(100)
    // 本任务无 selection_refund 流水
    const refunds = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.enterpriseId, testEnterpriseId),
          eq(creditTransactions.taskId, lifecycleTaskId),
          eq(creditTransactions.type, "selection_refund"),
        ),
      )
    expect(refunds).toHaveLength(0)
  })

  it("部分结算：按实际条数退款差额 + 认领防并发双退", async () => {
    const task = await insertTask(200)
    const ref = {
      id: task.id,
      enterpriseId: testEnterpriseId,
      platform: "temu",
      taskType: "market" as const,
      country: "US",
    }
    await ingestSelectionResults(
      ref,
      Array.from({ length: 40 }, (_, i) => temuRow(String(700_000 + i))),
    )
    await settleSelectionTask({
      taskId: task.id,
      finalStatus: "cancelled",
      fetchedCount: 40,
    })
    const [after] = await db
      .select()
      .from(selectionTasks)
      .where(eq(selectionTasks.id, task.id))
    expect(after!.status).toBe("cancelled")
    expect(after!.actualCredits).toBe(80) // 40 × 2

    // 结算幂等：重复 settle 不再退款、不改状态
    await settleSelectionTask({
      taskId: task.id,
      finalStatus: "completed",
      fetchedCount: 100,
    })
    const [after2] = await db
      .select()
      .from(selectionTasks)
      .where(eq(selectionTasks.id, task.id))
    expect(after2!.actualCredits).toBe(80)
    expect(after2!.status).toBe("cancelled")

    const refunds = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.type, "selection_refund"))
    // 本任务退款 = 200 - 80 = 120，仅一条
    const forTask = refunds.filter((r) => r.taskId === task.id)
    expect(forTask).toHaveLength(1)
    expect(forTask[0]!.amount).toBe(120)
  })

  it("失败全退：0 条结果全额退款", async () => {
    const task = await insertTask(60)
    await settleSelectionTask({
      taskId: task.id,
      finalStatus: "failed",
      fetchedCount: 0,
      errorMessage: "启动抓取失败：测试",
    })
    const [after] = await db
      .select()
      .from(selectionTasks)
      .where(eq(selectionTasks.id, task.id))
    expect(after!.actualCredits).toBe(0)
    expect(after!.errorMessage).toContain("测试")
    const refunds = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.taskId, task.id))
    const refund = refunds.find((r) => r.type === "selection_refund")
    expect(refund?.amount).toBe(60)
  })

  it("结果行随任务级联删除", async () => {
    await db.delete(selectionTasks).where(eq(selectionTasks.id, lifecycleTaskId))
    const remain = await db
      .select()
      .from(selectionResults)
      .where(eq(selectionResults.taskId, lifecycleTaskId))
    expect(remain).toHaveLength(0)
  })
})
