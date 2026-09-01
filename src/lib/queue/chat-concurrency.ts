import { redis } from "@/lib/redis"

/**
 * AI 对话流式并发槽（Redis 计数器 + TTL 自愈）
 *
 * 与生图槽（task-queue.ts acquireImageSlot）同款 Lua 模式，但独立计数：
 * 生图任务秒级~分钟级、对话流秒级，混用会互相挤占。
 *
 *   hanxing:chat:user:<uid>:concurrent   用户在途流数（防多标签页滥用）
 *   hanxing:chat:model:<modelId>:concurrent  模型全局在途流数（maxConcurrent）
 *
 * TTL 取模型 taskTimeout + 60s 缓冲：进程崩溃未 release 时计数器自动归零。
 */

const userChatKey = (userId: string) => `hanxing:chat:user:${userId}:concurrent`
const modelChatKey = (modelId: string) => `hanxing:chat:model:${modelId}:concurrent`

const ACQUIRE_CHAT_SLOT_LUA = `
local userCur = tonumber(redis.call('GET', KEYS[1]) or '0')
local userMax = tonumber(ARGV[1])
if userCur >= userMax then return 0 end
local modelMax = tonumber(ARGV[2])
if modelMax > 0 then
  local modelCur = tonumber(redis.call('GET', KEYS[2]) or '0')
  if modelCur >= modelMax then return 0 end
end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if modelMax > 0 then
  redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return 1
`

const RELEASE_CHAT_SLOT_LUA = `
for i = 1, #KEYS do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > 0 then redis.call('DECR', KEYS[i]) end
end
return 1
`

type RedisEval = (
  script: string,
  numKeys: number,
  ...args: unknown[]
) => Promise<number | string>

/** 单用户在途对话流上限 */
export const CHAT_USER_MAX_STREAMS = 3

export async function acquireChatSlot(opts: {
  userId: string
  modelId: string
  modelMaxConcurrent: number
  ttlSec: number
}): Promise<boolean> {
  const { userId, modelId, modelMaxConcurrent, ttlSec } = opts
  const res = await (redis.eval as unknown as RedisEval)(
    ACQUIRE_CHAT_SLOT_LUA,
    2,
    userChatKey(userId),
    modelChatKey(modelId),
    CHAT_USER_MAX_STREAMS,
    modelMaxConcurrent,
    ttlSec,
  )
  return Number(res) === 1
}

export async function releaseChatSlot(opts: {
  userId: string
  modelId: string
  modelMaxConcurrent: number
}): Promise<void> {
  const { userId, modelId, modelMaxConcurrent } = opts
  const keys =
    modelMaxConcurrent > 0
      ? [userChatKey(userId), modelChatKey(modelId)]
      : [userChatKey(userId)]
  await (redis.eval as unknown as RedisEval)(
    RELEASE_CHAT_SLOT_LUA,
    keys.length,
    ...keys,
  )
}
