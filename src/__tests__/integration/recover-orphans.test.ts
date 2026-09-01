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

/**
 * 孤儿任务回收集成测试（worker 崩溃/tsx watch 重启丢失在途任务的兜底）
 *
 * 场景：任务出队（ZREM）后 worker 死亡 → DB 停在 queued/processing 且不在
 * Redis 队列 → recoverOrphanTasks 重新入队/补终态。
 *
 * 注意：processor 依赖 "@/server/actions/create"（"use server" 模块，会拖入
 * next-auth 在 vitest 下无法解析），mock 掉其中的 refundFailedTask。
 */
vi.mock("@/server/actions/create", () => ({
  refundFailedTask: vi.fn(async () => undefined),
}))

const { recoverOrphanTasks } = await import("@/lib/queue/processor")

let entId: string
let userId: string
let modelId: string
const staleDate = () => new Date(Date.now() - 20 * 60 * 1000)

async function insertTask(opts: {
  status: "queued" | "processing"
  createdAt?: Date
  imageCount?: number
  succeededIndexes?: number[]
  resultImages?: string[]
}) {
  const [row] = await db
    .insert(generationTasks)
    .values({
      enterpriseId: entId,
      userId,
      modelId,
      prompt: "回收测试",
      imageCount: opts.imageCount ?? 1,
      status: opts.status,
      createdAt: opts.createdAt ?? staleDate(),
      succeededIndexes: opts.succeededIndexes ?? null,
      resultImages: opts.resultImages ?? null,
    })
    .returning()
  return row!
}

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "回收测试企业",
      slug: `rec-${randomUUID().slice(0, 8)}`,
      creditsBalance: 100,
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
      username: `rec_user_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: entId,
      groupId: group!.id,
    })
    .returning()
  userId = user!.id

  const [model] = await db
    .insert(models)
    .values({
      name: `rec-model-${randomUUID().slice(0, 8)}`,
      displayName: "回收测试模型",
      apiEndpoint: "https://recover.example.com/v1",
      apiKeyEncrypted: "dummy",
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
  // 清理回收写入的 Redis 队列/哈希（企业级 key 前缀）
  const keys = await redis.keys(`hanxing:ent:${entId}:*`)
  if (keys.length > 0) await redis.del(...keys)
  const globalMembers = await (
    redis.zrange as unknown as (k: string, a: number, b: number) => Promise<string[]>
  )("hanxing:queue:global", 0, -1)
  const mine = globalMembers.filter((m) => m.startsWith(`${entId}:`))
  if (mine.length > 0) await redis.zrem("hanxing:queue:global", ...mine)
})

describe("recoverOrphanTasks 孤儿任务回收", () => {
  it("processing + 陈旧 + 不在队列 → 重新入队并置回 queued", async () => {
    const task = await insertTask({ status: "processing" })
    const n = await recoverOrphanTasks()
    expect(n).toBeGreaterThanOrEqual(1)

    const rank = await redis.zrank(`hanxing:ent:${entId}:queue:tasks`, `${entId}:${task.id}`)
    expect(rank).not.toBeNull()

    const [row] = await db
      .select()
      .from(generationTasks)
      .where(eq(generationTasks.id, task.id))
    expect(row!.status).toBe("queued")
  })

  it("仍在 Redis 队列排队的任务不会被重复入队", async () => {
    const task = await insertTask({ status: "queued" })
    await enqueue({
      taskId: task.id,
      enterpriseId: entId,
      modelId,
      prompt: task.prompt,
      imageSize: "1024x1024",
      imageCount: 1,
      referenceImages: [],
      priority: 0,
      costPerImage: 1,
      apiTimeout: 120,
      taskTimeout: 300,
      maxRetries: 2,
    })
    await recoverOrphanTasks()
    // 仍是 queued（未被误改），队列成员唯一
    const members = await (
      redis.zrange as unknown as (
        k: string,
        a: number,
        b: number,
      ) => Promise<string[]>
    )(`hanxing:ent:${entId}:queue:tasks`, 0, -1)
    const mine = members.filter((m) => m === `${entId}:${task.id}`)
    expect(mine).toHaveLength(1)
  })

  it("刚创建的 processing 任务（未超阈值）不回收", async () => {
    const task = await insertTask({
      status: "processing",
      createdAt: new Date(),
    })
    await recoverOrphanTasks()
    const [row] = await db
      .select()
      .from(generationTasks)
      .where(eq(generationTasks.id, task.id))
    expect(row!.status).toBe("processing") // 未被动过
    const rank = await redis.zrank(`hanxing:ent:${entId}:queue:tasks`, `${entId}:${task.id}`)
    expect(rank).toBeNull()
  })

  it("DB 陈旧但 Redis 显示刚被消费（活跃 worker）→ 跳过不回收", async () => {
    // 场景：任务排队超 15 分钟后被 worker 刚消费（createdAt 陈旧、
    // startedAt 全新）。若只看 createdAt 会立即重新入队 → 与在跑 worker
    // 双跑、双退款。
    const task = await insertTask({ status: "processing" })
    await redis.hset(`hanxing:ent:${entId}:task:${task.id}`, {
      status: "processing",
      startedAt: String(Date.now()),
    })
    await recoverOrphanTasks()
    const [row] = await db
      .select()
      .from(generationTasks)
      .where(eq(generationTasks.id, task.id))
    expect(row!.status).toBe("processing") // 未被动过
    const rank = await redis.zrank(`hanxing:ent:${entId}:queue:tasks`, `${entId}:${task.id}`)
    expect(rank).toBeNull()
  })

  it("全部序号已成功的陈旧任务 → 直接补 completed（不入队不重跑）", async () => {
    const task = await insertTask({
      status: "processing",
      imageCount: 1,
      succeededIndexes: [0],
      resultImages: ["https://cos/done.png"],
    })
    await recoverOrphanTasks()
    const [row] = await db
      .select()
      .from(generationTasks)
      .where(eq(generationTasks.id, task.id))
    expect(row!.status).toBe("completed")
    const rank = await redis.zrank(`hanxing:ent:${entId}:queue:tasks`, `${entId}:${task.id}`)
    expect(rank).toBeNull()
  })
})
