"use server"

import { AuthError } from "next-auth"
import { eq } from "drizzle-orm"
import { signIn, signOut } from "@/lib/auth/config"
import { db } from "@/db/client"
import { users } from "@/db/schema"
import { loginSchema, type LoginInput } from "@/server/schemas/auth"
import { loginRateLimiter } from "@/lib/rate-limit"
import { writeLoginLog } from "@/lib/audit"
import { postLoginPath } from "@/lib/auth/post-login"
import { headers } from "next/headers"

/**
 * 登录 Server Action（手册 §5.3、§10.7）
 *
 * 流程：
 *   1. zod 校验入参；
 *   2. IP 维度登录限流（每 IP 15 分钟 10 次失败锁定）；
 *   3. 调用 Auth.js signIn（Credentials Provider 内部校验密码）；
 *   4. 落 login_logs 审计表（成功/失败）。
 */
export async function loginAction(input: LoginInput) {
  const parsed = loginSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: "用户名或密码格式错误" }
  }
  const { username, password } = parsed.data

  const h = await headers()
  const ip = getClientIp(h)

  // 双维度限流：IP（防单机爆破）+ 用户名（x-forwarded-for 可被客户端伪造
  // 轮换 IP 键绕过纯 IP 限流；同一账号无论来自哪个"IP"，失败计数共用）
  const ipKey = `ip:${ip}`
  const userKey = `u:${username.toLowerCase()}`
  const limited =
    (await loginRateLimiter.isLimited(ipKey)) ||
    (await loginRateLimiter.isLimited(userKey))
  if (limited) {
    return {
      ok: false,
      error: "登录失败次数过多，请稍后再试（15 分钟）",
    }
  }

  try {
    await signIn("credentials", {
      username,
      password,
      redirect: false,
    })
    // 成功：记录审计、重置限流计数；按角色返回落地页（超管 → /platform）
    await writeLoginLog({ username, ip, userAgent: h.get("user-agent") ?? "", success: true })
    await loginRateLimiter.reset(ipKey)
    await loginRateLimiter.reset(userKey)
    let redirectTo = postLoginPath(false)
    try {
      const [u] = await db
        .select({ isSuperAdmin: users.isSuperAdmin })
        .from(users)
        .where(eq(users.username, username))
        .limit(1)
      redirectTo = postLoginPath(u?.isSuperAdmin ?? false)
    } catch {
      // 查询失败按普通用户跳转，不影响登录本身
    }
    return { ok: true, error: null, redirectTo }
  } catch (err) {
    // 仅凭证类失败计入限流；基础设施异常（如 DB 闪断）不计，避免误锁真实用户
    if (err instanceof AuthError) {
      await loginRateLimiter.increment(ipKey)
      await loginRateLimiter.increment(userKey)
    }
    const reason = err instanceof AuthError ? err.type : "unknown"
    await writeLoginLog({
      username,
      ip,
      userAgent: h.get("user-agent") ?? "",
      success: false,
      failureReason: reason,
    })

    if (err instanceof AuthError) {
      return { ok: false, error: "用户名或密码错误" }
    }
    throw err // 非 AuthError 的意外错误向上抛
  }
}

/** 登出 */
export async function logoutAction() {
  await signOut({ redirect: false })
  return { ok: true }
}

function getClientIp(h: Headers): string {
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip") ??
    "unknown"
  )
}
