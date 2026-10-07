import { and, asc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { models, type ModelSizePreset } from "@/db/schema"
import type { UserContext } from "@/lib/auth/session"
import { sizeToRatio } from "@/lib/ai/image-model-config"
import type { DirectionConfig } from "@/lib/agent/pipelines"
import { loadFullDirectionConfig } from "@/server/services/agent/direction-config"

/**
 * Agent 工坊卡面生图模型候选池
 *
 * 超管在模型编辑勾选「Agent 工坊」(visibleInAgent) 启用任意多个模型；
 * 用户侧候选池在此基础上叠加企业/权限组可见性（复刻自由创作页
 * listAvailableModelsAction 的过滤口径）与比例严格锁定——仅保留拥有
 * 与平台卡面尺寸同比例（gcd 归约相等）启用预设的模型，保证用户换模型
 * 不换比例，套件资产与 AI 融合比例不受影响。
 */

export interface AgentCardModelOption {
  id: string
  displayName: string
  costPerImage: number
  /** 与平台卡面比例匹配的启用预设（生产时以该预设的具体尺寸出图） */
  matchedPreset: { label: string; width: number; height: number }
}

export interface AgentCardModelPool {
  /** 平台配置的卡面比例（如 "2:3"；候选池锁定的基准） */
  cardRatio: string
  options: AgentCardModelOption[]
}

function enabledPresets(presets: ModelSizePreset[] | null): ModelSizePreset[] {
  return (presets ?? []).filter(
    (p) => p.enabled !== false && p.width > 0 && p.height > 0,
  )
}

/** 平台配置的卡面尺寸链（templateConfig.assetSizes.card → models.imageSize → 1024x1024） */
export function adminCardSize(config: DirectionConfig): string {
  return (
    config.templateConfig?.assetSizes.card ||
    config.models.imageSize ||
    "1024x1024"
  )
}

/** 查询用户可用的 Agent 卡面模型候选池（可见性 + 比例锁定过滤） */
export async function loadAgentCardModelPool(
  ctx: UserContext,
): Promise<AgentCardModelPool> {
  const enterpriseId = ctx.user.enterpriseId
  if (!enterpriseId) return { cardRatio: "1:1", options: [] }

  const config = await loadFullDirectionConfig("tarot")
  const cardRatio = sizeToRatio(adminCardSize(config))

  const rows = await db
    .select({
      id: models.id,
      displayName: models.displayName,
      costPerImage: models.costPerImage,
      sizePresets: models.sizePresets,
      enterpriseId: models.enterpriseId,
    })
    .from(models)
    .where(and(eq(models.isActive, true), eq(models.visibleInAgent, true)))
    .orderBy(asc(models.sortOrder), asc(models.createdAt))

  // 平台预置 + 本企业私有
  let accessible = rows.filter(
    (m) => m.enterpriseId === null || m.enterpriseId === enterpriseId,
  )

  // 平台预置模型按企业 visiblePresetModels 白名单过滤（空 = 全部可见）
  const visiblePreset =
    (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
  if (visiblePreset.length > 0) {
    accessible = accessible.filter(
      (m) => m.enterpriseId !== null || visiblePreset.includes(m.id),
    )
  }

  // 权限组 allowedModels 白名单（空 = 放行全部）
  if (ctx.group && ctx.group.allowedModels.length > 0) {
    accessible = accessible.filter((m) =>
      ctx.group!.allowedModels.includes(m.id),
    )
  }

  // 比例严格锁定：必须有与平台卡面同比例的启用预设
  const options: AgentCardModelOption[] = []
  for (const m of accessible) {
    const preset = enabledPresets(m.sizePresets).find(
      (p) => sizeToRatio(`${p.width}x${p.height}`) === cardRatio,
    )
    if (preset) {
      options.push({
        id: m.id,
        displayName: m.displayName,
        costPerImage: m.costPerImage,
        matchedPreset: {
          label: preset.label,
          width: preset.width,
          height: preset.height,
        },
      })
    }
  }
  return { cardRatio, options }
}

/**
 * 校验用户提交的卡面模型选择（发起弹窗）：
 * 通过则返回可直接写入 run.input 与生产图 imagegen 节点的覆盖值。
 */
export async function resolveAgentCardModelChoice(
  ctx: UserContext,
  modelId: string,
): Promise<
  | { ok: true; imageModelId: string; imageSize: string }
  | { ok: false; error: string }
> {
  const pool = await loadAgentCardModelPool(ctx)
  const hit = pool.options.find((o) => o.id === modelId)
  if (!hit) {
    return {
      ok: false,
      error: `所选模型不可用，或不支持 ${pool.cardRatio} 卡面比例`,
    }
  }
  return {
    ok: true,
    imageModelId: hit.id,
    imageSize: `${hit.matchedPreset.width}x${hit.matchedPreset.height}`,
  }
}
