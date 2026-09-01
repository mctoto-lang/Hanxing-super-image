import { randomUUID } from "node:crypto"
import { redis } from "@/lib/redis"

/**
 * 工作台导出票据（Redis 存储，2 分钟过期，支持多实例部署）
 *
 * 独立于 "use server" actions 文件：导出下载路由（route handler）直接消费
 * 票据，不应依赖 server action 模块（会拖入 auth/next-auth 整条依赖链）。
 * action 与 route 都从这里导入。
 */

/** 导出票据 Redis key 前缀 */
const EXPORT_TICKET_KEY_PREFIX = "hanxing:export-ticket:"
/** 票据有效期（秒）——对齐旧实现「2 分钟过期」 */
const EXPORT_TICKET_TTL_SECONDS = 120

export interface ExportTicket {
  enterpriseId: string
  /** 绑定创建人：消费端校验 session 一致，防止票据在有效期内被他人使用 */
  userId: string
  taskId: string
  cardIds?: string[]
  format: string
}

/** 写入导出票据，返回一次性 token（2 分钟过期） */
export async function saveExportTicket(
  ticket: ExportTicket,
): Promise<string> {
  const token = randomUUID()
  // EX 设置过期，Redis 自动清理；无需手动遍历过期票据。
  await redis.set(
    EXPORT_TICKET_KEY_PREFIX + token,
    JSON.stringify(ticket),
    "EX",
    EXPORT_TICKET_TTL_SECONDS,
  )
  return token
}

/** 消费导出票据（供导出路由调用），过期或不存在返回 null。
 *  一次性消费：GETDEL 原子取出并删除，防止票据在有效期内被重放。
 *  过期票据由 Redis TTL 自动回收，无需手动清理。 */
export async function getExportTicket(
  token: string,
): Promise<ExportTicket | null> {
  const raw = await redis.getdel(EXPORT_TICKET_KEY_PREFIX + token)
  if (!raw) return null
  try {
    return JSON.parse(raw) as ExportTicket
  } catch {
    // 损坏数据直接当作无效票据
    return null
  }
}
