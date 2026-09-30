"use server"

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  agentEvents,
  agentReviews,
  agentRunItems,
  agentRounds,
  agentRuns,
} from "@/db/schema"
import {
  requireEnterpriseContext,
  type UserContext,
} from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import { checkRunCompletion } from "@/server/services/agent-orchestrator"
import {
  confirmItemSchema,
  regenItemSchema,
  runControlSchema,
} from "@/server/schemas/agent"
import { DEFAULT_SCORE_THRESHOLDS } from "@/lib/agent/score"
import { templateProductionMissingSlots, type TarotTemplateConfig } from "@/lib/agent/pipelines"
import { loadFullDirectionConfig } from "@/server/services/agent/direction-config"
import { AGENT_DIRECTIONS } from "@/lib/agent/graph"
import { revalidatePath } from "next/cache"

/**
 * AI Agent Server Actions（/agent 卡牌工坊：塔罗模板五阶段）
 *
 * - 全部 requireEnterpriseContext + agent 模块权限；数据访问强制
 *   enterpriseId + userId 双过滤（多租户铁律）；
 * - 经典全流程（template=null）已下线并清空历史数据，相关 action 移除；
 * - 模型由管理员在 agent_direction_config 预配置，用户零配置（质量参数可在创建时覆盖）。
 */

// ═══════════════════════════ 内部工具 ═══════════════════════════

function denyAgent(ctx: UserContext): string | null {
  return checkModuleAccess(ctx, "agent")
}

async function getOwnedRun(ctx: UserContext, runId: string) {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.enterpriseId, ctx.user.enterpriseId!),
        eq(agentRuns.userId, ctx.user.id),
      ),
    )
  return row ?? null
}

// ═══════════════════════════ 产品线 ═══════════════════════════

/**
 * 产品线列表（入口模板卡）：塔罗 ready 判定与模板生产配置完整性对齐
 * （templateProductionMissingSlots：文案/卡面生图/评审团），并返回质量
 * 默认值（阈值与打回上限，发起弹窗「标准」档初始值与滑块上限）。
 */
export async function listDirectionsAction() {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) throw new Error(denied)

  const result = []
  for (const meta of AGENT_DIRECTIONS) {
    const config = await loadFullDirectionConfig(meta.key)
    const missing = meta.key === "tarot" ? templateProductionMissingSlots(config) : [] as string[]
    const t = config.templateConfig as TarotTemplateConfig | undefined
    result.push({
      ...meta,
      enabled: config.enabled,
      sampleEnabled: config.sampleEnabled,
      sampleCount: config.sampleCount,
      ready: config.enabled && missing.length === 0,
      notReadyReason: config.enabled
        ? missing.length > 0
          ? `缺少配置：${missing.join("、")}，请联系管理员`
          : null
        : "该产品线暂未开放",
      /** 质量默认值（发起弹窗「标准」档与滑块范围）；maxRetries 钳到 0-3，
       *  与用户侧校验同限（历史配置行可能存过更大值，超限会让创建被拒） */
      qualityDefaults: t
        ? {
            contentThreshold: t.reviewThresholds.content,
            aestheticThreshold: t.reviewThresholds.aesthetic,
            consistencyThreshold: t.reviewThresholds.consistency,
            maxRetries: Math.max(0, Math.min(3, t.maxRetries)),
          }
        : null,
    })
  }
  return result
}

// ═══════════════════════════ 运行查询 ═══════════════════════════

/** 运行历史条目（首页项目卡） */
export interface RunHistoryEntry {
  id: string
  direction: string | null
  status: string
  phase: string
  prompt: string
  cardCount: number
  costCenticredits: number
  imageCostCredits: number
  llmCallCount: number
  imageCount: number
  createdAt: Date
  finishedAt: Date | null
  coverImageUrl: string | null
  itemStats: { status: string; count: number }[]
}

/** 项目历史分页结果（cursor = "<createdAtISO>|<id>"，取更旧一页） */
export interface ListRunsResult {
  runs: RunHistoryEntry[]
  nextCursor: string | null
}

/**
 * 最近运行历史（列表页）：(createdAt, id) 键集分页，多取 1 条判断下一页；
 * 封面优先取第一张带融合图的卡，否则按各 run 前 3 张卡补查生图轮（限制
 * rounds 查询规模）。
 */
export async function listRunsAction(
  input: { limit?: number; cursor?: string | null } | number = {},
): Promise<ListRunsResult> {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) throw new Error(denied)
  const opts = typeof input === "number" ? { limit: input } : input
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20))

  const conditions = [
    eq(agentRuns.enterpriseId, ctx.user.enterpriseId!),
    eq(agentRuns.userId, ctx.user.id),
  ]
  if (opts.cursor) {
    const separatorIndex = opts.cursor.lastIndexOf("|")
    const createdAt = opts.cursor.slice(0, separatorIndex)
    const id = opts.cursor.slice(separatorIndex + 1)
    if (!createdAt || !id) throw new Error("分页游标无效，请刷新页面")
    conditions.push(
      sql`(${agentRuns.createdAt}, ${agentRuns.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
    )
  }

  const rows = await db
    .select({
      id: agentRuns.id,
      direction: agentRuns.direction,
      status: agentRuns.status,
      phase: agentRuns.phase,
      prompt: sql<string>`left(${agentRuns.input} ->> 'prompt', 60)`,
      cardCount: sql<number>`(${agentRuns.input} ->> 'cardCount')::int`,
      costCenticredits: agentRuns.costCenticredits,
      imageCostCredits: agentRuns.imageCostCredits,
      llmCallCount: agentRuns.llmCallCount,
      imageCount: agentRuns.imageCount,
      createdAt: agentRuns.createdAt,
      finishedAt: agentRuns.finishedAt,
    })
    .from(agentRuns)
    .where(and(...conditions))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const runs = hasMore ? rows.slice(0, limit) : rows
  const last = runs[runs.length - 1]
  if (runs.length === 0) return { runs: [], nextCursor: null }

  const stats = await db
    .select({
      runId: agentRunItems.runId,
      status: agentRunItems.status,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(agentRunItems)
    .where(inArray(agentRunItems.runId, runs.map((r) => r.id)))
    .groupBy(agentRunItems.runId, agentRunItems.status)

  // 封面：第一张带融合图的卡优先；否则按各 run 前 3 张卡补查生图轮
  const itemRows = await db
    .select({
      id: agentRunItems.id,
      runId: agentRunItems.runId,
      framedImageUrl: agentRunItems.framedImageUrl,
    })
    .from(agentRunItems)
    .where(inArray(agentRunItems.runId, runs.map((r) => r.id)))
    .orderBy(asc(agentRunItems.index))
  const coverByRun = new Map<string, string>()
  const candidateItemsByRun = new Map<string, string[]>()
  for (const run of runs) {
    const items = itemRows.filter((i) => i.runId === run.id)
    const framed = items.find((i) => i.framedImageUrl)
    if (framed?.framedImageUrl) {
      coverByRun.set(run.id, framed.framedImageUrl)
    } else if (items.length > 0) {
      candidateItemsByRun.set(run.id, items.slice(0, 3).map((i) => i.id))
    }
  }
  const roundItemIds = [...candidateItemsByRun.values()].flat()
  if (roundItemIds.length > 0) {
    const roundRows = await db
      .select({ itemId: agentRounds.itemId, imageUrl: agentRounds.imageUrl })
      .from(agentRounds)
      .where(and(inArray(agentRounds.itemId, roundItemIds), isNotNull(agentRounds.imageUrl)))
    const imageByItem = new Map(roundRows.map((r) => [r.itemId, r.imageUrl]))
    for (const [runId, itemIds] of candidateItemsByRun) {
      const hit = itemIds.map((id) => imageByItem.get(id)).find(Boolean)
      if (hit) coverByRun.set(runId, hit)
    }
  }

  return {
    runs: runs.map((r) => ({
      ...r,
      coverImageUrl: coverByRun.get(r.id) ?? null,
      itemStats: stats.filter((s) => s.runId === r.id).map((s) => ({ status: s.status, count: s.count })),
    })),
    nextCursor: hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
  }
}

/**
 * 从运行快照的评审节点读取及格线（兼容多评审节点：任一节点携带该维度阈值即可）。
 * 快照缺失/数值非法时回退 fallback。
 */
function reviewThresholdFromSnapshot(
  snapshot: unknown,
  pick: (config: Record<string, unknown>) => unknown,
  fallback: number,
): number {
  const nodes = (snapshot as { nodes?: { config?: Record<string, unknown> }[] } | null)?.nodes ?? []
  for (const node of nodes) {
    const raw = node.config ? pick(node.config) : undefined
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100) {
      return Math.round(raw)
    }
  }
  return fallback
}

/** 单卡详情：全部轮次（prompt/图/候选）+ 审核与裁决记录（逐轮回放） */
export async function getRunItemDetailAction(itemId: string) {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) throw new Error(denied)
  const [item] = await db
    .select()
    .from(agentRunItems)
    .where(
      and(
        eq(agentRunItems.id, itemId),
        eq(agentRunItems.enterpriseId, ctx.user.enterpriseId!),
        eq(agentRunItems.userId, ctx.user.id),
      ),
    )
  if (!item) throw new Error("卡牌不存在")

  const rounds = await db
    .select()
    .from(agentRounds)
    .where(eq(agentRounds.itemId, itemId))
    .orderBy(agentRounds.roundNumber)
  const reviews = rounds.length
    ? await db
        .select()
        .from(agentReviews)
        .where(
          inArray(
            agentReviews.roundId,
            rounds.map((r) => r.id),
          ),
        )
    : []
  // 运行快照里的评审阈值（前端分数条着色用；快照缺失时回退默认值）
  const [run] = await db
    .select({ graphSnapshot: agentRuns.graphSnapshot })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, item.runId),
        eq(agentRuns.enterpriseId, ctx.user.enterpriseId!),
        eq(agentRuns.userId, ctx.user.id),
      ),
    )
  return {
    item: {
      id: item.id,
      index: item.index,
      name: item.name,
      meaning: item.meaning,
      status: item.status,
      isSample: item.isSample,
      roundsUsed: item.roundsUsed,
      finalRoundId: item.finalRoundId,
      fallbackContentWarning: item.fallbackContentWarning,
      manualRegenCount: item.manualRegenCount,
      errorMessage: item.errorMessage,
    },
    rounds,
    reviews,
    thresholds: {
      content: reviewThresholdFromSnapshot(
        run?.graphSnapshot,
        (config) => config.contentThreshold ?? config.aestheticThreshold,
        DEFAULT_SCORE_THRESHOLDS.content,
      ),
      aesthetic: reviewThresholdFromSnapshot(
        run?.graphSnapshot,
        (config) => config.aestheticThreshold,
        DEFAULT_SCORE_THRESHOLDS.aesthetic,
      ),
      consistency: reviewThresholdFromSnapshot(
        run?.graphSnapshot,
        (config) => config.consistencyThreshold ?? config.aestheticThreshold,
        DEFAULT_SCORE_THRESHOLDS.consistency,
      ),
    },
  }
}

// ═══════════════════════════ 项目删除 ═══════════════════════════

/**
 * 删除项目（历史记录管理）：运行中/排队中的项目暂不可删（无取消能力，
 * 需等待批次完成或失败）。子表（item/round/review/event/message/asset）
 * 由 agent_run 外键 ON DELETE CASCADE 级联清理；存储图片文件保留。
 */
export async function deleteRunAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) throw new Error(denied)
  runControlSchema.parse({ runId })
  const run = await getOwnedRun(ctx, runId)
  if (!run) throw new Error("项目不存在")
  if (run.status === "running" || run.status === "queued") {
    throw new Error("项目正在处理中，请等待本批次结束后再删除")
  }
  await db
    .delete(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.enterpriseId, ctx.user.enterpriseId!),
        eq(agentRuns.userId, ctx.user.id),
      ),
    )
  revalidatePath("/agent")
  return { ok: true }
}

// ═══════════════════════════ 单卡操作 ═══════════════════════════

/** 人工改选终版（兜底/自动通过后仍可改选任意一轮） */
export async function confirmItemAction(input: { itemId: string; roundId: string }) {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) throw new Error(denied)
  const parsed = confirmItemSchema.parse(input)
  const [item] = await db
    .select()
    .from(agentRunItems)
    .where(
      and(
        eq(agentRunItems.id, parsed.itemId),
        eq(agentRunItems.enterpriseId, ctx.user.enterpriseId!),
        eq(agentRunItems.userId, ctx.user.id),
      ),
    )
  if (!item) throw new Error("卡牌不存在")
  if (!["waiting_human", "fallback", "approved_by_ai", "confirmed"].includes(item.status)) {
    throw new Error("当前状态不可确认")
  }
  const [round] = await db
    .select({ id: agentRounds.id, roundNumber: agentRounds.roundNumber })
    .from(agentRounds)
    .where(and(eq(agentRounds.id, parsed.roundId), eq(agentRounds.itemId, item.id)))
  if (!round) throw new Error("所选轮次不存在")

  await db
    .update(agentRunItems)
    .set({ status: "confirmed", finalRoundId: round.id, updatedAt: new Date() })
    .where(eq(agentRunItems.id, item.id))
  await db.insert(agentEvents).values({
    runId: item.runId,
    action: "confirm",
    status: "ok",
    detail: `「${item.name ?? `第 ${item.index + 1} 张`}」已改选第 ${round.roundNumber} 轮为终版`,
    itemId: item.id,
    roundId: round.id,
  })
  await checkRunCompletion(item.runId)
  revalidatePath("/agent")
  return { ok: true }
}

/** 手动重开（不受打回上限约束；manualRegenCount 软限流计数提醒成本） */
export async function regenItemAction(input: { itemId: string }) {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) throw new Error(denied)
  const parsed = regenItemSchema.parse(input)
  const [item] = await db
    .select()
    .from(agentRunItems)
    .where(
      and(
        eq(agentRunItems.id, parsed.itemId),
        eq(agentRunItems.enterpriseId, ctx.user.enterpriseId!),
        eq(agentRunItems.userId, ctx.user.id),
      ),
    )
  if (!item) throw new Error("卡牌不存在")
  if (item.status === "pending" || ["drafting", "generating", "reviewing"].includes(item.status)) {
    throw new Error("该卡牌正在处理中，无法重开")
  }
  const [runRow] = await db
    .select({ status: agentRuns.status, template: agentRuns.template, phase: agentRuns.phase })
    .from(agentRuns)
    .where(eq(agentRuns.id, item.runId))
  // 模板流程：清单提示词是用户确认过的底稿，重开保留（首轮直接沿用，
  // 仅在审核打回时由文案 Agent 改写）
  const isTemplate = !!runRow?.template

  await db
    .update(agentRunItems)
    .set({
      status: "pending",
      roundsUsed: 0,
      finalRoundId: null,
      fallbackContentWarning: false,
      errorMessage: null,
      ...(isTemplate ? {} : { currentPrompt: null, promptSource: null }),
      manualRegenCount: item.manualRegenCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(agentRunItems.id, item.id))

  // 模板运行必须带上 produce_cards 动作，模板队列才会认领
  if (runRow && runRow.status !== "running" && runRow.status !== "queued") {
    await db
      .update(agentRuns)
      .set(
        isTemplate
          ? {
              status: "queued",
              finishedAt: null,
              error: null,
              pendingAction: { kind: "produce_cards", phase: runRow.phase, requestedAt: new Date().toISOString() },
              updatedAt: new Date(),
            }
          : { status: "queued", finishedAt: null, error: null, updatedAt: new Date() },
      )
      .where(eq(agentRuns.id, item.runId))
  }
  await db.insert(agentEvents).values({
    runId: item.runId,
    action: "regen",
    status: "ok",
    detail: `「${item.name ?? `第 ${item.index + 1} 张`}」手动重开（第 ${item.manualRegenCount + 1} 次，重新执行流水线）`,
    itemId: item.id,
  })
  revalidatePath("/agent")
  return { ok: true }
}
