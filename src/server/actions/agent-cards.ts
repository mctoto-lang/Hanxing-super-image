"use server"

import { and, asc, eq, notInArray } from "drizzle-orm"
import { db } from "@/db/client"
import { agentEvents, agentRunItems, agentRuns } from "@/db/schema"
import { requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import {
  composeDraftPrompt,
  validateTarotDraftPlan,
  validateTarotFinalPlan,
} from "@/lib/agent/cards/plan"
import { AgentRunNotFoundError } from "@/lib/agent/errors"
import { normalizeTemplateStage } from "@/lib/agent/graph"
import {
  buildTemplateProductionGraph,
  templateProductionMissingSlots,
} from "@/lib/agent/pipelines"
import { validateAgentGraph } from "@/lib/agent/validate"
import { loadFullDirectionConfig } from "@/server/services/agent/direction-config"
import {
  confirmCardPlanSchema,
  regenerateCardPromptsSchema,
  updateCardPlanItemSchema,
} from "@/server/schemas/agent-cards"

function deny(ctx: UserContext): void {
  const error = checkModuleAccess(ctx, "agent")
  if (error) throw new Error(error)
}

async function ownedTarotRun(ctx: UserContext, runId: string) {
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.enterpriseId, ctx.user.enterpriseId!), eq(agentRuns.userId, ctx.user.id)))
  if (!run || run.template !== "tarot") throw new AgentRunNotFoundError("塔罗项目不存在或无权访问")
  return run
}

/** 编辑单张画面提示词初稿（draft 阶段；旧 prompt 阶段的存量 run 同样放行）。 */
export async function updateTarotCardPlanItemAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = updateCardPlanItemSchema.parse(input)
  const run = await ownedTarotRun(ctx, parsed.runId)
  if (normalizeTemplateStage(run.stage) !== "draft") throw new Error("当前阶段不允许修改画面初稿")
  const [item] = await db.select().from(agentRunItems).where(and(eq(agentRunItems.id, parsed.itemId), eq(agentRunItems.runId, run.id)))
  if (!item) throw new Error("卡牌不存在")
  // 新流程：初稿直通 currentPrompt（不拼风格前缀、不带负向约束）；
  // 用户可控文本先剥离护栏标记，防止伪造 marker（沿用旧防线）
  const prompt = composeDraftPrompt(parsed.visualBrief)
  await db.update(agentRunItems).set({ meaning: parsed.meaning, visualBrief: parsed.visualBrief, currentPrompt: prompt, promptSource: "manual", updatedAt: new Date() }).where(eq(agentRunItems.id, item.id))
  return { ok: true }
}

/**
 * 重新生成画面提示词（排队由 worker 执行）：
 * - draft（或存量 prompt）阶段 → design_drafts（初稿重写）
 * - final 阶段 → design_finals（终稿重细化）
 * itemIds 缺省 = 全部 78 张；feedback 为可选的用户改写要求。
 */
export async function regenerateCardPromptsAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = regenerateCardPromptsSchema.parse(input)
  const run = await ownedTarotRun(ctx, parsed.runId)
  const stage = normalizeTemplateStage(run.stage)
  if (stage !== "draft" && stage !== "final") throw new Error("当前项目不在初稿或终稿阶段")
  if (parsed.itemIds?.length) {
    const items = await db.select({ id: agentRunItems.id }).from(agentRunItems).where(eq(agentRunItems.runId, run.id))
    const valid = new Set(items.map((item) => item.id))
    if (parsed.itemIds.some((id) => !valid.has(id))) throw new Error("包含不属于本项目的卡牌")
  }
  // 与 enqueueTemplateAction 同语义（该助手未跨 action 导出，此处内联）：
  // 条件更新守住读取→写入间隙，状态被并发改变时不覆盖
  const updated = await db
    .update(agentRuns)
    .set({
      pendingAction: {
        kind: stage === "final" ? "design_finals" : "design_drafts",
        itemIds: parsed.itemIds?.length ? parsed.itemIds : undefined,
        feedback: parsed.feedback || undefined,
        requestedAt: new Date().toISOString(),
      },
      status: "queued",
      error: null,
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, run.id), notInArray(agentRuns.status, ["running", "queued"])))
    .returning({ id: agentRuns.id })
  if (updated.length === 0) throw new Error("AI 团队正在处理中，请稍候")
  return { ok: true, count: parsed.itemIds?.length ?? 78 }
}

/**
 * 用户确认 78 张初稿后进入终稿细化阶段：排队 design_finals，由终稿细化师
 * 把初稿细化为结构化终稿（[1]画面风格 + [2]画面内容），完成后回 waiting_human
 * 等用户在终稿页查看与确认。
 */
export async function confirmTarotCardDraftsAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const { runId } = confirmCardPlanSchema.parse(input)
  const run = await ownedTarotRun(ctx, runId)
  if (normalizeTemplateStage(run.stage) !== "draft") throw new Error("当前项目不在初稿确认阶段")
  if (run.status === "running" || run.status === "queued") throw new Error("AI 团队正在处理中，请稍候")
  const items = await db.select().from(agentRunItems).where(eq(agentRunItems.runId, run.id)).orderBy(asc(agentRunItems.index))
  validateTarotDraftPlan(
    items.map((item) => ({ index: item.index, name: item.name ?? "", visualBrief: item.visualBrief ?? "" })),
  )

  // 条件更新守住读取→写入间隙：状态被并发改变（如 worker 已认领）时不覆盖
  const updated = await db
    .update(agentRuns)
    .set({
      stage: "final",
      status: "queued",
      error: null,
      pendingAction: { kind: "design_finals", requestedAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, run.id), notInArray(agentRuns.status, ["running", "queued"])))
    .returning({ id: agentRuns.id })
  if (updated.length === 0) throw new Error("AI 团队正在处理中，请稍候")
  await db.insert(agentEvents).values({
    runId: run.id,
    nodeKey: "final_refiner",
    nodeType: "agent",
    action: "start",
    status: "ok",
    detail: `画面初稿已确认（${items.length} 张），终稿细化师开始把初稿细化为结构化终稿`,
  })
  return { ok: true, count: items.length }
}

/**
 * 用户确认 78 张终稿后进入生图/评审阶段：以当前方向配置重建模板生产图
 * （graphSnapshot），并排队风格小样生产（produce_cards · sample），由 worker
 * 复用经典 item 流水线执行（生图 → 三审 → 总控裁决；不通过从初稿重细化）。
 */
export async function confirmTarotCardFinalsAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const { runId } = confirmCardPlanSchema.parse(input)
  const run = await ownedTarotRun(ctx, runId)
  if (normalizeTemplateStage(run.stage) !== "final") throw new Error("当前项目不在终稿确认阶段")
  if (run.status === "running" || run.status === "queued") throw new Error("AI 团队正在处理中，请稍候")
  const items = await db.select().from(agentRunItems).where(eq(agentRunItems.runId, run.id)).orderBy(asc(agentRunItems.index))
  // 终稿门槛：结构化两段为佳；存量旧式提示词长度达标即放行（不阻断过渡期项目）
  validateTarotFinalPlan(
    items.map((item) => ({ index: item.index, name: item.name ?? "", prompt: item.currentPrompt ?? "" })),
  )

  const config = await loadFullDirectionConfig("tarot")
  const missing = templateProductionMissingSlots(config)
  if (missing.length > 0) {
    throw new Error(`塔罗生产流水线缺少配置：${missing.join("、")}，请联系管理员在「Agent 工坊配置」中补齐`)
  }
  // 用户发起时选择的质量要求覆盖默认阈值与打回上限（存 run.input.quality）；
  // 用户选择的卡面模型（run.input.imageModelId/imageSize）同样带入重建图
  const graph = buildTemplateProductionGraph(config, run.input.quality, {
    imageModelId: run.input.imageModelId ?? null,
    imageSize: run.input.imageSize ?? null,
  })
  const validation = validateAgentGraph(graph)
  if (!validation.ok) throw new Error(`生产流水线配置无效：${validation.error}，请联系管理员检查`)

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
  if (updated.length === 0) throw new Error("AI 团队正在处理中，请稍候")
  await db.insert(agentEvents).values({
    runId: run.id,
    nodeKey: "artist",
    nodeType: "agent",
    action: "start",
    status: "ok",
    detail: `画面终稿已确认（${items.length} 张），开始生成 ${sampleCount} 张风格小样`,
  })
  return { ok: true, count: items.length, sampleCount }
}
