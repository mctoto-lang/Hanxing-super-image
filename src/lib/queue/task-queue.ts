import { redis } from "@/lib/redis"
import { env } from "@/lib/env"

/**
 * 基于 Redis 的分布式任务队列（手册 §5.4、§10.5）
 *
 * 结构（每个企业独立队列，Key 全部带 enterpriseId 前缀）：
 *   hanxing:ent:<entId>:queue:tasks    ZSet（score=priority*1e13 + (1e13-timestamp)，高优先级先执行 + 同优先级 FIFO）
 *   hanxing:ent:<entId>:task:<id>      Hash（任务元数据：modelId/prompt/imageSize/status...）
 *   hanxing:ent:<entId>:concurrent     String（企业在途图片计数，图片级，TTL 兜底自愈）
 *   hanxing:model:<modelId>:concurrent String（模型在途图片计数，跨企业全局，图片级，TTL 兜底自愈）
 *   hanxing:queue:global               ZSet（全局待处理，消费者扫描入口）
 *
 * 并发上限（图片级计数）：企业在途图片数 ≤ enterprise.maxConcurrent；
 * 同一模型全局在途图片数 ≤ model.maxConcurrent（≤0 视为不限）。
 * 出队仅要求企业至少剩 1 个图片槽位；实际占用由处理阶段逐张 acquire/release。
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
function modelConcurrentKey(modelId: string) {
  return `hanxing:model:${modelId}:concurrent`
}

/**
 * 原子获取一个图片槽位（企业 + 模型 + 权限组三条件，Lua 保证多 worker 安全）。
 * 任一条件不满足则不动计数并返回 0；成功则各计数器 +1 并续期 TTL。
 * modelMax / groupMax ≤ 0 表示该维度不限（跳过检查与计数）。
 */
const ACQUIRE_SLOT_LUA = `
local function overLimit(i, maxArg)
  local max = tonumber(maxArg)
  if max == nil or max <= 0 then return false end
  local cur = tonumber(redis.call('GET', KEYS[i]) or '0')
  return cur >= max
end
if overLimit(1, ARGV[1]) then return 0 end
if overLimit(2, ARGV[2]) then return 0 end
if overLimit(3, ARGV[3]) then return 0 end
for i = 1, 3 do
  local max = tonumber(ARGV[i])
  if max ~= nil and max > 0 then
    redis.call('INCR', KEYS[i])
    redis.call('EXPIRE', KEYS[i], ARGV[4])
  end
end
return 1
`

/** 原子释放一个图片槽位（计数器减到 0 为止，防负数；key 已过期则跳过） */
const RELEASE_SLOT_LUA = `
for i = 1, #KEYS do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > 0 then redis.call('DECR', KEYS[i]) end
end
return 1
`

/** 权限组图片并发计数（group.maxConcurrent 执行层） */
function groupConcurrentKey(groupId: string) {
  return `hanxing:group:${groupId}:concurrent`
}

/**
 * 获取图片槽位：企业 + 模型 + 权限组并发均未满时占用一个，返回是否成功。
 * 不限的维度传 ≤0（该维度不检查也不计数）；无 groupId 时组维度不生效。
 */
export async function acquireImageSlot(opts: {
  enterpriseId: string
  modelId: string
  groupId?: string | null
  enterpriseMaxConcurrent: number
  modelMaxConcurrent: number
  groupMaxConcurrent?: number | null
  ttlSec: number
}): Promise<boolean> {
  const {
    enterpriseId,
    modelId,
    groupId,
    enterpriseMaxConcurrent,
    modelMaxConcurrent,
    groupMaxConcurrent,
    ttlSec,
  } = opts
  // 三个 key 恒传（不限的维度指向占位 key，Lua 内 max<=0 不会读写它）
  const res = await (redis.eval as unknown as (
    script: string,
    numKeys: number,
    ...args: unknown[]
  ) => Promise<number | string>)(
    ACQUIRE_SLOT_LUA,
    3,
    entConcurrentKey(enterpriseId),
    modelConcurrentKey(modelId),
    groupId ? groupConcurrentKey(groupId) : entConcurrentKey(enterpriseId),
    enterpriseMaxConcurrent,
    modelMaxConcurrent,
    groupMaxConcurrent ?? 0,
    ttlSec,
  )
  return Number(res) === 1
}

/** 释放图片槽位（受限维度的计数器各 -1，幂等防负） */
export async function releaseImageSlot(opts: {
  enterpriseId: string
  modelId: string
  groupId?: string | null
  modelMaxConcurrent: number
  groupMaxConcurrent?: number | null
}): Promise<void> {
  const { enterpriseId, modelId, groupId, modelMaxConcurrent, groupMaxConcurrent } = opts
  const keys = [entConcurrentKey(enterpriseId)]
  if (modelMaxConcurrent > 0) keys.push(modelConcurrentKey(modelId))
  if (groupId && (groupMaxConcurrent ?? 0) > 0) {
    keys.push(groupConcurrentKey(groupId))
  }
  await (redis.eval as unknown as (
    script: string,
    numKeys: number,
    ...args: unknown[]
  ) => Promise<number | string>)(RELEASE_SLOT_LUA, keys.length, ...keys)
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
  /** 所属创作会话（用于任务完成后回写会话缩略图） */
  conversationId?: string | null
  /** 待生成的图片序号（部分失败重试时仅补失败张）；缺省 = 全部 imageCount 张 */
  pendingIndexes?: number[]
}

/** 入队：写入企业队列 + 全局队列 */
export async function enqueue(task: QueueTaskInput): Promise<void> {
  await enqueueMany([task])
}

/**
 * 批量入队：所有任务打包进一次 Redis pipeline 往返（工作台批量提交场景）。
 * score 的时间分量取反（1e13 - timestamp）：同毫秒内按序号递减，出队端
 * 取最高分 → 同优先级下先提交的先执行（FIFO）。Date.now() < 1e13 直到
 * 2286 年，时间分量恒为正且不会侵入相邻优先级桶。
 */
export async function enqueueMany(tasks: QueueTaskInput[]): Promise<void> {
  if (tasks.length === 0) return

  const base = Date.now()
  const pipeline = redis.pipeline()
  tasks.forEach((task, idx) => {
    // 元数据存 Hash
    pipeline.hset(entTaskKey(task.enterpriseId, task.taskId), {
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
      conversationId: task.conversationId ?? "",
      pendingIndexes: task.pendingIndexes ? JSON.stringify(task.pendingIndexes) : "",
      status: "queued",
      enqueuedAt: String(base + idx),
    } as Record<string, string>)

    // score = priority * 1e13 + (1e13 - timestamp)（数字大先执行；
    // 时间取反使同优先级下越早提交分数越高 → FIFO）
    const score = task.priority * 1e13 + (1e13 - (base + idx))
    const member = `${task.enterpriseId}:${task.taskId}`
    // ioredis 6 类型对 zadd 的 score 标注为 string，这里强制断言
    pipeline.zadd(entQueueKey(task.enterpriseId), score as unknown as string, member)
    pipeline.zadd(GLOBAL_QUEUE_KEY, score as unknown as string, member)
  })
  await pipeline.exec()
}

/** 出队：取下一个可执行任务（要求企业至少剩 1 个图片槽位；实际槽位由处理阶段逐张占用） */
export async function dequeueNext(opts: {
  enterpriseId: string
  enterpriseMaxConcurrent: number
}): Promise<QueueTaskInput | null> {
  const { enterpriseId, enterpriseMaxConcurrent } = opts

  // 检查企业图片并发是否已满（无槽位则本轮不再出队）。
  // maxConcurrent <= 0 与 Lua 槽位脚本、effectiveConcurrentLimit 语义一致：
  // 视为不限制（若按 0 比较，0 >= 0 恒真 → 该企业任务永远不出队）
  const current = Number((await redis.get(entConcurrentKey(enterpriseId))) ?? 0)
  if (enterpriseMaxConcurrent > 0 && current >= enterpriseMaxConcurrent) {
    return null
  }

  // ZSet 按分数倒序取第一个（最高优先级；同优先级因时间分量取反，
  // 最高分 = 最早提交 → FIFO）
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
  if (!data || !data.taskId) {
    // 元数据缺失：任务从队列消失但无法处理。不占用并发计数，
    // 并把 DB 端的孤儿任务交由调用方兜底清理（避免任务永久丢失）。
    console.warn(
      `[queue] 任务 ${taskId} 出队后元数据缺失（Hash 为空），交由孤儿回收兜底`,
    )
    return null
  }

  // 注意：出队不再预占并发计数（图片级计数由处理阶段 acquireImageSlot 逐张占用，
  // 计数器 TTL 自愈也改在 acquire 时续期）。
  await redis.hset(entTaskKey(enterpriseId, taskId), {
    status: "processing",
    startedAt: String(Date.now()),
  })

  let pendingIndexes: number[] | undefined
  if (data.pendingIndexes) {
    try {
      const parsed = JSON.parse(data.pendingIndexes)
      if (Array.isArray(parsed) && parsed.length > 0) pendingIndexes = parsed
    } catch {
      // 非法数据按全部生成处理
    }
  }

  return {
    taskId: data.taskId,
    enterpriseId: data.enterpriseId,
    modelId: data.modelId,
    prompt: data.prompt,
    // 尺寸兜底：异常入队缺尺寸时按默认 1024x1024，避免请求体缺 size 字段
    imageSize: data.imageSize || "1024x1024",
    imageCount: Number(data.imageCount),
    referenceImages: data.referenceImages ? JSON.parse(data.referenceImages) : [],
    priority: Number(data.priority),
    costPerImage: Number(data.costPerImage),
    apiTimeout: Number(data.apiTimeout),
    taskTimeout: Number(data.taskTimeout),
    maxRetries: Number(data.maxRetries),
    conversationId: data.conversationId || null,
    pendingIndexes,
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

/** 任务是否仍在企业待处理队列中（孤儿任务回收判断用；不在队列 = 已被消费或丢失） */
export async function isTaskInQueue(
  enterpriseId: string,
  taskId: string,
): Promise<boolean> {
  const rank = await (redis.zrank as unknown as (
    k: string,
    m: string,
  ) => Promise<number | null>)(entQueueKey(enterpriseId), `${enterpriseId}:${taskId}`)
  return rank !== null
}

/** 任务元数据 Hash 的终态保留期（终态后仅剩排查价值，到期自动清理防内存泄漏） */
const TASK_META_TTL_SEC = 7 * 24 * 3600

/** 任务完成：更新元数据并设置 TTL（图片槽位已在处理阶段逐张释放，这里不动计数器） */
export async function completeTask(
  enterpriseId: string,
  taskId: string,
): Promise<void> {
  const key = entTaskKey(enterpriseId, taskId)
  await redis.hset(key, {
    status: "completed",
    completedAt: String(Date.now()),
  })
  await redis.expire(key, TASK_META_TTL_SEC)
}

/** 任务失败：可重试时重新入队（图片槽位已逐张释放，不动计数器）；终态设 TTL */
export async function failTask(
  enterpriseId: string,
  taskId: string,
  shouldRetry: boolean,
): Promise<void> {
  const key = entTaskKey(enterpriseId, taskId)
  await redis.hset(key, {
    status: shouldRetry ? "queued" : "failed",
    failedAt: String(Date.now()),
  })
  if (!shouldRetry) {
    await redis.expire(key, TASK_META_TTL_SEC)
    return
  }
  // 重新入队（优先级不变；时间分量取反与 enqueueMany 一致，重试按当前
  // 时间排队、不插队）
  const data = await redis.hgetall(key)
  if (data?.taskId) {
    const score = Number(data.priority) * 1e13 + (1e13 - Date.now())
    const member = `${enterpriseId}:${taskId}`
    await redis.zadd(entQueueKey(enterpriseId), score as unknown as string, member)
    await redis.zadd(GLOBAL_QUEUE_KEY, score as unknown as string, member)
  }
}

/** 更新任务待生成序号（部分失败重试仅补失败张；须在 failTask 重新入队前写入） */
export async function setTaskPendingIndexes(
  enterpriseId: string,
  taskId: string,
  indexes: number[],
): Promise<void> {
  await redis.hset(entTaskKey(enterpriseId, taskId), {
    pendingIndexes: JSON.stringify(indexes),
  } as Record<string, string>)
}

/** 获取任务状态 */
export async function getTaskStatus(
  enterpriseId: string,
  taskId: string,
): Promise<Record<string, string> | null> {
  const data = await redis.hgetall(entTaskKey(enterpriseId, taskId))
  return data && Object.keys(data).length > 0 ? data : null
}

export { env }
