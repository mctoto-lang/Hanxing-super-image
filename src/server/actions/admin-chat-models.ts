"use server"

import { and, asc, eq, isNull, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { chatApiConfigs, type ChatModelExtraConfig } from "@/db/schema"
import {
  requireEnterpriseAdmin,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { chatModelConfigSchema } from "@/server/schemas/admin"
import { encrypt } from "@/lib/crypto"
import { revalidatePath } from "next/cache"
import { nextSortOrder } from "@/server/services/sort-order"
import type { PresetChatModelRow } from "@/server/actions/platform-chat-models"

/**
 * 企业对话模型管理 Server Actions（openai / claude / gemini / grok）
 *
 * - 企业管理员可 CRUD 本企业私有对话模型（enterpriseId = 本企业）。
 * - 平台预置对话模型（enterpriseId = NULL）只读展示，不可由企业管理员修改。
 * - 受企业 allowCustomModels 门控（与生图模型一致）。
 * - API Key 落库前 AES-256-GCM 加密；编辑时留空=不修改。
 */

export type AdminChatModelRow = PresetChatModelRow

/** 把扁平字段组装为 extraConfig */
function buildChatExtraConfig(d: {
  temperature?: number
  maxTokens?: number
  thinkingOverrides?: NonNullable<ChatModelExtraConfig["thinkingOverrides"]>
}): ChatModelExtraConfig {
  const cfg: ChatModelExtraConfig = {}
  if (d.temperature !== undefined) cfg.temperature = d.temperature
  if (d.maxTokens !== undefined && d.maxTokens > 0) cfg.maxTokens = d.maxTokens
  if (d.thinkingOverrides && Object.keys(d.thinkingOverrides).length > 0) {
    cfg.thinkingOverrides = d.thinkingOverrides
  }
  return cfg
}

const chatModelSelectFields = {
  id: chatApiConfigs.id,
  enterpriseId: chatApiConfigs.enterpriseId,
  name: chatApiConfigs.name,
  displayName: chatApiConfigs.displayName,
  description: chatApiConfigs.description,
  badgeText: chatApiConfigs.badgeText,
  badgeColor: chatApiConfigs.badgeColor,
  iconUrl: chatApiConfigs.iconUrl,
  apiEndpoint: chatApiConfigs.apiEndpoint,
  formatType: chatApiConfigs.formatType,
  extraConfig: chatApiConfigs.extraConfig,
  maxContextTokens: chatApiConfigs.maxContextTokens,
  maxOutputTokens: chatApiConfigs.maxOutputTokens,
  inputPriceCenticredits: chatApiConfigs.inputPriceCenticredits,
  outputPriceCenticredits: chatApiConfigs.outputPriceCenticredits,
  supportsThinking: chatApiConfigs.supportsThinking,
  supportsVision: chatApiConfigs.supportsVision,
  maxConcurrent: chatApiConfigs.maxConcurrent,
  maxRetries: chatApiConfigs.maxRetries,
  apiTimeout: chatApiConfigs.apiTimeout,
  taskTimeout: chatApiConfigs.taskTimeout,
  isActive: chatApiConfigs.isActive,
}

/** 列出平台预置对话模型（只读）+ 本企业私有对话模型（不含解密 Key，分页） */
export async function listAdminChatModelsAction(
  opts: { page?: number; pageSize?: number } = {},
): Promise<{
  items: AdminChatModelRow[]
  total: number
  presetCount: number
  privateCount: number
  activeCount: number
  page: number
  pageSize: number
}> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize ?? 20)))

  const where = or(
    isNull(chatApiConfigs.enterpriseId),
    eq(chatApiConfigs.enterpriseId, enterpriseId),
  )
  const [rows, [{ total }], agg] = await Promise.all([
    db
      .select(chatModelSelectFields)
      .from(chatApiConfigs)
      .where(where)
      .orderBy(asc(chatApiConfigs.sortOrder), asc(chatApiConfigs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(chatApiConfigs).where(where),
    db
      .select({
        presetCount: sql<number>`count(*) filter (where ${chatApiConfigs.enterpriseId} is null)::int`,
        privateCount: sql<number>`count(*) filter (where ${chatApiConfigs.enterpriseId} is not null)::int`,
        activeCount: sql<number>`count(*) filter (where ${chatApiConfigs.isActive})::int`,
      })
      .from(chatApiConfigs)
      .where(where),
  ])

  return {
    items: rows,
    total,
    presetCount: agg[0]?.presetCount ?? 0,
    privateCount: agg[0]?.privateCount ?? 0,
    activeCount: agg[0]?.activeCount ?? 0,
    page,
    pageSize,
  }
}

/** 创建企业私有对话模型 */
export async function createChatModelAction(
  input: Record<string, unknown>,
): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  if (ctx.enterprise?.allowCustomModels === false) {
    return { ok: false, error: "平台已关闭本企业自定义模型" }
  }

  const parsed = chatModelConfigSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  if (!d.apiKey || d.apiKey.length === 0) {
    return { ok: false, error: "请输入 API Key" }
  }

  try {
    // 追加到列表末尾（用户侧对话模型列表按 sortOrder 排序，企业新建默认 0 会跳到预置模型之前）
    const sortOrder = await nextSortOrder(chatApiConfigs)
    await db.insert(chatApiConfigs).values({
      enterpriseId, // 企业私有对话模型
      name: d.name,
      displayName: d.displayName,
      description: d.description || null,
      badgeText: d.badgeText || null,
      badgeColor: d.badgeColor || null,
      iconUrl: d.iconUrl || null,
      apiEndpoint: d.apiEndpoint,
      apiKeyEncrypted: encrypt(d.apiKey),
      formatType: d.formatType,
      extraConfig: buildChatExtraConfig(d),
      sortOrder,
      maxContextTokens: d.maxContextTokens,
      maxOutputTokens: d.maxOutputTokens,
      inputPriceCenticredits: d.inputPriceCenticredits,
      outputPriceCenticredits: d.outputPriceCenticredits,
      supportsThinking: d.supportsThinking,
      supportsVision: d.supportsVision,
      maxConcurrent: d.maxConcurrent,
      maxRetries: d.maxRetries,
      apiTimeout: d.apiTimeout,
      taskTimeout: d.taskTimeout,
      isActive: true,
    })
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.message.includes("unique")
          ? "模型标识 + API 地址已存在"
          : "创建失败",
    }
  }

  revalidatePath("/admin/chat-models")
  return { ok: true, error: null }
}

/** 更新本企业私有对话模型（平台预置不可改） */
export async function updateChatModelAction(
  modelId: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  if (ctx.enterprise?.allowCustomModels === false) {
    return { ok: false, error: "平台已关闭本企业自定义模型" }
  }

  const parsed = chatModelConfigSchema.partial().safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  // 必须是本企业私有对话模型
  const [existing] = await db
    .select({ id: chatApiConfigs.id })
    .from(chatApiConfigs)
    .where(
      and(
        eq(chatApiConfigs.id, modelId),
        eq(chatApiConfigs.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (!existing) {
    return { ok: false, error: "对话模型不存在或无权修改（平台预置不可改）" }
  }

  const set: Record<string, unknown> = {}
  if (d.name !== undefined) set.name = d.name
  if (d.displayName !== undefined) set.displayName = d.displayName
  if (d.description !== undefined) set.description = d.description || null
  if (d.badgeText !== undefined) set.badgeText = d.badgeText || null
  if (d.badgeColor !== undefined) set.badgeColor = d.badgeColor || null
  if (d.iconUrl !== undefined) set.iconUrl = d.iconUrl || null
  if (d.apiEndpoint !== undefined) set.apiEndpoint = d.apiEndpoint
  if (d.formatType !== undefined) set.formatType = d.formatType
  if (d.temperature !== undefined || d.maxTokens !== undefined) {
    set.extraConfig = buildChatExtraConfig(d)
  }
  if (d.maxContextTokens !== undefined) set.maxContextTokens = d.maxContextTokens
  if (d.maxOutputTokens !== undefined) set.maxOutputTokens = d.maxOutputTokens
  if (d.inputPriceCenticredits !== undefined) set.inputPriceCenticredits = d.inputPriceCenticredits
  if (d.outputPriceCenticredits !== undefined) set.outputPriceCenticredits = d.outputPriceCenticredits
  if (d.supportsThinking !== undefined) set.supportsThinking = d.supportsThinking
  if (d.supportsVision !== undefined) set.supportsVision = d.supportsVision
  if (d.maxConcurrent !== undefined) set.maxConcurrent = d.maxConcurrent
  if (d.maxRetries !== undefined) set.maxRetries = d.maxRetries
  if (d.apiTimeout !== undefined) set.apiTimeout = d.apiTimeout
  if (d.taskTimeout !== undefined) set.taskTimeout = d.taskTimeout
  // API Key 仅当填了才更新
  if (d.apiKey && d.apiKey.length > 0) {
    set.apiKeyEncrypted = encrypt(d.apiKey)
  }

  if (Object.keys(set).length === 0) {
    return { ok: true, error: null }
  }
  set.updatedAt = new Date()

  try {
    await db
      .update(chatApiConfigs)
      .set(set)
      .where(eq(chatApiConfigs.id, modelId))
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.message.includes("unique")
          ? "模型标识 + API 地址已存在"
          : "更新失败",
    }
  }

  revalidatePath("/admin/chat-models")
  return { ok: true, error: null }
}

/** 启停本企业私有对话模型（平台预置不可改） */
export async function toggleChatModelActiveAction(
  modelId: string,
  isActive: boolean,
): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  if (ctx.enterprise?.allowCustomModels === false) {
    return { ok: false, error: "平台已关闭本企业自定义模型" }
  }

  const [existing] = await db
    .select({ id: chatApiConfigs.id })
    .from(chatApiConfigs)
    .where(
      and(
        eq(chatApiConfigs.id, modelId),
        eq(chatApiConfigs.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (!existing) {
    return { ok: false, error: "对话模型不存在或无权修改（平台预置不可改）" }
  }

  await db
    .update(chatApiConfigs)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(chatApiConfigs.id, modelId))

  revalidatePath("/admin/chat-models")
  return { ok: true, error: null }
}
