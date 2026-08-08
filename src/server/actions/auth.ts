"use server"

import { AuthError } from "next-auth"
import { signIn, signOut } from "@/lib/auth/config"
import { loginSchema, type LoginInput } from "@/server/schemas/auth"
import { loginRateLimiter } from "@/lib/rate-limit"
import { writeLoginLog } from "@/lib/audit"
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

  // 登录限流
  const limited = await loginRateLimiter.isLimited(ip)
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
    // 成功：记录审计、重置限流计数
    await writeLoginLog({ username, ip, userAgent: h.get("user-agent") ?? "", success: true })
    await loginRateLimiter.reset(ip)
    return { ok: true, error: null }
  } catch (err) {
    // 失败：累计限流计数 + 审计
    await loginRateLimiter.increment(ip)
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
