/**
 * 工作台 Agent 模型候选池与选择校验
 *
 * 对话模型（主控 + 评审团）复用 Agent 工坊的候选池口径
 * （services/agent/chat-models：isActive + 企业归属 + 企业 visiblePresetChatModels
 * 白名单 + 权限组 allowedChatModels 白名单）；图片模型复刻工作台
 * listWorkspaceModelsAction 的可见性口径（visibleInWorkspace + 企业白名单 +
 * 权限组白名单），附带结构化尺寸预设与启用 "WxH" 串（发起弹窗四类尺寸选择）。
 */
import { and, asc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { models, type ModelSizePreset } from "@/db/schema"
import type { UserContext } from "@/lib/auth/session"
import {
  loadAgentChatModelPool,
  resolveAgentChatModelChoice,
  resolveAgentReviewerChoice,
  type AgentChatModelOption,
} from "@/server/services/agent/chat-models"
import type {
  WorkspaceAgentTemplateKey,
  WorkspaceAgentTemplateSizes,
} from "@/lib/workspace/agent-types"
import { DEFAULT_TEMPLATE_SIZES } from "@/lib/workspace/agent-templates"
import { isValidSizeValue } from "./templates"

export type WorkspaceAgentChatModelOption = AgentChatModelOption

export { resolveAgentChatModelChoice, resolveAgentReviewerChoice }

/** 主控对话模型候选（主模型需支持视觉：参考图直接进主对话） */
export async function listWorkspaceAgentVisionChatModels(
  ctx: UserContext,
): Promise<WorkspaceAgentChatModelOption[]> {
  const pool = await loadAgentChatModelPool(ctx)
  return pool.options.filter((m) => m.supportsVision)
}

/** 评审模型候选（同样要求视觉；数量 0-3 在 create action 校验） */
export async function listWorkspaceAgentReviewerChatModels(
  ctx: UserContext,
): Promise<WorkspaceAgentChatModelOption[]> {
  return listWorkspaceAgentVisionChatModels(ctx)
}

/**
 * 平台默认主控模型：候选池（仅视觉模型，按池排序）首个。
 * 发起弹窗允许「平台默认配置」（chatModelId 传空），服务端在此解析为具体
 * 模型落 input，worker 执行期确定性；池为空返回 null（action 报错）。
 */
export async function resolveDefaultVisionChatModel(
  ctx: UserContext,
): Promise<WorkspaceAgentChatModelOption | null> {
  const options = await listWorkspaceAgentVisionChatModels(ctx)
  return options[0] ?? null
}

// ---------------------------------------------------------------------------
// 图片模型（工作台可见口径 + 启用尺寸预设）
// ---------------------------------------------------------------------------

export interface WorkspaceAgentImageModelOption {
  id: string
  name: string
  displayName: string
  /** 模型图标（经存储代理加载；发起弹窗下拉展示） */
  iconUrl: string | null
  /** 启用尺寸预设（"WxH"；空 = 模型未配置启用预设） */
  sizes: string[]
  /** 结构化尺寸预设（含未启用项；发起弹窗优先展示比例标签） */
  sizePresets: ModelSizePreset[] | null
  costPerImage: number
  supportsReferenceImage: boolean
  maxReferenceImages: number | null
  scope: string
}

/** 启用预设 → "WxH" 串（供四类尺寸校验） */
export function enabledSizeValues(presets: ModelSizePreset[] | null): string[] {
  if (!Array.isArray(presets)) return []
  return presets
    .filter((p) => p && p.enabled !== false && p.width > 0 && p.height > 0)
    .map((p) => `${p.width}x${p.height}`)
}

/** 工作台 Agent 可用生图模型（含尺寸预设，供发起弹窗四类尺寸选择） */
export async function listWorkspaceAgentImageModels(
  ctx: UserContext,
): Promise<WorkspaceAgentImageModelOption[]> {
  if (!ctx.enterprise || !ctx.user.enterpriseId) return []
  const scopeEnterpriseId = ctx.user.enterpriseId
  const rows = await db
    .select({
      id: models.id,
      name: models.name,
      displayName: models.displayName,
      iconUrl: models.iconUrl,
      sizePresets: models.sizePresets,
      costPerImage: models.costPerImage,
      supportsReferenceImage: models.supportsReferenceImage,
      maxReferenceImages: models.maxReferenceImages,
      enterpriseId: models.enterpriseId,
    })
    .from(models)
    .where(and(eq(models.isActive, true), eq(models.visibleInWorkspace, true)))
    .orderBy(asc(models.sortOrder), asc(models.createdAt))

  let accessible = rows.filter(
    (m) => m.enterpriseId === null || m.enterpriseId === scopeEnterpriseId,
  )
  const visiblePreset =
    (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
  if (visiblePreset.length > 0) {
    accessible = accessible.filter(
      (m) => m.enterpriseId !== null || visiblePreset.includes(m.id),
    )
  }
  const groupAllowed = ctx.group?.allowedModels ?? []
  if (groupAllowed.length > 0) {
    accessible = accessible.filter((m) => groupAllowed.includes(m.id))
  }
  return accessible.map((m) => ({
    id: m.id,
    name: m.name,
    displayName: m.displayName,
    iconUrl: m.iconUrl,
    sizes: enabledSizeValues(m.sizePresets),
    sizePresets: m.sizePresets ?? null,
    costPerImage: m.costPerImage,
    supportsReferenceImage: m.supportsReferenceImage,
    maxReferenceImages: m.maxReferenceImages,
    scope: m.enterpriseId === null ? "平台预置" : "本企业",
  }))
}

/**
 * 校验生图模型与四类尺寸：
 * - 模型须在工作台可见口径内；
 * - 四类尺寸须齐全（"WxH"）且均为该模型启用预设；
 * - 未选模型时：模板默认尺寸兜底（不校验预设），仅校验格式。
 */
export async function resolveWorkspaceAgentImageChoice(
  ctx: UserContext,
  input: {
    templateKey: WorkspaceAgentTemplateKey
    imageModelId?: string | null
    sizes?: Partial<WorkspaceAgentTemplateSizes> | null
  },
): Promise<
  | { ok: true; imageModelId: string | null; sizes: WorkspaceAgentTemplateSizes }
  | { ok: false; error: string }
> {
  const defaults = DEFAULT_TEMPLATE_SIZES[input.templateKey] ?? DEFAULT_TEMPLATE_SIZES.tarot81
  const sizes = { ...defaults, ...(input.sizes ?? {}) } as WorkspaceAgentTemplateSizes
  const kinds = ["card", "back", "border", "box"] as const
  for (const kind of kinds) {
    if (!isValidSizeValue(sizes[kind])) {
      return { ok: false, error: "四类尺寸（卡面/牌背/边框/牌盒）必须齐全且为 WxH 格式" }
    }
  }
  if (!input.imageModelId) {
    return { ok: true, imageModelId: null, sizes }
  }
  const pool = await listWorkspaceAgentImageModels(ctx)
  const model = pool.find((m) => m.id === input.imageModelId)
  if (!model) {
    return { ok: false, error: "所选生图模型不可用（已停用或不在本企业/权限组开放范围）" }
  }
  for (const kind of kinds) {
    if (!model.sizes.includes(sizes[kind])) {
      return {
        ok: false,
        error: `尺寸「${sizes[kind]}」（${kind}）不在模型「${model.displayName}」的启用预设内`,
      }
    }
  }
  return { ok: true, imageModelId: model.id, sizes }
}
