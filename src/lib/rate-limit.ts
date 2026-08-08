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
