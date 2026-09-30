"use server"

import { asc, eq, inArray } from "drizzle-orm"
import { db } from "@/db/client"
import {
  agentDirectionConfigs,
  chatApiConfigs,
  enterprises,
  models as modelsTable,
} from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import { directionConfigUpdateSchema } from "@/server/schemas/agent"
import { DEFAULT_DIRECTION_CONFIGS, defaultTemplateConfigFor, type DirectionConfig, type TarotTemplateConfig } from "@/lib/agent/pipelines"
import type { AgentDirection } from "@/lib/agent/graph"
import { revalidatePath } from "next/cache"

/**
 * 平台 Agent 配置 Server Actions（/platform/agent-config，仅超管）
 *
 * 三条产品线（塔罗/神谕/扑克）的各角色模型与阈值预配置；行不存在时以
 * DEFAULT_DIRECTION_CONFIGS 兜底展示（保存时落库）。
 */

/** 读取三方向配置（缺行用默认值补齐；模板配置缺字段以内置默认归一，保证表单始终拿到完整对象） */
export async function listDirectionConfigsAction() {
  await requireSuperAdmin()
  const rows = await db.select().from(agentDirectionConfigs)
  return DEFAULT_DIRECTION_CONFIGS.map((def) => {
    const row = rows.find((r) => r.direction === def.direction)
    if (!row) return def
    const defaults = defaultTemplateConfigFor(row.direction)
    let templateConfig: DirectionConfig["templateConfig"]
    if (defaults && row.templateConfig) {
      const raw = row.templateConfig as Partial<TarotTemplateConfig> & { assetSizes?: Record<string, string> }
      const baseSizes = defaults.assetSizes
      // 资产尺寸逐键校验（WxH；空串=跟随平台经典尺寸），非法值回退默认，
      // 避免坏行让表单/保存连锁失败
      const sizes = Object.fromEntries(
        Object.entries({ ...baseSizes, ...(raw.assetSizes ?? {}) }).map(([key, value]) => [
          key,
          typeof value === "string" && /^(\d+x\d+)?$/.test(value) ? value : (baseSizes[key as keyof typeof baseSizes] ?? "1024x1024"),
        ]),
      )
      templateConfig = { ...defaults, ...raw, assetSizes: sizes as TarotTemplateConfig["assetSizes"] }
    } else {
      templateConfig = (row.templateConfig as DirectionConfig["templateConfig"] | null) ?? defaults ?? undefined
    }
    return {
      direction: row.direction,
      enabled: row.enabled,
      sampleEnabled: row.sampleEnabled,
      sampleCount: row.sampleCount,
      maxRetries: row.maxRetries,
      thresholds: row.thresholds,
      models: row.models as DirectionConfig["models"],
      templateConfig,
    }
  })
}

/** 保存单方向配置（upsert；服务端校验视觉槽位必须是支持视觉的模型） */
export async function updateDirectionConfigAction(input: unknown) {
  await requireSuperAdmin()
  const parsed = directionConfigUpdateSchema.parse(input)
  const [existing] = await db
    .select()
    .from(agentDirectionConfigs)
    .where(eq(agentDirectionConfigs.direction, parsed.direction))
  const base = existing
    ? {
        enabled: existing.enabled,
        sampleEnabled: existing.sampleEnabled,
        sampleCount: existing.sampleCount,
        maxRetries: existing.maxRetries,
        thresholds: existing.thresholds,
        models: existing.models as DirectionConfig["models"],
        templateConfig: existing.templateConfig as DirectionConfig["templateConfig"],
      }
    : DEFAULT_DIRECTION_CONFIGS.find((d) => d.direction === parsed.direction)!

  const parsedTemplateConfig: TarotTemplateConfig | undefined = parsed.templateConfig
    ? {
        ...parsed.templateConfig,
        copywriterChatModelId: parsed.templateConfig.copywriterChatModelId ?? null,
        assetSizes: {
          ...DEFAULT_DIRECTION_CONFIGS.find((d) => d.direction === "tarot")!.templateConfig!.assetSizes,
          ...parsed.templateConfig.assetSizes,
        },
      } as TarotTemplateConfig
    : undefined
  const normalizedTemplate = parsedTemplateConfig
    ? { ...parsedTemplateConfig, frameMode: "ai" as const }
    : base.templateConfig
  const merged = {
    enabled: parsed.enabled ?? base.enabled,
    sampleEnabled: parsed.sampleEnabled ?? base.sampleEnabled,
    sampleCount: parsed.sampleCount ?? base.sampleCount,
    maxRetries: parsed.maxRetries ?? base.maxRetries,
    thresholds: parsed.thresholds ?? base.thresholds,
    models: parsed.models
      ? { ...base.models, ...parsed.models }
      : base.models,
    templateConfig: normalizedTemplate,
  }

  // 服务端二次校验：模板评审团必须选择 supportsVision=true 的对话模型
  // （经典三审槽位已不在配置界面暴露，仅作既有数据的回退来源）
  const reviewerIds = normalizedTemplate?.reviewerModelIds?.filter(Boolean) ?? []
  if (reviewerIds.length > 0) {
    const rows = await db
      .select({ id: chatApiConfigs.id, supportsVision: chatApiConfigs.supportsVision, displayName: chatApiConfigs.displayName })
      .from(chatApiConfigs)
      .where(inArray(chatApiConfigs.id, reviewerIds))
    const visionOk = new Set(rows.filter((r) => r.supportsVision).map((r) => r.id))
    for (const id of reviewerIds) {
      if (!visionOk.has(id)) {
        const name = rows.find((r) => r.id === id)?.displayName ?? id
        throw new Error(`评审团模型「${name}」必须开启多模态（图片输入）`)
      }
    }
  }

  if (existing) {
    await db
      .update(agentDirectionConfigs)
      .set({ ...merged, updatedAt: new Date() })
      .where(eq(agentDirectionConfigs.direction, parsed.direction))
  } else {
    await db.insert(agentDirectionConfigs).values({
      direction: parsed.direction as AgentDirection,
      ...merged,
    })
  }
  revalidatePath("/platform/agent-config")
  revalidatePath("/agent")
  return { ok: true }
}

/** 全部可选对话模型（平台预置 + 各企业私有，标注归属；配置下拉用） */
export async function listAllChatModelsAction() {
  await requireSuperAdmin()
  const rows = await db
    .select({
      id: chatApiConfigs.id,
      displayName: chatApiConfigs.displayName,
      supportsVision: chatApiConfigs.supportsVision,
      isActive: chatApiConfigs.isActive,
      enterpriseId: chatApiConfigs.enterpriseId,
      enterpriseName: enterprises.name,
    })
    .from(chatApiConfigs)
    .leftJoin(enterprises, eq(chatApiConfigs.enterpriseId, enterprises.id))
    .orderBy(asc(chatApiConfigs.sortOrder), asc(chatApiConfigs.createdAt))
  return rows
    .filter((r) => r.isActive)
    .map((r) => ({
      id: r.id,
      displayName: r.displayName,
      supportsVision: r.supportsVision,
      scope: r.enterpriseId ? `企业 · ${r.enterpriseName ?? ""}` : "平台预置",
    }))
}

/** 全部可选生图模型（真实配置：平台预置 + 企业私有，isActive） */
export async function listAllImageModelsAction() {
  await requireSuperAdmin()
  const rows = await db
    .select({
      id: modelsTable.id,
      displayName: modelsTable.displayName,
      costPerImage: modelsTable.costPerImage,
      sizePresets: modelsTable.sizePresets,
      supportsReferenceImage: modelsTable.supportsReferenceImage,
      enterpriseId: modelsTable.enterpriseId,
      enterpriseName: enterprises.name,
    })
    .from(modelsTable)
    .leftJoin(enterprises, eq(modelsTable.enterpriseId, enterprises.id))
    .where(eq(modelsTable.isActive, true))
    .orderBy(asc(modelsTable.sortOrder), asc(modelsTable.createdAt))
  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    costPerImage: r.costPerImage,
    sizePresets: r.sizePresets ?? [],
    supportsReferenceImage: r.supportsReferenceImage,
    scope: r.enterpriseId ? `企业 · ${r.enterpriseName ?? ""}` : "平台预置",
  }))
}
