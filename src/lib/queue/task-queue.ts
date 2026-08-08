import { redis } from "@/lib/redis"
import { env } from "@/lib/env"

/**
 * 基于 Redis 的分布式任务队列（手册 §5.4、§10.5）
 *
 * 结构（每个企业独立队列，Key 全部带 enterpriseId 前缀）：
 *   hanxing:ent:<entId>:queue:tasks    ZSet（score=priority*1e13 + timestamp，保证高优先级 + FIFO）
 *   hanxing:ent:<entId>:task:<id>      Hash（任务元数据：modelId/prompt/imageSize/status...）
 *   hanxing:ent:<entId>:concurrent     String（当前并发计数，INCR/DECR + 过期兜底）
 *   hanxing:queue:global               ZSet（全局待处理，消费者扫描入口）
 *
 * 三层并发上限：enterprise.maxConcurrent ≥ group.maxConcurrent ≥ model.maxConcurrent（取最小，§10.5）。
 */

const GLOBAL_QUEUE_KEY = "hanxing:queue:global"

function entQueueKey(entId: string) {
  return `hanxing:ent:${entId}:queue:tasks`
}
function entTaskKey(entId: string, taskId: string) {
  return `hanxing:ent:${entId}:task:${taskId}`
}
function entConcurrentKey(entId: string) {
  return `hanxing:ent:${entId}:concurrent`
}
function entRateKey(entId: string) {
  return `hanxing:ent:${entId}:rate:generate`
}

export interface QueueTaskInput {
  taskId: string
  enterpriseId: string
  modelId: string
  prompt: string
  imageSize: string
  imageCount: number
  referenceImages: string[]
  priority: number
  costPerImage: number
  apiTimeout: number
  taskTimeout: number
  maxRetries: number
}

/** 入队：写入企业队列 + 全局队列 */
export async function enqueue(task: QueueTaskInput): Promise<void> {
  // 元数据存 Hash
  await redis.hset(entTaskKey(task.enterpriseId, task.taskId), {
    taskId: task.taskId,
    enterpriseId: task.enterpriseId,
    modelId: task.modelId,
    prompt: task.prompt,
    imageSize: task.imageSize,
    imageCount: String(task.imageCount),
    referenceImages: JSON.stringify(task.referenceImages),
    priority: String(task.priority),
    costPerImage: String(task.costPerImage),
    apiTimeout: String(task.apiTimeout),
    taskTimeout: String(task.taskTimeout),
    maxRetries: String(task.maxRetries),
    status: "queued",
    enqueuedAt: String(Date.now()),
  })

  // score = priority * 1e13 + timestamp（数字大先执行；同优先级 FIFO）
  const score = task.priority * 1e13 + Date.now()
  const member = `${task.enterpriseId}:${task.taskId}`
  // ioredis 6 类型对 zadd 的 score 标注为 string，这里强制断言
  await redis.zadd(entQueueKey(task.enterpriseId), score as unknown as string, member)
  await redis.zadd(GLOBAL_QUEUE_KEY, score as unknown as string, member)
}

/** 出队：取下一个可执行任务（受企业并发上限约束） */
export async function dequeueNext(opts: {
  enterpriseId: string
  enterpriseMaxConcurrent: number
}): Promise<QueueTaskInput | null> {
  const { enterpriseId, enterpriseMaxConcurrent } = opts

  // 检查并发是否已满
  const current = Number((await redis.get(entConcurrentKey(enterpriseId))) ?? 0)
  if (current >= enterpriseMaxConcurrent) return null

  // ZSet 按分数倒序取第一个（最高优先级最早）
  // ioredis 6 类型对索引参数标注为 string，运行时接受 number
  const members = await (redis.zrange as unknown as (k: string, a: number, b: number) => Promise<string[]>)(
    entQueueKey(enterpriseId), -1, -1,
  )
  if (members.length === 0) return null
  const member = members[0]!
  const taskId = member.split(":")[1]!

  // 原子移除（避免重复消费）
  const removed = await redis.zrem(entQueueKey(enterpriseId), member)
  if (removed === 0) return null
  await redis.zrem(GLOBAL_QUEUE_KEY, member)

  // 读取元数据
  const data = await redis.hgetall(entTaskKey(enterpriseId, taskId))
  if (!data || !data.taskId) return null

  // 并发计数 +1
  await redis.incr(entConcurrentKey(enterpriseId))
  await redis.hset(entTaskKey(enterpriseId, taskId), {
    status: "processing",
    startedAt: String(Date.now()),
  })

  return {
    taskId: data.taskId,
    enterpriseId: data.enterpriseId,
    modelId: data.modelId,
    prompt: data.prompt,
    imageSize: data.imageSize,
    imageCount: Number(data.imageCount),
    referenceImages: data.referenceImages ? JSON.parse(data.referenceImages) : [],
    priority: Number(data.priority),
    costPerImage: Number(data.costPerImage),
    apiTimeout: Number(data.apiTimeout),
    taskTimeout: Number(data.taskTimeout),
    maxRetries: Number(data.maxRetries),
  }
}

/** 扫描所有有待处理任务的企业（供消费者轮询） */
export async function listEnterprisesWithPendingTasks(): Promise<string[]> {
  const members = await (redis.zrange as unknown as (k: string, a: number, b: number) => Promise<string[]>)(
    GLOBAL_QUEUE_KEY, 0, -1,
  )
  const entIds = new Set<string>()
  for (const m of members) {
    const entId = m.split(":")[0]
    if (entId) entIds.add(entId)
  }
  return [...entIds]
}

/** 任务完成：并发计数 -1 */
export async function completeTask(
  enterpriseId: string,
  taskId: string,
): Promise<void> {
  await redis.decr(entConcurrentKey(enterpriseId))
  await redis.hset(entTaskKey(enterpriseId, taskId), {
    status: "completed",
    completedAt: String(Date.now()),
  })
  // 清理元数据（保留一段时间用于结果查询，由调用方控制删除）
}

/** 任务失败：并发计数 -1，可重试时重新入队 */
export async function failTask(
  enterpriseId: string,
  taskId: string,
  shouldRetry: boolean,
): Promise<void> {
  await redis.decr(entConcurrentKey(enterpriseId))
  await redis.hset(entTaskKey(enterpriseId, taskId), {
    status: shouldRetry ? "queued" : "failed",
    failedAt: String(Date.now()),
  })
  if (shouldRetry) {
    // 重新入队（优先级不变）
    const data = await redis.hgetall(entTaskKey(enterpriseId, taskId))
    if (data?.taskId) {
      const score = Number(data.priority) * 1e13 + Date.now()
      const member = `${enterpriseId}:${taskId}`
      await redis.zadd(entQueueKey(enterpriseId), score as unknown as string, member)
      await redis.zadd(GLOBAL_QUEUE_KEY, score as unknown as string, member)
    }
  }
}

/** 获取任务状态 */
export async function getTaskStatus(
  enterpriseId: string,
  taskId: string,
): Promise<Record<string, string> | null> {
  const data = await redis.hgetall(entTaskKey(enterpriseId, taskId))
  return data && Object.keys(data).length > 0 ? data : null
}

/** 生图速率计数（用于限流，§10.5） */
export async function incrGenerateRate(enterpriseId: string): Promise<number> {
  const key = entRateKey(enterpriseId)
  const n = await redis.incr(key)
  if (n === 1) await redis.expire(key, 60) // 每分钟窗口
  return n
}

export { env }
