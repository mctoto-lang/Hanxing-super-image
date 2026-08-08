"use server"

import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { permissionGroups, users } from "@/db/schema"
import {
  requireEnterpriseAdmin,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { permissionGroupSchema } from "@/server/schemas/admin"
import { revalidatePath } from "next/cache"

/**
 * 权限组管理 Server Actions（手册 M2、D21）
 *
 * 权限组绑定企业（每企业可有多个组，至多一个 isDefault）。
 * 企业管理员（owner/admin）可 CRUD 本企业的权限组。
 */

/** 列出本企业的权限组 */
export async function listGroupsAction() {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  return await db
    .select({
      id: permissionGroups.id,
      name: permissionGroups.name,
      description: permissionGroups.description,
      allowedModels: permissionGroups.allowedModels,
      allowedPages: permissionGroups.allowedPages,
      maxConcurrent: permissionGroups.maxConcurrent,
      priority: permissionGroups.priority,
      isDefault: permissionGroups.isDefault,
      memberCount: db.$count(users, eq(users.groupId, permissionGroups.id)),
      createdAt: permissionGroups.createdAt,
    })
    .from(permissionGroups)
    .where(eq(permissionGroups.enterpriseId, enterpriseId))
    .orderBy(permissionGroups.createdAt)
}

/** 创建权限组 */
export async function createGroupAction(input: {
  name: string
  description?: string
  allowedModels?: string[]
  allowedPages?: string[]
  maxConcurrent?: number
  priority?: number
}) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const parsed = permissionGroupSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  const [group] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId,
      name: d.name,
      description: d.description ?? null,
      allowedModels: d.allowedModels,
      allowedPages: d.allowedPages,
      maxConcurrent: d.maxConcurrent,
      priority: d.priority,
      isDefault: false, // 默认组只能由系统创建
    })
    .returning()

  revalidatePath("/admin/groups")
  return { ok: true as const, error: null, groupId: group!.id }
}

/** 更新权限组 */
export async function updateGroupAction(
  groupId: string,
  input: {
    name: string
    description?: string
    allowedModels?: string[]
    allowedPages?: string[]
    maxConcurrent?: number
    priority?: number
  },
) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const parsed = permissionGroupSchema.partial().safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }

  // 组必须属于本企业
  const [existing] = await db
    .select()
    .from(permissionGroups)
    .where(
      and(
        eq(permissionGroups.id, groupId),
        eq(permissionGroups.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (!existing) return { ok: false as const, error: "权限组不存在" }
  if (existing.isDefault && parsed.data.name && parsed.data.name !== existing.name) {
    return { ok: false as const, error: "默认权限组不可改名" }
  }

  await db
    .update(permissionGroups)
    .set({
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined
        ? { description: parsed.data.description }
        : {}),
      ...(parsed.data.allowedModels
        ? { allowedModels: parsed.data.allowedModels }
        : {}),
      ...(parsed.data.allowedPages
        ? { allowedPages: parsed.data.allowedPages }
        : {}),
      ...(parsed.data.maxConcurrent
        ? { maxConcurrent: parsed.data.maxConcurrent }
        : {}),
      ...(parsed.data.priority !== undefined
        ? { priority: parsed.data.priority }
        : {}),
    })
    .where(eq(permissionGroups.id, groupId))

  revalidatePath("/admin/groups")
  return { ok: true as const, error: null }
}

/** 删除权限组（默认组不可删；组内有成员不可删） */
export async function deleteGroupAction(groupId: string) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  const [existing] = await db
    .select()
    .from(permissionGroups)
    .where(
      and(
        eq(permissionGroups.id, groupId),
        eq(permissionGroups.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (!existing) return { ok: false as const, error: "权限组不存在" }
  if (existing.isDefault) {
    return { ok: false as const, error: "默认权限组不可删除" }
  }

  // 检查组内是否还有成员
  const memberCount = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.groupId, groupId))
    .limit(1)
  if (memberCount.length > 0) {
    return { ok: false as const, error: "组内仍有成员，请先转移" }
  }

  await db.delete(permissionGroups).where(eq(permissionGroups.id, groupId))
  revalidatePath("/admin/groups")
  return { ok: true as const, error: null }
}
