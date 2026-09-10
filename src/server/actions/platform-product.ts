"use server"

import { asc, eq, inArray } from "drizzle-orm"
import { pinyin } from "pinyin-pro"
import { db } from "@/db/client"
import {
  platformSizeSpecs,
  productDirections,
  type ProductDirectionScope,
} from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import {
  createDirectionSchema,
  createSizeSpecSchema,
  updateDirectionSchema,
  updateSizeSpecSchema,
  type CreateDirectionInput,
  type CreateSizeSpecInput,
  type UpdateDirectionInput,
  type UpdateSizeSpecInput,
} from "@/server/schemas/platform-product"
import { directionInScope } from "@/lib/product/prompt"
import {
  nextSortOrder,
  redistributeSortOrder,
} from "@/server/services/sort-order"
import { revalidatePath } from "next/cache"

/**
 * 超管商品主图 V2 主数据管理（方向池 / 平台尺寸规范）
 */

function revalidateAll() {
  // 方向池/尺寸规范被商品与穿戴共用；穿戴方向页复用本模块的 action
  // （含拖拽），product-config 与 weartry-config 的子路由都需失效
  revalidatePath("/platform/product-config", "layout")
  revalidatePath("/platform/weartry-config", "layout")
  revalidatePath("/product")
  revalidatePath("/weartry")
}

// ═══════════════ 方向管理 ═══════════════

export async function listDirectionsAction() {
  await requireSuperAdmin()
  return db
    .select()
    .from(productDirections)
    .orderBy(asc(productDirections.sortOrder), asc(productDirections.createdAt))
}

/**
 * 从方向名称生成拼音 key（白底图 → baiditu）：
 * 剔除非 [a-z0-9] 字符、超长截断；转换不出拉丁字符时回退时间戳兜底。
 * 冲突时由调用方追加 _2/_3 后缀去重。
 */
function generateDirectionKey(name: string): string {
  const py = pinyin(name, { toneType: "none", type: "array" })
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 50)
  return py || `dir_${Date.now().toString(36)}`
}

/** 生成不冲突的方向 key：拼音 + _2/_3… 后缀（key 有库级唯一约束） */
async function generateUniqueDirectionKey(name: string): Promise<string> {
  const existing = new Set(
    (
      await db.select({ key: productDirections.key }).from(productDirections)
    ).map((r) => r.key),
  )
  const base = generateDirectionKey(name)
  if (!existing.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}_${i}`
    if (!existing.has(candidate)) return candidate
  }
  return `${base}_${Date.now().toString(36)}`
}

export async function createDirectionAction(input: CreateDirectionInput) {
  await requireSuperAdmin()
  const parsed = createDirectionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  // 固定项守卫：产品精修快捷优化项固定，不可新增
  if (parsed.data.scope === "refine") {
    return { ok: false, error: "产品精修快捷优化项固定，不可新增" }
  }
  try {
    const key =
      parsed.data.key ?? (await generateUniqueDirectionKey(parsed.data.name))
    const { scope, ...rest } = parsed.data
    await db
      .insert(productDirections)
      .values({
        ...rest,
        appliesTo: [scope],
        key,
        sortOrder: rest.sortOrder ?? (await nextSortOrder(productDirections)),
      })
  } catch (err) {
    if (err instanceof Error && err.message.includes("pd_key_unique")) {
      return { ok: false, error: "方向标识已存在" }
    }
    return { ok: false, error: "创建失败" }
  }
  revalidateAll()
  return { ok: true, error: null }
}

/**
 * 拖拽排序：按新顺序重写方向 sortOrder（商品套图/A+详情页/穿戴方向池；
 * 展示按 scope 过滤，重排子集值不影响其它池）。
 * 固定项守卫：产品精修固定项不参与排序。
 */
export async function reorderDirectionsAction(ids: string[]) {
  await requireSuperAdmin()
  if (ids.length === 0) return { ok: true, error: null }
  const rows = await db
    .select({ id: productDirections.id, appliesTo: productDirections.appliesTo })
    .from(productDirections)
    .where(inArray(productDirections.id, ids))
  const idSet = new Set(ids)
  if (rows.length !== idSet.size) {
    return { ok: false, error: "存在无效的方向" }
  }
  if (rows.some((r) => directionInScope(r.appliesTo, "refine"))) {
    return { ok: false, error: "产品精修快捷优化项固定，不支持拖拽排序" }
  }
  try {
    await redistributeSortOrder(productDirections, ids)
  } catch {
    return { ok: false, error: "排序保存失败" }
  }
  revalidateAll()
  return { ok: true, error: null }
}

export async function updateDirectionAction(id: string, input: UpdateDirectionInput) {
  await requireSuperAdmin()
  const parsed = updateDirectionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const [existing] = await db
    .select({ appliesTo: productDirections.appliesTo })
    .from(productDirections)
    .where(eq(productDirections.id, id))
    .limit(1)
  if (!existing) return { ok: false, error: "方向不存在" }
  // 固定项守卫：精修快捷优化项仅允许改提示词模板（防改名/改分类/改排序逃逸固定集）
  if (directionInScope(existing.appliesTo, "refine")) {
    const { promptTemplate } = parsed.data
    if (promptTemplate == null) {
      return { ok: false, error: "产品精修快捷优化项固定，仅可修改提示词模板" }
    }
    await db
      .update(productDirections)
      .set({ promptTemplate, updatedAt: new Date() })
      .where(eq(productDirections.id, id))
    revalidateAll()
    return { ok: true, error: null }
  }
  const { scope, ...rest } = parsed.data
  const data = {
    ...rest,
    ...(scope
      ? { appliesTo: [scope] as [ProductDirectionScope] }
      : {}),
  }
  if (Object.keys(data).length === 0) {
    return { ok: false, error: "无变更" }
  }
  await db
    .update(productDirections)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(productDirections.id, id))
  revalidateAll()
  return { ok: true, error: null }
}

export async function toggleDirectionActiveAction(id: string) {
  await requireSuperAdmin()
  const [row] = await db
    .select()
    .from(productDirections)
    .where(eq(productDirections.id, id))
    .limit(1)
  if (!row) return { ok: false, error: "方向不存在" }
  // 固定项守卫：精修快捷优化项不可停用（反向「启用」放行——自愈历史误停用）
  if (directionInScope(row.appliesTo, "refine") && row.isActive) {
    return { ok: false, error: "产品精修快捷优化项固定，不可停用" }
  }
  await db
    .update(productDirections)
    .set({ isActive: !row.isActive, updatedAt: new Date() })
    .where(eq(productDirections.id, id))
  revalidateAll()
  return { ok: true, error: null }
}

// ═══════════════ 尺寸规范管理 ═══════════════

export async function listSizeSpecsAction() {
  await requireSuperAdmin()
  return db
    .select()
    .from(platformSizeSpecs)
    .orderBy(
      asc(platformSizeSpecs.platformKey),
      asc(platformSizeSpecs.sortOrder),
    )
}

export async function createSizeSpecAction(input: CreateSizeSpecInput) {
  await requireSuperAdmin()
  const parsed = createSizeSpecSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  try {
    await db.insert(platformSizeSpecs).values({
      ...parsed.data,
      sortOrder:
        parsed.data.sortOrder ?? (await nextSortOrder(platformSizeSpecs)),
    })
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("pss_platform_label_unique")
    ) {
      return { ok: false, error: "该平台下尺寸名称已存在" }
    }
    return { ok: false, error: "创建失败" }
  }
  revalidateAll()
  return { ok: true, error: null }
}

/**
 * 拖拽排序：按新顺序重写尺寸规范 sortOrder（按平台分组内拖动）。
 * 分组校验：批次必须同属一个平台——跨组混排会把 A 组的值重分配
 * 写进 B 组，污染两组之间的相对顺序。
 */
export async function reorderSizeSpecsAction(ids: string[]) {
  await requireSuperAdmin()
  if (ids.length === 0) return { ok: true, error: null }
  const rows = await db
    .select({
      id: platformSizeSpecs.id,
      platformKey: platformSizeSpecs.platformKey,
    })
    .from(platformSizeSpecs)
    .where(inArray(platformSizeSpecs.id, ids))
  const idSet = new Set(ids)
  if (rows.length !== idSet.size) {
    return { ok: false, error: "存在无效的尺寸规范" }
  }
  const platformKeys = new Set(rows.map((r) => r.platformKey))
  if (platformKeys.size > 1) {
    return { ok: false, error: "仅可在同一平台分组内拖动排序" }
  }
  try {
    await redistributeSortOrder(platformSizeSpecs, ids)
  } catch {
    return { ok: false, error: "排序保存失败" }
  }
  revalidateAll()
  return { ok: true, error: null }
}

export async function updateSizeSpecAction(id: string, input: UpdateSizeSpecInput) {
  await requireSuperAdmin()
  const parsed = updateSizeSpecSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const data = parsed.data
  if (Object.keys(data).length === 0) {
    return { ok: false, error: "无变更" }
  }
  await db
    .update(platformSizeSpecs)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(platformSizeSpecs.id, id))
  revalidateAll()
  return { ok: true, error: null }
}

export async function toggleSizeSpecActiveAction(id: string) {
  await requireSuperAdmin()
  const [row] = await db
    .select()
    .from(platformSizeSpecs)
    .where(eq(platformSizeSpecs.id, id))
    .limit(1)
  if (!row) return { ok: false, error: "规范不存在" }
  await db
    .update(platformSizeSpecs)
    .set({ isActive: !row.isActive, updatedAt: new Date() })
    .where(eq(platformSizeSpecs.id, id))
  revalidateAll()
  return { ok: true, error: null }
}
