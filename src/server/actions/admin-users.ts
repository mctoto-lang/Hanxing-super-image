"use server"

import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  permissionGroups,
  users,
  type EnterpriseRole,
} from "@/db/schema"
import {
  requireEnterpriseAdmin,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { hashPassword } from "@/lib/crypto"
import {
  createMemberSchema,
  changeRoleSchema,
  assignGroupSchema,
} from "@/server/schemas/admin"
import { revalidatePath } from "next/cache"

/**
 * 企业管理员 Server Actions（手册 M2、D19）
 *
 * 企业管理员负责本企业内成员增删、改角色、分配权限组。
 * 全部强制 enterpriseId 隔离（只能管本企业成员）。
 */

/** 增加成员到本企业 */
export async function createMemberAction(input: {
  username: string
  password: string
  name?: string
  email?: string
  role?: EnterpriseRole
  groupId?: string
}) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const parsed = createMemberSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  // 用户名全局唯一
  const [dup] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, d.username))
    .limit(1)
  if (dup) return { ok: false as const, error: "用户名已存在" }

  // 组必须属于本企业（或用默认组）
  let groupId = d.groupId
  if (!groupId) {
    const [g] = await db
      .select()
      .from(permissionGroups)
      .where(
        and(
          eq(permissionGroups.enterpriseId, enterpriseId),
          eq(permissionGroups.isDefault, true),
        ),
      )
      .limit(1)
    groupId = g?.id
  }
  if (!groupId) return { ok: false as const, error: "未配置默认权限组" }

  const hash = await hashPassword(d.password)
  // 企业管理员不能创建 owner（只能超管指定）
  const role: EnterpriseRole = d.role === "owner" ? "member" : (d.role ?? "member")

  await db.insert(users).values({
    username: d.username,
    name: d.name ?? d.username,
    email: d.email ?? null,
    passwordHash: hash,
    isSuperAdmin: false,
    enterpriseId,
    enterpriseRole: role,
    groupId,
  })

  revalidatePath("/admin/users")
  return { ok: true as const, error: null }
}

/** 删除成员（只能删本企业，不能删超管，不能删自己） */
export async function removeMemberAction(userId: string) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  if (userId === ctx.user.id) {
    return { ok: false, error: "不能删除自己" }
  }

  const [target] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.enterpriseId, enterpriseId)))
    .limit(1)
  if (!target) return { ok: false as const, error: "成员不存在" }
  if (target.isSuperAdmin) return { ok: false as const, error: "不能删除超管" }
  // owner 只能由超管处理
  if (target.enterpriseRole === "owner") {
    return { ok: false as const, error: "企业主需由平台超管处理" }
  }

  await db.delete(users).where(eq(users.id, userId))
  revalidatePath("/admin/users")
  return { ok: true as const, error: null }
}

/** 改成员角色（admin 可改 member↔admin，不能改 owner） */
export async function changeRoleAction(input: {
  userId: string
  role: EnterpriseRole
}) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const parsed = changeRoleSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data
  if (d.role === "owner") {
    return { ok: false as const, error: "企业主需由平台超管指定" }
  }
  if (d.userId === ctx.user.id) {
    return { ok: false as const, error: "不能修改自己的角色" }
  }

  const [target] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, d.userId), eq(users.enterpriseId, enterpriseId)))
    .limit(1)
  if (!target) return { ok: false as const, error: "成员不存在" }
  if (target.enterpriseRole === "owner") {
    return { ok: false as const, error: "不能修改企业主的角色" }
  }

  await db
    .update(users)
    .set({ enterpriseRole: d.role, updatedAt: new Date() })
    .where(eq(users.id, d.userId))

  revalidatePath("/admin/users")
  return { ok: true as const, error: null }
}

/** 分配成员到权限组 */
export async function assignGroupAction(input: {
  userId: string
  groupId: string
}) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const parsed = assignGroupSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  // 组必须属于本企业
  const [group] = await db
    .select()
    .from(permissionGroups)
    .where(
      and(
        eq(permissionGroups.id, d.groupId),
        eq(permissionGroups.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (!group) return { ok: false as const, error: "权限组不存在" }

  const [target] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, d.userId), eq(users.enterpriseId, enterpriseId)))
    .limit(1)
  if (!target) return { ok: false as const, error: "成员不存在" }

  await db
    .update(users)
    .set({ groupId: d.groupId, updatedAt: new Date() })
    .where(eq(users.id, d.userId))

  revalidatePath("/admin/users")
  return { ok: true as const, error: null }
}

/** 列出本企业成员 */
export async function listMembersAction() {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  return await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      enterpriseRole: users.enterpriseRole,
      groupId: users.groupId,
      groupName: permissionGroups.name,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(permissionGroups, eq(users.groupId, permissionGroups.id))
    .where(eq(users.enterpriseId, enterpriseId))
    .orderBy(users.createdAt)
}
