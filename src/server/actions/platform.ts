"use server"

import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  or,
  sql,
  sum,
} from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  chatTasks,
  conversations,
  enterprises,
  generationTasks,
  models,
  permissionGroups,
  systemSettings,
  users,
  workspaceApiLogs,
  type ModuleName,
  type SystemSettingValue,
} from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import { encrypt, hashPassword } from "@/lib/crypto"
import { rechargeCredits } from "@/server/services/credits-service"
import {
  createEnterpriseSchema,
  createUserSchema,
  rechargeSchema,
  updateModulesSchema,
  updateEnterpriseModelConfigSchema,
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
      enabledModules: d.enabledModules ?? ["create", "assets", "mockup", "settings"],
      maxConcurrent: d.maxConcurrent ?? 5,
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

/** 平台列表统一分页参数（page 从 1 开始） */
export interface PlatformListParams {
  page?: number
  pageSize?: number
  q?: string
}

/** 列出所有企业（超管，分页 + 可选搜索 name/slug） */
export async function listEnterprisesAction(opts: PlatformListParams = {}) {
  await requireSuperAdmin()
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)))
  const offset = (page - 1) * pageSize
  const q = opts.q?.trim()

  const where = q
    ? or(
        ilike(enterprises.name, `%${q}%`),
        ilike(enterprises.slug, `%${q}%`),
      )
    : undefined

  const [items, [{ total }]] = await Promise.all([
    db
      .select({
        id: enterprises.id,
        name: enterprises.name,
        slug: enterprises.slug,
        status: enterprises.status,
        creditsBalance: enterprises.creditsBalance,
        enabledModules: enterprises.enabledModules,
        maxConcurrent: enterprises.maxConcurrent,
        allowCustomModels: enterprises.allowCustomModels,
        visiblePresetModels: enterprises.visiblePresetModels,
        visiblePresetChatModels: enterprises.visiblePresetChatModels,
        createdAt: enterprises.createdAt,
      })
      .from(enterprises)
      .where(where)
      .orderBy(enterprises.createdAt)
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(enterprises).where(where),
  ])

  return { items, total, page, pageSize }
}

/** 列出所有平台用户（超管，分页 + 可选搜索 username/昵称/邮箱） */
export async function listAllUsersAction(opts: PlatformListParams = {}) {
  await requireSuperAdmin()
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)))
  const offset = (page - 1) * pageSize
  const q = opts.q?.trim()

  const where = q
    ? or(
        ilike(users.username, `%${q}%`),
        ilike(users.name, `%${q}%`),
        ilike(users.email, `%${q}%`),
      )
    : undefined

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

/**
 * 平台总览统计（需求 1：超管看板）
 *
 * 聚合：企业/用户/平台积分总量、生图总次数、已完成、今日、状态分布、
 * 企业生图 Top10、近 30 天趋势（任务数 + 完成数双序列）、
 * 平台预置模型使用 Top。
 */
export interface PlatformStats {
  enterpriseCount: number
  userCount: number
  totalCredits: number
  totalTasks: number
  completedTasks: number
  todayTasks: number
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
}

export async function getPlatformStatsAction(): Promise<PlatformStats> {
  await requireSuperAdmin()

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

  // 任务计数（总量、今日）；已完成从 statusDistribution 取
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const [taskAgg] = await db
    .select({ totalTasks: count() })
    .from(generationTasks)
  // 今日任务数单独查
  const [todayAgg] = await db
    .select({ c: count() })
    .from(generationTasks)
    .where(gte(generationTasks.createdAt, todayStart))

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

  // 近 30 天趋势（任务数 + 完成数双序列，供看板面积图）
  const trend = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${generationTasks.createdAt}), 'YYYY-MM-DD')`,
      taskCount: count(),
      completedCount: sql<number>`count(*) filter (where ${generationTasks.status} = 'completed')::int`,
    })
    .from(generationTasks)
    .where(sql`${generationTasks.createdAt} >= ${sql.raw("CURRENT_DATE - INTERVAL '29 days'")}`)
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

  return {
    enterpriseCount: baseAgg?.enterpriseCount ?? 0,
    userCount: userAgg?.userCount ?? 0,
    totalCredits: Number(baseAgg?.totalCredits ?? 0),
    totalTasks: taskAgg?.totalTasks ?? 0,
    // completedTasks 用条件计数更准确，这里近似用已完成聚合
    completedTasks:
      statusRows.find((s) => s.status === "completed")?.count ?? 0,
    todayTasks: todayAgg?.c ?? 0,
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
  }
}

/**
 * 对话类数据看板统计（超管）
 *
 * 数据源：
 * - chatTasks：对话任务（深化/重生成/翻译）总量、今日、状态/类型分布、30 天趋势、模型排行
 * - workspaceApiLogs（apiType=chat）：成功率、平均耗时
 * - conversations：创作会话总数
 */
export interface ChatPlatformStats {
  totalCalls: number
  todayCalls: number
  statusDistribution: { status: string; count: number }[]
  taskTypeDistribution: { taskType: string; count: number }[]
  dailyTrend: Array<{ day: string; taskCount: number; completedCount: number }>
  modelRanking: Array<{
    configId: string | null
    displayName: string | null
    taskCount: number
  }>
  apiTotal: number
  apiSuccessCount: number
  apiAvgDurationMs: number | null
  conversationCount: number
}

export async function getChatStatsAction(): Promise<ChatPlatformStats> {
  await requireSuperAdmin()

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const [totalAgg, todayAgg, statusRows, typeRows, trend, ranking, apiAgg, convAgg] =
    await Promise.all([
      db.select({ c: count() }).from(chatTasks),
      db
        .select({ c: count() })
        .from(chatTasks)
        .where(gte(chatTasks.createdAt, todayStart)),
      db
        .select({ status: chatTasks.status, count: count() })
        .from(chatTasks)
        .groupBy(chatTasks.status),
      db
        .select({ taskType: chatTasks.taskType, count: count() })
        .from(chatTasks)
        .groupBy(chatTasks.taskType),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${chatTasks.createdAt}), 'YYYY-MM-DD')`,
          taskCount: count(),
          completedCount: sql<number>`count(*) filter (where ${chatTasks.status} = 'completed')::int`,
        })
        .from(chatTasks)
        .where(
          sql`${chatTasks.createdAt} >= ${sql.raw("CURRENT_DATE - INTERVAL '29 days'")}`,
        )
        .groupBy(sql`date_trunc('day', ${chatTasks.createdAt})`)
        .orderBy(sql`date_trunc('day', ${chatTasks.createdAt})`),
      db
        .select({
          configId: chatTasks.apiConfigId,
          displayName: chatApiConfigs.displayName,
          taskCount: count(),
        })
        .from(chatTasks)
        .leftJoin(chatApiConfigs, eq(chatTasks.apiConfigId, chatApiConfigs.id))
        .groupBy(chatTasks.apiConfigId, chatApiConfigs.displayName)
        .orderBy(desc(count()))
        .limit(10),
      db
        .select({
          total: count(),
          successCount: sql<number>`count(*) filter (where ${workspaceApiLogs.responseStatus} = 'success')::int`,
          avgDuration: sql<number | null>`avg(${workspaceApiLogs.durationMs})::int`,
        })
        .from(workspaceApiLogs)
        .where(eq(workspaceApiLogs.apiType, "chat")),
      db.select({ c: count() }).from(conversations),
    ])

  return {
    totalCalls: totalAgg[0]?.c ?? 0,
    todayCalls: todayAgg[0]?.c ?? 0,
    statusDistribution: statusRows.map((s) => ({
      status: s.status,
      count: s.count,
    })),
    taskTypeDistribution: typeRows.map((t) => ({
      taskType: t.taskType,
      count: t.count,
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
    apiTotal: apiAgg[0]?.total ?? 0,
    apiSuccessCount: apiAgg[0]?.successCount ?? 0,
    apiAvgDurationMs: apiAgg[0]?.avgDuration ?? null,
    conversationCount: convAgg[0]?.c ?? 0,
  }
}


/* ═══════════════ 企业级样机渲染服务配置（system_setting key="mockup"） ═══════════════ */

/** 下发给超管的配置视图（密钥明文不出库，仅 hasApiKey） */
export interface MockupSettingView {
  enterpriseId: string
  apiBaseUrl: string
  hasApiKey: boolean
  costPerRender: number
  enabled: boolean
}

interface MockupSettingValue {
  apiBaseUrl?: string
  apiKeyEncrypted?: string
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
    costPerRender: Number.isFinite(cost) && cost > 0 ? Math.floor(cost) : 1,
    enabled: v.enabled !== false,
  }
}

export async function saveMockupSettingAction(input: {
  enterpriseId: string
  apiBaseUrl: string
  /** 留空 = 保留已存密钥 */
  apiKey?: string
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
  const enabled = input.enabled === true

  if (enabled && (!apiBaseUrl || !apiKeyEncrypted)) {
    return { ok: false, error: "启用前必须填写服务地址与 API Key" }
  }

  const value = {
    apiBaseUrl,
    apiKeyEncrypted,
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
