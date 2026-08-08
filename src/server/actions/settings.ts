"use server"

import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { users } from "@/db/schema"
import { requireUserContext } from "@/lib/auth/session"
import {
  hashPassword,
  verifyPassword,
} from "@/lib/crypto"
import {
  updateProfileSchema,
  changePasswordSchema,
} from "@/server/schemas/settings"
import { revalidatePath } from "next/cache"

/**
 * 用户设置 Server Actions（手册 M4）
 *
 * 个人资料（昵称、邮箱）、改密码。
 */

export async function updateProfileAction(input: {
  name?: string
  email?: string
}) {
  const ctx = await requireUserContext()
  const parsed = updateProfileSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  await db
    .update(users)
    .set({
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.email !== undefined ? { email: d.email || null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, ctx.user.id))

  revalidatePath("/settings")
  return { ok: true, error: null }
}

export async function changePasswordAction(input: {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}) {
  const ctx = await requireUserContext()
  const parsed = changePasswordSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, ctx.user.id))
    .limit(1)
  if (!user) return { ok: false, error: "用户不存在" }

  const ok = await verifyPassword(d.currentPassword, user.passwordHash)
  if (!ok) return { ok: false, error: "当前密码错误" }

  const newHash = await hashPassword(d.newPassword)
  await db
    .update(users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, ctx.user.id))

  return { ok: true, error: null }
}

void and
