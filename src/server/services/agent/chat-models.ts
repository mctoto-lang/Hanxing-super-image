import { asc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { chatApiConfigs } from "@/db/schema"
import type { UserContext } from "@/lib/auth/session"

/**
 * Agent 工坊 AI 团队对话模型候选池（用户侧）
 *
 * 阶段对话模型（创意总监/风格策划/提示词撰写）与评审团模型默认由超管在
 * 「Agent 工坊配置」预置；本模块让用户在发起弹窗按需覆盖。候选池复刻
 * chat-service.listAccessibleChatModels 的可见性口径（isActive + 企业归属 +
 * 企业 visiblePresetChatModels 白名单 + 权限组 allowedChatModels 白名单）
 * ——执行链的 loadChatModel 只校验 isActive/企业归属，用户自选必须经此
 * 池校验后才允许写入 run.input。
 */

export interface AgentChatModelOption {
  id: string
  displayName: string
  /** 是否支持视觉（评审团候选的硬门槛） */
  supportsVision: boolean
  /** 平台预置 / 本企业 */
  scope: string
}

export interface AgentChatModelPool {
  options: AgentChatModelOption[]
}

/** 查询用户可用的 Agent 对话模型候选池（可见性过滤；无比例约束） */
export async function loadAgentChatModelPool(
  ctx: UserContext,
): Promise<AgentChatModelPool> {
  const enterpriseId = ctx.user.enterpriseId
  if (!enterpriseId) return { options: [] }

  const rows = await db
    .select({
      id: chatApiConfigs.id,
      displayName: chatApiConfigs.displayName,
      name: chatApiConfigs.name,
      supportsVision: chatApiConfigs.supportsVision,
      enterpriseId: chatApiConfigs.enterpriseId,
    })
    .from(chatApiConfigs)
    .where(eq(chatApiConfigs.isActive, true))
    .orderBy(asc(chatApiConfigs.sortOrder), asc(chatApiConfigs.createdAt))

  // 平台预置 + 本企业私有
  let accessible = rows.filter(
    (m) => m.enterpriseId === null || m.enterpriseId === enterpriseId,
  )

  // 平台预置模型按企业 visiblePresetChatModels 白名单过滤（空 = 全部可见）
  const whitelist =
    (ctx.enterprise?.visiblePresetChatModels as string[] | null) ?? []
  if (whitelist.length > 0) {
    accessible = accessible.filter(
      (m) => m.enterpriseId !== null || whitelist.includes(m.id),
    )
  }

  // 权限组 allowedChatModels 白名单（空 = 放行全部）
  const groupAllowed = ctx.group?.allowedChatModels ?? []
  if (groupAllowed.length > 0) {
    accessible = accessible.filter((m) => groupAllowed.includes(m.id))
  }

  return {
    options: accessible.map((m) => ({
      id: m.id,
      displayName: m.displayName || m.name,
      supportsVision: !!m.supportsVision,
      scope: m.enterpriseId === null ? "平台预置" : "本企业",
    })),
  }
}

/**
 * 校验用户提交的单个团队对话模型选择（发起 + 确认提示词时各验一次，
 * 对齐卡面模型 resolveAgentCardModelChoice 的两阶段复验先例）。
 */
export async function resolveAgentChatModelChoice(
  ctx: UserContext,
  modelId: string,
): Promise<{ ok: true; modelId: string } | { ok: false; error: string }> {
  const pool = await loadAgentChatModelPool(ctx)
  const hit = pool.options.find((o) => o.id === modelId)
  if (!hit) {
    return { ok: false, error: "所选对话模型不可用（已停用或不在本企业/权限组开放范围）" }
  }
  return { ok: true, modelId: hit.id }
}

/**
 * 校验用户提交的评审团选择：1-3 个、去重、全部在候选池内且支持视觉
 * （与超管侧 reviewerModelIds 的口径一致：zod max(3) + supportsVision）。
 */
export async function resolveAgentReviewerChoice(
  ctx: UserContext,
  modelIds: string[],
): Promise<
  | { ok: true; reviewerModelIds: string[] }
  | { ok: false; error: string }
> {
  const unique = [...new Set(modelIds.filter(Boolean))]
  if (unique.length === 0) {
    return { ok: false, error: "评审团至少选择 1 个模型" }
  }
  if (unique.length > 3) {
    return { ok: false, error: `评审团最多 3 个模型，当前 ${unique.length} 个` }
  }
  const pool = await loadAgentChatModelPool(ctx)
  for (const id of unique) {
    const hit = pool.options.find((o) => o.id === id)
    if (!hit) {
      return { ok: false, error: "评审团包含不可用的对话模型（已停用或不在本企业/权限组开放范围）" }
    }
    if (!hit.supportsVision) {
      return { ok: false, error: `评审团模型「${hit.displayName}」未开启多模态（视觉），无法读图评审` }
    }
  }
  return { ok: true, reviewerModelIds: unique }
}
