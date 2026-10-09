/**
 * 塔罗 78 张卡牌清单创建（服务层，与 "use server" action 解耦，
 * 供方向确认等阶段动作复用）。
 *
 * 幂等 + 并发安全：agent_run_item 上 (runId, index) 唯一索引 +
 * ON CONFLICT DO NOTHING，并发双击只会落一份 78 行清单；
 * isSample 由当前模板配置 templateConfig.sampleCount 决定。
 */
import { asc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { agentRunItems, type AgentRunRow } from "@/db/schema"
import { getDeckTemplate } from "@/lib/agent/templates"
import { buildTarotCardPlan } from "@/lib/agent/cards/plan"
import { sampleIndexes } from "@/lib/agent/pipelines"
import type { AgentTemplateDirection } from "@/lib/agent/graph"
import { loadFullDirectionConfig } from "./direction-config"

export async function ensureTarotCardPlan(run: AgentRunRow, direction: AgentTemplateDirection | null) {
  if (!run.selectedDirectionId) throw new Error("请先确认内容方向")
  const template = getDeckTemplate("tarot")
  if (!template) throw new Error("塔罗模板未注册")
  const existing = await db.select().from(agentRunItems).where(eq(agentRunItems.runId, run.id)).orderBy(asc(agentRunItems.index))
  if (existing.length === 78) return existing
  if (existing.length > 0) throw new Error("卡牌清单处于不完整状态，请联系管理员清理后重试")

  const config = await loadFullDirectionConfig("tarot")
  const sampleCount = config.templateConfig?.sampleCount ?? config.sampleCount
  const sampleSet = new Set(sampleIndexes("tarot", template.meta.cardCount, sampleCount))
  const plan = buildTarotCardPlan({ brief: run.brief, direction })
  await db
    .insert(agentRunItems)
    .values(
      plan.map((item) => ({
        runId: run.id,
        enterpriseId: run.enterpriseId,
        userId: run.userId,
        index: item.index,
        name: item.name,
        meaning: item.meaning,
        // 提示词正文不预填：空 = 待 AI 撰写（进度与就绪判据见 isPromptItemReady）
        visualBrief: item.visualBrief || null,
        currentPrompt: item.prompt || null,
        promptSource: "initial" as const,
        status: "pending" as const,
        isSample: sampleSet.has(item.index),
      })),
    )
    .onConflictDoNothing()
  return db.select().from(agentRunItems).where(eq(agentRunItems.runId, run.id)).orderBy(asc(agentRunItems.index))
}
