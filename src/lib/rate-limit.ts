import { redis } from "@/lib/redis"

/**
 * 基于 Redis 的限流（手册 §10.7）
 *
 * 登录限流：每 IP 15 分钟 10 次失败后锁定。
 * Key 命名遵循 §10.5 规范（登录限流按 IP，不带企业维度）。
 */

const LOGIN_WINDOW_SECONDS = 15 * 60 // 15 分钟
const LOGIN_MAX_FAILURES = 10

const LOGIN_KEY = (ip: string) => `hanxing:login:rate:${ip}`

export const loginRateLimiter = {
  /** 累计一次失败 */
  async increment(ip: string): Promise<number> {
    const key = LOGIN_KEY(ip)
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, LOGIN_WINDOW_SECONDS)
    }
    return count
  },

  /** 是否已被锁定（达到阈值） */
  async isLimited(ip: string): Promise<boolean> {
    const count = await redis.get(LOGIN_KEY(ip))
    if (!count) return false
    return Number(count) >= LOGIN_MAX_FAILURES
  },

  /** 登录成功后重置计数 */
  async reset(ip: string): Promise<void> {
    await redis.del(LOGIN_KEY(ip))
  },

  /** 当前失败计数（用于调试/展示） */
  async current(ip: string): Promise<number> {
    const count = await redis.get(LOGIN_KEY(ip))
    return count ? Number(count) : 0
  },
}

/**
 * AI 交互动作限流（用户级，手册 §10.5 同款 incr+expire 模式）
 *
 * 商品主图 V2 的 AI 帮写 / 智能匹配共享此额度（对话模型 token 成本防护）。
 * 每用户每分钟 5 次，超限由调用方提示「操作过于频繁」。
 */
const AI_ACTION_WINDOW_SECONDS = 60
const AI_ACTION_MAX_PER_WINDOW = 5

const AI_ACTION_KEY = (enterpriseId: string, userId: string) =>
  `hanxing:ent:${enterpriseId}:user:${userId}:ai:rate`

export const aiActionRateLimiter = {
  /** 累计一次并返回是否超限（true=已超限，应拒绝） */
  async consume(enterpriseId: string, userId: string): Promise<boolean> {
    const key = AI_ACTION_KEY(enterpriseId, userId)
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, AI_ACTION_WINDOW_SECONDS)
    }
    return Number(count) > AI_ACTION_MAX_PER_WINDOW
  },
}

/**
 * AI 对话消息限流（用户级，独立于商品 AI 动作额度）
 *
 * 交互式对话节奏快于批量 AI 动作，独立窗口：每用户每分钟 20 条。
 */
const CHAT_WINDOW_SECONDS = 60
const CHAT_MAX_PER_WINDOW = 20

const CHAT_KEY = (enterpriseId: string, userId: string) =>
  `hanxing:ent:${enterpriseId}:user:${userId}:chat:rate`

export const chatRateLimiter = {
  /** 累计一次并返回是否超限（true=已超限，应拒绝） */
  async consume(enterpriseId: string, userId: string): Promise<boolean> {
    const key = CHAT_KEY(enterpriseId, userId)
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, CHAT_WINDOW_SECONDS)
    }
    return Number(count) > CHAT_MAX_PER_WINDOW
  },
}
