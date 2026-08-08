import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { loginLogs, users } from "@/db/schema"

/**
 * 审计日志写入（手册 §10.7）
 *
 * 登录审计：记录所有登录尝试（成功/失败）。
 * 失败登录且用户名不存在时 userId/enterpriseId 为 NULL。
 */

export interface LoginLogInput {
  username: string
  ip: string
  userAgent: string
  success: boolean
  failureReason?: string
}

export async function writeLoginLog(input: LoginLogInput): Promise<void> {
  // 反查用户（失败登录时用户名可能不存在）
  const [user] = await db
    .select({ id: users.id, enterpriseId: users.enterpriseId })
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1)

  try {
    await db.insert(loginLogs).values({
      userId: user?.id ?? null,
      username: input.username,
      enterpriseId: user?.enterpriseId ?? null,
      ip: input.ip,
      userAgent: input.userAgent || null,
      success: input.success,
      failureReason: input.failureReason ?? null,
    })
  } catch (err) {
    // 审计日志失败不应影响主流程，仅打印
    console.error("[audit] writeLoginLog 失败:", err)
  }
}
