"use server"

import { and, asc, eq, notInArray } from "drizzle-orm"
import { db } from "@/db/client"
import { agentEvents, agentRunItems, agentRuns } from "@/db/schema"
import { requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import { validateTarotCardPlan } from "@/lib/agent/cards/plan"
import type { TarotCardPlanItem } from "@/lib/agent/cards/plan"
import { applyCardArtGuardrails, stripGuardrailMarker } from "@/lib/agent/prompt-guardrails"
import { AgentRunNotFoundError } from "@/lib/agent/errors"
import {
  buildTemplateProductionGraph,
  templateProductionMissingSlots,
} from "@/lib/agent/pipelines"
import { validateAgentGraph } from "@/lib/agent/validate"
import { loadFullDirectionConfig } from "@/server/services/agent/direction-config"
import { ensureTarotCardPlan } from "@/server/services/agent/card-plan"
import { cardPlanQuerySchema, confirmCardPlanSchema, updateCardPlanItemSchema } from "@/server/schemas/agent-cards"

function deny(ctx: UserContext): void {
  const error = checkModuleAccess(ctx, "agent")
  if (error) throw new Error(error)
}

async function ownedTarotRun(ctx: UserContext, runId: string) {
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.enterpriseId, ctx.user.enterpriseId!), eq(agentRuns.userId, ctx.user.id)))
  if (!run || run.template !== "tarot") throw new AgentRunNotFoundError("塔罗项目不存在或无权访问")
  return run
}

/** 创建或补齐当前项目的 78 张卡牌清单（只生成文本，不调用生图 API）。 */
export async function ensureTarotCardPlanAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const id = cardPlanQuerySchema.parse({ runId }).runId
  const run = await ownedTarotRun(ctx, id)
  const direction = run.directions.find((item) => item.id === run.selectedDirectionId) ?? null
  return ensureTarotCardPlan(run, direction)
}

export async function listTarotCardPlanAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const id = cardPlanQuerySchema.parse({ runId }).runId
  const run = await ownedTarotRun(ctx, id)
  const items = await db.select().from(agentRunItems).where(eq(agentRunItems.runId, run.id)).orderBy(asc(agentRunItems.index))
  return { run, items }
}

export async function updateTarotCardPlanItemAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = updateCardPlanItemSchema.parse(input)
  const run = await ownedTarotRun(ctx, parsed.runId)
  if (run.stage !== "prompt") throw new Error("当前阶段不允许修改卡牌清单")
  const [item] = await db.select().from(agentRunItems).where(and(eq(agentRunItems.id, parsed.itemId), eq(agentRunItems.runId, run.id)))
  if (!item) throw new Error("卡牌不存在")
  // 用户可控文本先剥离护栏标记，防止伪造 marker 关闭护栏/豁免清洗
  const prompt = applyCardArtGuardrails(
    `${stripGuardrailMarker(parsed.visualBrief)}\n${stripGuardrailMarker(run.brief ?? "")}`,
  )
  await db.update(agentRunItems).set({ meaning: parsed.meaning, visualBrief: parsed.visualBrief, currentPrompt: prompt, promptSource: "manual", updatedAt: new Date() }).where(eq(agentRunItems.id, item.id))
  return { ok: true }
}

/**
 * 用户确认 78 张清单后进入生图/评审阶段：以当前方向配置重建模板生产图
 * （graphSnapshot），并排队风格小样生产（produce_cards · sample），由 worker
 * 复用经典 item 流水线执行（生图 → 三审 → 总控裁决）。
 */
export async function confirmTarotCardPlanAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const { runId } = confirmCardPlanSchema.parse(input)
  const run = await ownedTarotRun(ctx, runId)
  if (run.stage !== "prompt") throw new Error("当前项目不在卡牌清单确认阶段")
  if (run.status === "running" || run.status === "queued") throw new Error("AI 团队正在处理中，请稍候")
  const items = await db.select().from(agentRunItems).where(eq(agentRunItems.runId, run.id)).orderBy(asc(agentRunItems.index))
  const plan: TarotCardPlanItem[] = items.map((item) => ({ index: item.index, name: item.name ?? "", meaning: item.meaning ?? "", visualBrief: item.visualBrief ?? "", prompt: item.currentPrompt ?? "" }))
  validateTarotCardPlan(plan)

  const config = await loadFullDirectionConfig("tarot")
  const missing = templateProductionMissingSlots(config)
  if (missing.length > 0) {
    throw new Error(`塔罗生产流水线缺少配置：${missing.join("、")}，请联系管理员在「Agent 工坊配置」中补齐`)
  }
  // 用户发起时选择的质量要求覆盖默认阈值与打回上限（存 run.input.quality）
  const graph = buildTemplateProductionGraph(config, run.input.quality)
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
    detail: `卡牌清单已确认（${items.length} 张），开始生成 ${sampleCount} 张风格小样`,
  })
  return { ok: true, count: items.length, sampleCount }
}
