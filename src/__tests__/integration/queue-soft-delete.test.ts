import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  enterprises,
  generationTasks,
  models,
  permissionGroups,
  users,
} from "@/db/schema"
import { redis } from "@/lib/redis"
import { enqueue } from "@/lib/queue/task-queue"
import { encrypt } from "@/lib/crypto"

/**
 * 队列「删除止损」集成测试（真实本地 PG + Redis）。
 *
 * 软删任务与图像队列的三道防线（删除后不得继续生图/重试/退款）：
 *   ① 孤儿回收跳过软删任务（不重新入队）；
 *   ② 消费前拦截：软删任务出队后直接跳过，不发起任何 AI 请求；
 *   ③ 处理中删除：生图请求失败后不重试、不退款，Redis 收尾为终态。
 */
const refundMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock("@/server/services/credits-service", () => ({
  refundFailedTask: refundMock,
}))

const { processQueueOnce, recoverOrphanTasks } = await import(
  "@/lib/queue/processor"
)

let entId: string
let userId: string
let modelId: string

async function insertTask(opts: {
  status: "queued" | "processing"
  deletedAt?: Date | null
  createdAt?: Date
}) {
  const [row] = await db
    .insert(generationTasks)
    .values({
      enterpriseId: entId,
      userId,
      modelId,
      prompt: "止损测试",
      imageCount: 1,
      status: opts.status,
      deletedAt: opts.deletedAt ?? null,
      createdAt: opts.createdAt ?? new Date(Date.now() - 20 * 60 * 1000),
    })
    .returning()
  return row!
}

async function enqueueTask(taskId: string) {
  await enqueue({
    taskId,
    enterpriseId: entId,
    modelId,
    prompt: "止损测试",
    imageSize: "1024x1024",
    imageCount: 1,
    referenceImages: [],
    priority: 0,
    costPerImage: 1,
    apiTimeout: 30,
    taskTimeout: 60,
    maxRetries: 2,
  })
}

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "止损测试企业",
      slug: `stopsell-${randomUUID().slice(0, 8)}`,
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
      username: `stopsell_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: entId,
      groupId: group!.id,
    })
    .returning()
  userId = user!.id

  const [model] = await db
    .insert(models)
    .values({
      name: `stopsell-model-${randomUUID().slice(0, 8)}`,
      displayName: "止损测试模型",
      apiEndpoint: "https://stopsell.example.com/v1",
      // 真实加密的 key：处理器发起请求前会解密，"dummy" 会因解密失败
      // 提前抛错（走不到 fetch/删除逻辑）
      apiKeyEncrypted: encrypt("sk-stopsell-dummy"),
    })
    .returning()
  modelId = model!.id
})

afterAll(async () => {
  await db.delete(generationTasks).where(eq(generationTasks.enterpriseId, entId))
  await db.delete(users).where(eq(users.enterpriseId, entId))
  await db.delete(permissionGroups).where(eq(permissionGroups.enterpriseId, entId))
  await db.delete(models).where(eq(models.id, modelId))
  await db.delete(enterprises).where(eq(enterprises.id, entId))
  const keys = await redis.keys(`hanxing:ent:${entId}:*`)
  if (keys.length > 0) await redis.del(...keys)
  const globalMembers = await (
    redis.zrange as unknown as (k: string, a: number, b: number) => Promise<string[]>
  )("hanxing:queue:global", 0, -1)
  const mine = globalMembers.filter((m) => m.startsWith(`${entId}:`))
  if (mine.length > 0) await redis.zrem("hanxing:queue:global", ...mine)
  vi.unstubAllGlobals()
})

describe("队列删除止损", () => {
  it("① 孤儿回收跳过软删任务：不重新入队、状态不动", async () => {
    const task = await insertTask({ status: "processing", deletedAt: new Date() })
    await recoverOrphanTasks()

    const rank = await redis.zrank(
      `hanxing:ent:${entId}:queue:tasks`,
      `${entId}:${task.id}`,
    )
    expect(rank).toBeNull()

    const [row] = await db
      .select()
      .from(generationTasks)
      .where(eq(generationTasks.id, task.id))
    expect(row!.status).toBe("processing")
    expect(row!.deletedAt).not.toBeNull()
  })

  it("② 消费前拦截：软删任务出队后直接跳过，不发起 AI 请求", async () => {
    const task = await insertTask({ status: "queued", deletedAt: new Date() })
    await enqueueTask(task.id)

    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await processQueueOnce()

    // 未发起任何生图请求；DB 行保持软删 + queued（守卫在任何写操作之前返回）
    expect(fetchMock).not.toHaveBeenCalled()
    const [row] = await db
      .select()
      .from(generationTasks)
      .where(eq(generationTasks.id, task.id))
    expect(row!.deletedAt).not.toBeNull()
    expect(row!.status).toBe("queued")

    // Redis 队列已清理（不会留给下一轮重复消费）
    const rank = await redis.zrank(
      `hanxing:ent:${entId}:queue:tasks`,
      `${entId}:${task.id}`,
    )
    expect(rank).toBeNull()
  })

  it("③ 处理中删除：生图失败后不重试、不退款", async () => {
    refundMock.mockClear()
    const task = await insertTask({ status: "queued" })
    await enqueueTask(task.id)

    // AI 请求进行中将任务软删（模拟用户此刻删除），随后请求失败
    const fetchMock = vi.fn(async () => {
      await db
        .update(generationTasks)
        .set({ deletedAt: new Date() })
        .where(eq(generationTasks.id, task.id))
      return new Response("upstream error", { status: 500 })
    })
    vi.stubGlobal("fetch", fetchMock)

    await processQueueOnce()

    // 已删任务不退款、不重新入队重试
    expect(refundMock).not.toHaveBeenCalled()
    const [row] = await db
      .select()
      .from(generationTasks)
      .where(eq(generationTasks.id, task.id))
    expect(row!.retryCount).toBe(0)
    expect(row!.status).toBe("processing") // 未被置回 queued（无重试）
    expect(row!.deletedAt).not.toBeNull()

    const rank = await redis.zrank(
      `hanxing:ent:${entId}:queue:tasks`,
      `${entId}:${task.id}`,
    )
    expect(rank).toBeNull()
  })
})
