import { cache } from "react"
import { eq } from "drizzle-orm"
import { auth } from "@/lib/auth/config"
import { db } from "@/db/client"
import {
  enterprises,
  permissionGroups,
  users,
  type ModuleName,
  type EnterpriseRole,
} from "@/db/schema"

/** 企业行的推断类型 */
type Enterprise = typeof enterprises.$inferSelect
/** 权限组行的推断类型 */
type PermissionGroup = typeof permissionGroups.$inferSelect
/** 用户行的推断类型 */
type User = typeof users.$inferSelect

/**
 * 用户上下文三元组（手册 §5.1、§10.2）
 *
 * 每个服务端请求通过 getCurrentUserContext() 拿到 (user, enterprise, group)，
 * 后续所有业务查询必须基于此作用域注入 enterpriseId（多租户铁律）。
 */
export interface UserContext {
  user: Pick<
    User,
    | "id"
    | "username"
    | "name"
    | "image"
    | "isSuperAdmin"
    | "enterpriseId"
    | "enterpriseRole"
    | "groupId"
    | "creditsBalance"
  >
  enterprise: Enterprise | null // 超管为 null
  group: PermissionGroup | null // 超管或未分配组时为 null
  /** 模块访问校验：企业已开通模块 ∩ 权限组允许页面（手册 D22+D21） */
  accessibleModules: ModuleName[]
  /** 是否可访问某模块 */
  canAccess: (module: ModuleName) => boolean
}

export type { EnterpriseRole }

/**
 * 获取当前登录用户的完整上下文（服务端专用，带 React cache 防重复查询）。
 *
 * 未登录返回 null。
 */
export const getCurrentUserContext = cache(async (): Promise<UserContext | null> => {
  const session = await auth()
  if (!session?.user?.id) return null

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1)
  if (!user || user.status !== "active") return null

  let enterprise: Enterprise | null = null
  let group: PermissionGroup | null = null

  if (user.enterpriseId) {
    ;[enterprise] = await db
      .select()
      .from(enterprises)
      .where(eq(enterprises.id, user.enterpriseId))
      .limit(1)
    // 企业已停用则视为无有效企业作用域（§R9：操作全部 403）
    if (enterprise?.status !== "active") enterprise = null
  }

  if (user.groupId) {
    ;[group] = await db
      .select()
      .from(permissionGroups)
      .where(eq(permissionGroups.id, user.groupId))
      .limit(1)
  }

  const accessibleModules = computeAccessibleModules(
    user.isSuperAdmin,
    enterprise?.enabledModules ?? [],
    group?.allowedPages ?? [],
  )

  return {
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      image: user.image,
      isSuperAdmin: user.isSuperAdmin,
      enterpriseId: user.enterpriseId,
      enterpriseRole: user.enterpriseRole,
      groupId: user.groupId,
      creditsBalance: user.creditsBalance,
    },
    enterprise,
    group,
    accessibleModules,
    canAccess: (module) => accessibleModules.includes(module),
  }
})

/**
 * 模块访问校验链（手册 §5.1）：
 *   企业 enabledModules 是否含目标模块？ → 否：403
 *     └ 是 → 权限组 allowedPages 是否含目标页？ → 否：403
 *             └ 是 → 放行
 *
 * 超管无企业归属，不进入业务页（创作/资产/批量/商品），仅保留个人设置。
 */
export function computeAccessibleModules(
  isSuperAdmin: boolean,
  enterpriseModules: ModuleName[],
  groupAllowedPages: ModuleName[],
): ModuleName[] {
  if (isSuperAdmin) {
    // 超管：仅个人设置（平台管理入口走二级导航，不走业务模块）
    return ["settings"]
  }
  if (groupAllowedPages.length === 0) {
    return enterpriseModules
  }
  return enterpriseModules.filter((m) => groupAllowedPages.includes(m))
}

/**
 * 要求当前用户必须登录且属于某企业，否则抛错（供 Server Action 入口校验）。
 */
export async function requireUserContext(): Promise<UserContext> {
  const ctx = await getCurrentUserContext()
  if (!ctx) throw new Error("UNAUTHORIZED: 未登录")
  return ctx
}

/**
 * 要求当前用户必须属于某企业（普通成员/管理员），超管和企业为空则拒绝。
 */
export async function requireEnterpriseContext(): Promise<UserContext> {
  const ctx = await requireUserContext()
  if (!ctx.enterprise || !ctx.user.enterpriseId) {
    throw new Error("FORBIDDEN: 当前用户无企业归属")
  }
  return ctx
}

/**
 * 要求当前用户必须是企业管理员（owner/admin）。
 */
export async function requireEnterpriseAdmin(): Promise<UserContext> {
  const ctx = await requireEnterpriseContext()
  if (ctx.user.enterpriseRole !== "owner" && ctx.user.enterpriseRole !== "admin") {
    throw new Error("FORBIDDEN: 需要企业管理员权限")
  }
  return ctx
}

/**
 * 要求当前用户必须是平台超管。
 */
export async function requireSuperAdmin(): Promise<UserContext> {
  const ctx = await requireUserContext()
  if (!ctx.user.isSuperAdmin) {
    throw new Error("FORBIDDEN: 需要平台超管权限")
  }
  return ctx
}

/**
 * 多租户数据隔离作用域注入器（手册 §10.2 铁律）。
 *
 * 所有业务查询强制带 WHERE enterprise_id = $user.enterpriseId。
 * 超管场景需显式声明（不应通过此函数）。
 */
export function getCurrentEnterpriseScope(ctx: UserContext): {
  enterpriseId: string
} {
  if (!ctx.user.enterpriseId) {
    throw new Error("FORBIDDEN: 当前用户无企业作用域")
  }
  return { enterpriseId: ctx.user.enterpriseId }
}
