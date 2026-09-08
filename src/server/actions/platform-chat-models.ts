"use server"

import { and, eq, isNull, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { chatApiConfigs, enterprises, type ChatModelExtraConfig } from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import { chatModelConfigSchema } from "@/server/schemas/admin"
import { encrypt } from "@/lib/crypto"
import { revalidatePath } from "next/cache"

/**
 * 平台预置对话模型管理 Server Actions（openai / claude / gemini / grok）
 *
 * - 仅超管可操作；管理 enterpriseId = NULL 的平台预置对话模型（全企业可用，
 *   受各企业 visiblePresetChatModels 白名单过滤，空 = 全部可见）。
 * - API Key 落库前 AES-256-GCM 加密；编辑时留空 = 不修改。
 * - 停用 = is_active=false，保留模板关联与历史任务外键完整性。
 * - 新建预置后自动追加进所有已启用白名单的企业（与生图预置模型同构）。
 * - temperature/maxTokens 落 extraConfig（工作台内部 AI 用）；
 *   maxContext/maxOutput/厘级价格/思考强度为 /chat 交互对话专用。
 */

/** 新建平台预置对话模型后，追加进所有白名单非空的企业（幂等） */
async function syncPresetChatModelToWhitelists(modelId: string) {
  const affected = await db
    .select({
      id: enterprises.id,
      visible: enterprises.visiblePresetChatModels,
    })
    .from(enterprises)
    .where(sql`jsonb_array_length(${enterprises.visiblePresetChatModels}) > 0`)

  for (const ent of affected) {
    const list = (ent.visible as string[] | null) ?? []
    if (list.includes(modelId)) continue
    await db
      .update(enterprises)
      .set({ visiblePresetChatModels: [...list, modelId], updatedAt: new Date() })
      .where(eq(enterprises.id, ent.id))
  }
}

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

/** 列表行类型（与 listPresetChatModelsAction 返回一致） */
export interface PresetChatModelRow {
  id: string
  enterpriseId: string | null
  name: string
  displayName: string
  description: string | null
  badgeText: string | null
  badgeColor: string | null
  iconUrl: string | null
  apiEndpoint: string
  formatType: string
  extraConfig: ChatModelExtraConfig | null
  maxContextTokens: number
  maxOutputTokens: number
  inputPriceCenticredits: number
  outputPriceCenticredits: number
  supportsThinking: boolean
  supportsVision: boolean
  maxConcurrent: number
  maxRetries: number
  apiTimeout: number
  taskTimeout: number
  isActive: boolean
}

/**
 * 列出全部平台预置对话模型（enterpriseId=NULL，不含解密 Key，分页）。
 * 默认 pageSize=100 兼顾全量下拉场景。
 */
export async function listPresetChatModelsAction(
  opts: { page?: number; pageSize?: number } = {},
): Promise<{
  items: PresetChatModelRow[]
  total: number
  activeCount: number
  page: number
  pageSize: number
}> {
  await requireSuperAdmin()
  const page = Math.max(1, Math.floor(opts.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 100)))

  const rows = await db
    .select({
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
    })
    .from(chatApiConfigs)
    .where(isNull(chatApiConfigs.enterpriseId))
    .orderBy(chatApiConfigs.createdAt)

  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    activeCount: rows.filter((m) => m.isActive).length,
    page,
    pageSize,
  }
}

/** 创建平台预置对话模型（enterpriseId=NULL，全企业可用） */
export async function createPresetChatModelAction(
  input: Record<string, unknown>,
): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
  await requireSuperAdmin()
  const parsed = chatModelConfigSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  if (!d.apiKey || d.apiKey.length === 0) {
    return { ok: false, error: "请输入 API Key" }
  }

  try {
    const [created] = await db
      .insert(chatApiConfigs)
      .values({
        enterpriseId: null, // 平台预置对话模型
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
      .returning({ id: chatApiConfigs.id })
    if (created) {
      await syncPresetChatModelToWhitelists(created.id)
    }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.message.includes("unique")
          ? "模型标识 + API 地址已存在"
          : "创建失败",
    }
  }

  revalidatePath("/platform/chat-models")
  return { ok: true, error: null }
}

/** 更新平台预置对话模型 */
export async function updatePresetChatModelAction(
  modelId: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
  await requireSuperAdmin()
  const parsed = chatModelConfigSchema.partial().safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  // 必须是平台预置对话模型（enterpriseId=NULL）
  const [existing] = await db
    .select()
    .from(chatApiConfigs)
    .where(and(eq(chatApiConfigs.id, modelId), isNull(chatApiConfigs.enterpriseId)))
    .limit(1)
  if (!existing) {
    return { ok: false, error: "平台预置对话模型不存在" }
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
    await db.update(chatApiConfigs).set(set).where(eq(chatApiConfigs.id, modelId))
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.message.includes("unique")
          ? "模型标识 + API 地址已存在"
          : "更新失败",
    }
  }

  revalidatePath("/platform/chat-models")
  return { ok: true, error: null }
}

/** 启停平台预置对话模型（软删除/恢复） */
export async function togglePresetChatModelActiveAction(
  modelId: string,
  isActive: boolean,
): Promise<{ ok: true; error: null } | { ok: false; error: string }> {
  await requireSuperAdmin()

  const [existing] = await db
    .select({ id: chatApiConfigs.id, enterpriseId: chatApiConfigs.enterpriseId })
    .from(chatApiConfigs)
    .where(and(eq(chatApiConfigs.id, modelId), isNull(chatApiConfigs.enterpriseId)))
    .limit(1)
  if (!existing) {
    return { ok: false, error: "平台预置对话模型不存在" }
  }

  await db
    .update(chatApiConfigs)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(chatApiConfigs.id, modelId))

  revalidatePath("/platform/chat-models")
  return { ok: true, error: null }
}
