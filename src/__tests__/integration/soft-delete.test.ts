import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatConversations,
  chatMessages,
  conversations,
  creditTransactions,
  enterprises,
  generationTasks,
  models,
  permissionGroups,
  pinnedTasks,
  users,
} from "@/db/schema"
import { getMemberUsageStats } from "@/server/services/member-stats-service"
import { listTransactions } from "@/server/services/credits-service"
import {
  deleteConversationAction,
  deleteTaskAction,
  listConversationTasksAction,
  listConversationsAction,
} from "@/server/actions/conversations"
import {
  deleteChatConversationAction,
  listChatConversationsAction,
} from "@/server/actions/chat"

/**
 * 软删除集成测试（真实本地 PG）。
 *
 * 验证用户删除只对用户侧隐藏，管理端三处数据不受影响：
 *   ① 数据看板 getMemberUsageStats 聚合数字在删除前后不变；
 *   ② 积分流水 listTransactions 仍能 join 出已删任务的 source（模块列）；
 *   ③ 用户端列表（创作会话/会话内任务/对话会话）删除后查不到；
 *   ④ 任务软删时收藏行同步清理。
 *
 * 登录态经 mock auth() 注入夹具用户（next-auth 无法在 vitest 加载）；
 * revalidatePath 在无 Next 请求上下文时会抛错，mock 为空操作。
 */
const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

let entId: string
let userId: string
let convId: string
let taskIdKeep: string
let taskIdDelete: string
let chatConvId: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "软删测试企业",
      slug: `softdel-${randomUUID().slice(0, 8)}`,
    })
    .returning()
  entId = ent!.id

  const [group] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entId, name: "默认组", isDefault: true })
    .returning()

  const [user] = await db
    .insert(users)
    .values({
      username: `softdel_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      name: "软删用户",
      enterpriseId: entId,
      groupId: group!.id,
    })
    .returning()
  userId = user!.id
  mockSession.userId = userId

  const [model] = await db
    .insert(models)
    .values({
      enterpriseId: entId,
      name: `softdel-img-${randomUUID().slice(0, 8)}`,
      displayName: "软删生图模型",
      apiEndpoint: "https://example.com/img",
      apiKeyEncrypted: "dummy",
    })
    .returning()

  const [conv] = await db
    .insert(conversations)
    .values({
      enterpriseId: entId,
      userId,
      title: "软删测试会话",
    })
    .returning()
  convId = conv!.id

  await db.insert(generationTasks).values([
    {
      enterpriseId: entId,
      userId,
      prompt: "保留任务",
      source: "create",
      status: "completed",
      creditsCharged: 10,
      modelId: model!.id,
      conversationId: convId,
      createdAt: new Date(),
    },
    {
      enterpriseId: entId,
      userId,
      prompt: "待删任务",
      source: "create",
      status: "completed",
      creditsCharged: 20,
      modelId: model!.id,
      conversationId: convId,
      createdAt: new Date(),
    },
  ])
  const taskRows = await db
    .select({ id: generationTasks.id, prompt: generationTasks.prompt })
    .from(generationTasks)
    .where(eq(generationTasks.conversationId, convId))
  taskIdKeep = taskRows.find((t) => t.prompt === "保留任务")!.id
  taskIdDelete = taskRows.find((t) => t.prompt === "待删任务")!.id

  // 待删任务被收藏（验证软删时收藏行同步清理）
  await db.insert(pinnedTasks).values({
    enterpriseId: entId,
    userId,
    taskId: taskIdDelete,
    source: "create",
  })

  // 生图扣费流水：taskId 指向待删任务（验证删除后模块列仍可显示）
  await db.insert(creditTransactions).values({
    enterpriseId: entId,
    userId,
    type: "allocation_deduct",
    amount: -20,
    balanceAfter: 80,
    taskId: taskIdDelete,
    remark: "生图消耗",
  })

  const [chatConv] = await db
    .insert(chatConversations)
    .values({ enterpriseId: entId, userId, title: "软删对话" })
    .returning()
  chatConvId = chatConv!.id

  await db.insert(chatMessages).values([
    {
      conversationId: chatConvId,
      enterpriseId: entId,
      userId,
      role: "assistant",
      status: "completed",
      costCenticredits: 250,
      createdAt: new Date(),
    },
    {
      conversationId: chatConvId,
      enterpriseId: entId,
      userId,
      role: "assistant",
      status: "completed",
      costCenticredits: 150,
      createdAt: new Date(),
    },
  ])
})

afterAll(async () => {
  // users.enterpriseId 为 set null 不级联，需先删成员（级联其余夹具）
  await db.delete(users).where(eq(users.enterpriseId, entId))
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

describe("软删除：用户删除后管理端数据保留", () => {
  it("删除前基线：用户端可见、看板数字与流水模块列正确", async () => {
    const convs = await listConversationsAction()
    expect(convs.map((c) => c.id)).toEqual([convId])

    const tasks = await listConversationTasksAction(convId)
    expect(tasks).toHaveLength(2)

    const chatConvs = await listChatConversationsAction()
    expect(chatConvs.map((c) => c.id)).toEqual([chatConvId])

    const stats = await getMemberUsageStats(entId)
    expect(stats.monthKpi.imageCount).toBe(2)
    expect(stats.monthKpi.credits).toBeCloseTo(30 + 4, 5) // 生图 30 + 对话 4
    expect(stats.monthKpi.chatTotal).toBe(2)

    const tx = await listTransactions({ enterpriseId: entId })
    expect(tx.total).toBe(1)
    expect(tx.items[0]!.source).toBe("create")
  })

  it("删除单个任务：用户端隐藏、收藏行清理，看板与流水不受影响", async () => {
    const r = await deleteTaskAction(taskIdDelete)
    expect(r.ok).toBe(true)

    const tasks = await listConversationTasksAction(convId)
    expect(tasks.map((t) => t.id)).toEqual([taskIdKeep])

    // 收藏行已清理
    const pins = await db
      .select()
      .from(pinnedTasks)
      .where(eq(pinnedTasks.taskId, taskIdDelete))
    expect(pins).toHaveLength(0)

    // 看板数字不变
    const stats = await getMemberUsageStats(entId)
    expect(stats.monthKpi.imageCount).toBe(2)
    expect(stats.monthKpi.credits).toBeCloseTo(34, 5)

    // 流水保留且模块列仍显示
    const tx = await listTransactions({ enterpriseId: entId })
    expect(tx.total).toBe(1)
    expect(tx.items[0]!.source).toBe("create")
  })

  it("删除创作会话：会话与其余任务对用户隐藏，看板与流水不变", async () => {
    const r = await deleteConversationAction(convId)
    expect(r.ok).toBe(true)

    expect(await listConversationsAction()).toHaveLength(0)
    expect(await listConversationTasksAction(convId)).toHaveLength(0)

    // 直接 DB 断言：会话下全部任务行都被置位（而非仅靠会话过滤兜住）
    const under = await db
      .select({ id: generationTasks.id, deletedAt: generationTasks.deletedAt })
      .from(generationTasks)
      .where(eq(generationTasks.conversationId, convId))
    expect(under).toHaveLength(2)
    expect(under.every((t) => t.deletedAt != null)).toBe(true)

    const stats = await getMemberUsageStats(entId)
    expect(stats.monthKpi.imageCount).toBe(2)
    expect(stats.monthKpi.credits).toBeCloseTo(34, 5)

    const tx = await listTransactions({ enterpriseId: entId })
    expect(tx.items[0]!.source).toBe("create")
  })

  it("删除对话会话：用户端隐藏，消息整批置位，看板对话统计不变", async () => {
    const r = await deleteChatConversationAction(chatConvId)
    expect(r.ok).toBe(true)

    expect(await listChatConversationsAction()).toHaveLength(0)

    // 直接 DB 断言：会话下全部 chat_message 行都被置位——listChatMessages
    // 以会话过滤兜底，若删除 action 里整批置位逻辑失效此断言才会暴露
    const msgs = await db
      .select({ id: chatMessages.id, deletedAt: chatMessages.deletedAt })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, chatConvId))
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs.every((m) => m.deletedAt != null)).toBe(true)

    const stats = await getMemberUsageStats(entId)
    expect(stats.monthKpi.chatTotal).toBe(2)
    expect(stats.monthKpi.credits).toBeCloseTo(34, 5)
  })

  it("重复删除与重复提交校验：已删资源按不存在处理", async () => {
    const again = await deleteConversationAction(convId)
    expect(again.ok).toBe(false)

    const againTask = await deleteTaskAction(taskIdKeep)
    // 任务已随会话软删，视为不存在
    expect(againTask.ok).toBe(false)
  })

  it("非 create 源任务不可通过 deleteTaskAction 软删（product/weartry/mockup 无删除功能）", async () => {
    const [productTask] = await db
      .insert(generationTasks)
      .values({
        enterpriseId: entId,
        userId,
        prompt: "商品任务",
        source: "product",
        status: "completed",
        creditsCharged: 5,
        modelId: (
          await db
            .select({ id: models.id })
            .from(models)
            .where(eq(models.enterpriseId, entId))
            .limit(1)
        )[0]!.id,
        createdAt: new Date(),
      })
      .returning()
    try {
      const r = await deleteTaskAction(productTask!.id)
      expect(r.ok).toBe(false)

      const [row] = await db
        .select({ deletedAt: generationTasks.deletedAt })
        .from(generationTasks)
        .where(eq(generationTasks.id, productTask!.id))
      expect(row!.deletedAt).toBeNull()
    } finally {
      await db.delete(generationTasks).where(eq(generationTasks.id, productTask!.id))
    }
  })
})
