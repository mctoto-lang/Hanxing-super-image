"use server"

import { and, eq, isNull } from "drizzle-orm"
import { db } from "@/db/client"
import {
  enterprises,
  permissionGroups,
  users,
  type ModuleName,
} from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import { hashPassword } from "@/lib/crypto"
import { rechargeCredits } from "@/server/services/credits-service"
import {
  createEnterpriseSchema,
  createUserSchema,
  rechargeSchema,
  updateModulesSchema,
} from "@/server/schemas/platform"
import { revalidatePath } from "next/cache"

/**
 * 平台超管 Server Actions（手册 M2、D20/D22）
 *
 * - createEnterprise（D20：唯一创建入口；含种子默认权限组 + enabledModules）
 * - createUserAndAssign（D19：超管建账号 + 分配企业 + 设初始角色）
 * - rechargeCredits（D8：企业充值）
 * - updateModules（D22：企业级模块开关）
 */

async function ensureDefaultGroup(enterpriseId: string, tx = db) {
  const [existing] = await tx
    .select()
    .from(permissionGroups)
    .where(
      and(
        eq(permissionGroups.enterpriseId, enterpriseId),
        eq(permissionGroups.isDefault, true),
      ),
    )
    .limit(1)
  if (existing) return existing

  const [group] = await tx
    .insert(permissionGroups)
    .values({
      enterpriseId,
      name: "默认组",
      description: "企业默认权限组",
      allowedModels: [],
      allowedPages: [],
      maxConcurrent: 2,
      priority: 0,
      isDefault: true,
    })
    .returning()
  return group!
}

/** 创建企业（D20：仅超管；同时创建默认权限组 + 初始 owner） */
export async function createEnterpriseAction(input: {
  name: string
  slug: string
  enabledModules?: ModuleName[]
  maxConcurrent?: number
  initialCredits?: number
  /** 同时创建首个 owner 的账号信息（可选） */
  owner?: { username: string; password: string; name?: string }
}) {
  const ctx = await requireSuperAdmin()
  const parsed = createEnterpriseSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  // slug 唯一性预检
  const [dup] = await db
    .select({ id: enterprises.id })
    .from(enterprises)
    .where(eq(enterprises.slug, d.slug))
    .limit(1)
  if (dup) return { ok: false as const, error: "slug 已存在" }

  const [enterprise] = await db
    .insert(enterprises)
    .values({
      name: d.name,
      slug: d.slug,
      enabledModules: d.enabledModules ?? ["create", "assets", "settings"],
      maxConcurrent: d.maxConcurrent ?? 5,
      creditsBalance: d.initialCredits ?? 0,
    })
    .returning()

  const group = await ensureDefaultGroup(enterprise!.id)

  // 创建 owner（可选）
  if (d.owner) {
    const hash = await hashPassword(d.owner.password)
    await db.insert(users).values({
      username: d.owner.username,
      name: d.owner.name ?? d.owner.username,
      passwordHash: hash,
      isSuperAdmin: false,
      enterpriseId: enterprise!.id,
      enterpriseRole: "owner",
      groupId: group.id,
    })
  }

  revalidatePath("/platform/enterprises")
  return {
    ok: true as const,
    error: null,
    enterpriseId: enterprise!.id,
  }
}

/** 超管建用户并分配企业（D19） */
export async function createUserAndAssignAction(input: {
  username: string
  password: string
  name?: string
  email?: string
  enterpriseId: string
  role?: "owner" | "admin" | "member"
  groupId?: string
}) {
  const ctx = await requireSuperAdmin()
  const parsed = createUserSchema.safeParse(input)
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

  // 未指定组则用企业默认组
  let groupId = d.groupId
  if (!groupId) {
    const [g] = await db
      .select()
      .from(permissionGroups)
      .where(
        and(
          eq(permissionGroups.enterpriseId, d.enterpriseId),
          eq(permissionGroups.isDefault, true),
        ),
      )
      .limit(1)
    groupId = g?.id
  }
  if (!groupId) return { ok: false as const, error: "企业未配置默认权限组" }

  const hash = await hashPassword(d.password)
  const [user] = await db
    .insert(users)
    .values({
      username: d.username,
      name: d.name ?? d.username,
      email: d.email ?? null,
      passwordHash: hash,
      isSuperAdmin: false,
      enterpriseId: d.enterpriseId,
      enterpriseRole: d.role ?? "member",
      groupId,
    })
    .returning()

  revalidatePath("/platform/users")
  return { ok: true as const, error: null, userId: user!.id }
}

/** 企业充值（D8：企业共享积分池） */
export async function rechargeCreditsAction(input: {
  enterpriseId: string
  amount: number
  remark?: string
}) {
  const ctx = await requireSuperAdmin()
  const parsed = rechargeSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  try {
    const { balanceAfter } = await rechargeCredits({
      enterpriseId: d.enterpriseId,
      amount: d.amount,
      userId: ctx.user.id,
      remark: d.remark ?? "平台充值",
    })
    revalidatePath("/platform/enterprises")
    return { ok: true as const, error: null, balanceAfter }
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "充值失败",
    }
  }
}

/** 更新企业模块开关（D22） */
export async function updateModulesAction(input: {
  enterpriseId: string
  modules: ModuleName[]
}) {
  const ctx = await requireSuperAdmin()
  const parsed = updateModulesSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  // 至少保留 settings（用户总能访问个人设置）
  const modules: ModuleName[] = d.modules.includes("settings")
    ? d.modules
    : ([...d.modules, "settings"] as ModuleName[])

  await db
    .update(enterprises)
    .set({ enabledModules: modules, updatedAt: new Date() })
    .where(eq(enterprises.id, d.enterpriseId))

  revalidatePath("/platform/enterprises")
  return { ok: true as const, error: null }
}

/** 列出所有企业（超管） */
export async function listEnterprisesAction() {
  const ctx = await requireSuperAdmin()
  return await db
    .select({
      id: enterprises.id,
      name: enterprises.name,
      slug: enterprises.slug,
      status: enterprises.status,
      creditsBalance: enterprises.creditsBalance,
      enabledModules: enterprises.enabledModules,
      maxConcurrent: enterprises.maxConcurrent,
      createdAt: enterprises.createdAt,
    })
    .from(enterprises)
    .orderBy(enterprises.createdAt)
}

/** 列出所有平台用户（超管） */
export async function listAllUsersAction() {
  const ctx = await requireSuperAdmin()
  return await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      isSuperAdmin: users.isSuperAdmin,
      enterpriseId: users.enterpriseId,
      enterpriseRole: users.enterpriseRole,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      enterpriseName: enterprises.name,
    })
    .from(users)
    .leftJoin(enterprises, eq(users.enterpriseId, enterprises.id))
    .orderBy(users.createdAt)
}

void isNull
