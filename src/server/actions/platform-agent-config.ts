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
import { DEFAULT_DIRECTION_CONFIGS, normalizeTarotTemplateConfig, type DirectionConfig, type TarotTemplateConfig } from "@/lib/agent/pipelines"
import type { AgentDirection } from "@/lib/agent/graph"
import { revalidatePath } from "next/cache"

/**
 * 平台 Agent 配置 Server Actions（/platform/agent-config，仅超管）
 *
 * 三条产品线（塔罗/神谕/扑克）的各角色模型与阈值预配置；行不存在时以
 * DEFAULT_DIRECTION_CONFIGS 兜底展示（保存时落库）。
 */

/** 读取三方向配置（存量脏值统一归一化，保证表单拿到的恒为可保存的合法值） */
export async function listDirectionConfigsAction() {
  await requireSuperAdmin()
  const [rows, chatModels] = await Promise.all([
    db.select().from(agentDirectionConfigs),
    db
      .select({
        id: chatApiConfigs.id,
        isActive: chatApiConfigs.isActive,
        supportsVision: chatApiConfigs.supportsVision,
      })
      .from(chatApiConfigs),
  ])
  // 评审团只保留「现存且启用且支持视觉」的模型 id：旧库可能存有已删除/
  // 已停用/非视觉的 id——它们在表单上不可见（只列 active+vision 模型），
  // 却会导致保存被服务端视觉校验拒绝，形成"看不见也删不掉"的死角
  const visionModelIds = new Set(
    chatModels.filter((m) => m.isActive && m.supportsVision).map((m) => m.id),
  )

  return DEFAULT_DIRECTION_CONFIGS.map((def) => {
    const row = rows.find((r) => r.direction === def.direction)
    if (!row) return def
    const templateConfig =
      def.direction === "tarot"
        ? (() => {
            const normalized = normalizeTarotTemplateConfig(row.templateConfig)
            normalized.reviewerModelIds = normalized.reviewerModelIds.filter((id) => visionModelIds.has(id))
            return normalized
          })()
        : ((row.templateConfig as DirectionConfig["templateConfig"] | null) ?? undefined)
    const rawModels = row.models as DirectionConfig["models"]
    return {
      direction: row.direction,
      enabled: row.enabled,
      sampleEnabled: row.sampleEnabled,
      // 顶层列同样按当前 schema 范围钳制（旧库越界值直接透传会被保存校验拒绝）
      sampleCount: Math.min(12, Math.max(1, row.sampleCount)),
      maxRetries: Math.min(3, Math.max(0, row.maxRetries)),
      thresholds: {
        aestheticThreshold: Math.min(95, Math.max(40, row.thresholds.aestheticThreshold)),
        consistencyThreshold: Math.min(95, Math.max(40, row.thresholds.consistencyThreshold)),
      },
      models: { ...rawModels, imageSize: rawModels.imageSize || "1024x1024" },
      templateConfig,
    }
  })
}

/** 保存单方向配置（upsert；服务端校验视觉槽位必须是支持视觉的模型） */
export async function updateDirectionConfigAction(input: unknown) {
  await requireSuperAdmin()
  const parsedResult = directionConfigUpdateSchema.safeParse(input)
  if (!parsedResult.success) {
    // Server Action 的 ZodError 会被 Next.js 脱敏成笼统文案；展开首个
    // issue 的字段与原因，让管理员能直接看懂哪里不合法
    const issue = parsedResult.error.issues[0]
    const path = issue ? issue.path.join(".") : ""
    throw new Error(`配置校验失败：${issue?.message ?? "字段非法"}${path ? `（字段：${path}）` : ""}`)
  }
  const parsed = parsedResult.data
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

  // 归一化兜底：补齐缺省尺寸键/字段。此前此处手工展开
  // DEFAULT_DIRECTION_CONFIGS.find(...)!.templateConfig!.assetSizes——默认项
  // 并没有 templateConfig 字段，运行时必抛 "reading 'assetSizes'"，是
  // 保存失败的第一根因；输入已过 schema 校验，统一走已测的 normalize 幂等补齐
  const parsedTemplateConfig: TarotTemplateConfig | undefined = parsed.templateConfig
    ? normalizeTarotTemplateConfig(parsed.templateConfig)
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
