import Redis from "ioredis"
import { env } from "@/lib/env"

/**
 * Redis 客户端单例（手册 §2.1、§5.4、§10.5）
 *
 * 用途：会话缓存、登录限流、任务队列状态、并发计数、热点缓存。
 *
 * 全局缓存单例，避免开发期 HMR 反复创建连接。
 */
const globalForRedis = globalThis as unknown as {
  __redis?: Redis
}

export const redis: Redis =
  globalForRedis.__redis ??
  new Redis(env.REDIS_URL, {
    // 连接失败时打印而不是直接崩（队列降级策略见 §R10）
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  })

if (process.env.NODE_ENV !== "production") {
  globalForRedis.__redis = redis
}

redis.on("error", (err) => {
  console.error("[redis] 连接错误:", err.message)
})
