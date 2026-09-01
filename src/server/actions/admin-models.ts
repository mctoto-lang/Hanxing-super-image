"use server"

import { and, eq, isNull, or } from "drizzle-orm"
import { db } from "@/db/client"
import { models, type ModelExtraConfig } from "@/db/schema"
import {
  requireEnterpriseAdmin,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { modelConfigSchema } from "@/server/schemas/admin"
import { validateImageModelConfig } from "@/lib/ai/image-model-config"
import { encrypt } from "@/lib/crypto"
import { revalidatePath } from "next/cache"

/**
 * 模型配置管理 Server Actions（手册 §4.3、§5.6、M3）
 *
 * - 企业管理员可 CRUD 本企业私有模型（enterpriseId = 本企业）。
 * - 平台预置模型（enterpriseId = NULL）只读展示，不可由企业管理员修改。
 * - API Key 落库前 AES-256-GCM 加密；编辑时留空=不修改。
 * - 删除=软删除（is_active=false），保留历史任务外键完整性。
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
 * 列出平台预置模型（按企业 visiblePresetModels 过滤）+ 本企业私有模型（不含解密 Key）
 *
 * - 平台预置模型（enterpriseId=NULL）：仅当企业 visiblePresetModels 为空时全部可见，
 *   否则只返回白名单内的（需求 2c）。
 * - 企业私有模型：本企业全部。
 *
 * 白名单过滤在内存中完成，分页对过滤后的列表切片（page 从 1 开始）。
 * 返回行类型与 components/admin/model-form-dialog.tsx 的 ModelRow 一致。
 */
export async function listModelsAction(
  opts: { page?: number; pageSize?: number } = {},
) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

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
      createdAt: models.createdAt,
    })
    .from(models)
    .where(
      or(isNull(models.enterpriseId), eq(models.enterpriseId, enterpriseId)),
    )
    .orderBy(models.createdAt)

  // 平台预置模型按企业白名单过滤（空 = 全部可见）
  const visiblePreset =
    (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
  const filtered = rows.filter((m) => {
    if (m.enterpriseId !== null) return true // 企业私有：保留
    // 平台预置：白名单空 = 全部可见；否则只留白名单内
    if (visiblePreset.length === 0) return true
    return visiblePreset.includes(m.id)
  })

  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)))
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    presetCount: filtered.filter((m) => m.enterpriseId === null).length,
    privateCount: filtered.filter((m) => m.enterpriseId !== null).length,
    activeCount: filtered.filter((m) => m.isActive).length,
    page,
    pageSize,
  }
}

/** 创建企业私有模型 */
export async function createModelAction(input: Record<string, unknown>) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  // 需求 2c：企业关闭自定义模型时禁止新建
  if (ctx.enterprise?.allowCustomModels === false) {
    return { ok: false as const, error: "平台已关闭本企业自定义模型" }
  }

  const parsed = modelConfigSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  if (!d.apiKey || d.apiKey.length === 0) {
    return { ok: false, error: "请输入 API Key" }
  }

  const extraConfig = buildExtraConfig(d)

  // 白名单校验 extraConfig
  try {
    validateImageModelConfig({ apiFormat: d.apiFormat, extraConfig })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "模型配置校验失败",
    }
  }

  try {
    await db.insert(models).values({
      enterpriseId, // 企业私有模型
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
  } catch (err) {
    // 唯一约束冲突等
    return {
      ok: false,
      error:
        err instanceof Error && err.message.includes("unique")
          ? "模型标识 + API 地址已存在"
          : "创建失败",
    }
  }

  revalidatePath("/admin/models")
  return { ok: true as const, error: null }
}

/** 更新本企业私有模型（平台预置模型不可改） */
export async function updateModelAction(
  modelId: string,
  input: Record<string, unknown>,
) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  // 需求 2c：企业关闭自定义模型时禁止编辑私有模型
  if (ctx.enterprise?.allowCustomModels === false) {
    return { ok: false as const, error: "平台已关闭本企业自定义模型" }
  }

  const parsed = modelConfigSchema.partial().safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  // 必须是本企业私有模型
  const [existing] = await db
    .select()
    .from(models)
    .where(
      and(eq(models.id, modelId), eq(models.enterpriseId, enterpriseId)),
    )
    .limit(1)
  if (!existing) {
    return { ok: false, error: "模型不存在或无权修改（平台预置模型不可改）" }
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

  const set: Record<string, unknown> = {
    extraConfig,
  }
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

  revalidatePath("/admin/models")
  return { ok: true as const, error: null }
}

/** 启停模型（软删除/恢复，仅本企业私有模型） */
export async function toggleModelActiveAction(
  modelId: string,
  isActive: boolean,
) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  // 需求 2c：企业关闭自定义模型时禁止启停私有模型
  if (ctx.enterprise?.allowCustomModels === false) {
    return { ok: false as const, error: "平台已关闭本企业自定义模型" }
  }

  const [existing] = await db
    .select({ id: models.id, enterpriseId: models.enterpriseId })
    .from(models)
    .where(
      and(eq(models.id, modelId), eq(models.enterpriseId, enterpriseId)),
    )
    .limit(1)
  if (!existing) {
    return { ok: false, error: "模型不存在或无权修改（平台预置模型不可改）" }
  }

  await db
    .update(models)
    .set({ isActive })
    .where(eq(models.id, modelId))

  revalidatePath("/admin/models")
  return { ok: true as const, error: null }
}
