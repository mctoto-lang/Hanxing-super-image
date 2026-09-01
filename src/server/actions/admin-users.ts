"use server"

import { and, count, eq, ilike, or } from "drizzle-orm"
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
import {
  allocateCreditsToUser,
  setUserCreditsBalance,
} from "@/server/services/credits-service"
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
    return { ok: false as const, error: "企业管理员（owner）需由平台超管处理" }
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
    return { ok: false as const, error: "企业管理员（owner）需由平台超管指定" }
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
    return { ok: false as const, error: "不能修改企业管理员（owner）的角色" }
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

/** 列表分页参数（管理端列表统一约定：page 从 1 开始） */
export interface ListPageParams {
  page?: number
  pageSize?: number
  q?: string
}

function normalizePage(opts: ListPageParams, defaultPageSize = 20) {
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? defaultPageSize)))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

/** 列出本企业成员（分页 + 可选搜索 username/昵称/邮箱） */
export async function listMembersAction(opts: ListPageParams = {}) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const { page, pageSize, offset } = normalizePage(opts)
  const q = opts.q?.trim()

  const scopeCond = eq(users.enterpriseId, enterpriseId)
  const where = q
    ? and(
        scopeCond,
        or(
          ilike(users.username, `%${q}%`),
          ilike(users.name, `%${q}%`),
          ilike(users.email, `%${q}%`),
        ),
      )
    : scopeCond

  const [items, [{ total }]] = await Promise.all([
    db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        email: users.email,
        image: users.image,
        enterpriseRole: users.enterpriseRole,
        groupId: users.groupId,
        groupName: permissionGroups.name,
        creditsBalance: users.creditsBalance,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .leftJoin(permissionGroups, eq(users.groupId, permissionGroups.id))
      .where(where)
      .orderBy(users.createdAt)
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(users).where(where),
  ])

  return { items, total, page, pageSize }
}

/**
 * 分配积分给本企业成员（需求 3：企业池 → 成员个人配额）
 *
 * 强制：目标成员必须属于本企业；允许向 owner（含自己）从企业池下发个人配额。
 */
export async function allocateCreditsToUserAction(input: {
  targetUserId: string
  amount: number
  remark?: string
}): Promise<{ ok: true; error: null; userBalanceAfter: number } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const amount = Math.floor(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "分配数量必须为正整数" }
  }
  if (amount > 1_000_000) {
    return { ok: false, error: "单次分配上限 100 万" }
  }

  // 目标必须属于本企业
  const [target] = await db
    .select({ id: users.id, enterpriseId: users.enterpriseId })
    .from(users)
    .where(and(eq(users.id, input.targetUserId), eq(users.enterpriseId, enterpriseId)))
    .limit(1)
  if (!target) return { ok: false, error: "成员不存在或不属于本企业" }

  try {
    const { userBalanceAfter } = await allocateCreditsToUser({
      enterpriseId,
      operatorUserId: ctx.user.id,
      targetUserId: input.targetUserId,
      amount,
      remark: input.remark ?? undefined,
    })
    revalidatePath("/admin/users")
    revalidatePath("/admin/credits")
    return { ok: true, error: null, userBalanceAfter }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "分配失败",
    }
  }
}

/**
 * 管理员编辑成员头像（imageUrl 为 null 即移除）。
 * 图片本体由 /api/upload/avatar 上传，此处只落 users.image。
 */
export async function setMemberAvatarAction(input: {
  userId: string
  imageUrl: string | null
}): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  if (
    input.imageUrl !== null &&
    (typeof input.imageUrl !== "string" ||
      input.imageUrl.length > 500 ||
      !/^(https?:\/\/|\/)/.test(input.imageUrl))
  ) {
    return { ok: false, error: "头像地址不合法" }
  }

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, input.userId), eq(users.enterpriseId, enterpriseId)))
    .limit(1)
  if (!target) return { ok: false, error: "成员不存在或不属于本企业" }

  await db
    .update(users)
    .set({ image: input.imageUrl, updatedAt: new Date() })
    .where(eq(users.id, input.userId))

  revalidatePath("/admin/users")
  return { ok: true, error: null }
}

/**
 * 将成员个人配额直接设为新余额（差额记账，type=adjustment）
 */
export async function adjustUserCreditsAction(input: {
  targetUserId: string
  newBalance: number
  remark?: string
}): Promise<
  | { ok: true; error: null; balanceAfter: number; delta: number }
  | { ok: false; error: string }
> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const newBalance = Math.floor(input.newBalance)
  if (!Number.isFinite(newBalance) || newBalance < 0) {
    return { ok: false, error: "新余额必须是不小于 0 的整数" }
  }
  if (newBalance > 100_000_000) {
    return { ok: false, error: "新余额超出上限" }
  }

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, input.targetUserId), eq(users.enterpriseId, enterpriseId)))
    .limit(1)
  if (!target) return { ok: false, error: "成员不存在或不属于本企业" }

  try {
    const result = await setUserCreditsBalance({
      enterpriseId,
      operatorUserId: ctx.user.id,
      targetUserId: input.targetUserId,
      newBalance,
      remark: input.remark?.trim() || undefined,
    })
    revalidatePath("/admin/users")
    revalidatePath("/admin/credits")
    return { ok: true, error: null, ...result }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "调整失败",
    }
  }
}
