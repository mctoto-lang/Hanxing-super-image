import { redis } from "@/lib/redis"

/**
 * 企业成员在线状态（Redis ZSET，key 命名遵循手册 §10.5）
 *
 * ZSET：member = userId，score = 最近心跳毫秒时间戳。
 * 客户端每 30s 心跳一次（GET /api/presence），超过在线窗口未见心跳即视为
 * 离线，由心跳顺带的 ZREMRANGEBYSCORE 清理，无需独立过期任务。
 *
 * 资源量级：每次心跳 3 个 O(log N) 命令，每在线用户约 100 字节内存。
 */

/** 在线判定窗口：心跳间隔 30s × 3，容忍两次心跳丢失 */
const ONLINE_WINDOW_MS = 90_000

const presenceKey = (enterpriseId: string) =>
  `hanxing:ent:${enterpriseId}:presence`

/** 心跳：刷新当前用户活跃时间，并清理窗口外的过期成员 */
export async function touchPresence(
  enterpriseId: string,
  userId: string,
): Promise<void> {
  const now = Date.now()
  await redis
    .multi()
    .zadd(presenceKey(enterpriseId), now, userId)
    .zremrangebyscore(
      presenceKey(enterpriseId),
      "-inf",
      now - ONLINE_WINDOW_MS,
    )
    .exec()
}

/** 在线用户 id 列表（按最近活跃倒序） */
export async function listOnlineUserIds(
  enterpriseId: string,
): Promise<string[]> {
  const now = Date.now()
  return redis.zrevrangebyscore(
    presenceKey(enterpriseId),
    "+inf",
    now - ONLINE_WINDOW_MS,
  )
}

/** 主动下线（登出时调用；不调用也会在窗口后自动过期） */
export async function removePresence(
  enterpriseId: string,
  userId: string,
): Promise<void> {
  await redis.zrem(presenceKey(enterpriseId), userId)
}
