"use server"

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  models,
  permissionGroups,
  users,
  type ModuleName,
} from "@/db/schema"
import {
  requireEnterpriseAdmin,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { permissionGroupSchema } from "@/server/schemas/admin"
import { moveGroupMembersSchema } from "@/server/schemas/admin"
import { revalidatePath } from "next/cache"

/**
 * 权限组管理 Server Actions（手册 M2、D21）
 *
 * 权限组绑定企业（每企业可有多个组，至多一个 isDefault）。
 * 企业管理员（owner/admin）可 CRUD 本企业的权限组。
 */

/** 列表分页参数（管理端列表统一约定：page 从 1 开始） */
export interface ListPageParams {
  page?: number
  pageSize?: number
}

/** 列出本企业的权限组（分页） */
export async function listGroupsAction(opts: ListPageParams = {}) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)))
  const offset = (page - 1) * pageSize

  const where = eq(permissionGroups.enterpriseId, enterpriseId)
  const [items, [{ total }]] = await Promise.all([
    db
      .select({
        id: permissionGroups.id,
        name: permissionGroups.name,
        description: permissionGroups.description,
        allowedModels: permissionGroups.allowedModels,
        allowedChatModels: permissionGroups.allowedChatModels,
        allowedPages: permissionGroups.allowedPages,
        maxConcurrent: permissionGroups.maxConcurrent,
        priority: permissionGroups.priority,
        isDefault: permissionGroups.isDefault,
        memberCount: db.$count(users, eq(users.groupId, permissionGroups.id)),
        createdAt: permissionGroups.createdAt,
      })
      .from(permissionGroups)
      .where(where)
      .orderBy(permissionGroups.createdAt, permissionGroups.id)
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(permissionGroups)
      .where(where),
  ])

  return { items, total, page, pageSize }
}

/**
 * 列出本企业全部权限组（不分页，供下拉选择器用）。
 *
 * listGroupsAction 单页上限 50；组多于 50 时按 total 翻页拉全量再聚合，
 * 避免目标组下拉静默截断（组本身有分页管理页，此处只取 id/name 等字段）。
 */
export async function listAllGroupsAction() {
  const first = await listGroupsAction({ page: 1, pageSize: 50 })
  const totalPages = Math.ceil(first.total / first.pageSize)
  const rest =
    totalPages > 1
      ? await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) =>
            listGroupsAction({ page: i + 2, pageSize: first.pageSize }),
          ),
        )
      : []
  return rest.reduce((acc, r) => acc.concat(r.items), [...first.items])
}

/**
 * 把 id 列表裁剪到企业开通范围（静默裁剪，兼容历史组残留数据）：
 * 越权项（企业已关闭的模块/模型）移除；但若原值非空而裁完为空，
 * 保留原值——空数组语义是「放行全部」，静默放宽权限比保留无效 id 更危险。
 * （三白名单同时全部裁空的场景由返回的 allOutOfScope 标记，调用方直接报错，
 * 不再走到这里的「保留原值」分支。）
 */
function pruneToScope<T extends string>(ids: T[], visibleIds: Set<string>): T[] {
  const pruned = ids.filter((id) => visibleIds.has(id))
  return pruned.length > 0 || ids.length === 0 ? pruned : ids
}

/** 企业可用生图模型 id 集（平台预置 ∩ visiblePresetModels 白名单 + 本企业私有） */
async function loadVisibleModelIds(
  enterpriseId: string,
  whitelist: string[],
): Promise<Set<string>> {
  const rows = await db
    .select({ id: models.id, enterpriseId: models.enterpriseId })
    .from(models)
    .where(or(isNull(models.enterpriseId), eq(models.enterpriseId, enterpriseId)))
  return new Set(
    rows
      .filter(
        (m) =>
          m.enterpriseId !== null ||
          whitelist.length === 0 ||
          whitelist.includes(m.id),
      )
      .map((m) => m.id),
  )
}

/** 企业可用对话模型 id 集（同上，白名单为 visiblePresetChatModels） */
async function loadVisibleChatModelIds(
  enterpriseId: string,
  whitelist: string[],
): Promise<Set<string>> {
  const rows = await db
    .select({ id: chatApiConfigs.id, enterpriseId: chatApiConfigs.enterpriseId })
    .from(chatApiConfigs)
    .where(
      or(
        isNull(chatApiConfigs.enterpriseId),
        eq(chatApiConfigs.enterpriseId, enterpriseId),
      ),
    )
  return new Set(
    rows
      .filter(
        (m) =>
          m.enterpriseId !== null ||
          whitelist.length === 0 ||
          whitelist.includes(m.id),
      )
      .map((m) => m.id),
  )
}

/**
 * 权限组三白名单按企业开通范围裁剪（allowedPages ⊆ enabledModules、
 * allowedModels/allowedChatModels ⊆ 企业可见模型），仅处理入参中出现的字段。
 */
async function pruneGroupScope(
  ctx: Awaited<ReturnType<typeof requireEnterpriseAdmin>>,
  input: {
    allowedModels?: string[]
    allowedChatModels?: string[]
    allowedPages?: ModuleName[]
  },
) {
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const moduleKeys = new Set<string>([
    ...(ctx.enterprise?.enabledModules ?? []),
    "settings", // 平台侧强制保留 settings，防御旧数据缺失
  ])
  const [visibleModelIds, visibleChatIds] = await Promise.all([
    loadVisibleModelIds(enterpriseId, ctx.enterprise?.visiblePresetModels ?? []),
    loadVisibleChatModelIds(
      enterpriseId,
      ctx.enterprise?.visiblePresetChatModels ?? [],
    ),
  ])
  // 所选全部越权判定：任一白名单有勾选，但全部勾选项均不在企业开通范围
  // （三白名单裁后全空）——此时不走 pruneToScope 的「保留原值」兜底，
  // 由调用方明确报错，避免整组无效 id 无感知落库
  const validPages = (input.allowedPages ?? []).filter((p) =>
    moduleKeys.has(p),
  )
  const validModels = (input.allowedModels ?? []).filter((id) =>
    visibleModelIds.has(id),
  )
  const validChatModels = (input.allowedChatModels ?? []).filter((id) =>
    visibleChatIds.has(id),
  )
  const allOutOfScope =
    (input.allowedPages?.length ?? 0) +
      (input.allowedModels?.length ?? 0) +
      (input.allowedChatModels?.length ?? 0) >
      0 &&
    validPages.length === 0 &&
    validModels.length === 0 &&
    validChatModels.length === 0
  return {
    ...(input.allowedModels
      ? { allowedModels: pruneToScope(input.allowedModels, visibleModelIds) }
      : {}),
    ...(input.allowedChatModels
      ? {
          allowedChatModels: pruneToScope(
            input.allowedChatModels,
            visibleChatIds,
          ),
        }
      : {}),
    ...(input.allowedPages
      ? { allowedPages: pruneToScope(input.allowedPages, moduleKeys) }
      : {}),
    allOutOfScope,
  }
}

/** 创建权限组 */
export async function createGroupAction(input: {
  name: string
  description?: string
  allowedModels?: string[]
  allowedChatModels?: string[]
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
  // 三白名单按企业开通范围静默裁剪（越权项不可落库）；
  // 所选全部越权（裁后全空）时明确报错，绝不静默放宽为「放行全部」
  const scoped = await pruneGroupScope(ctx, d)
  if (scoped.allOutOfScope) {
    return {
      ok: false as const,
      error: "所选模块/模型均已不在企业开通范围，请重新选择",
    }
  }

  const [group] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId,
      name: d.name,
      description: d.description ?? null,
      allowedModels: scoped.allowedModels ?? [],
      allowedChatModels: scoped.allowedChatModels ?? [],
      allowedPages: scoped.allowedPages ?? [],
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
    allowedChatModels?: string[]
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

  // 三白名单按企业开通范围静默裁剪（越权项不可落库；编辑弹窗可能带出历史残留 id）；
  // 所选全部越权（裁后全空）时明确报错，绝不静默放宽为「放行全部」
  const scoped = await pruneGroupScope(ctx, parsed.data)
  if (scoped.allOutOfScope) {
    return {
      ok: false as const,
      error: "所选模块/模型均已不在企业开通范围，请重新选择",
    }
  }

  await db
    .update(permissionGroups)
    .set({
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined
        ? { description: parsed.data.description }
        : {}),
      ...(parsed.data.allowedModels
        ? { allowedModels: scoped.allowedModels ?? parsed.data.allowedModels }
        : {}),
      ...(parsed.data.allowedChatModels
        ? { allowedChatModels: scoped.allowedChatModels ?? parsed.data.allowedChatModels }
        : {}),
      ...(parsed.data.allowedPages
        ? { allowedPages: scoped.allowedPages ?? parsed.data.allowedPages }
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

/** 查看组内成员（组必须属于本企业；上限 200 条，仅用于弹窗展示） */
export async function listGroupMembersAction(groupId: string) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  const [group] = await db
    .select({ id: permissionGroups.id })
    .from(permissionGroups)
    .where(
      and(
        eq(permissionGroups.id, groupId),
        eq(permissionGroups.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (!group) return { ok: false as const, error: "权限组不存在" }

  const members = await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      enterpriseRole: users.enterpriseRole,
      status: users.status,
    })
    .from(users)
    .where(eq(users.groupId, groupId))
    .orderBy(users.createdAt)
    .limit(200)

  return { ok: true as const, error: null, members }
}

/**
 * 整组转移成员到目标组（删除组前须先清空成员）。
 *
 * from/to 均须属于本企业且不相同；转移后 from 组成员数为 0，
 * 可直接删除。空组转移幂等成功（moved=0）。
 */
export async function moveGroupMembersAction(input: {
  fromGroupId: string
  toGroupId: string
}) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const parsed = moveGroupMembersSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  const groups = await db
    .select({ id: permissionGroups.id })
    .from(permissionGroups)
    .where(
      and(
        eq(permissionGroups.enterpriseId, enterpriseId),
        inArray(permissionGroups.id, [d.fromGroupId, d.toGroupId]),
      ),
    )
  const ids = new Set(groups.map((g) => g.id))
  if (!ids.has(d.fromGroupId) || !ids.has(d.toGroupId)) {
    return { ok: false as const, error: "权限组不存在" }
  }

  const moved = await db
    .update(users)
    .set({ groupId: d.toGroupId, updatedAt: new Date() })
    .where(eq(users.groupId, d.fromGroupId))
    .returning({ id: users.id })

  revalidatePath("/admin/groups")
  revalidatePath("/admin/users")
  return { ok: true as const, error: null, moved: moved.length }
}
