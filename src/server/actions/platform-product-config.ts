"use server"

import { and, asc, eq, isNull } from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  productLanguages,
  productPlatforms,
  productPromptTemplates,
} from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import {
  getDesignatedProductChatModelId,
  saveDesignatedProductChatModelId,
} from "@/server/services/product-ai-config"
import {
  createLanguageSchema,
  createPlatformSchema,
  createPromptTemplateSchema,
  saveProductChatModelSettingSchema,
  updateLanguageSchema,
  updatePlatformSchema,
  updatePromptTemplateSchema,
  type CreateLanguageInput,
  type CreatePlatformInput,
  type CreatePromptTemplateInput,
  type UpdateLanguageInput,
  type UpdatePlatformInput,
  type UpdatePromptTemplateInput,
} from "@/server/schemas/platform-product"
import { revalidatePath } from "next/cache"

/**
 * 超管「商品主图配置」中心（V2.1）
 *
 * 上架平台 / 语言 / 提示词模板 / AI 对话模型 / 精修优化项（复用方向表 refine
 * 范围，见 platform-product.ts 的方向 CRUD）/ 尺寸规范。
 */

function revalidateAll() {
  revalidatePath("/platform/product-config")
  revalidatePath("/product")
}

// ═══════════════ 上架平台 ═══════════════

export async function listPlatformsConfigAction() {
  await requireSuperAdmin()
  return db
    .select()
    .from(productPlatforms)
    .orderBy(asc(productPlatforms.sortOrder), asc(productPlatforms.key))
}

export async function createPlatformConfigAction(input: CreatePlatformInput) {
  await requireSuperAdmin()
  const parsed = createPlatformSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  try {
    await db.insert(productPlatforms).values(parsed.data)
  } catch (err) {
    if (err instanceof Error && err.message.includes("pp_key_unique")) {
      return { ok: false, error: "平台标识已存在" }
    }
    return { ok: false, error: "创建失败" }
  }
  revalidateAll()
  return { ok: true, error: null }
}

export async function updatePlatformConfigAction(id: string, input: UpdatePlatformInput) {
  await requireSuperAdmin()
  const parsed = updatePlatformSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const data = parsed.data
  if (Object.keys(data).length === 0) return { ok: false, error: "无变更" }
  await db
    .update(productPlatforms)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(productPlatforms.id, id))
  revalidateAll()
  return { ok: true, error: null }
}

export async function togglePlatformConfigActiveAction(id: string) {
  await requireSuperAdmin()
  const [row] = await db
    .select()
    .from(productPlatforms)
    .where(eq(productPlatforms.id, id))
    .limit(1)
  if (!row) return { ok: false, error: "平台不存在" }
  await db
    .update(productPlatforms)
    .set({ isActive: !row.isActive, updatedAt: new Date() })
    .where(eq(productPlatforms.id, id))
  revalidateAll()
  return { ok: true, error: null }
}

// ═══════════════ 语言 ═══════════════

export async function listLanguagesConfigAction() {
  await requireSuperAdmin()
  return db
    .select()
    .from(productLanguages)
    .orderBy(asc(productLanguages.sortOrder), asc(productLanguages.key))
}

export async function createLanguageConfigAction(input: CreateLanguageInput) {
  await requireSuperAdmin()
  const parsed = createLanguageSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  try {
    await db.insert(productLanguages).values(parsed.data)
  } catch (err) {
    if (err instanceof Error && err.message.includes("plg_key_unique")) {
      return { ok: false, error: "语言标识已存在" }
    }
    return { ok: false, error: "创建失败" }
  }
  revalidateAll()
  return { ok: true, error: null }
}

export async function updateLanguageConfigAction(id: string, input: UpdateLanguageInput) {
  await requireSuperAdmin()
  const parsed = updateLanguageSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const data = parsed.data
  if (Object.keys(data).length === 0) return { ok: false, error: "无变更" }
  await db
    .update(productLanguages)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(productLanguages.id, id))
  revalidateAll()
  return { ok: true, error: null }
}

export async function toggleLanguageConfigActiveAction(id: string) {
  await requireSuperAdmin()
  const [row] = await db
    .select()
    .from(productLanguages)
    .where(eq(productLanguages.id, id))
    .limit(1)
  if (!row) return { ok: false, error: "语言不存在" }
  await db
    .update(productLanguages)
    .set({ isActive: !row.isActive, updatedAt: new Date() })
    .where(eq(productLanguages.id, id))
  revalidateAll()
  return { ok: true, error: null }
}

// ═══════════════ 提示词模板 ═══════════════

export async function listPromptTemplatesConfigAction() {
  await requireSuperAdmin()
  return db
    .select()
    .from(productPromptTemplates)
    .orderBy(asc(productPromptTemplates.sortOrder), asc(productPromptTemplates.scene))
}

export async function createPromptTemplateConfigAction(input: CreatePromptTemplateInput) {
  await requireSuperAdmin()
  const parsed = createPromptTemplateSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  try {
    await db.insert(productPromptTemplates).values(parsed.data)
  } catch (err) {
    if (err instanceof Error && err.message.includes("ppt_scene_unique")) {
      return { ok: false, error: "该场景的模板已存在" }
    }
    return { ok: false, error: "创建失败" }
  }
  revalidateAll()
  return { ok: true, error: null }
}

export async function updatePromptTemplateConfigAction(
  id: string,
  input: UpdatePromptTemplateInput,
) {
  await requireSuperAdmin()
  const parsed = updatePromptTemplateSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const data = parsed.data
  if (Object.keys(data).length === 0) return { ok: false, error: "无变更" }
  await db
    .update(productPromptTemplates)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(productPromptTemplates.id, id))
  revalidateAll()
  return { ok: true, error: null }
}

export async function togglePromptTemplateConfigActiveAction(id: string) {
  await requireSuperAdmin()
  const [row] = await db
    .select()
    .from(productPromptTemplates)
    .where(eq(productPromptTemplates.id, id))
    .limit(1)
  if (!row) return { ok: false, error: "模板不存在" }
  await db
    .update(productPromptTemplates)
    .set({ isActive: !row.isActive, updatedAt: new Date() })
    .where(eq(productPromptTemplates.id, id))
  revalidateAll()
  return { ok: true, error: null }
}

// ═══════════════ AI 对话模型（全局强制指定） ═══════════════

/** 下拉候选行 */
export interface ProductChatModelOption {
  id: string
  displayName: string
  name: string
}

/** 读当前指定 + 活跃平台预置模型候选（指定行失效时 active=false，前端提示回退中） */
export async function getProductChatModelSettingAction(): Promise<{
  chatApiConfigId: string | null
  active: boolean
  options: ProductChatModelOption[]
}> {
  await requireSuperAdmin()
  const [options, designatedId] = await Promise.all([
    db
      .select({
        id: chatApiConfigs.id,
        displayName: chatApiConfigs.displayName,
        name: chatApiConfigs.name,
      })
      .from(chatApiConfigs)
      .where(
        and(
          eq(chatApiConfigs.isActive, true),
          isNull(chatApiConfigs.enterpriseId),
        ),
      )
      .orderBy(asc(chatApiConfigs.displayName)),
    getDesignatedProductChatModelId(),
  ])
  return {
    chatApiConfigId: designatedId,
    active: designatedId ? options.some((o) => o.id === designatedId) : false,
    options,
  }
}

/** 保存指定（null=清除）；id 必须是活跃的平台预置模型 */
export async function saveProductChatModelSettingAction(
  chatApiConfigId: string | null,
) {
  await requireSuperAdmin()
  const parsed = saveProductChatModelSettingSchema.safeParse({ chatApiConfigId })
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const id = parsed.data.chatApiConfigId
  if (id) {
    const [row] = await db
      .select({ id: chatApiConfigs.id })
      .from(chatApiConfigs)
      .where(
        and(
          eq(chatApiConfigs.id, id),
          eq(chatApiConfigs.isActive, true),
          isNull(chatApiConfigs.enterpriseId),
        ),
      )
      .limit(1)
    if (!row) return { ok: false, error: "指定模型不存在或不可用" }
  }
  await saveDesignatedProductChatModelId(id)
  revalidateAll()
  return { ok: true, error: null }
}
