"use server"

import { and, eq, isNull, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  models,
  enterprises,
  type ModelExtraConfig,
  type ModelSizePreset,
} from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import { modelConfigSchema } from "@/server/schemas/admin"
import { validateImageModelConfig } from "@/lib/ai/image-model-config"
import { encrypt } from "@/lib/crypto"
import { revalidatePath } from "next/cache"

/**
 * 平台预置模型管理 Server Actions（需求 2）
 *
 * - 仅超管可操作；管理 enterpriseId = NULL 的平台预置模型（全企业可见）。
 * - API Key 落库前 AES-256-GCM 加密；编辑时留空 = 不修改。
 * - 删除 = 软删除（is_active=false），保留历史任务外键完整性。
 * - costPerImage 由超管在此定义，企业用户生图按此扣个人配额。
 */

/** 把扁平字段组装为 extraConfig（按 apiFormat 白名单） */
function buildExtraConfig(input: {
  apiFormat: "openai" | "jimeng"
  jimengResolution?: "1k" | "2k" | "4k"
  jimengN?: number
}): ModelExtraConfig {
  // openai 标准格式无额外配置项
  if (input.apiFormat === "openai") return {}
  // jimeng
  const cfg: ModelExtraConfig = {}
  if (input.jimengResolution) cfg.jimengResolution = input.jimengResolution
  if (input.jimengN) cfg.jimengN = input.jimengN
  return cfg
}

/**
 * 把平台预置模型 id 幂等地追加到所有「白名单模式」企业（visiblePresetModels 非空）。
 *
 * 企业白名单语义（需求 2c）：空 = 全部预置可见（无需同步）；
 * 非空 = 仅枚举的 id 可见，新建预置模型必须显式追加，否则会被企业端过滤层③
 * （listAvailableModelsAction 的 visiblePresetModels 判断）拦截。
 */
async function syncPresetModelToWhitelists(modelId: string) {
  const affected = await db
    .select({
      id: enterprises.id,
      visible: enterprises.visiblePresetModels,
    })
    .from(enterprises)
    .where(sql`jsonb_array_length(${enterprises.visiblePresetModels}) > 0`)

  for (const ent of affected) {
    const list = (ent.visible as string[] | null) ?? []
    if (list.includes(modelId)) continue // 幂等：已包含则跳过
    await db
      .update(enterprises)
      .set({ visiblePresetModels: [...list, modelId], updatedAt: new Date() })
      .where(eq(enterprises.id, ent.id))
  }
}

/** 列表项类型（与 listPresetModelsAction 返回一致） */
export interface PresetModelRow {
  id: string
  enterpriseId: string | null
  name: string
  displayName: string
  apiEndpoint: string
  apiFormat: "openai" | "jimeng"
  extraConfig: ModelExtraConfig | null
  costPerImage: number
  description: string | null
  badgeText: string | null
  badgeColor: string | null
  sizePresets: ModelSizePreset[] | null
  supportsImageCount: boolean
  supportsSmartSize: boolean
  visibleInCreate: boolean
  visibleInWorkspace: boolean
  visibleInProduct: boolean
  visibleInWeartry: boolean
  supportsReferenceImage: boolean
  maxReferenceImages: number
  referenceImageField: string | null
  maxConcurrent: number
  maxRetries: number
  apiTimeout: number
  taskTimeout: number
  isActive: boolean
  iconUrl: string | null
}

/**
 * 列出全部平台预置模型（enterpriseId=NULL，不含解密 Key，分页）。
 * 默认 pageSize=100 兼顾「企业模型配置」弹窗的全量下拉场景。
 */
export async function listPresetModelsAction(
  opts: { page?: number; pageSize?: number } = {},
): Promise<{
  items: PresetModelRow[]
  total: number
  activeCount: number
  totalCost: number
  page: number
  pageSize: number
}> {
  await requireSuperAdmin()
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 100)))

  const rows = await db
    .select({
      id: models.id,
      enterpriseId: models.enterpriseId,
      name: models.name,
      displayName: models.displayName,
      apiEndpoint: models.apiEndpoint,
      apiFormat: models.apiFormat,
      extraConfig: models.extraConfig,
      costPerImage: models.costPerImage,
      description: models.description,
      badgeText: models.badgeText,
      badgeColor: models.badgeColor,
      sizePresets: models.sizePresets,
      supportsImageCount: models.supportsImageCount,
      supportsSmartSize: models.supportsSmartSize,
      visibleInCreate: models.visibleInCreate,
      visibleInWorkspace: models.visibleInWorkspace,
      visibleInProduct: models.visibleInProduct,
      visibleInWeartry: models.visibleInWeartry,
      supportsReferenceImage: models.supportsReferenceImage,
      maxReferenceImages: models.maxReferenceImages,
      referenceImageField: models.referenceImageField,
      maxConcurrent: models.maxConcurrent,
      maxRetries: models.maxRetries,
      apiTimeout: models.apiTimeout,
      taskTimeout: models.taskTimeout,
      isActive: models.isActive,
      iconUrl: models.iconUrl,
    })
    .from(models)
    .where(isNull(models.enterpriseId))
    .orderBy(models.createdAt)

  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    activeCount: rows.filter((m) => m.isActive).length,
    totalCost: rows.reduce((acc, m) => acc + (m.costPerImage ?? 0), 0),
    page,
    pageSize,
  }
}

/** 创建平台预置模型（enterpriseId=NULL，全企业可见） */
export async function createPresetModelAction(
  input: Record<string, unknown>,
): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
  await requireSuperAdmin()
  const parsed = modelConfigSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  if (!d.apiKey || d.apiKey.length === 0) {
    return { ok: false, error: "请输入 API Key" }
  }

  const extraConfig = buildExtraConfig(d)

  try {
    validateImageModelConfig({ apiFormat: d.apiFormat, extraConfig })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "模型配置校验失败",
    }
  }

  try {
    const [created] = await db
      .insert(models)
      .values({
        enterpriseId: null, // 平台预置模型
        name: d.name,
        displayName: d.displayName,
        apiEndpoint: d.apiEndpoint,
        apiKeyEncrypted: encrypt(d.apiKey),
        apiFormat: d.apiFormat,
        extraConfig,
        costPerImage: d.costPerImage,
        description: d.description || null,
        badgeText: d.badgeText || null,
        badgeColor: d.badgeColor || null,
        sizePresets: d.sizePresets.length > 0 ? d.sizePresets : null,
        supportsImageCount: d.supportsImageCount,
        supportsSmartSize: d.supportsSmartSize,
        visibleInCreate: d.visibleInCreate,
        visibleInWorkspace: d.visibleInWorkspace,
        visibleInProduct: d.visibleInProduct,
        visibleInWeartry: d.visibleInWeartry,
        supportsReferenceImage: d.supportsReferenceImage,
        maxReferenceImages: d.maxReferenceImages,
        referenceImageField: d.referenceImageField || null,
        maxConcurrent: d.maxConcurrent,
        maxRetries: d.maxRetries,
        apiTimeout: d.apiTimeout,
        taskTimeout: d.taskTimeout,
        iconUrl: d.iconUrl || null,
      })
      .returning()

    // 自动把新预置模型开放给所有「白名单模式」企业，否则这些企业端看不到
    await syncPresetModelToWhitelists(created!.id)
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.message.includes("unique")
          ? "模型标识 + API 地址已存在"
          : "创建失败",
    }
  }

  revalidatePath("/platform/models")
  revalidatePath("/platform/enterprises")
  return { ok: true, error: null }
}

/** 更新平台预置模型 */
export async function updatePresetModelAction(
  modelId: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
  await requireSuperAdmin()
  const parsed = modelConfigSchema.partial().safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  // 必须是平台预置模型（enterpriseId=NULL）
  const [existing] = await db
    .select()
    .from(models)
    .where(and(eq(models.id, modelId), isNull(models.enterpriseId)))
    .limit(1)
  if (!existing) {
    return { ok: false, error: "平台预置模型不存在" }
  }

  const apiFormat = d.apiFormat ?? existing.apiFormat
  const extraConfig =
    d.apiFormat || d.jimengResolution
      ? buildExtraConfig({
          apiFormat,
          jimengResolution: d.jimengResolution,
          jimengN: d.jimengN,
        })
      : existing.extraConfig

  try {
    validateImageModelConfig({ apiFormat, extraConfig })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "模型配置校验失败",
    }
  }

  const set: Record<string, unknown> = { extraConfig }
  if (d.name !== undefined) set.name = d.name
  if (d.displayName !== undefined) set.displayName = d.displayName
  if (d.apiEndpoint !== undefined) set.apiEndpoint = d.apiEndpoint
  if (d.apiFormat !== undefined) set.apiFormat = d.apiFormat
  if (d.costPerImage !== undefined) set.costPerImage = d.costPerImage
  if (d.description !== undefined) set.description = d.description || null
  if (d.badgeText !== undefined) set.badgeText = d.badgeText || null
  if (d.badgeColor !== undefined) set.badgeColor = d.badgeColor || null
  if (d.sizePresets !== undefined)
    set.sizePresets = d.sizePresets.length > 0 ? d.sizePresets : null
  if (d.supportsImageCount !== undefined)
    set.supportsImageCount = d.supportsImageCount
  if (d.supportsSmartSize !== undefined)
    set.supportsSmartSize = d.supportsSmartSize
  if (d.visibleInCreate !== undefined) set.visibleInCreate = d.visibleInCreate
  if (d.visibleInWorkspace !== undefined)
    set.visibleInWorkspace = d.visibleInWorkspace
  if (d.visibleInProduct !== undefined) set.visibleInProduct = d.visibleInProduct
  if (d.visibleInWeartry !== undefined) set.visibleInWeartry = d.visibleInWeartry
  if (d.supportsReferenceImage !== undefined)
    set.supportsReferenceImage = d.supportsReferenceImage
  if (d.maxReferenceImages !== undefined)
    set.maxReferenceImages = d.maxReferenceImages
  if (d.referenceImageField !== undefined)
    set.referenceImageField = d.referenceImageField || null
  if (d.maxConcurrent !== undefined) set.maxConcurrent = d.maxConcurrent
  if (d.maxRetries !== undefined) set.maxRetries = d.maxRetries
  if (d.apiTimeout !== undefined) set.apiTimeout = d.apiTimeout
  if (d.taskTimeout !== undefined) set.taskTimeout = d.taskTimeout
  if (d.iconUrl !== undefined) set.iconUrl = d.iconUrl || null
  // API Key 仅当填了才更新
  if (d.apiKey && d.apiKey.length > 0) {
    set.apiKeyEncrypted = encrypt(d.apiKey)
  }

  await db.update(models).set(set).where(eq(models.id, modelId))

  revalidatePath("/platform/models")
  return { ok: true, error: null }
}

/** 启停平台预置模型（软删除/恢复） */
export async function togglePresetModelActiveAction(
  modelId: string,
  isActive: boolean,
): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
  await requireSuperAdmin()

  const [existing] = await db
    .select({ id: models.id, enterpriseId: models.enterpriseId })
    .from(models)
    .where(and(eq(models.id, modelId), isNull(models.enterpriseId)))
    .limit(1)
  if (!existing) {
    return { ok: false, error: "平台预置模型不存在" }
  }

  await db.update(models).set({ isActive }).where(eq(models.id, modelId))

  revalidatePath("/platform/models")
  return { ok: true, error: null }
}
