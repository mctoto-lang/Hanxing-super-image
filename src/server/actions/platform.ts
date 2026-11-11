"use server"

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  sum,
} from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  chatConversations,
  chatMessages,
  enterprises,
  enterpriseSubscriptions,
  generationTasks,
  models,
  permissionGroups,
  subscriptionPlans,
  systemSettings,
  users,
  type ModuleName,
  type SystemSettingValue,
} from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import { encrypt, hashPassword } from "@/lib/crypto"
import {
  decryptTemuSecret,
  encryptTemuSecret,
  isMaskedTemuSecret,
  loadTemuAppConfig,
  maskTemuSecret,
  saveTemuAppConfig,
} from "@/lib/temu-api/app-config"
import { listTransactions, rechargeCredits } from "@/server/services/credits-service"
import {
  createEnterpriseSchema,
  createUserSchema,
  rechargeSchema,
  updateModulesSchema,
  updateEnterpriseConcurrencySchema,
  updateEnterpriseModelConfigSchema,
  updateEnterpriseInfoSchema,
  setEnterpriseStatusSchema,
  updatePlatformUserSchema,
  setPlatformUserStatusSchema,
  resetPlatformUserPasswordSchema,
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
  chatMaxConcurrent?: number
  initialCredits?: number
  allowCustomModels?: boolean
  visiblePresetModels?: string[]
  visiblePresetChatModels?: string[]
  /** 同时创建首个 owner 的账号信息（可选） */
  owner?: { username: string; password: string; name?: string }
}) {
  await requireSuperAdmin()
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
      enabledModules: d.enabledModules ?? ["create", "assets", "mockup", "settings", "inventory"],
      maxConcurrent: d.maxConcurrent ?? 5,
      chatMaxConcurrent: d.chatMaxConcurrent ?? 5,
      creditsBalance: d.initialCredits ?? 0,
      allowCustomModels: d.allowCustomModels ?? true,
      visiblePresetModels: d.visiblePresetModels ?? [],
      visiblePresetChatModels: d.visiblePresetChatModels ?? [],
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
  await requireSuperAdmin()
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

/**
 * 超管编辑平台用户（用户名/昵称/类型/归属企业/角色）。
 *
 * 保护口径：
 * - 不能编辑当前登录账号（自身类型/归属变更易把自己锁死）；
 * - username 全局唯一（排除自身）；
 * - 提升为超管：强制清空企业/权限组、角色回落 member；
 * - owner 兜底：目标当前是 owner 且将失去 owner 身份（降角色/转企业/转超管）
 *   时，若其是企业最后一个可用 owner 则拒绝（与企业侧「owner 由超管处理」
 *   口径互补：超管可以动 owner，但不能让企业没有 owner）；检查与更新同
 *   事务 + owner 行锁，并发操作不会让企业失去全部 owner；
 * - 跨企业转移：权限组属于企业，回落目标企业默认组（无则自动创建）。
 */
export async function updatePlatformUserAction(input: {
  userId: string
  username: string
  name?: string
  isSuperAdmin: boolean
  /** 空串 = 无企业（仅超管合法） */
  enterpriseId: string
  enterpriseRole: "owner" | "admin" | "member"
}) {
  const ctx = await requireSuperAdmin()
  const parsed = updatePlatformUserSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  if (d.userId === ctx.user.id) {
    return {
      ok: false as const,
      error: "不能编辑当前登录账号（自身信息请走个人设置，或由其他超管操作）",
    }
  }

  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, d.userId))
    .limit(1)
  if (!target) return { ok: false as const, error: "用户不存在" }

  // username 全局唯一（排除自身）
  if (d.username !== target.username) {
    const [dup] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, d.username), ne(users.id, d.userId)))
      .limit(1)
    if (dup) return { ok: false as const, error: "用户名已存在" }
  }

  const nextEnterpriseId = d.isSuperAdmin ? null : d.enterpriseId || null
  if (!d.isSuperAdmin && !nextEnterpriseId) {
    return { ok: false as const, error: "企业用户必须归属企业" }
  }

  // owner 兜底：将失去 owner 身份（降角色 / 离开企业 / 转超管）时，
  // 原企业必须还有其他可用（active）owner。
  // 检查与更新在同一事务内（对原企业全部可用 owner 行 FOR UPDATE，
  // 含目标本身）：两名超管并发处理同一企业最后两个 owner 时，
  // 后到者会看到先行者已提交的结果并被拒绝，企业不会失去全部 owner
  const losesOwner =
    target.enterpriseRole === "owner" &&
    (d.isSuperAdmin ||
      nextEnterpriseId !== target.enterpriseId ||
      d.enterpriseRole !== "owner")

  // 跨企业转移：权限组回落目标企业默认组（组不可跨企业保留）
  let nextGroupId = target.groupId
  if (nextEnterpriseId !== target.enterpriseId) {
    nextGroupId = nextEnterpriseId ? (await ensureDefaultGroup(nextEnterpriseId)).id : null
  }

  const nextValues = {
    username: d.username,
    name: d.name?.trim() || null,
    isSuperAdmin: d.isSuperAdmin,
    enterpriseId: nextEnterpriseId,
    enterpriseRole: d.isSuperAdmin ? "member" : d.enterpriseRole,
    groupId: nextGroupId,
    updatedAt: new Date(),
  }

  if (losesOwner && target.enterpriseId) {
    const originEnterpriseId = target.enterpriseId
    const guarded = await db.transaction(async (tx) => {
      // 锁原企业全部可用 owner 行（含目标）：并发的降角色/转企业/转超管/
      // 停用（setPlatformUserStatus 同口径加锁）在此串行化
      const owners = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.enterpriseId, originEnterpriseId),
            eq(users.enterpriseRole, "owner"),
            eq(users.status, "active"),
          ),
        )
        .for("update")
      if (!owners.some((o) => o.id !== d.userId)) {
        return {
          ok: false as const,
          error: "该企业仅剩此一名可用的企业管理员（owner），请先为其指定新 owner 再操作",
        }
      }
      await tx.update(users).set(nextValues).where(eq(users.id, d.userId))
      return { ok: true as const }
    })
    if (!guarded.ok) return guarded
  } else {
    await db.update(users).set(nextValues).where(eq(users.id, d.userId))
  }

  revalidatePath("/platform/users")
  revalidatePath("/platform/enterprises")
  return { ok: true as const, error: null }
}

/**
 * 停用/启用平台用户（超管；owner 由超管处理的企业侧口径的对应入口）。
 *
 * 停用后无法登录、在途会话周期复核时即时降权；不能操作自己；
 * 停用最后一个可用 owner 拒绝（口径同 updatePlatformUser：检查与更新
 * 同事务 + owner 行锁，并发安全）。
 */
export async function setPlatformUserStatusAction(input: {
  userId: string
  status: "active" | "disabled"
}) {
  const ctx = await requireSuperAdmin()
  const parsed = setPlatformUserStatusSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  if (d.userId === ctx.user.id) {
    return { ok: false as const, error: "不能停用/启用当前登录账号" }
  }

  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, d.userId))
    .limit(1)
  if (!target) return { ok: false as const, error: "用户不存在" }

  if (
    d.status === "disabled" &&
    target.enterpriseRole === "owner" &&
    target.enterpriseId !== null
  ) {
    const originEnterpriseId = target.enterpriseId
    // 检查与更新同一事务 + FOR UPDATE（口径同 updatePlatformUser 的
    // owner 兜底）：并发停用同一企业最后两个 owner 时后到者被拒绝
    const guarded = await db.transaction(async (tx) => {
      const owners = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.enterpriseId, originEnterpriseId),
            eq(users.enterpriseRole, "owner"),
            eq(users.status, "active"),
          ),
        )
        .for("update")
      if (!owners.some((o) => o.id !== d.userId)) {
        return {
          ok: false as const,
          error: "该企业仅剩此一名可用的企业管理员（owner），请先指定新 owner 再停用",
        }
      }
      await tx
        .update(users)
        .set({ status: d.status, updatedAt: new Date() })
        .where(eq(users.id, d.userId))
      return { ok: true as const }
    })
    if (!guarded.ok) return guarded
  } else {
    await db
      .update(users)
      .set({ status: d.status, updatedAt: new Date() })
      .where(eq(users.id, d.userId))
  }

  revalidatePath("/platform/users")
  return { ok: true as const, error: null }
}

/**
 * 超管重置平台用户密码。
 *
 * 可重置任何人（含 owner——owner 忘密码的唯一兜底）；不能重置自己
 * （走个人设置）。重置后请将新密码线下告知本人。
 *
 * 会话口径（维持现状）：JWT 无状态、无密码版本校验，重置密码不会
 * 吊销该用户已登录的会话；成功返回 hint 提示超管「如需强制下线请先
 * 停用再启用」（停用经 getCurrentUserContext 每请求复核 user.status，
 * 可即时断权）。仅超管重置这一处提示；管理员重置成员/自助修改不在此列。
 */
export async function resetPlatformUserPasswordAction(input: {
  userId: string
  newPassword: string
}) {
  const ctx = await requireSuperAdmin()
  const parsed = resetPlatformUserPasswordSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  if (d.userId === ctx.user.id) {
    return { ok: false as const, error: "不能在此重置自己的密码（请走个人设置）" }
  }

  const [target] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.id, d.userId))
    .limit(1)
  if (!target) return { ok: false as const, error: "用户不存在" }

  const hash = await hashPassword(d.newPassword)
  await db
    .update(users)
    .set({ passwordHash: hash, updatedAt: new Date() })
    .where(eq(users.id, d.userId))

  return {
    ok: true as const,
    error: null,
    hint: "重置密码不会使该用户已登录的会话失效；如需强制下线，请先停用再启用该账号",
  }
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
  await requireSuperAdmin()
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

/**
 * 更新企业级并发上限（企业管理页设置）：
 * - maxConcurrent 生图并发（Redis 槽位跨副本强制，原有逻辑不变）
 * - chatMaxConcurrent 对话并发（/chat 流式在途流数）
 */
export async function updateEnterpriseConcurrencyAction(input: {
  enterpriseId: string
  maxConcurrent: number
  chatMaxConcurrent: number
}) {
  await requireSuperAdmin()
  const parsed = updateEnterpriseConcurrencySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  await db
    .update(enterprises)
    .set({
      maxConcurrent: d.maxConcurrent,
      chatMaxConcurrent: d.chatMaxConcurrent,
      updatedAt: new Date(),
    })
    .where(eq(enterprises.id, d.enterpriseId))

  revalidatePath("/platform/enterprises")
  return { ok: true as const, error: null }
}

/**
 * 更新企业模型配置（需求 2b）
 *
 * - allowCustomModels：是否允许企业自建私有模型
 * - visiblePresetModels：可见的平台预置模型 id 白名单（空 = 全部可见）
 * - visiblePresetChatModels：可见的平台预置对话模型 id 白名单（空 = 全部可见）
 */
export async function updateEnterpriseModelConfigAction(input: {
  enterpriseId: string
  allowCustomModels: boolean
  visiblePresetModels: string[]
  visiblePresetChatModels: string[]
}) {
  await requireSuperAdmin()
  const parsed = updateEnterpriseModelConfigSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  await db
    .update(enterprises)
    .set({
      allowCustomModels: d.allowCustomModels,
      visiblePresetModels: d.visiblePresetModels,
      visiblePresetChatModels: d.visiblePresetChatModels,
      updatedAt: new Date(),
    })
    .where(eq(enterprises.id, d.enterpriseId))

  revalidatePath("/platform/enterprises")
  return { ok: true as const, error: null }
}

/** 更新企业基本信息（名称/Slug/Logo，超管；slug 唯一性排除自身） */
export async function updateEnterpriseInfoAction(input: {
  enterpriseId: string
  name?: string
  slug?: string
  logoUrl?: string | null
}) {
  await requireSuperAdmin()
  const parsed = updateEnterpriseInfoSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  if (d.slug) {
    const [dup] = await db
      .select({ id: enterprises.id })
      .from(enterprises)
      .where(and(eq(enterprises.slug, d.slug), ne(enterprises.id, d.enterpriseId)))
      .limit(1)
    if (dup) return { ok: false as const, error: "slug 已被其他企业使用" }
  }

  await db
    .update(enterprises)
    .set({
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.slug !== undefined ? { slug: d.slug } : {}),
      ...(d.logoUrl !== undefined ? { logoUrl: d.logoUrl } : {}),
      updatedAt: new Date(),
    })
    .where(eq(enterprises.id, d.enterpriseId))

  revalidatePath("/platform/enterprises")
  revalidatePath(`/platform/enterprises/${d.enterpriseId}`)
  return { ok: true as const, error: null }
}

/**
 * 停用/启用企业（超管）
 *
 * 停用语义（session.ts 既有实现）：成员仍可登录，但企业视为无作用域，
 * 全部业务操作 403；启用即时恢复。
 */
export async function setEnterpriseStatusAction(input: {
  enterpriseId: string
  status: "active" | "suspended"
}) {
  await requireSuperAdmin()
  const parsed = setEnterpriseStatusSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  await db
    .update(enterprises)
    .set({ status: d.status, updatedAt: new Date() })
    .where(eq(enterprises.id, d.enterpriseId))

  revalidatePath("/platform/enterprises")
  revalidatePath(`/platform/enterprises/${d.enterpriseId}`)
  return { ok: true as const, error: null }
}

/** 企业详情（超管）：基本信息 + 套餐 + 成员/任务统计；不存在返回 null */
export async function getEnterpriseDetailAction(enterpriseId: string) {
  await requireSuperAdmin()
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRe.test(enterpriseId)) return null

  const [row] = await db
    .select({
      id: enterprises.id,
      name: enterprises.name,
      slug: enterprises.slug,
      logoUrl: enterprises.logoUrl,
      status: enterprises.status,
      creditsBalance: enterprises.creditsBalance,
      enabledModules: enterprises.enabledModules,
      maxConcurrent: enterprises.maxConcurrent,
      chatMaxConcurrent: enterprises.chatMaxConcurrent,
      allowCustomModels: enterprises.allowCustomModels,
      visiblePresetModels: enterprises.visiblePresetModels,
      visiblePresetChatModels: enterprises.visiblePresetChatModels,
      createdAt: enterprises.createdAt,
      memberCount: db.$count(users, eq(users.enterpriseId, enterprises.id)),
      taskCount: db.$count(
        generationTasks,
        eq(generationTasks.enterpriseId, enterprises.id),
      ),
      planId: subscriptionPlans.id,
      planName: subscriptionPlans.name,
      planIconKey: subscriptionPlans.iconKey,
      planColor: subscriptionPlans.color,
      planCreditsPerCycle: subscriptionPlans.creditsPerCycle,
      planCycleDays: subscriptionPlans.cycleDays,
      planMaxMembers: subscriptionPlans.maxMembers,
      planExpiresAt: enterpriseSubscriptions.expiresAt,
      planStartsAt: enterpriseSubscriptions.startsAt,
    })
    .from(enterprises)
    .leftJoin(
      enterpriseSubscriptions,
      eq(enterpriseSubscriptions.enterpriseId, enterprises.id),
    )
    .leftJoin(
      subscriptionPlans,
      eq(subscriptionPlans.id, enterpriseSubscriptions.planId),
    )
    .where(eq(enterprises.id, enterpriseId))
    .limit(1)

  if (!row) return null
  const now = Date.now()
  return {
    ...row,
    planExpiresAt: row.planExpiresAt?.toISOString() ?? null,
    planStartsAt: row.planStartsAt?.toISOString() ?? null,
    planIsExpired: row.planExpiresAt ? row.planExpiresAt.getTime() <= now : false,
  }
}

/** 超管：按企业列成员（分页 + 搜索 username/昵称/邮箱） */
export async function listEnterpriseMembersAction(opts: {
  enterpriseId: string
  page?: number
  pageSize?: number
  q?: string
}) {
  await requireSuperAdmin()
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)))
  const offset = (page - 1) * pageSize
  const q = opts.q?.trim()

  const scopeCond = eq(users.enterpriseId, opts.enterpriseId)
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

/** 超管：查某企业积分流水（复用 credits-service.listTransactions） */
export async function listEnterpriseTransactionsAction(opts: {
  enterpriseId: string
  page?: number
  pageSize?: number
  type?: Parameters<typeof listTransactions>[0]["type"]
  q?: string
}) {
  await requireSuperAdmin()
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)))
  const result = await listTransactions({
    enterpriseId: opts.enterpriseId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    type: opts.type,
    q: opts.q?.trim() || undefined,
  })
  return { ...result, page, pageSize }
}

/** 超管：列某企业权限组（企业详情页「添加成员」下拉数据源） */
export async function listEnterpriseGroupsAction(enterpriseId: string) {
  await requireSuperAdmin()
  const items = await db
    .select({
      id: permissionGroups.id,
      name: permissionGroups.name,
      isDefault: permissionGroups.isDefault,
    })
    .from(permissionGroups)
    .where(eq(permissionGroups.enterpriseId, enterpriseId))
    .orderBy(desc(permissionGroups.isDefault), permissionGroups.createdAt)
    .limit(50)
  return { items }
}

/** 超管：企业下拉选项全量（建/编辑用户与筛选条数据源，仅 id/name、按名称排序、不分页截断） */
export async function listEnterpriseOptionsAction() {
  await requireSuperAdmin()
  const items = await db
    .select({ id: enterprises.id, name: enterprises.name })
    .from(enterprises)
    .orderBy(asc(enterprises.name))
  return { items }
}

/** 平台列表统一分页参数（page 从 1 开始） */
export interface PlatformListParams {
  page?: number
  pageSize?: number
  q?: string
}

/** 企业列表筛选/排序参数（企业管理页 URL 驱动） */
export interface EnterpriseListFilters {
  /** 状态筛选（缺省 = 全部） */
  status?: "active" | "suspended"
  /** 套餐筛选：套餐 id 或 "none"（免费版，缺省 = 全部） */
  planId?: string
  /** 排序：createdAt_desc（默认）/ createdAt_asc / credits_desc */
  sort?: "createdAt_desc" | "createdAt_asc" | "credits_desc"
}

/** 列出所有企业（超管，分页 + 搜索 name/slug + 状态/套餐筛选 + 排序 + 成员/任务统计） */
export async function listEnterprisesAction(
  opts: PlatformListParams & EnterpriseListFilters = {},
) {
  await requireSuperAdmin()
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)))
  const offset = (page - 1) * pageSize
  const q = opts.q?.trim()

  const conditions = []
  if (q) {
    conditions.push(
      or(ilike(enterprises.name, `%${q}%`), ilike(enterprises.slug, `%${q}%`)),
    )
  }
  if (opts.status === "active" || opts.status === "suspended") {
    conditions.push(eq(enterprises.status, opts.status))
  }
  if (opts.planId === "none") {
    // 免费版 = 无订阅行（join 后判空）
    conditions.push(isNull(enterpriseSubscriptions.enterpriseId))
  } else if (opts.planId) {
    conditions.push(eq(enterpriseSubscriptions.planId, opts.planId))
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const orderBy =
    opts.sort === "createdAt_asc"
      ? asc(enterprises.createdAt)
      : opts.sort === "credits_desc"
        ? desc(enterprises.creditsBalance)
        : desc(enterprises.createdAt)

  const [items, [{ total }]] = await Promise.all([
    db
      .select({
        id: enterprises.id,
        name: enterprises.name,
        slug: enterprises.slug,
        logoUrl: enterprises.logoUrl,
        status: enterprises.status,
        creditsBalance: enterprises.creditsBalance,
        enabledModules: enterprises.enabledModules,
        maxConcurrent: enterprises.maxConcurrent,
        chatMaxConcurrent: enterprises.chatMaxConcurrent,
        allowCustomModels: enterprises.allowCustomModels,
        visiblePresetModels: enterprises.visiblePresetModels,
        visiblePresetChatModels: enterprises.visiblePresetChatModels,
        createdAt: enterprises.createdAt,
        // 成员数 / 累计生图任务数（标量子查询，每页 ≤50 行）
        memberCount: db.$count(users, eq(users.enterpriseId, enterprises.id)),
        taskCount: db.$count(
          generationTasks,
          eq(generationTasks.enterpriseId, enterprises.id),
        ),
        // 当前订阅套餐（未分配时均为 null）
        planId: subscriptionPlans.id,
        planName: subscriptionPlans.name,
        planIconKey: subscriptionPlans.iconKey,
        planColor: subscriptionPlans.color,
        planCreditsPerCycle: subscriptionPlans.creditsPerCycle,
        planCycleDays: subscriptionPlans.cycleDays,
        planMaxMembers: subscriptionPlans.maxMembers,
        planExpiresAt: enterpriseSubscriptions.expiresAt,
        planStartsAt: enterpriseSubscriptions.startsAt,
      })
      .from(enterprises)
      .leftJoin(
        enterpriseSubscriptions,
        eq(enterpriseSubscriptions.enterpriseId, enterprises.id),
      )
      .leftJoin(
        subscriptionPlans,
        eq(subscriptionPlans.id, enterpriseSubscriptions.planId),
      )
      .where(where)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: count() })
      .from(enterprises)
      .leftJoin(
        enterpriseSubscriptions,
        eq(enterpriseSubscriptions.enterpriseId, enterprises.id),
      )
      .where(where),
  ])

  const now = Date.now()
  return {
    items: items.map((e) => ({
      ...e,
      planExpiresAt: e.planExpiresAt?.toISOString() ?? null,
      planStartsAt: e.planStartsAt?.toISOString() ?? null,
      planIsExpired: e.planExpiresAt ? e.planExpiresAt.getTime() <= now : false,
    })),
    total,
    page,
    pageSize,
  }
}

/** 平台用户列表筛选参数（平台用户页 URL 驱动） */
export interface PlatformUserListFilters {
  /** 类型筛选：superadmin=超管 / enterprise=企业用户（缺省 = 全部） */
  type?: "superadmin" | "enterprise"
  /** 状态筛选（缺省 = 全部） */
  status?: "active" | "disabled"
  /** 归属企业筛选（uuid；缺省 = 全部） */
  enterpriseId?: string
}

/** 列出所有平台用户（超管，分页 + 搜索 username/昵称/邮箱 + 类型/状态/企业筛选） */
export async function listAllUsersAction(
  opts: PlatformListParams & PlatformUserListFilters = {},
) {
  await requireSuperAdmin()
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)))
  const offset = (page - 1) * pageSize
  const q = opts.q?.trim()

  const conditions = []
  if (q) {
    conditions.push(
      or(
        ilike(users.username, `%${q}%`),
        ilike(users.name, `%${q}%`),
        ilike(users.email, `%${q}%`),
      ),
    )
  }
  if (opts.type === "superadmin") conditions.push(eq(users.isSuperAdmin, true))
  if (opts.type === "enterprise") conditions.push(eq(users.isSuperAdmin, false))
  if (opts.status === "active" || opts.status === "disabled") {
    conditions.push(eq(users.status, opts.status))
  }
  if (opts.enterpriseId) conditions.push(eq(users.enterpriseId, opts.enterpriseId))
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const [items, [{ total }]] = await Promise.all([
    db
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
      .where(where)
      .orderBy(users.createdAt)
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: count() })
      .from(users)
      .leftJoin(enterprises, eq(users.enterpriseId, enterprises.id))
      .where(where),
  ])

  return { items, total, page, pageSize }
}

/** 看板时间范围（天）：白名单外的值回落 30 */
const DASHBOARD_RANGES = [7, 30, 90] as const
type DashboardRange = (typeof DASHBOARD_RANGES)[number]

function normalizeDashboardRange(range?: number): DashboardRange {
  const r = Math.floor(Number(range ?? 30))
  return (DASHBOARD_RANGES as readonly number[]).includes(r)
    ? (r as DashboardRange)
    : 30
}

/**
 * 平台总览统计（需求 1：超管看板）
 *
 * 聚合：企业/用户/平台积分总量、生图总次数、已完成、今日（含昨日环比）、
 * 状态分布、企业生图 Top10、近 N 天趋势（任务数 + 完成数双序列）、
 * 平台预置模型使用 Top；增强项：今日活跃用户/今日失败率/平均生成耗时/
 * 今日积分消耗/积分消耗趋势/24 小时时段分布/用户与企业增长曲线。
 */
export interface PlatformStats {
  enterpriseCount: number
  userCount: number
  totalCredits: number
  totalTasks: number
  completedTasks: number
  todayTasks: number
  /** 昨日任务数（今日生图卡环比用） */
  yesterdayTasks: number
  /** 今日活跃用户（今日有生图任务的不同用户数） */
  todayActiveUsers: number
  /** 今日失败率（0-100，今日无任务时 null） */
  todayFailedRate: number | null
  /** 平均生成耗时（毫秒，按已完成任务的 completed_at - started_at） */
  avgDurationMs: number | null
  /** 今日积分消耗（sum credits_charged） */
  todayCreditsConsumed: number
  statusDistribution: { status: string; count: number }[]
  enterpriseRanking: Array<{
    enterpriseId: string
    enterpriseName: string
    taskCount: number
    totalCharged: number
  }>
  dailyTrend: Array<{ day: string; taskCount: number; completedCount: number }>
  modelRanking: Array<{
    modelId: string | null
    modelName: string
    modelDisplayName: string
    taskCount: number
  }>
  /** 近 30 天每日积分消耗 */
  creditsTrend: Array<{ day: string; amount: number }>
  /** 24 小时生图时段分布（近 N 天聚合，补齐 0-23 全时段） */
  hourlyDistribution: Array<{ hour: number; count: number }>
  /** 近 30 天每日新增用户 */
  userGrowthTrend: Array<{ day: string; count: number }>
  /** 近 30 天每日新增企业 */
  enterpriseGrowthTrend: Array<{ day: string; count: number }>
}

export async function getPlatformStatsAction(
  range?: number,
): Promise<PlatformStats> {
  await requireSuperAdmin()
  const days = normalizeDashboardRange(range)

  // 基础计数 + 积分总量（一条查询）
  const [baseAgg] = await db
    .select({
      enterpriseCount: count(),
      totalCredits: sum(enterprises.creditsBalance),
    })
    .from(enterprises)
  const [userAgg] = await db
    .select({ userCount: count() })
    .from(users)

  // 任务计数（总量、今日、昨日）；已完成从 statusDistribution 取
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)

  const [taskAgg] = await db
    .select({ totalTasks: count() })
    .from(generationTasks)
  // 今日任务数单独查
  const [todayAgg] = await db
    .select({ c: count() })
    .from(generationTasks)
    .where(gte(generationTasks.createdAt, todayStart))
  // 昨日任务数（今日环比）
  const [yesterdayAgg] = await db
    .select({ c: count() })
    .from(generationTasks)
    .where(
      and(
        gte(generationTasks.createdAt, yesterdayStart),
        lt(generationTasks.createdAt, todayStart),
      ),
    )

  // 状态分布
  const statusRows = await db
    .select({
      status: generationTasks.status,
      count: count(),
    })
    .from(generationTasks)
    .groupBy(generationTasks.status)

  // 企业生图排行（Top 10，按任务数）
  const ranking = await db
    .select({
      enterpriseId: generationTasks.enterpriseId,
      enterpriseName: enterprises.name,
      taskCount: count(),
      totalCharged: sum(generationTasks.creditsCharged),
    })
    .from(generationTasks)
    .innerJoin(enterprises, eq(generationTasks.enterpriseId, enterprises.id))
    .groupBy(generationTasks.enterpriseId, enterprises.name)
    .orderBy(desc(count()))
    .limit(10)

  // 近 N 天趋势（任务数 + 完成数双序列，供看板面积图；窗口含今天）
  const trend = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${generationTasks.createdAt}), 'YYYY-MM-DD')`,
      taskCount: count(),
      completedCount: sql<number>`count(*) filter (where ${generationTasks.status} = 'completed')::int`,
    })
    .from(generationTasks)
    .where(
      sql`${generationTasks.createdAt} >= ${sql.raw(`CURRENT_DATE - INTERVAL '${days - 1} days'`)}`,
    )
    .groupBy(sql`date_trunc('day', ${generationTasks.createdAt})`)
    .orderBy(sql`date_trunc('day', ${generationTasks.createdAt})`)

  // 平台预置模型使用排行（Top 10）
  const modelRanking = await db
    .select({
      modelId: generationTasks.modelId,
      modelName: models.name,
      modelDisplayName: models.displayName,
      taskCount: count(),
    })
    .from(generationTasks)
    .innerJoin(models, eq(generationTasks.modelId, models.id))
    .groupBy(generationTasks.modelId, models.name, models.displayName)
    .orderBy(desc(count()))
    .limit(10)

  // ===== 增强统计（活跃/失败率/耗时/积分消耗/时段/增长，并行） =====
  const [
    todayStatusRows,
    activeUsersAgg,
    avgDurationAgg,
    todayCreditsAgg,
    creditsTrendRows,
    hourlyRows,
    userGrowthRows,
    entGrowthRows,
  ] = await Promise.all([
    // 今日状态分布（失败率口径）
    db
      .select({ status: generationTasks.status, count: count() })
      .from(generationTasks)
      .where(gte(generationTasks.createdAt, todayStart))
      .groupBy(generationTasks.status),
    // 今日活跃用户（今日有生图任务的不同用户）
    db
      .select({
        c: sql<number>`count(distinct ${generationTasks.userId})::int`,
      })
      .from(generationTasks)
      .where(gte(generationTasks.createdAt, todayStart)),
    // 平均生成耗时（全部已完成任务，completed_at - started_at）
    db
      .select({
        avgMs: sql<
          number | null
        >`avg(extract(epoch from (${generationTasks.completedAt} - ${generationTasks.startedAt})) * 1000)::int`,
      })
      .from(generationTasks)
      .where(
        and(
          isNotNull(generationTasks.completedAt),
          isNotNull(generationTasks.startedAt),
        ),
      ),
    // 今日积分消耗
    db
      .select({ amount: sum(generationTasks.creditsCharged) })
      .from(generationTasks)
      .where(gte(generationTasks.createdAt, todayStart)),
    // 近 30 天每日积分消耗
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${generationTasks.createdAt}), 'YYYY-MM-DD')`,
        amount: sum(generationTasks.creditsCharged),
      })
      .from(generationTasks)
      .where(
        sql`${generationTasks.createdAt} >= ${sql.raw("CURRENT_DATE - INTERVAL '29 days'")}`,
      )
      .groupBy(sql`date_trunc('day', ${generationTasks.createdAt})`)
      .orderBy(sql`date_trunc('day', ${generationTasks.createdAt})`),
    // 24 小时生图时段分布（近 N 天聚合）
    db
      .select({
        hour: sql<number>`extract(hour from ${generationTasks.createdAt})::int`,
        count: count(),
      })
      .from(generationTasks)
      .where(
        sql`${generationTasks.createdAt} >= ${sql.raw(`CURRENT_DATE - INTERVAL '${days - 1} days'`)}`,
      )
      .groupBy(sql`extract(hour from ${generationTasks.createdAt})`),
    // 近 30 天每日新增用户
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${users.createdAt}), 'YYYY-MM-DD')`,
        count: count(),
      })
      .from(users)
      .where(
        sql`${users.createdAt} >= ${sql.raw("CURRENT_DATE - INTERVAL '29 days'")}`,
      )
      .groupBy(sql`date_trunc('day', ${users.createdAt})`)
      .orderBy(sql`date_trunc('day', ${users.createdAt})`),
    // 近 30 天每日新增企业
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${enterprises.createdAt}), 'YYYY-MM-DD')`,
        count: count(),
      })
      .from(enterprises)
      .where(
        sql`${enterprises.createdAt} >= ${sql.raw("CURRENT_DATE - INTERVAL '29 days'")}`,
      )
      .groupBy(sql`date_trunc('day', ${enterprises.createdAt})`)
      .orderBy(sql`date_trunc('day', ${enterprises.createdAt})`),
  ])

  const todayTasks = todayAgg?.c ?? 0
  const todayFailed =
    todayStatusRows.find((s) => s.status === "failed")?.count ?? 0
  // 24 小时补齐 0-23（缺失时段计 0，柱状图横轴连续）
  const hourlyMap = new Map(hourlyRows.map((r) => [Number(r.hour), r.count]))
  const hourlyDistribution = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    count: hourlyMap.get(h) ?? 0,
  }))

  return {
    enterpriseCount: baseAgg?.enterpriseCount ?? 0,
    userCount: userAgg?.userCount ?? 0,
    totalCredits: Number(baseAgg?.totalCredits ?? 0),
    totalTasks: taskAgg?.totalTasks ?? 0,
    // completedTasks 用条件计数更准确，这里近似用已完成聚合
    completedTasks:
      statusRows.find((s) => s.status === "completed")?.count ?? 0,
    todayTasks,
    yesterdayTasks: yesterdayAgg?.c ?? 0,
    todayActiveUsers: activeUsersAgg[0]?.c ?? 0,
    todayFailedRate: todayTasks > 0 ? (todayFailed / todayTasks) * 100 : null,
    avgDurationMs: avgDurationAgg[0]?.avgMs ?? null,
    todayCreditsConsumed: Number(todayCreditsAgg[0]?.amount ?? 0),
    statusDistribution: statusRows.map((s) => ({
      status: s.status,
      count: s.count,
    })),
    enterpriseRanking: ranking.map((r) => ({
      enterpriseId: r.enterpriseId,
      enterpriseName: r.enterpriseName ?? "—",
      taskCount: r.taskCount,
      totalCharged: Number(r.totalCharged ?? 0),
    })),
    dailyTrend: trend.map((t) => ({
      day: t.day,
      taskCount: t.taskCount,
      completedCount: t.completedCount,
    })),
    modelRanking: modelRanking.map((m) => ({
      modelId: m.modelId,
      modelName: m.modelName,
      modelDisplayName: m.modelDisplayName,
      taskCount: m.taskCount,
    })),
    creditsTrend: creditsTrendRows.map((r) => ({
      day: r.day,
      amount: Number(r.amount ?? 0),
    })),
    hourlyDistribution,
    userGrowthTrend: userGrowthRows.map((r) => ({
      day: r.day,
      count: r.count,
    })),
    enterpriseGrowthTrend: entGrowthRows.map((r) => ({
      day: r.day,
      count: r.count,
    })),
  }
}

/**
 * 对话类数据看板统计（超管）
 *
 * 数据源：/chat 交互式对话的 chat_message（按助手消息计，每条 = 一次
 * 模型调用）+ chat_conversation。早期版本统计 chat_task（工作台批量
 * 提示词任务）/ workspace_api_logs，与交互式对话数据脱节导致看板恒为
 * 空，已切换为真实对话数据。
 */
export interface ChatPlatformStats {
  /** 助手消息总数 */
  totalMessages: number
  todayMessages: number
  /** 昨日助手消息数（今日消息卡环比用） */
  yesterdayMessages: number
  /** 今日活跃对话用户（今日有助手消息的不同用户数） */
  todayActiveChatUsers: number
  /** 对话会话总数（chat_conversation） */
  conversationCount: number
  /** 助手消息状态分布（streaming/completed/failed/stopped） */
  statusDistribution: { status: string; count: number }[]
  dailyTrend: Array<{ day: string; taskCount: number; completedCount: number }>
  modelRanking: Array<{
    configId: string | null
    displayName: string | null
    taskCount: number
  }>
  /** completed 占助手消息总数比例（0-100，无消息时 null） */
  successRate: number | null
  /** 助手消息平均耗时（毫秒） */
  avgDurationMs: number | null
  /** 企业对话占比（助手消息数 Top 5 + 其他） */
  enterpriseShare: Array<{ name: string; count: number }>
}

export async function getChatStatsAction(
  range?: number,
): Promise<ChatPlatformStats> {
  await requireSuperAdmin()
  const days = normalizeDashboardRange(range)

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)
  // 仅统计助手消息：一条助手消息 = 一次模型调用（用户消息不产生调用）
  const assistant = eq(chatMessages.role, "assistant")

  const [
    totalAgg,
    todayAgg,
    yesterdayAgg,
    todayActiveAgg,
    statusRows,
    trend,
    ranking,
    convAgg,
    entRows,
  ] = await Promise.all([
    db
      .select({
        c: count(),
        avgDuration: sql<number | null>`avg(${chatMessages.durationMs})::int`,
      })
      .from(chatMessages)
      .where(assistant),
    db
      .select({ c: count() })
      .from(chatMessages)
      .where(and(assistant, gte(chatMessages.createdAt, todayStart))),
    // 昨日消息数（今日环比）
    db
      .select({ c: count() })
      .from(chatMessages)
      .where(
        and(
          assistant,
          gte(chatMessages.createdAt, yesterdayStart),
          lt(chatMessages.createdAt, todayStart),
        ),
      ),
    // 今日活跃对话用户（今日有助手消息的不同用户）
    db
      .select({ c: sql<number>`count(distinct ${chatMessages.userId})::int` })
      .from(chatMessages)
      .where(and(assistant, gte(chatMessages.createdAt, todayStart))),
      db
        .select({ status: chatMessages.status, count: count() })
        .from(chatMessages)
        .where(assistant)
        .groupBy(chatMessages.status),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${chatMessages.createdAt}), 'YYYY-MM-DD')`,
          taskCount: count(),
          completedCount: sql<number>`count(*) filter (where ${chatMessages.status} = 'completed')::int`,
        })
        .from(chatMessages)
        .where(
          and(
            assistant,
            sql`${chatMessages.createdAt} >= ${sql.raw(`CURRENT_DATE - INTERVAL '${days - 1} days'`)}`,
          ),
        )
        .groupBy(sql`date_trunc('day', ${chatMessages.createdAt})`)
        .orderBy(sql`date_trunc('day', ${chatMessages.createdAt})`),
      db
        .select({
          configId: chatMessages.modelId,
          displayName: chatApiConfigs.displayName,
          taskCount: count(),
        })
        .from(chatMessages)
        .leftJoin(chatApiConfigs, eq(chatMessages.modelId, chatApiConfigs.id))
        .where(assistant)
        .groupBy(chatMessages.modelId, chatApiConfigs.displayName)
        .orderBy(desc(count()))
        .limit(10),
      db.select({ c: count() }).from(chatConversations),
      db
        .select({ name: enterprises.name, count: count() })
        .from(chatMessages)
        .innerJoin(enterprises, eq(chatMessages.enterpriseId, enterprises.id))
        .where(assistant)
        .groupBy(enterprises.name)
        .orderBy(desc(count()))
        .limit(5),
    ])

  const totalMessages = totalAgg[0]?.c ?? 0
  const completedCount =
    statusRows.find((s) => s.status === "completed")?.count ?? 0
  const top5Total = entRows.reduce((acc, r) => acc + r.count, 0)
  const restCount = totalMessages - top5Total

  return {
    totalMessages,
    todayMessages: todayAgg[0]?.c ?? 0,
    yesterdayMessages: yesterdayAgg[0]?.c ?? 0,
    todayActiveChatUsers: todayActiveAgg[0]?.c ?? 0,
    conversationCount: convAgg[0]?.c ?? 0,
    statusDistribution: statusRows.map((s) => ({
      status: s.status,
      count: s.count,
    })),
    dailyTrend: trend.map((t) => ({
      day: t.day,
      taskCount: t.taskCount,
      completedCount: t.completedCount,
    })),
    modelRanking: ranking.map((r) => ({
      configId: r.configId,
      displayName: r.displayName,
      taskCount: r.taskCount,
    })),
    successRate:
      totalMessages > 0 ? (completedCount / totalMessages) * 100 : null,
    avgDurationMs: totalAgg[0]?.avgDuration ?? null,
    enterpriseShare: [
      ...entRows.map((r) => ({ name: r.name ?? "—", count: r.count })),
      ...(restCount > 0 ? [{ name: "其他企业", count: restCount }] : []),
    ],
  }
}


/* ═══════════════ 企业级样机渲染服务配置（system_setting key="mockup"） ═══════════════ */

/** 下发给超管的配置视图（密钥明文不出库，仅 hasApiKey/hasWebhookSecret） */
export interface MockupSettingView {
  enterpriseId: string
  apiBaseUrl: string
  hasApiKey: boolean
  hasWebhookSecret: boolean
  costPerRender: number
  enabled: boolean
}

interface MockupSettingValue {
  apiBaseUrl?: string
  apiKeyEncrypted?: string
  webhookSecretEncrypted?: string
  costPerRender?: number
  enabled?: boolean
}

async function readMockupSetting(
  enterpriseId: string,
): Promise<MockupSettingValue> {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(
      and(
        eq(systemSettings.key, "mockup"),
        eq(systemSettings.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  return (row?.value ?? {}) as MockupSettingValue
}

export async function getMockupSettingAction(
  enterpriseId: string,
): Promise<MockupSettingView> {
  await requireSuperAdmin()
  const v = await readMockupSetting(enterpriseId)
  const cost = Number(v.costPerRender)
  return {
    enterpriseId,
    apiBaseUrl: v.apiBaseUrl ?? "",
    hasApiKey: Boolean(v.apiKeyEncrypted),
    hasWebhookSecret: Boolean(v.webhookSecretEncrypted),
    costPerRender: Number.isFinite(cost) && cost > 0 ? Math.floor(cost) : 1,
    enabled: v.enabled !== false,
  }
}

export async function saveMockupSettingAction(input: {
  enterpriseId: string
  apiBaseUrl: string
  /** 留空 = 保留已存密钥 */
  apiKey?: string
  /** Webhook 签名密钥（与 PS-API 该 API Key 的 webhookSecret 配对）；留空 = 保留；传 "-" 清除 */
  webhookSecret?: string
  costPerRender: number
  enabled: boolean
}): Promise<{ ok: boolean; error: string | null }> {
  await requireSuperAdmin()

  const enterpriseId = String(input.enterpriseId ?? "").trim()
  if (!/^[0-9a-f-]{36}$/i.test(enterpriseId)) {
    return { ok: false, error: "企业 ID 非法" }
  }
  const [ent] = await db
    .select({ id: enterprises.id })
    .from(enterprises)
    .where(eq(enterprises.id, enterpriseId))
    .limit(1)
  if (!ent) return { ok: false, error: "企业不存在" }

  const apiBaseUrl = String(input.apiBaseUrl ?? "")
    .trim()
    .replace(/\/+$/, "")
  if (apiBaseUrl && !/^https?:\/\/.+/i.test(apiBaseUrl)) {
    return { ok: false, error: "服务地址必须是 http(s):// 开头的 URL" }
  }
  const cost = Math.floor(Number(input.costPerRender))
  if (!Number.isFinite(cost) || cost < 1 || cost > 100000) {
    return { ok: false, error: "渲染单价必须是 1~100000 的整数" }
  }

  const existing = await readMockupSetting(enterpriseId)
  const newKey = String(input.apiKey ?? "").trim()
  const apiKeyEncrypted = newKey ? encrypt(newKey) : (existing.apiKeyEncrypted ?? "")
  // webhookSecret：留空保留；输入 "-" 表示清除（关闭终态推送，回落纯轮询）
  const newSecret = String(input.webhookSecret ?? "").trim()
  const webhookSecretEncrypted =
    newSecret === "-"
      ? ""
      : newSecret
        ? encrypt(newSecret)
        : (existing.webhookSecretEncrypted ?? "")
  const enabled = input.enabled === true

  if (enabled && (!apiBaseUrl || !apiKeyEncrypted)) {
    return { ok: false, error: "启用前必须填写服务地址与 API Key" }
  }

  const value = {
    apiBaseUrl,
    apiKeyEncrypted,
    webhookSecretEncrypted,
    costPerRender: cost,
    enabled,
  } as unknown as SystemSettingValue
  // 企业级 enterpriseId 非 NULL：unique(key, enterpriseId) 可命中，upsert 安全
  await db
    .insert(systemSettings)
    .values({
      enterpriseId,
      key: "mockup",
      value,
      description: "样机渲染服务配置（psd-render-api 地址/密钥/单价）",
    })
    .onConflictDoUpdate({
      target: [systemSettings.key, systemSettings.enterpriseId],
      set: { value, updatedAt: new Date() },
    })

  revalidatePath("/platform/enterprises")
  return { ok: true, error: null }
}

/* ─── 企业级 TEMU 应用凭证（system_setting key=temu_api_app；每企业可对接各自的自研应用） ─── */

/** TEMU 应用凭证表单值（secret 回显掩码） */
export interface TemuAppSettingView {
  appKey: string
  appSecret: string
  testMode: boolean
}

export async function getTemuAppSettingAction(
  enterpriseId: string,
): Promise<TemuAppSettingView> {
  await requireSuperAdmin()
  const config = await loadTemuAppConfig(enterpriseId)
  return {
    appKey: config.appKey,
    appSecret: maskTemuSecret(decryptTemuSecret(config.appSecretEncrypted)),
    testMode: config.testMode,
  }
}

export async function saveTemuAppSettingAction(input: {
  enterpriseId: string
  appKey: string
  appSecret: string
  testMode: boolean
}): Promise<{ ok: boolean; error: string | null }> {
  await requireSuperAdmin()

  const enterpriseId = String(input.enterpriseId ?? "").trim()
  if (!/^[0-9a-f-]{36}$/i.test(enterpriseId)) {
    return { ok: false, error: "企业 ID 非法" }
  }
  const [ent] = await db
    .select({ id: enterprises.id })
    .from(enterprises)
    .where(eq(enterprises.id, enterpriseId))
    .limit(1)
  if (!ent) return { ok: false, error: "企业不存在" }

  const current = await loadTemuAppConfig(enterpriseId)
  const appKey = input.appKey.trim()
  // 掩码=保留现值；其余以输入为准（空串=清空）
  const masked = isMaskedTemuSecret(input.appSecret)
  const plainSecret = masked
    ? decryptTemuSecret(current.appSecretEncrypted)
    : input.appSecret.trim()

  if (!input.testMode && appKey && !plainSecret) {
    return { ok: false, error: "已填写 app_key 但 app_secret 为空，请补全后再保存" }
  }
  if (!input.testMode && !appKey && plainSecret) {
    return { ok: false, error: "已填写 app_secret 但 app_key 为空，请补全后再保存" }
  }

  await saveTemuAppConfig(enterpriseId, {
    appKey,
    appSecretEncrypted: encryptTemuSecret(plainSecret),
    testMode: input.testMode,
  })
  revalidatePath("/platform/enterprises")
  return { ok: true, error: null }
}
