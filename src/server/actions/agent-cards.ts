"use server"

import { and, asc, eq, inArray, notInArray } from "drizzle-orm"
import { db } from "@/db/client"
import { agentEvents, agentRunItems, agentRuns } from "@/db/schema"
import { requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import {
  composeDraftPrompt,
  validateTarotPromptPlan,
} from "@/lib/agent/cards/plan"
import { normalizeTemplateStage } from "@/lib/agent/graph"
import {
  buildTemplateProductionGraph,
  templateProductionMissingSlots,
} from "@/lib/agent/pipelines"
import { validateAgentGraph } from "@/lib/agent/validate"
import { loadFullDirectionConfig } from "@/server/services/agent/direction-config"
import { resolveAgentCardModelChoice } from "@/server/services/agent/card-models"
import {
  resolveAgentChatModelChoice,
  resolveAgentReviewerChoice,
} from "@/server/services/agent/chat-models"
import {
  confirmCardPlanSchema,
  regenerateCardPromptsSchema,
  updateCardPlanItemSchema,
} from "@/server/schemas/agent-cards"

/** 模块权限校验：返回错误文案（null = 放行），由各 action 决定抛出或返回 */
function denyError(ctx: UserContext): string | null {
  return checkModuleAccess(ctx, "agent")
}

async function ownedTarotRun(ctx: UserContext, runId: string) {
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.enterpriseId, ctx.user.enterpriseId!), eq(agentRuns.userId, ctx.user.id)))
  if (!run || run.template !== "tarot") return null
  return run
}

const RUN_NOT_FOUND = "塔罗项目不存在或无权访问"

/**
 * 编辑单张画面提示词（draft 阶段；存量 prompt/final 阶段的 run 归一并放行）。
 * 业务失败返回 { ok:false, error } 而非 throw：生产环境 Server Action 的
 * 抛错会被抹为 digest 占位错误（Minified React error #441），用户看不到
 * 真实中文提示。
 */
export async function updateTarotCardPlanItemAction(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseContext()
  const denied = denyError(ctx)
  if (denied) return { ok: false, error: denied }
  const parsed = updateCardPlanItemSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "参数无效" }
  const run = await ownedTarotRun(ctx, parsed.data.runId)
  if (!run) return { ok: false, error: RUN_NOT_FOUND }
  const stage = normalizeTemplateStage(run.stage)
  if (stage !== "draft") return { ok: false, error: "当前阶段不允许修改画面提示词" }
  // 运行态守卫：design_drafts 在途期间 worker 会整批回写 currentPrompt，
  // 此刻的直调编辑会被静默覆盖
  if (run.status === "running" || run.status === "queued") return { ok: false, error: "AI 团队正在处理中，请稍候" }
  const [item] = await db.select().from(agentRunItems).where(and(eq(agentRunItems.id, parsed.data.itemId), eq(agentRunItems.runId, run.id)))
  if (!item) return { ok: false, error: "卡牌不存在" }
  // 提示词即终稿（单段短文本直通 currentPrompt）；用户可控文本先剥离
  // 护栏标记，防止伪造 marker（沿用旧防线）；visualBrief 同步冗余；
  // 手动编辑视为用户确认，失败标记一并清除
  const prompt = composeDraftPrompt(parsed.data.visualBrief)
  await db.update(agentRunItems).set({ meaning: parsed.data.meaning, visualBrief: prompt, currentPrompt: prompt, promptSource: "manual", errorMessage: null, updatedAt: new Date() }).where(eq(agentRunItems.id, item.id))
  return { ok: true }
}

/**
 * 重新生成画面提示词（排队由 worker 执行）：draft 阶段 → design_drafts
 * （单段短提示词重写，首次撰写即终稿）。存量 run 在途的 design_finals
 * 队列不受影响（legacy 执行器继续处理）。
 * itemIds 缺省 = 全部 78 张；feedback 为可选的用户改写要求。
 * 提交时目标卡复位为「待写」（promptSource=initial、清失败标记），正文保留
 * 供对照——进度条只统计 AI 完成稿，杜绝重生成期间显示满格。复位必须晚于
 * 运行态预检：先复位后守卫失败不回滚，会把已完成卡永久留在「待写」态。
 * 业务失败返回 { ok:false, error }（同 updateTarotCardPlanItemAction，防 #441）。
 */
export async function regenerateCardPromptsAction(
  input: unknown,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseContext()
  const denied = denyError(ctx)
  if (denied) return { ok: false, error: denied }
  const parsed = regenerateCardPromptsSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "参数无效" }
  const run = await ownedTarotRun(ctx, parsed.data.runId)
  if (!run) return { ok: false, error: RUN_NOT_FOUND }
  if (normalizeTemplateStage(run.stage) !== "draft") return { ok: false, error: "当前项目不在画面提示词阶段" }
  if (run.status === "running" || run.status === "queued") return { ok: false, error: "AI 团队正在处理中，请稍候" }
  const allItems = await db.select({ id: agentRunItems.id }).from(agentRunItems).where(eq(agentRunItems.runId, run.id))
  const valid = new Set(allItems.map((item) => item.id))
  if (parsed.data.itemIds?.length) {
    if (parsed.data.itemIds.some((id) => !valid.has(id))) return { ok: false, error: "包含不属于本项目的卡牌" }
  }
  const targetIds = parsed.data.itemIds?.length ? parsed.data.itemIds : [...valid]
  if (targetIds.length > 0) {
    await db
      .update(agentRunItems)
      .set({ promptSource: "initial", errorMessage: null, updatedAt: new Date() })
      .where(inArray(agentRunItems.id, targetIds))
  }
  // 与 enqueueTemplateAction 同语义（该助手未跨 action 导出，此处内联）：
  // 条件更新守住读取→写入间隙，状态被并发改变时不覆盖
  const updated = await db
    .update(agentRuns)
    .set({
      pendingAction: {
        kind: "design_drafts",
        itemIds: parsed.data.itemIds?.length ? parsed.data.itemIds : undefined,
        feedback: parsed.data.feedback || undefined,
        requestedAt: new Date().toISOString(),
      },
      status: "queued",
      error: null,
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, run.id), notInArray(agentRuns.status, ["running", "queued"])))
    .returning({ id: agentRuns.id })
  if (updated.length === 0) return { ok: false, error: "AI 团队正在处理中，请稍候" }
  return { ok: true, count: parsed.data.itemIds?.length ?? 78 }
}

/**
 * 用户确认 78 张画面提示词后直接进入生图/评审阶段（首次撰写即终稿，
 * 四阶段流程无独立终稿阶段）：以当前方向配置重建模板生产图（graphSnapshot），
 * 并排队风格小样生产（produce_cards · sample），由 worker 复用经典 item
 * 流水线执行（生图 → 三审 → 总控裁决；不通过按评审意见重写提示词）。
 * 存量 run 的结构化两段终稿同样放行（validateTarotPromptPlan 兼容两种形态）。
 * 业务失败返回 { ok:false, error }（同 updateTarotCardPlanItemAction，防 #441）。
 */
export async function confirmTarotCardDraftsAction(
  input: unknown,
): Promise<{ ok: true; count: number; sampleCount: number } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseContext()
  const denied = denyError(ctx)
  if (denied) return { ok: false, error: denied }
  const parsed = confirmCardPlanSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "参数无效" }
  const run = await ownedTarotRun(ctx, parsed.data.runId)
  if (!run) return { ok: false, error: RUN_NOT_FOUND }
  if (normalizeTemplateStage(run.stage) !== "draft") return { ok: false, error: "当前项目不在画面提示词确认阶段" }
  if (run.status === "running" || run.status === "queued") return { ok: false, error: "AI 团队正在处理中，请稍候" }
  const items = await db.select().from(agentRunItems).where(eq(agentRunItems.runId, run.id)).orderBy(asc(agentRunItems.index))
  // 提示词必须经 AI 生成（或用户手动编辑）：存在失败标记的卡不允许确认，
  // 需先「一键重试」或手动修改保存
  const failedItems = items.filter((item) => item.errorMessage)
  if (failedItems.length > 0) {
    return {
      ok: false,
      error: `${failedItems.length} 张画面提示词生成失败（如「${failedItems[0]!.name ?? ""}」），请先重试失败卡或手动修改后再确认`,
    }
  }
  // 提示词门槛：新单段短提示词 ≥60 字；存量结构化终稿 content ≥60 字放行
  try {
    validateTarotPromptPlan(
      items.map((item) => ({ index: item.index, name: item.name ?? "", prompt: item.currentPrompt ?? "" })),
    )
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "画面提示词未达确认门槛" }
  }

  const config = await loadFullDirectionConfig("tarot")
  // 用户发起时选择的 AI 团队覆盖（run.input.teamModelOverrides）中参与生产
  // 的槽位（提示词撰写 + 评审团）确认时复验——模型可能在此期间被停用/移出
  // 白名单，不复验会让 78 张生产在运行期逐张失败（run.input 无换模型入口）。
  // 创意总监/风格策划只服务 clarify/gen_style_spec（早已完成），不复验：
  // 中途停用不应阻断已进入生产关口的项目。
  const teamOverrides = run.input.teamModelOverrides
  if (teamOverrides?.copywriterChatModelId) {
    const resolved = await resolveAgentChatModelChoice(ctx, teamOverrides.copywriterChatModelId)
    if (!resolved.ok) {
      return {
        ok: false,
        error: `所选提示词撰写模型已不可用：${resolved.error}。请联系管理员重新启用模型，或重新发起项目更换模型`,
      }
    }
  }
  if (teamOverrides?.reviewerModelIds?.length) {
    const resolved = await resolveAgentReviewerChoice(ctx, teamOverrides.reviewerModelIds)
    if (!resolved.ok) {
      return {
        ok: false,
        error: `所选评审团已不可用：${resolved.error}。请联系管理员重新启用模型，或重新发起项目更换评审团`,
      }
    }
  }
  const missing = templateProductionMissingSlots(config, {
    imageModelId: run.input.imageModelId ?? null,
    copywriterChatModelId: teamOverrides?.copywriterChatModelId ?? null,
    reviewerModelIds: teamOverrides?.reviewerModelIds,
  })
  if (missing.length > 0) {
    return { ok: false, error: `塔罗生产流水线缺少配置：${missing.join("、")}，请联系管理员在「Agent 工坊配置」中补齐` }
  }
  // 固化模型复验：发起时校验过，但模型可能在此期间被停用/移出权限组——
  // 不复验会让 78 张生产在运行期逐张失败（run.input 无换模型入口）
  if (run.input.imageModelId) {
    const resolved = await resolveAgentCardModelChoice(ctx, run.input.imageModelId)
    if (!resolved.ok) {
      return { ok: false, error: `${resolved.error}。请联系管理员重新启用模型，或重新发起项目更换卡面模型` }
    }
  }
  // 用户发起时选择的质量要求覆盖默认阈值与打回上限（存 run.input.quality）；
  // 用户选择的卡面模型与 AI 团队模型（run.input）同样带入重建图
  const graph = buildTemplateProductionGraph(config, run.input.quality, {
    imageModelId: run.input.imageModelId ?? null,
    imageSize: run.input.imageSize ?? null,
    copywriterChatModelId: teamOverrides?.copywriterChatModelId ?? null,
    reviewerModelIds: teamOverrides?.reviewerModelIds,
  })
  const validation = validateAgentGraph(graph)
  if (!validation.ok) return { ok: false, error: `生产流水线配置无效：${validation.error}，请联系管理员检查` }

  const sampleCount = items.filter((item) => item.isSample).length
  // 条件更新守住读取→写入间隙：状态被并发改变（如 worker 已认领）时不覆盖
  const updated = await db
    .update(agentRuns)
    .set({
      stage: "art",
      phase: "sample",
      graphSnapshot: graph,
      status: "queued",
      error: null,
      pendingAction: { kind: "produce_cards", phase: "sample", requestedAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, run.id), notInArray(agentRuns.status, ["running", "queued"])))
    .returning({ id: agentRuns.id })
  if (updated.length === 0) return { ok: false, error: "AI 团队正在处理中，请稍候" }
  await db.insert(agentEvents).values({
    runId: run.id,
    nodeKey: "artist",
    nodeType: "agent",
    action: "start",
    status: "ok",
    detail: `画面提示词已确认（${items.length} 张），开始生成 ${sampleCount} 张风格小样`,
  })
  return { ok: true, count: items.length, sampleCount }
}
