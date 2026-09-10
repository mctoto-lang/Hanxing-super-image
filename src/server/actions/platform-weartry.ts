"use server"

import { asc, eq } from "drizzle-orm"
import { pinyin } from "pinyin-pro"
import { db } from "@/db/client"
import { weartryScenes } from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import {
  createSceneSchema,
  updateSceneSchema,
  type CreateSceneInput,
  type UpdateSceneInput,
} from "@/server/schemas/platform-weartry"
import {
  nextSortOrder,
  redistributeSortOrder,
} from "@/server/services/sort-order"
import { revalidatePath } from "next/cache"

/**
 * 超管穿戴图片主数据管理（预置场景）
 *
 * 场景 key 由名称拼音自动生成（与图片方向同规）；
 * 商品图片配置中心（/platform/product-config）不涉及本文件任何数据。
 */

function revalidateAll() {
  revalidatePath("/platform/weartry-config/scenes")
  revalidatePath("/weartry")
}

export async function listWeartryScenesAdminAction() {
  await requireSuperAdmin()
  return db
    .select()
    .from(weartryScenes)
    .orderBy(asc(weartryScenes.sortOrder), asc(weartryScenes.createdAt))
}

/**
 * 从场景名称生成拼音 key（城市街拍 → chengshijiepai）：
 * 剔除非 [a-z0-9] 字符、超长截断；转换不出拉丁字符时回退时间戳兜底。
 */
function generateSceneKey(name: string): string {
  const py = pinyin(name, { toneType: "none", type: "array" })
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 50)
  return py || `scene_${Date.now().toString(36)}`
}

/** 生成不冲突的场景 key：拼音 + _2/_3… 后缀（key 有库级唯一约束） */
async function generateUniqueSceneKey(name: string): Promise<string> {
  const existing = new Set(
    (await db.select({ key: weartryScenes.key }).from(weartryScenes)).map(
      (r) => r.key,
    ),
  )
  const base = generateSceneKey(name)
  if (!existing.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}_${i}`
    if (!existing.has(candidate)) return candidate
  }
  return `${base}_${Date.now().toString(36)}`
}

export async function createWeartrySceneAction(input: CreateSceneInput) {
  await requireSuperAdmin()
  const parsed = createSceneSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  try {
    const key = parsed.data.key ?? (await generateUniqueSceneKey(parsed.data.name))
    await db.insert(weartryScenes).values({
      ...parsed.data,
      key,
      sortOrder: parsed.data.sortOrder ?? (await nextSortOrder(weartryScenes)),
    })
  } catch (err) {
    if (err instanceof Error && err.message.includes("ws_key_unique")) {
      return { ok: false, error: "场景标识已存在" }
    }
    return { ok: false, error: "创建失败" }
  }
  revalidateAll()
  return { ok: true, error: null }
}

/** 拖拽排序：按新顺序重写穿戴场景 sortOrder */
export async function reorderWeartryScenesAction(ids: string[]) {
  await requireSuperAdmin()
  try {
    await redistributeSortOrder(weartryScenes, ids)
  } catch {
    return { ok: false, error: "排序保存失败" }
  }
  revalidateAll()
  return { ok: true, error: null }
}

export async function updateWeartrySceneAction(
  id: string,
  input: UpdateSceneInput,
) {
  await requireSuperAdmin()
  const parsed = updateSceneSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  if (Object.keys(parsed.data).length === 0) {
    return { ok: false, error: "无变更" }
  }
  // key 创建后不可改（提交校验与 templateInfo.sceneKey 依赖其稳定）
  const { key: _key, ...rest } = parsed.data
  await db
    .update(weartryScenes)
    .set({ ...rest, updatedAt: new Date() })
    .where(eq(weartryScenes.id, id))
  revalidateAll()
  return { ok: true, error: null }
}

export async function toggleWeartrySceneActiveAction(id: string) {
  await requireSuperAdmin()
  const [row] = await db
    .select()
    .from(weartryScenes)
    .where(eq(weartryScenes.id, id))
    .limit(1)
  if (!row) return { ok: false, error: "场景不存在" }
  await db
    .update(weartryScenes)
    .set({ isActive: !row.isActive, updatedAt: new Date() })
    .where(eq(weartryScenes.id, id))
  revalidateAll()
  return { ok: true, error: null }
}
