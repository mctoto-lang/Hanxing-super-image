import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  chatConversations,
  chatMessages,
  enterprises,
  generationTasks,
  models,
  users,
} from "@/db/schema"
import { getMemberUsageStats } from "@/server/services/member-stats-service"

/**
 * 成员管理数据面板聚合集成测试（真实本地 PG）。
 *
 * 覆盖：本月 / 上月 KPI（成功率按已结束请求口径）、90 天趋势补零、
 * 明细 breakdown（模块占比含 Top5 成员 / 模型占比 / 成员排行含调用次数）。
 * 注意：generation_task.status 默认 queued，成功率口径要求夹具显式
 * 设置状态（completed / failed / queued 混合，验证排队不计入分母）。
 */

let entId: string
let userA: string
let userB: string
let imgModelId: string
let chatModelId: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "统计测试企业",
      slug: `stats-${randomUUID().slice(0, 8)}`,
    })
    .returning()
  entId = ent!.id

  const [a] = await db
    .insert(users)
    .values({
      username: `stats_a_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      name: "统计甲",
      enterpriseId: entId,
    })
    .returning()
  userA = a!.id

  const [b] = await db
    .insert(users)
    .values({
      username: `stats_b_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      name: "统计乙",
      enterpriseId: entId,
    })
    .returning()
  userB = b!.id

  // 1 名禁用成员：计入成员总数 KPI，不产生消耗
  await db.insert(users).values({
    username: `stats_c_${randomUUID().slice(0, 8)}`,
    passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    name: "统计丙",
    enterpriseId: entId,
    status: "disabled",
  })

  // 生图模型 / 对话模型（随企业级联清理）
  const [imgModel] = await db
    .insert(models)
    .values({
      enterpriseId: entId,
      name: `stats-img-${randomUUID().slice(0, 8)}`,
      displayName: "统计生图模型",
      apiEndpoint: "https://example.com/img",
      apiKeyEncrypted: "dummy",
    })
    .returning()
  imgModelId = imgModel!.id

  const [chatModel] = await db
    .insert(chatApiConfigs)
    .values({
      enterpriseId: entId,
      name: `stats-chat-${randomUUID().slice(0, 8)}`,
      displayName: "统计对话模型",
      apiEndpoint: "https://example.com/chat",
      apiKeyEncrypted: "dummy",
    })
    .returning()
  chatModelId = chatModel!.id

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const daysAgo3 = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 3,
  )

  await db.insert(generationTasks).values([
    // 甲：今日自由创作 10 + 今日批量生图 20（均成功）
    {
      enterpriseId: entId,
      userId: userA,
      prompt: "t1",
      source: "create",
      status: "completed",
      creditsCharged: 10,
      modelId: imgModelId,
      createdAt: today,
    },
    {
      enterpriseId: entId,
      userId: userA,
      prompt: "t2",
      source: "workspace",
      status: "completed",
      creditsCharged: 20,
      modelId: imgModelId,
      createdAt: today,
    },
    // 乙：3 天前商品图片 5（成功，验证按日聚合与跨日趋势 / 跨月边界）
    {
      enterpriseId: entId,
      userId: userB,
      prompt: "t3",
      source: "product",
      status: "completed",
      creditsCharged: 5,
      modelId: imgModelId,
      createdAt: daysAgo3,
    },
    // 甲：今日失败任务（计次、计入成功率分母，不产生消耗）
    {
      enterpriseId: entId,
      userId: userA,
      prompt: "t4",
      source: "create",
      status: "failed",
      creditsCharged: 0,
      modelId: imgModelId,
      createdAt: today,
    },
    // 甲：今日排队中任务（计次，不计入成功率分母）
    {
      enterpriseId: entId,
      userId: userA,
      prompt: "t5",
      source: "create",
      status: "queued",
      creditsCharged: 0,
      modelId: imgModelId,
      createdAt: today,
    },
  ])

  const [conv] = await db
    .insert(chatConversations)
    .values({ enterpriseId: entId, userId: userA, title: "会话" })
    .returning()

  await db.insert(chatMessages).values([
    // 甲：今日对话消耗 250 厘 = 2.5 积分（成功）
    {
      conversationId: conv!.id,
      enterpriseId: entId,
      userId: userA,
      role: "assistant",
      status: "completed",
      costCenticredits: 250,
      modelId: chatModelId,
      createdAt: today,
    },
    // 今日被中断的 assistant 消息：计入成功率分母、不计成功
    {
      conversationId: conv!.id,
      enterpriseId: entId,
      userId: userA,
      role: "assistant",
      status: "stopped",
      costCenticredits: 0,
      modelId: chatModelId,
      createdAt: today,
    },
    // user 角色消息：不计入对话次数
    {
      conversationId: conv!.id,
      enterpriseId: entId,
      userId: userA,
      role: "user",
      status: "completed",
      costCenticredits: 0,
      createdAt: today,
    },
  ])
})

afterAll(async () => {
  // users.enterpriseId 为 set null 不级联，需先删成员（级联其任务/消息）
  await db.delete(users).where(eq(users.enterpriseId, entId))
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

/** 统计口径（Asia/Shanghai）下 offset 天前的日期键 */
function dayKeyOf(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - offsetDays * 86400_000))
}

/** 今日的统计口径日期键 */
function todayKey(): string {
  return dayKeyOf(0)
}

/** 3 天前的任务是否落在本月（月初 1-3 号运行时落在上一月） */
const task3InCurrentMonth = dayKeyOf(3).slice(0, 7) === todayKey().slice(0, 7)

describe("getMemberUsageStats（成员数据面板聚合）", () => {
  it("KPI：成员数/本月新增、本月生图次数/消耗/成功率口径", async () => {
    const s = await getMemberUsageStats(entId)
    expect(s.memberTotal).toBe(3)
    expect(s.memberActive).toBe(2)
    expect(s.memberDisabled).toBe(1)
    expect(s.newMembersThisMonth).toBe(3)

    const k = s.monthKpi
    // 生图次数含全部状态：今日 4 条（成功 2 / 失败 1 / 排队 1）+ 3 天前 1 条（跨月边界）
    expect(k.imageCount).toBe(4 + (task3InCurrentMonth ? 1 : 0))
    // 消耗：今日生图 10 + 20 + 对话 2.5（失败/排队/中断均 0）
    const expectCredits = 32.5 + (task3InCurrentMonth ? 5 : 0)
    expect(k.credits).toBeCloseTo(expectCredits, 5)
    // 成功率分母只含已结束请求：completed + failed（排队 t5 排除）
    expect(k.imageTotal).toBe(3 + (task3InCurrentMonth ? 1 : 0))
    expect(k.imageCompleted).toBe(2 + (task3InCurrentMonth ? 1 : 0))
    // 对话按 assistant 消息计：completed + stopped（user 消息排除）
    expect(k.chatTotal).toBe(2)
    expect(k.chatCompleted).toBe(1)
  })

  it("KPI：上月环比数据（跨月边界下 3 天前任务归属上月）", async () => {
    const s = await getMemberUsageStats(entId)
    const p = s.prevMonthKpi
    if (task3InCurrentMonth) {
      expect(p.imageCount).toBe(0)
      expect(p.credits).toBe(0)
      expect(p.imageTotal).toBe(0)
      expect(p.chatTotal).toBe(0)
    } else {
      expect(p.imageCount).toBe(1)
      expect(p.credits).toBeCloseTo(5, 5)
      expect(p.imageTotal).toBe(1)
      expect(p.imageCompleted).toBe(1)
      expect(p.chatTotal).toBe(0)
    }
  })

  it("趋势：固定 90 天序列、缺失日补零、今日/3 天前按日聚合", async () => {
    const s = await getMemberUsageStats(entId)
    expect(s.trend).toHaveLength(90)
    const last = s.trend[89]!
    expect(last.day).toBe(todayKey())
    expect(last.imageCredits).toBe(30)
    expect(last.chatCredits).toBeCloseTo(2.5, 5)
    const day3 = s.trend[86]!
    expect(day3.imageCredits).toBe(5)
    expect(day3.chatCredits).toBe(0)
  })

  it("明细：模块占比六模块固定顺序 + 各模块 Top 成员", async () => {
    const s = await getMemberUsageStats(entId)
    expect(s.breakdown.modules.map((m) => m.key)).toEqual([
      "chat",
      "create",
      "workspace",
      "product",
      "weartry",
      "mockup",
    ])
    const byKey = Object.fromEntries(s.breakdown.modules.map((m) => [m.key, m]))
    expect(byKey.chat!.credits).toBeCloseTo(2.5, 5)
    expect(byKey.chat!.topUsers[0]).toEqual({ name: "统计甲", credits: 2.5 })
    expect(byKey.create!.credits).toBe(10)
    expect(byKey.create!.topUsers[0]?.name).toBe("统计甲")
    expect(byKey.workspace!.credits).toBe(20)
    expect(byKey.product!.credits).toBe(5)
    expect(byKey.product!.topUsers[0]?.name).toBe("统计乙")
    expect(byKey.weartry!.credits).toBe(0)
    expect(byKey.weartry!.topUsers).toHaveLength(0)
  })

  it("明细：模型占比合并生图与对话模型（消耗 + 调用次数）", async () => {
    const s = await getMemberUsageStats(entId)
    expect(s.breakdown.models).toHaveLength(2)
    // 按消耗降序：生图模型 35 > 对话模型 2.5
    expect(s.breakdown.models[0]).toEqual({
      key: `image:${imgModelId}`,
      label: "统计生图模型",
      credits: 35,
      calls: 5,
    })
    expect(s.breakdown.models[1]).toEqual({
      key: `chat:${chatModelId}`,
      label: "统计对话模型",
      credits: 2.5,
      calls: 2,
    })
  })

  it("明细：成员排行合并生图 + 对话（积分 + 调用次数），甲第一、乙第二", async () => {
    const s = await getMemberUsageStats(entId)
    expect(s.breakdown.topUsers[0]).toEqual({
      name: "统计甲",
      credits: 32.5,
      calls: 6, // 生图 4（含失败/排队）+ 对话 assistant 2
    })
    expect(s.breakdown.topUsers[1]).toEqual({
      name: "统计乙",
      credits: 5,
      calls: 1,
    })
  })
})
