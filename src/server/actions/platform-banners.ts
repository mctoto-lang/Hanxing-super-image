"use server"

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm"
import { db } from "@/db/client"
import { banners } from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import {
  bannerInputSchema,
  deleteBannerSchema,
  toggleBannerSchema,
  updateBannerSchema,
} from "@/server/schemas/platform"
import {
  nextSortOrder,
  redistributeSortOrder,
} from "@/server/services/sort-order"
import { revalidatePath } from "next/cache"
import type { PlatformListParams } from "./platform"

/**
 * 广告横幅 Server Actions（超管配置，登录后全站展示）
 *
 * - CRUD 均超管专属；展示端 getDisplayBanner 由 DashboardShell 调用，
 *   从生效横幅（启用 + 投放窗口内 + 倒计时未到期）中随机取一条实现轮换
 */

/** 展示端横幅数据（可序列化，直接传给客户端组件） */
export interface DisplayBanner {
  id: string
  title: string
  content: string
  linkUrl: string | null
  linkLabel: string
  icon: string
  countdownEndsAt: string | null
  /** 内容指纹（updatedAt）：关闭记忆 key 的一部分，内容更新后横幅重新出现 */
  revision: string
}

/** ISO 字符串 → Date（空串/undefined → null，DB 列可空） */
function toDate(v: string | undefined): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 横幅新建/编辑入参（时间均为 ISO 字符串，可空字段传 undefined） */
export interface BannerActionInput {
  title: string
  content: string
  linkUrl?: string
  linkLabel?: string
  icon?: string
  countdownEndsAt?: string
  startsAt?: string
  endsAt?: string
  sortOrder?: number
  isActive?: boolean
}

/** 新建横幅 */
export async function createBannerAction(input: BannerActionInput) {
  await requireSuperAdmin()
  const parsed = bannerInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  await db.insert(banners).values({
    title: d.title,
    content: d.content,
    linkUrl: d.linkUrl?.trim() || null,
    linkLabel: d.linkLabel ?? "立即查看",
    icon: d.icon ?? "megaphone",
    countdownEndsAt: toDate(d.countdownEndsAt),
    startsAt: toDate(d.startsAt),
    endsAt: toDate(d.endsAt),
    sortOrder: d.sortOrder ?? (await nextSortOrder(banners)),
    isActive: d.isActive ?? true,
  })

  revalidatePath("/platform/banners")
  return { ok: true as const, error: null }
}

/**
 * 拖拽排序：按新顺序重写横幅 sortOrder。
 * 列表分页 20/页——拖拽仅当前页子集，值重分配保证跨页相对顺序不变；
 * 不 bump updatedAt（避免展示端「关闭横幅」记忆被重置）。
 */
export async function reorderBannersAction(ids: string[]) {
  await requireSuperAdmin()
  try {
    await redistributeSortOrder(banners, ids)
  } catch {
    return { ok: false, error: "排序保存失败" }
  }
  revalidatePath("/platform/banners")
  return { ok: true, error: null }
}

/** 更新横幅（updatedAt 变化 → 展示端关闭记忆失效，横幅重新出现） */
export async function updateBannerAction(input: BannerActionInput & { id: string }) {
  await requireSuperAdmin()
  const parsed = updateBannerSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const { id, ...d } = parsed.data

  await db
    .update(banners)
    .set({
      title: d.title,
      content: d.content,
      linkUrl: d.linkUrl?.trim() || null,
      linkLabel: d.linkLabel ?? "立即查看",
      icon: d.icon ?? "megaphone",
      countdownEndsAt: toDate(d.countdownEndsAt),
      startsAt: toDate(d.startsAt),
      endsAt: toDate(d.endsAt),
      sortOrder: d.sortOrder ?? 0,
      isActive: d.isActive ?? true,
      updatedAt: new Date(),
    })
    .where(eq(banners.id, id))

  revalidatePath("/platform/banners")
  return { ok: true as const, error: null }
}

/** 删除横幅 */
export async function deleteBannerAction(input: { id: string }) {
  await requireSuperAdmin()
  const parsed = deleteBannerSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }

  await db.delete(banners).where(eq(banners.id, parsed.data.id))

  revalidatePath("/platform/banners")
  return { ok: true as const, error: null }
}

/** 启用/停用横幅 */
export async function toggleBannerAction(input: { id: string; isActive: boolean }) {
  await requireSuperAdmin()
  const parsed = toggleBannerSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }

  await db
    .update(banners)
    .set({
      isActive: parsed.data.isActive,
      updatedAt: new Date(),
    })
    .where(eq(banners.id, parsed.data.id))

  revalidatePath("/platform/banners")
  return { ok: true as const, error: null }
}

/** 横幅列表（超管管理页，分页 + 标题/内容搜索） */
export async function listBannersAction(opts: PlatformListParams = {}) {
  await requireSuperAdmin()
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)))
  const offset = (page - 1) * pageSize
  const q = opts.q?.trim()

  const where = q
    ? or(ilike(banners.title, `%${q}%`), ilike(banners.content, `%${q}%`))
    : undefined

  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(banners)
      .where(where)
      .orderBy(asc(banners.sortOrder), desc(banners.createdAt))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(banners).where(where),
  ])

  return { items, total, page, pageSize }
}

/**
 * 展示端：随机取一条当前生效的横幅（轮换）
 *
 * 生效条件：已启用 + 投放窗口内（startsAt/endsAt 空 = 不限）+ 倒计时未到期
 * （countdownEndsAt 空 = 无倒计时；到期后按促销语义自动下线）。
 * 未命中返回 null（展示组件渲染为空，不占位）。
 */
export async function getDisplayBanner(): Promise<DisplayBanner | null> {
  const now = new Date()

  const [row] = await db
    .select()
    .from(banners)
    .where(
      and(
        eq(banners.isActive, true),
        or(isNull(banners.startsAt), lte(banners.startsAt, now)),
        or(isNull(banners.endsAt), gt(banners.endsAt, now)),
        or(isNull(banners.countdownEndsAt), gt(banners.countdownEndsAt, now)),
      ),
    )
    .orderBy(sql`random()`)
    .limit(1)

  if (!row) return null

  return {
    id: row.id,
    title: row.title,
    content: row.content,
    linkUrl: row.linkUrl,
    linkLabel: row.linkLabel,
    icon: row.icon,
    countdownEndsAt: row.countdownEndsAt
      ? row.countdownEndsAt.toISOString()
      : null,
    revision: row.updatedAt.toISOString(),
  }
}
