"use server"

import { and, asc, desc, eq, inArray, isNotNull, lte, notInArray, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db/client"
import {
  agentAssets,
  agentEvents,
  agentReviews,
  agentRunItems,
  agentRounds,
  agentRuns,
  chatApiConfigs,
  generationTasks,
} from "@/db/schema"
import { getStorage } from "@/lib/storage"
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
import { reviewThresholdFromSnapshot, templateProductionMissingSlots, type TarotTemplateConfig } from "@/lib/agent/pipelines"
import { loadFullDirectionConfig } from "@/server/services/agent/direction-config"
import { loadAgentCardModelPool } from "@/server/services/agent/card-models"
import { loadAgentChatModelPool } from "@/server/services/agent/chat-models"
import { AGENT_DIRECTIONS } from "@/lib/agent/graph"
import { revalidatePath } from "next/cache"

/**
 * AI Agent Server Actions（/agent 卡牌工坊：塔罗模板四阶段）
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

/**
 * Agent 工坊卡面生图模型候选池（发起弹窗「卡面生图模型」选项来源）：
 * visibleInAgent 启用 ∩ 企业/权限组可见 ∩ 比例严格锁定（与平台卡面同比例
 * 的启用预设）。返回 cardRatio 供前端展示锁定比例徽标。
 */
export async function listAgentCardModelsAction() {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) throw new Error(denied)
  return await loadAgentCardModelPool(ctx)
}

/**
 * Agent 工坊 AI 团队对话模型候选池（发起弹窗「AI 团队模型」选项来源）：
 * 企业/权限组可见的启用对话模型（带 supportsVision 标记；评审团候选仅
 * 展示视觉模型）。用户缺省不选 = 跟随平台超管配置。
 */
export async function listAgentChatModelsAction() {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) throw new Error(denied)
  return await loadAgentChatModelPool(ctx)
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

  // 封面：第一张带融合图的卡优先（SQL 侧每 run 取一行，不再全量拉回
  // 50×78 行 items 到内存过滤）；无融合图的 run 再按前 3 张卡补查生图轮
  const framedRows = await db
    .selectDistinctOn([agentRunItems.runId], {
      runId: agentRunItems.runId,
      framedImageUrl: agentRunItems.framedImageUrl,
    })
    .from(agentRunItems)
    .where(
      and(
        inArray(agentRunItems.runId, runs.map((r) => r.id)),
        isNotNull(agentRunItems.framedImageUrl),
      ),
    )
    .orderBy(agentRunItems.runId, asc(agentRunItems.index))
  const coverByRun = new Map<string, string>()
  for (const row of framedRows) {
    if (row.framedImageUrl) coverByRun.set(row.runId, row.framedImageUrl)
  }

  const runsNeedingRoundCover = runs.filter((r) => !coverByRun.has(r.id)).map((r) => r.id)
  if (runsNeedingRoundCover.length > 0) {
    const itemRows = await db
      .select({ id: agentRunItems.id, runId: agentRunItems.runId })
      .from(agentRunItems)
      .where(and(inArray(agentRunItems.runId, runsNeedingRoundCover), lte(agentRunItems.index, 2)))
      .orderBy(asc(agentRunItems.index))
    const roundItemIds = itemRows.map((i) => i.id)
    if (roundItemIds.length > 0) {
      const roundRows = await db
        .select({ itemId: agentRounds.itemId, imageUrl: agentRounds.imageUrl })
        .from(agentRounds)
        .where(and(inArray(agentRounds.itemId, roundItemIds), isNotNull(agentRounds.imageUrl)))
      const imageByItem = new Map(roundRows.map((r) => [r.itemId, r.imageUrl]))
      for (const runId of runsNeedingRoundCover) {
        const hit = itemRows
          .filter((i) => i.runId === runId)
          .map((i) => imageByItem.get(i.id))
          .find(Boolean)
        if (hit) coverByRun.set(runId, hit)
      }
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
  // 评审节点 → 模型中文名（弹窗按「评审 N · 模型名」分组展示）
  const snapshot = (run?.graphSnapshot ?? null) as {
    nodes?: { id: string; type: string; config: { chatModelId?: string } }[]
  } | null
  const reviewNodeEntries = (snapshot?.nodes ?? [])
    .filter((node) => node.type === "review" && node.config?.chatModelId)
    .map((node) => ({ nodeKey: node.id, modelId: node.config.chatModelId! }))
  const reviewModelIds = [...new Set(reviewNodeEntries.map((entry) => entry.modelId))]
  const reviewModelRows = reviewModelIds.length
    ? await db
        .select({ id: chatApiConfigs.id, displayName: chatApiConfigs.displayName })
        .from(chatApiConfigs)
        .where(inArray(chatApiConfigs.id, reviewModelIds))
    : []
  const reviewModelNameById = new Map(reviewModelRows.map((row) => [row.id, row.displayName]))
  const reviewModels = reviewNodeEntries.map((entry, index) => ({
    nodeKey: entry.nodeKey,
    label: `评审 ${index + 1}`,
    modelName: reviewModelNameById.get(entry.modelId) ?? "未知模型",
  }))
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
      /** 提示词终稿（评审弹窗内可编辑；后续生图沿用） */
      currentPrompt: item.currentPrompt,
    },
    rounds,
    reviews,
    /** 评审节点模型（按快照顺序；快照缺失/旧数据为空数组，弹窗回退平铺展示） */
    reviewModels,
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
 * 由 agent_run 外键 ON DELETE CASCADE 级联清理；存储图片文件先收集
 * URL 再交 storage 批量删除（非本平台存储的 URL 自动跳过，删除失败
 * 不阻断项目删除——文件残留由存储清理策略兜底）。
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

  // 删除前收集本项目产生的全部图片 URL（级联删除后无从查起）
  const urls = new Set<string>()
  const collect = (...values: (string | null | undefined | string[])[]) => {
    for (const value of values) {
      if (!value) continue
      if (typeof value === "string") {
        if (value.startsWith("http")) urls.add(value)
      } else {
        for (const item of value) if (item?.startsWith("http")) urls.add(item)
      }
    }
  }
  try {
    const [roundRows, itemRows, assetRows, genTaskRows] = await Promise.all([
      db
        .select({ imageUrl: agentRounds.imageUrl, candidates: agentRounds.candidates })
        .from(agentRounds)
        .where(eq(agentRounds.runId, runId)),
      db
        .select({ framedImageUrl: agentRunItems.framedImageUrl })
        .from(agentRunItems)
        .where(eq(agentRunItems.runId, runId)),
      db.select({ url: agentAssets.url }).from(agentAssets).where(eq(agentAssets.runId, runId)),
      db
        .select({ resultImages: generationTasks.resultImages })
        .from(generationTasks)
        .where(
          and(
            eq(generationTasks.source, "agent"),
            sql`${generationTasks.templateInfo} ->> 'runId' = ${runId}`,
          ),
        ),
    ])
    for (const row of roundRows) {
      collect(row.imageUrl, (row.candidates ?? []).map((c) => c.url))
    }
    for (const row of itemRows) collect(row.framedImageUrl)
    for (const row of assetRows) collect(row.url)
    for (const row of genTaskRows) collect(row.resultImages ?? [])
  } catch (error) {
    console.error("[agent] 删除项目前收集图片 URL 失败（将继续删除 DB 记录）:", error)
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

  // DB 级联删除成功后再清理存储文件（失败不阻断：幂等可重试，残留由保留策略兜底）
  if (urls.size > 0) {
    try {
      await (await getStorage()).deleteObjects([...urls])
    } catch (error) {
      console.error(`[agent] 删除项目 ${runId} 的存储文件失败（${urls.size} 个，记录已删除）:`, error)
    }
  }
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
  // failed 也允许改选：生图失败（如内容被上游拒绝/调用失败）的卡若有历史
  // 成图轮，用户可直接改选其一为终稿收口，不必重开重试
  if (!["waiting_human", "fallback", "approved_by_ai", "confirmed", "failed"].includes(item.status)) {
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

/**
 * 手动重开（不受打回上限约束；manualRegenCount 软限流计数提醒成本）。
 * 业务失败返回 { ok:false, error } 而非 throw：生产环境 Server Action 的
 * 抛错会被抹为 digest 占位错误（Minified React error #441），用户看不到
 * 真实中文提示。
 */
export async function regenItemAction(
  input: { itemId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) return { ok: false, error: denied }
  const parsed = regenItemSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "参数无效" }
  const { itemId } = parsed.data
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
  if (!item) return { ok: false, error: "卡牌不存在" }
  if (item.status === "pending" || ["drafting", "generating", "reviewing"].includes(item.status)) {
    return { ok: false, error: "该卡牌正在处理中，无法重开" }
  }
  const [runRow] = await db
    .select({ status: agentRuns.status, template: agentRuns.template, phase: agentRuns.phase })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, item.runId),
        eq(agentRuns.enterpriseId, ctx.user.enterpriseId!),
        eq(agentRuns.userId, ctx.user.id),
      ),
    )
  // 模板流程（经典全流程已下线）：清单提示词是用户确认过的底稿，重开保留
  // （首轮直接沿用，仅在审核打回时由文案 Agent 改写）
  if (!runRow?.template) return { ok: false, error: "该项目不是模板项目，无法重开" }

  await db
    .update(agentRunItems)
    .set({
      status: "pending",
      roundsUsed: 0,
      finalRoundId: null,
      fallbackContentWarning: false,
      errorMessage: null,
      manualRegenCount: item.manualRegenCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(agentRunItems.id, item.id))

  // 模板运行必须带上 produce_cards 动作，模板队列才会认领
  if (runRow.status !== "running" && runRow.status !== "queued") {
    // 条件更新守住 SELECT→UPDATE 间隙：状态被并发改变（如 worker 已认领）时不覆盖
    const updated = await db
      .update(agentRuns)
      .set({
        status: "queued",
        finishedAt: null,
        error: null,
        pendingAction: { kind: "produce_cards", phase: runRow.phase, requestedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(and(eq(agentRuns.id, item.runId), notInArray(agentRuns.status, ["running", "queued"])))
      .returning({ id: agentRuns.id })
    if (updated.length === 0) return { ok: false, error: "AI 团队正在处理中，请稍候" }
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

/**
 * 批量重试失败卡面（生图/模型调用失败造成的中断）：把该 run 全部
 * failed/cancelled 卡一次性重置为 pending 并重新排队生产。produce_cards
 * 只原子认领 pending 卡（见 runItemBatches），已完成的卡不会被重复处理。
 * 业务失败返回 { ok:false, error } 而非 throw：生产环境 Server Action 的
 * 抛错会被抹为 digest 占位错误（Minified React error #441）。
 */
export async function regenFailedItemsAction(
  runId: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) return { ok: false, error: denied }
  const parsed = z.string().uuid().safeParse(runId)
  if (!parsed.success) return { ok: false, error: "项目 ID 无效" }
  const id = parsed.data
  const runRow = await getOwnedRun(ctx, id)
  if (!runRow) return { ok: false, error: "项目不存在或无权访问" }
  if (!runRow.template) return { ok: false, error: "该项目不是模板项目" }
  if (runRow.status === "running" || runRow.status === "queued") {
    return { ok: false, error: "AI 团队正在处理中，请稍候" }
  }
  const failed = await db
    .select({ id: agentRunItems.id })
    .from(agentRunItems)
    .where(
      and(eq(agentRunItems.runId, id), inArray(agentRunItems.status, ["failed", "cancelled"])),
    )
  if (failed.length === 0) return { ok: false, error: "没有可重试的失败卡面" }

  await db
    .update(agentRunItems)
    .set({
      status: "pending",
      roundsUsed: 0,
      finalRoundId: null,
      fallbackContentWarning: false,
      errorMessage: null,
      manualRegenCount: sql`${agentRunItems.manualRegenCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(agentRunItems.runId, id), inArray(agentRunItems.status, ["failed", "cancelled"])),
    )

  // 条件更新守住 SELECT→UPDATE 间隙：状态被并发改变（如 worker 已认领）时不覆盖
  const updated = await db
    .update(agentRuns)
    .set({
      status: "queued",
      finishedAt: null,
      error: null,
      pendingAction: { kind: "produce_cards", phase: runRow.phase, requestedAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, id), notInArray(agentRuns.status, ["running", "queued"])))
    .returning({ id: agentRuns.id })
  if (updated.length === 0) return { ok: false, error: "AI 团队正在处理中，请稍候" }

  await db.insert(agentEvents).values({
    runId: id,
    action: "regen",
    status: "ok",
    detail: `批量重试 ${failed.length} 张失败卡面（重置为待生产并重新排队）`,
  })
  revalidatePath("/agent")
  return { ok: true, count: failed.length }
}

/**
 * 一键重新生成风格小样（art 阶段 sample 相位）：把全部 isSample 卡重置为
 * pending 并重新排队小样生产（无论成败）。phase=full 后小样终图已锁定为
 * 成套一致性基准，不再允许整批重跑（单张重开不受此限）。业务失败返回
 * { ok:false, error } 而非 throw：生产环境 Server Action 抛错会被抹为
 * digest 占位错误（Minified React error #441）。
 */
export async function regenSampleItemsAction(
  runId: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) return { ok: false, error: denied }
  const parsed = z.string().uuid().safeParse(runId)
  if (!parsed.success) return { ok: false, error: "项目 ID 无效" }
  const id = parsed.data
  const runRow = await getOwnedRun(ctx, id)
  if (!runRow) return { ok: false, error: "项目不存在或无权访问" }
  if (!runRow.template) return { ok: false, error: "该项目不是模板项目" }
  if (runRow.status === "running" || runRow.status === "queued") {
    return { ok: false, error: "AI 团队正在处理中，请稍候" }
  }
  if (runRow.stage !== "art" || runRow.phase !== "sample") {
    return {
      ok: false,
      error: "风格小样确认后已作为成套一致性基准，无法整批重新生成（可在卡面弹窗中单张重开）",
    }
  }
  const samples = await db
    .select({ id: agentRunItems.id })
    .from(agentRunItems)
    .where(and(eq(agentRunItems.runId, id), eq(agentRunItems.isSample, true)))
  if (samples.length === 0) return { ok: false, error: "该项目没有风格小样" }

  await db
    .update(agentRunItems)
    .set({
      status: "pending",
      roundsUsed: 0,
      finalRoundId: null,
      fallbackContentWarning: false,
      errorMessage: null,
      manualRegenCount: sql`${agentRunItems.manualRegenCount} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(agentRunItems.runId, id), eq(agentRunItems.isSample, true)))

  // 条件更新守住 SELECT→UPDATE 间隙：状态被并发改变（如 worker 已认领）时不覆盖
  const updated = await db
    .update(agentRuns)
    .set({
      status: "queued",
      finishedAt: null,
      error: null,
      pendingAction: { kind: "produce_cards", phase: "sample", requestedAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, id), notInArray(agentRuns.status, ["running", "queued"])))
    .returning({ id: agentRuns.id })
  if (updated.length === 0) return { ok: false, error: "AI 团队正在处理中，请稍候" }

  await db.insert(agentEvents).values({
    runId: id,
    action: "regen",
    status: "ok",
    detail: `一键重新生成风格小样（重置 ${samples.length} 张）`,
  })
  revalidatePath("/agent")
  return { ok: true, count: samples.length }
}

/** 用户编辑卡面提示词终稿（评审弹窗内）；后续生图/重开沿用编辑后的 currentPrompt */
const updateItemPromptSchema = z.object({
  itemId: z.string().uuid(),
  prompt: z.string().trim().min(10, "提示词太短（至少 10 字）").max(8000),
})

export async function updateItemPromptAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  const denied = denyAgent(ctx)
  if (denied) throw new Error(denied)
  const parsed = updateItemPromptSchema.parse(input)
  const [item] = await db
    .select({ id: agentRunItems.id, runId: agentRunItems.runId, status: agentRunItems.status })
    .from(agentRunItems)
    .where(
      and(
        eq(agentRunItems.id, parsed.itemId),
        eq(agentRunItems.enterpriseId, ctx.user.enterpriseId!),
        eq(agentRunItems.userId, ctx.user.id),
      ),
    )
  if (!item) throw new Error("卡牌不存在")
  // 在途守卫（对齐 regenItemAction）：生成/评审期间改写 currentPrompt 会与
  // worker 内存态 state.prompt 竞态，下一轮或崩溃恢复后口径不一
  if (["drafting", "generating", "reviewing"].includes(item.status)) {
    throw new Error("该卡牌正在生成或评审中，请等待本轮完成后再编辑提示词")
  }
  await db
    .update(agentRunItems)
    .set({ currentPrompt: parsed.prompt, updatedAt: new Date() })
    .where(eq(agentRunItems.id, item.id))
  await db.insert(agentEvents).values({
    runId: item.runId,
    action: "edit",
    status: "ok",
    detail: "提示词终稿已人工编辑，后续生图将使用编辑后的版本",
    itemId: item.id,
  })
  revalidatePath("/agent")
  return { ok: true }
}
