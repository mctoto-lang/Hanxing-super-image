/**
 * Agent 工作流编排引擎（塔罗模板 produce_cards 生产执行；经典全流程已下线）
 *
 * 执行模型：
 * - run 级：worker（agent-processor）原子认领 queued 模板任务 → 经
 *   executeTemplateProduction 按 item 并发池执行；
 * - item 级（单卡流水线）：按主边拓扑序遍历图，并行分支（多评审节点）
 *   同批并发；supervisor 裁决 approve / retry（沿 retry 边回到上游节点，
 *   携带本轮反馈，只传本轮防 prompt 膨胀）/ 耗尽兜底选历史最优；
 * - 留痕：每轮尝试写 agent_round，审核与裁决写 agent_review，全程写
 *   agent_event，节点聚合状态写 agent_node_run（画布状态色数据源）。
 *
 * 计费：
 * - LLM：每次调用按实际 usage × 模型厘价累计，满 100 厘（1 积分）原子扣企业池
 *   写流水（复用 deductCredits，taskId 记 runId 便于对账）；调用与结算实现
 *   抽在 ./agent/llm（与模板化步骤共享）；
 * - 生图：每轮按张预扣（model.costPerImage），失败张退还（与生图队列语义一致）。
 *
 * 韧性：
 * - 取消等状态边界：每个节点组执行前检查 run 状态；
 * - worker 崩溃恢复：agent-processor 扫描 running 且心跳超时的模板运行，
 *   退回 queued + 在途 item 复位后重新执行（全部状态落库驱动，天然幂等续跑）。
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  agentEvents,
  agentReviews,
  agentRunItems,
  agentRounds,
  agentRuns,
  enterprises,
  models as modelsTable,
  permissionGroups,
  users,
  type AgentRunRow,
} from "@/db/schema"
import type {
  ChatContentPart,
  ChatUpstreamMessage,
} from "@/lib/ai/chat/chat-model-config"
import { callImageApi, isContentPolicyError, summarizeImageErrors } from "@/lib/ai"
import { acquireImageSlot, releaseImageSlot } from "@/lib/queue/task-queue"
import { majorityVotePassed } from "@/lib/agent/review"
import { effectiveConcurrentLimit } from "@/lib/auth/permissions"
import { getStorage } from "@/lib/storage"
import { signUploadToken } from "@/lib/storage/upload-token"
import { deductCredits, refundCredits, CreditsInsufficientError } from "@/server/services/credits-service"
import { recordAgentImageTask } from "./agent/image-gen-log"
import {
  callLlmJson,
  LlmValidationError,
  loadChatModel,
  runLabel,
  type ChatModelRow,
} from "./agent/llm"
import type {
  AgentGraph,
  AgentGraphNode,
  AgentNodeConfigByType,
  AgentPromptSource,
  RetryFeedback,
  ReviewResultPayload,
  RoundCandidate,
  VerdictPayload,
} from "@/lib/agent/graph"
import { mainEdges, nodesById, validateAgentGraph } from "@/lib/agent/validate"
import { DEFAULT_REVIEWER_PROMPT, PIPELINE_NODE_IDS } from "@/lib/agent/pipelines"
import { suitCountRuleByIndex } from "@/lib/agent/templates"
import { splitFinalPromptSegments } from "@/lib/agent/cards/plan"

type ImageModelRow = typeof modelsTable.$inferSelect

/** item 终态（不再被 worker 拾取） */
const TERMINAL_ITEM_STATUSES = ["approved_by_ai", "fallback", "confirmed", "failed", "cancelled"] as const
/** item 过渡态（worker 崩溃恢复时复位回 pending） */
const TRANSIENT_ITEM_STATUSES = ["drafting", "generating", "reviewing"] as const

/** 暂停信号：item 当前节点收尾后中断，状态复位 pending（不算失败） */
class PauseSignal extends Error {
  constructor() {
    super("运行已暂停")
    this.name = "PauseSignal"
  }
}

/** 取消信号：item 随运行取消 */
class CancelSignal extends Error {
  constructor() {
    super("运行已取消")
    this.name = "CancelSignal"
  }
}

// ═══════════════════════════ 运行环境 ═══════════════════════════

/** 单次 run 执行期内不变的上下文（模型行 / 并发参数按需懒加载缓存） */
interface RunEnv {
  run: AgentRunRow
  graph: AgentGraph
  byId: Map<string, AgentGraphNode>
  enterpriseMaxConcurrent: number
  groupId: string | null
  groupMaxConcurrent: number
  /** 权限组生图模型白名单（jsonb；null = 无组或未配置 = 放行全部） */
  groupAllowedModels: string[] | null
  chatModelCache: Map<string, ChatModelRow>
  imageModelCache: Map<string, ImageModelRow>
}

async function buildRunEnv(run: AgentRunRow): Promise<RunEnv> {
  const graph = run.graphSnapshot
  const [entRow] = await db
    .select({ maxConcurrent: enterprises.maxConcurrent })
    .from(enterprises)
    .where(eq(enterprises.id, run.enterpriseId))
  const [groupRow] = await db
    .select({
      groupId: permissionGroups.id,
      maxConcurrent: permissionGroups.maxConcurrent,
      allowedModels: permissionGroups.allowedModels,
    })
    .from(users)
    .innerJoin(permissionGroups, eq(users.groupId, permissionGroups.id))
    .where(eq(users.id, run.userId))
  return {
    run,
    graph,
    byId: nodesById(graph),
    enterpriseMaxConcurrent: entRow?.maxConcurrent ?? 5,
    groupId: groupRow?.groupId ?? null,
    groupMaxConcurrent: groupRow?.maxConcurrent ?? 0,
    groupAllowedModels: Array.isArray(groupRow?.allowedModels)
      ? (groupRow.allowedModels as string[])
      : null,
    chatModelCache: new Map(),
    imageModelCache: new Map(),
  }
}

/** 加载生图模型 */
async function loadImageModel(env: RunEnv, modelId: string | null): Promise<ImageModelRow> {
  if (!modelId) throw new Error("节点未配置生图模型")
  const cached = env.imageModelCache.get(modelId)
  if (cached) return cached
  const [row] = await db
    .select()
    .from(modelsTable)
    .where(eq(modelsTable.id, modelId))
  if (!row || !row.isActive) throw new Error("生图模型不存在或已停用")
  if (row.enterpriseId !== null && row.enterpriseId !== env.run.enterpriseId) {
    throw new Error("生图模型不在本企业可用范围内")
  }
  // 权限组白名单兜底：发起时已校验，防启动后权限变更导致越权（空 = 放行）
  if (
    env.groupAllowedModels &&
    env.groupAllowedModels.length > 0 &&
    !env.groupAllowedModels.includes(modelId)
  ) {
    throw new Error("当前权限组无权使用该生图模型")
  }
  env.imageModelCache.set(modelId, row)
  return row
}

// ═══════════════════════════ 事件 / 节点状态 / 心跳 ═══════════════════════════

async function logEvent(input: {
  runId: string
  nodeKey?: string | null
  nodeType?: AgentGraphNode["type"] | null
  action: string
  status: "ok" | "warn" | "error"
  detail?: string
  itemId?: string | null
  roundId?: string | null
}): Promise<void> {
  await db.insert(agentEvents).values({
    runId: input.runId,
    nodeKey: input.nodeKey ?? null,
    nodeType: input.nodeType ?? null,
    action: input.action,
    status: input.status,
    detail: input.detail ?? null,
    itemId: input.itemId ?? null,
    roundId: input.roundId ?? null,
  })
}

async function heartbeat(runId: string): Promise<void> {
  await db.update(agentRuns).set({ updatedAt: new Date() }).where(eq(agentRuns.id, runId))
}

// ═══════════════════════════ 生图（槽位 + 预扣/退还） ═══════════════════════════

/**
 * 单轮生图：预扣（张数 × 单价）→ callImageApi（企业/模型/权限组槽位限流）。
 *
 * 遵循模型配置的容错参数（与生图队列语义对齐）：
 * - apiTimeout：单次上游请求超时（适配器内部生效）；
 * - taskTimeout：本轮总预算，到时中止剩余尝试；
 * - maxRetries：失败重试次数，间隔 3s×次数退避（≤30s）；部分成功只补失败张
 *   （callImageApi 的 indexes 语义），重试过程写事件日志；
 * - 最终未成功的张数退还预扣费用。
 */
async function generateRoundImages(
  env: RunEnv,
  model: ImageModelRow,
  prompt: string,
  imageSize: string,
  count: number,
  taskContext?: { itemLabel?: string | null },
): Promise<{ urls: string[]; costCredits: number }> {
  const startedAt = Date.now()
  // 预扣（对齐生图队列「预扣 + 失败退还」语义）
  const prepay = model.costPerImage * count
  await deductCredits({
    enterpriseId: env.run.enterpriseId,
    userId: env.run.userId,
    amount: prepay,
    taskId: env.run.id,
    remark: `AI Agent 生图 · ${model.displayName} · ${runLabel(env.run)}（${count} 张预扣）`,
  })
  await db
    .update(agentRuns)
    .set({ imageCostCredits: sql`${agentRuns.imageCostCredits} + ${prepay}` })
    .where(eq(agentRuns.id, env.run.id))

  const slotTtlSec = Math.max(30, model.taskTimeout || 600) + 300
  let slotWaitStart = 0
  let slotWaitLogged = 0
  const slots = {
    acquireSlot: async () => {
      const ok = await acquireImageSlot({
        enterpriseId: env.run.enterpriseId,
        modelId: model.id,
        groupId: env.groupId,
        enterpriseMaxConcurrent: env.enterpriseMaxConcurrent,
        modelMaxConcurrent: model.maxConcurrent,
        groupMaxConcurrent: env.groupMaxConcurrent,
        ttlSec: slotTtlSec,
      })
      if (!ok) {
        const now = Date.now()
        if (!slotWaitStart) {
          slotWaitStart = now
          slotWaitLogged = now
          await logEvent({
            runId: env.run.id,
            action: "start",
            status: "warn",
            detail: `生图等待全局并发槽位（与生图队列共享：企业上限 ${env.enterpriseMaxConcurrent}，模型上限 ${model.maxConcurrent}，权限组上限 ${env.groupMaxConcurrent || "不限"}）`,
          })
        } else if (now - slotWaitLogged > 30_000) {
          slotWaitLogged = now
          await logEvent({
            runId: env.run.id,
            action: "start",
            status: "warn",
            detail: `仍在等待并发槽位（已等待 ${Math.round((now - slotWaitStart) / 1000)}s）`,
          })
        }
      } else {
        if (slotWaitStart && Date.now() - slotWaitStart > 3000) {
          await logEvent({
            runId: env.run.id,
            action: "done",
            status: "ok",
            detail: `获得并发槽位（等待了 ${Math.round((Date.now() - slotWaitStart) / 1000)}s）`,
          })
        }
        slotWaitStart = 0
      }
      return ok
    },
    releaseSlot: () =>
      releaseImageSlot({
        enterpriseId: env.run.enterpriseId,
        modelId: model.id,
        groupId: env.groupId,
        modelMaxConcurrent: model.maxConcurrent,
        groupMaxConcurrent: env.groupMaxConcurrent,
      }),
  }

  // 本轮总预算（taskTimeout 秒），到时中止剩余请求与重试
  const maxRetries = Math.max(0, model.maxRetries ?? 0)
  const taskTimeoutMs = Math.max(30, model.taskTimeout || 300) * 1000
  const budget = new AbortController()
  const budgetTimer = setTimeout(() => budget.abort(), taskTimeoutMs)
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      budget.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t)
          reject(new Error(`生图超过任务超时预算（${model.taskTimeout || 300}s）`))
        },
        { once: true },
      )
    })

  const okUrls: string[] = []
  let pending = Array.from({ length: count }, (_, i) => i)
  // 最后一次上游失败原因：最终 throw 时完整带给 item.errorMessage / run.error
  let lastFailReason = "未知原因"

  try {
    const storage = await getStorage()
    const endpointHost = (() => {
      try {
        return new URL(model.apiEndpoint).hostname
      } catch {
        return null
      }
    })()

    for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(30_000, 3000 * attempt)
        await sleep(backoffMs)
        await logEvent({
          runId: env.run.id,
          nodeKey: PIPELINE_NODE_IDS.imagegen,
          nodeType: "image_gen",
          action: "retry",
          status: "warn",
          detail: `生图第 ${attempt}/${maxRetries} 次重试（剩余 ${pending.length} 张，间隔 ${Math.round(backoffMs / 1000)}s）`,
        })
      }
      try {
        const results = await callImageApi({
          model,
          prompt,
          imageSize,
          imageCount: pending.length,
          indexes: pending,
          referenceImages: env.run.input.referenceImages?.length
            ? env.run.input.referenceImages.map((u) => signUploadToken(u))
            : null,
          signal: budget.signal,
          downloadAndUpload: async (url) => {
            return storage.saveFromUrl(
              url,
              env.run.enterpriseId,
              "generate",
              endpointHost ? [endpointHost] : undefined,
            )
          },
          slots,
        })
        const succeeded = results.filter((r) => r.url)
        for (const r of succeeded) {
          okUrls.push(r.url!)
        }
        // 单张失败不抛异常（部分成功语义）：从结果里取上游原始错误，
        // 否则重试耗尽后只剩「未知原因」，无法定位上游问题
        const failedNow = summarizeImageErrors(results)
        if (failedNow) lastFailReason = failedNow
        pending = pending.filter((i) => !succeeded.some((r) => r.index === i))
      } catch (err) {
        if (budget.signal.aborted) {
          await logEvent({
            runId: env.run.id,
            nodeKey: PIPELINE_NODE_IDS.imagegen,
            nodeType: "image_gen",
            action: "fail",
            status: "warn",
            detail: `生图超过任务超时预算（${model.taskTimeout || 300}s），停止重试（成功 ${okUrls.length}/${count}）`,
          })
          break
        }
        const reason = err instanceof Error ? err.message : String(err)
        lastFailReason = reason
        if (attempt >= maxRetries) {
          await logEvent({
            runId: env.run.id,
            nodeKey: PIPELINE_NODE_IDS.imagegen,
            nodeType: "image_gen",
            action: "fail",
            status: "warn",
            // 完整保留上游错误（状态码/响应体），便于定位错误来源
            detail: `生图失败（重试 ${maxRetries} 次后放弃）：${reason}`,
          })
        }
      }
    }
  } finally {
    clearTimeout(budgetTimer)
  }

  // 未成功的张数退还
  const failed = count - okUrls.length
  if (failed > 0) {
    const refund = model.costPerImage * failed
    await refundCredits({
      enterpriseId: env.run.enterpriseId,
      userId: env.run.userId,
      amount: refund,
      taskId: env.run.id,
      remark: `AI Agent 生图失败退还 · ${model.displayName}（${failed} 张）`,
    })
    await db
      .update(agentRuns)
      .set({ imageCostCredits: sql`${agentRuns.imageCostCredits} - ${refund}` })
      .where(eq(agentRuns.id, env.run.id))
  }
  if (okUrls.length > 0) {
    await db
      .update(agentRuns)
      .set({ imageCount: sql`${agentRuns.imageCount} + ${okUrls.length}` })
      .where(eq(agentRuns.id, env.run.id))
  } else {
    // 补录失败生图任务（资产管理/操作日志可见；费用已退还按 0 计）
    await recordAgentImageTask({
      run: env.run,
      model,
      prompt,
      imageSize,
      kindLabel: "卡面",
      itemLabel: taskContext?.itemLabel ?? null,
      imageCount: count,
      resultImages: [],
      errorMessage: `生图失败（已重试 ${maxRetries} 次）：${lastFailReason}`,
      creditsCharged: 0,
      durationMs: Date.now() - startedAt,
    })
    throw new Error(`生图失败（已重试 ${maxRetries} 次，费用已退还）：${lastFailReason}`)
  }
  // 补录成功生图任务（资产管理画廊 + 操作日志生图 Tab 可见）
  await recordAgentImageTask({
    run: env.run,
    model,
    prompt,
    imageSize,
    kindLabel: "卡面",
    itemLabel: taskContext?.itemLabel ?? null,
    imageCount: count,
    resultImages: okUrls,
    creditsCharged: model.costPerImage * okUrls.length,
    durationMs: Date.now() - startedAt,
  })
  return { urls: okUrls, costCredits: model.costPerImage * okUrls.length }
}

// ═══════════════════════════ 兜底选优（ai-card-studio fallback_select） ═══════════════════════════

interface RoundWithReviews {
  roundId: string
  roundNumber: number
  imageUrl: string
  contentPass: boolean | null
  aestheticScore: number | null
}

/** 拉取某 item 全部有图轮次及审核结论 */
async function loadItemRoundsWithReviews(itemId: string): Promise<RoundWithReviews[]> {
  const rounds = await db
    .select()
    .from(agentRounds)
    .where(and(eq(agentRounds.itemId, itemId), sql`${agentRounds.imageUrl} IS NOT NULL`))
    .orderBy(asc(agentRounds.roundNumber))
  if (rounds.length === 0) return []
  const reviews = await db
    .select()
    .from(agentReviews)
    .where(
      and(
        inArray(
          agentReviews.roundId,
          rounds.map((r) => r.id),
        ),
        eq(agentReviews.kind, "review"),
      ),
    )
  return rounds.map((r) => {
    const rs = reviews.filter((v) => v.roundId === r.id)
    const content = rs.find((v) => (v.result as ReviewResultPayload).dimension === "content")
    const aesthetic = rs.find((v) => (v.result as ReviewResultPayload).dimension === "aesthetic")
    return {
      roundId: r.id,
      roundNumber: r.roundNumber,
      imageUrl: r.imageUrl!,
      contentPass: content ? (content.result as ReviewResultPayload).pass ?? null : null,
      aestheticScore: aesthetic ? (aesthetic.result as ReviewResultPayload).score ?? null : null,
    }
  })
}

/**
 * 历史最优：内容通过的轮次里审美最高；全部内容不过才退选审美最高；
 * 全部无评分取最后一轮（fallbackContentWarning 由调用方按 contentPass 判断）
 */
function pickBestRound(rounds: RoundWithReviews[]): RoundWithReviews | null {
  if (rounds.length === 0) return null
  const withAesthetic = [...rounds].sort((a, b) => (b.aestheticScore ?? -1) - (a.aestheticScore ?? -1))
  const contentPassed = withAesthetic.filter((r) => r.contentPass === true)
  if (contentPassed.length > 0) return contentPassed[0]!
  const scored = withAesthetic.filter((r) => r.aestheticScore !== null)
  if (scored.length > 0) return scored[0]!
  return rounds[rounds.length - 1]!
}

// ═══════════════════════════ 单卡流水线（图遍历） ═══════════════════════════

/** item 遍历期间的内存态（重启后从 DB 行重建） */
interface ItemState {
  name: string | null
  meaning: string | null
  prompt: string | null
  promptSource: AgentPromptSource
  roundsUsed: number
  currentRoundId: string | null
  candidates: string[]
  imageUrl: string | null
  /** 本轮审核结论（总控裁决输入；retry 时转成反馈带给上游）——多评审聚合后的值 */
  contentPass: boolean | null
  contentReason: string | null
  aestheticScore: number | null
  aestheticReason: string | null
  aestheticOk: boolean | null
  consistencyScore: number | null
  consistencyReason: string | null
  consistencyOk: boolean | null
  /** 多评审累计（每个评审节点贡献一次；legacy 字段由 refreshAggregated 刷新） */
  reviewAgg: {
    content: { sum: number; passVotes: number; total: number; reasons: string[] }
    aesthetic: { sum: number; passVotes: number; total: number; reasons: string[] }
    consistency: { sum: number; passVotes: number; total: number; reasons: string[] }
  }
}

/**
 * 多评审聚合刷新：分数取算术平均，通过判定取多数票（单评审一票否决，
 * 与 lib/agent/review.ts 的 aggregateReviewerScores 同语义；多数票规则
 * 统一引自 majorityVotePassed，避免各处复刻口径漂移）。
 */
function refreshAggregatedReviewState(state: ItemState): void {
  const agg = state.reviewAgg
  if (agg.content.total > 0) {
    state.contentPass = majorityVotePassed(agg.content.passVotes, agg.content.total)
    state.contentReason = agg.content.reasons.length > 0 ? agg.content.reasons.join("；") : null
  }
  for (const [key, scoreKey, okKey] of [
    ["aesthetic", "aestheticScore", "aestheticOk"],
    ["consistency", "consistencyScore", "consistencyOk"],
  ] as const) {
    const entry = agg[key]
    if (entry.total > 0) {
      state[scoreKey] = Math.round(entry.sum / entry.total)
      state[okKey] = majorityVotePassed(entry.passVotes, entry.total)
      state[key === "aesthetic" ? "aestheticReason" : "consistencyReason"] =
        entry.reasons.length > 0 ? entry.reasons.join("；") : null
    }
  }
}

type WalkOutcome =
  | { kind: "done" } // 到达结束节点
  | { kind: "waiting_human" }
  | { kind: "retry"; targetId: string; feedback: RetryFeedback }

/** 运行活跃状态 + 当前阶段（两阶段：sample 先行） */
async function assertRunActive(runId: string): Promise<{
  status: "running" | "paused" | "cancelled" | "other"
  phase: "sample" | "full" | null
}> {
  const [row] = await db
    .select({ status: agentRuns.status, phase: agentRuns.phase })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
  if (!row) return { status: "other", phase: null }
  if (row.status === "running") return { status: "running", phase: row.phase }
  if (row.status === "paused") return { status: "paused", phase: row.phase }
  if (row.status === "cancelled") return { status: "cancelled", phase: row.phase }
  return { status: "other", phase: row.phase }
}

/**
 * 执行单卡流水线：外层打回循环 + 内层拓扑遍历。
 * startAtId 用于 retry 重启（跳过该节点之前的节点）。
 */
async function walkItem(
  env: RunEnv,
  item: typeof agentRunItems.$inferSelect,
  state: ItemState,
  startAtId: string,
): Promise<WalkOutcome> {
  const graph = env.graph
  const edges = mainEdges(graph)
  const indeg = new Map<string, number>()
  const outMain = new Map<string, string[]>()
  for (const n of graph.nodes) {
    indeg.set(n.id, 0)
    outMain.set(n.id, [])
  }
  for (const e of edges) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
    outMain.get(e.source)?.push(e.target)
  }

  // 从 startAtId 开始：其拓扑上游视为已完成（不入队）
  let frontier: string[] = [startAtId]
  const executed = new Set<string>()
  // 预置 startAt 的所有主入边来源为已执行（等待中的汇合节点不再等它们）
  for (const e of edges) {
    if (e.target === startAtId) executed.add(e.source)
  }

  while (frontier.length > 0) {
    // 每个节点组执行前检查运行状态（暂停/取消即时中断）
    const alive = await assertRunActive(env.run.id)
    if (alive.status === "paused") throw new PauseSignal()
    if (alive.status === "cancelled") throw new CancelSignal()
    await heartbeat(env.run.id)

    // 同层节点并发执行（三审并行）；串行链自然退化为单节点组
    const outcomes = await Promise.all(
      frontier.map((nodeId) => executeNode(env, item, state, env.byId.get(nodeId)!)),
    )

    for (const nodeId of frontier) executed.add(nodeId)

    // supervisor retry：立即中断本层，交由外层循环重启
    const retry = outcomes.find((o) => o?.kind === "retry") as
      | { kind: "retry"; targetId: string; feedback: RetryFeedback }
      | undefined
    if (retry) return retry
    const humanHit = outcomes.find((o) => o?.kind === "waiting_human")
    if (humanHit) return { kind: "waiting_human" }
    const stopped = outcomes.find((o) => o?.kind === "stopped")
    if (stopped) return { kind: "done" }

    // 收集下一层：主入边全部已执行且未执行过的节点
    const next = new Set<string>()
    for (const nodeId of frontier) {
      for (const t of outMain.get(nodeId) ?? []) {
        if (executed.has(t)) continue
        const ready = (edges.filter((e) => e.target === t)).every((e) => executed.has(e.source))
        if (ready) next.add(t)
      }
    }
    frontier = [...next]
  }
  return { kind: "done" }
}

/** 节点执行结果（影响遍历控制的特殊返回） */
type NodeOutcome =
  | { kind: "passed" }
  | { kind: "retry"; targetId: string; feedback: RetryFeedback }
  | { kind: "waiting_human" }
  | { kind: "stopped" } // item 已达终态（失败/兜底标失败），停止遍历

async function executeNode(
  env: RunEnv,
  item: typeof agentRunItems.$inferSelect,
  state: ItemState,
  node: AgentGraphNode,
): Promise<NodeOutcome> {
  const runId = env.run.id
  const title = node.config.title
  try {
    switch (node.type) {
      case "start":
        return { kind: "passed" }

      case "agent":
        await executeAgentNode(env, item, state, node)
        return { kind: "passed" }

      case "image_gen":
        return await executeImageGenNode(env, item, state, node)

      case "review":
        await executeReviewNode(env, item, state, node)
        return { kind: "passed" }

      case "supervisor":
        return await executeSupervisorNode(env, item, state, node)

      case "human": {
        // 置等待人工确认；提议轮 = 当前轮
        await db
          .update(agentRunItems)
          .set({
            status: "waiting_human",
            finalRoundId: state.currentRoundId,
            updatedAt: new Date(),
          })
          .where(eq(agentRunItems.id, item.id))
        await logEvent({
          runId,
          nodeKey: node.id,
          nodeType: "human",
          action: "start",
          status: "ok",
          detail: `「${state.name ?? `第 ${item.index + 1} 张`}」等待人工确认`,
          itemId: item.id,
          roundId: state.currentRoundId,
        })
        return { kind: "waiting_human" }
      }

      case "end":
        return { kind: "passed" }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logEvent({
      runId,
      nodeKey: node.id,
      nodeType: node.type,
      action: "fail",
      status: "error",
      detail: `节点「${title}」失败：${message}`,
      itemId: item.id,
    })
    throw err
  }
}

/** 文案/智能体节点（item 级）：起草（无反馈且有需求）或按本轮反馈改写（只传本轮反馈）。
 *  run 级角色（style/structure）在 executeAgentRun 初始化阶段执行，item 遍历时跳过。 */
async function executeAgentNode(
  env: RunEnv,
  item: typeof agentRunItems.$inferSelect,
  state: ItemState,
  node: AgentGraphNode,
): Promise<void> {
  const config = node.config as AgentNodeConfigByType["agent"]
  if (config.role === "style" || config.role === "structure") return
  const model = await loadChatModel(env, config.chatModelId)

  // 重启幂等：已有 prompt 且本轮无反馈 → 跳过起草（反馈任一维度不通过即进入改写）。
  // 用户在 final 阶段确认过的终稿即 item.currentPrompt（state.prompt 初始值），
  // 首轮生产由此直接进入生图，不会重写确认稿；起草分支仅在手动重开等
  // prompt 为空的场景触发，输出口径与终稿两段结构保持一致。
  const hasFeedback =
    state.contentPass === false ||
    state.aestheticOk === false ||
    state.consistencyOk === false
  if (state.prompt && !hasFeedback) return

  await db
    .update(agentRunItems)
    .set({ status: "drafting", updatedAt: new Date() })
    .where(eq(agentRunItems.id, item.id))
  await logEvent({
    runId: env.run.id,
    nodeKey: node.id,
    nodeType: "agent",
    action: "start",
    status: "ok",
    detail: hasFeedback ? `改写提示词（第 ${state.roundsUsed + 1} 轮打回）` : "起草牌名/牌义/提示词",
    itemId: item.id,
  })

  const candidateCount = Math.max(1, config.candidateCount || 1)
  const formatSpec = hasFeedback
    ? `只输出 JSON：{"prompt": "重新细化后的完整终稿（[1] 画面风格 + [2] 画面内容 两段结构）"}`
    : candidateCount > 1
      ? `输出 ${candidateCount} 个候选，只输出 JSON：{"variants": [{"name": "牌名", "meaning": "一句话牌义", "prompt": "完整终稿（[1] 画面风格 + [2] 画面内容 两段结构）"}, ...]}`
      : `只输出 JSON：{"name": "牌名(≤20字，可选)", "meaning": "一句话牌义(可选)", "prompt": "完整终稿（[1] 画面风格 + [2] 画面内容 两段结构，画面内容 150-250 字）"}`

  const systemPrompt = `${config.rolePrompt}\n\n【输出格式】${formatSpec}\n不要输出 JSON 以外的任何内容（包括代码块标记、解释、前后缀）。`

  const basePayload: Record<string, unknown> = {
    task: hasFeedback ? "revise" : "draft",
    userPrompt: env.run.input.prompt,
    styleDoc: (env.run.styleDoc ?? "").slice(0, 2000),
    card: {
    index: item.index + 1,
    total: env.run.input.cardCount,
    name: state.name,
    meaning: state.meaning,
    // 花色数量硬规则（Ace 至十 = 恰好 N 个花色物品；宫廷牌/大阿卡纳无要求）
    suitRule: suitCountRuleByIndex(item.index),
  },
    referenceImageCount: env.run.input.referenceImages?.length ?? 0,
  }
  if (hasFeedback) {
    // 打回重细化契约（见 ROLE_PROMPTS.finalRefiner）：以初稿为基准重新细化。
    // 必须携带初稿 visualBrief——只有旧终稿时模型无法「回到初稿重写」，
    // 旧终稿仅作上下文参考（评审意见指向其问题表述）
    if (item.visualBrief) basePayload.draft = item.visualBrief
    basePayload.originalPrompt = state.prompt
    basePayload.feedback = {
      contentPass: state.contentPass,
      contentReason: state.contentReason,
      aestheticScore: state.aestheticScore,
      aestheticReason: state.aestheticReason,
      consistencyScore: state.consistencyScore,
      consistencyReason: state.consistencyReason,
    }
  }

  const messages: ChatUpstreamMessage[] = [
    { role: "user", content: JSON.stringify(basePayload, null, 2) },
  ]
  const parsed = await callLlmJson<Record<string, unknown>>(env, model, {
    systemPrompt,
    messages,
    thinkingLevel: config.thinkingLevel || "medium",
    validate: (p) => {
      if (hasFeedback) {
        if (!strField(p.prompt)) throw new LlmValidationError("缺少 prompt 字段（改写需输出完整提示词）")
      } else if (candidateCount > 1) {
        const variants = p.variants
        if (!Array.isArray(variants) || variants.length === 0 || !strField((variants[0] as Record<string, unknown>)?.prompt)) {
          throw new LlmValidationError("缺少 variants[0].prompt 字段")
        }
      } else if (!strField(p.prompt)) {
        throw new LlmValidationError("缺少 prompt 字段（需包含 name/meaning/prompt）")
      }
    },
  })

  if (hasFeedback) {
    const prompt = strField(parsed.prompt)!
    state.prompt = prompt
    state.promptSource = "auto_revise"
    // 反馈已消费：清除审核结论与评审累计，防崩溃重启后误判为再次改写
    state.contentPass = null
    state.contentReason = null
    state.aestheticScore = null
    state.aestheticReason = null
    state.aestheticOk = null
    state.consistencyScore = null
    state.consistencyReason = null
    state.consistencyOk = null
    state.reviewAgg = {
      content: { sum: 0, passVotes: 0, total: 0, reasons: [] },
      aesthetic: { sum: 0, passVotes: 0, total: 0, reasons: [] },
      consistency: { sum: 0, passVotes: 0, total: 0, reasons: [] },
    }
  } else if (candidateCount > 1 && Array.isArray(parsed.variants) && parsed.variants.length > 0) {
    const variants = parsed.variants as Record<string, unknown>[]
    const first = variants[0]!
    state.name = strField(first.name) ?? state.name
    state.meaning = strField(first.meaning) ?? state.meaning
    state.prompt = strField(first.prompt) ?? state.prompt
    state.promptSource = "initial"
    await logEvent({
      runId: env.run.id,
      nodeKey: node.id,
      nodeType: "agent",
      action: "done",
      status: "ok",
      detail: `产出 ${variants.length} 个候选文案，采用第 1 版「${state.name ?? ""}」`,
      itemId: item.id,
    })
  } else {
    const name = strField(parsed.name)
    const meaning = strField(parsed.meaning)
    const prompt = strField(parsed.prompt) ?? ""
    state.name = name ?? state.name
    state.meaning = meaning ?? state.meaning
    state.prompt = prompt
    state.promptSource = "initial"
  }

  await db
    .update(agentRunItems)
    .set({
      name: state.name,
      meaning: state.meaning,
      currentPrompt: state.prompt,
      promptSource: state.promptSource,
      updatedAt: new Date(),
    })
    .where(eq(agentRunItems.id, item.id))
  await logEvent({
    runId: env.run.id,
    nodeKey: node.id,
    nodeType: "agent",
    action: "done",
    status: "ok",
    detail: hasFeedback
      ? `改写完成（第 ${state.roundsUsed} 轮打回后，提示词已按本轮反馈调整）`
      : `起草完成：「${state.name ?? `第 ${item.index + 1} 张`}」`,
    itemId: item.id,
  })
}

function strField(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/** 生图节点：落一轮 round → 生成候选 → 预扣/退还（内容拒绝时返回 retry 打回改写） */
async function executeImageGenNode(
  env: RunEnv,
  item: typeof agentRunItems.$inferSelect,
  state: ItemState,
  node: AgentGraphNode,
): Promise<NodeOutcome> {
  const config = node.config as AgentNodeConfigByType["image_gen"]
  if (!state.prompt) throw new Error("缺少提示词（上游智能体节点未产出）")
  const model = await loadImageModel(env, config.imageModelId)
  const candidateCount = Math.max(1, config.candidateCount || 1)

  await db
    .update(agentRunItems)
    .set({ status: "generating", updatedAt: new Date() })
    .where(eq(agentRunItems.id, item.id))

  // 轮次号取「该 item 历史最大轮次 + 1」（手动重开会重置 roundsUsed，
  // 不能用它推导，否则与既有 round 行冲突）
  const [maxRound] = await db
    .select({ maxNum: sql<number>`COALESCE(MAX(${agentRounds.roundNumber}), 0)` })
    .from(agentRounds)
    .where(eq(agentRounds.itemId, item.id))
  const roundNumber = (maxRound?.maxNum ?? 0) + 1
  const [round] = await db
    .insert(agentRounds)
    .values({
      runId: env.run.id,
      itemId: item.id,
      roundNumber,
      prompt: state.prompt,
      promptSource: state.promptSource ?? "initial",
    })
    .returning()
  await logEvent({
    runId: env.run.id,
    nodeKey: node.id,
    nodeType: "image_gen",
    action: "start",
    status: "ok",
    detail: `第 ${roundNumber} 轮生图（${candidateCount} 张候选）`,
    itemId: item.id,
    roundId: round!.id,
  })

  let urls: string[]
  let costCredits: number
  try {
    ;({ urls, costCredits } = await generateRoundImages(
      env,
      model,
      state.prompt,
      config.imageSize || "1024x1024",
      candidateCount,
      { itemLabel: item.name },
    ))
  } catch (err) {
    // 内容安全拒绝（画面描述血腥/色情/暴力等被上游拦截）：报错原文交给终稿
    // 细化师改写规避，走与评审打回同一条 retry 通道；过载/超时等纯调用
    // 失败不改写（同样提示词重试即可），维持原样抛出走 failed 人工重试。
    const message = err instanceof Error ? err.message : String(err)
    const supervisorNode = env.graph.nodes.find((n) => n.type === "supervisor")
    const maxRetries =
      (supervisorNode?.config as { maxRetries?: number } | undefined)?.maxRetries ?? 2
    if (isContentPolicyError(message) && state.roundsUsed < maxRetries) {
      await logEvent({
        runId: env.run.id,
        nodeKey: node.id,
        nodeType: "image_gen",
        action: "retry",
        status: "warn",
        detail: `第 ${roundNumber} 轮生图被上游内容安全策略拒绝（${state.roundsUsed + 1}/${maxRetries}），打回改写规避敏感内容`,
        itemId: item.id,
        roundId: round!.id,
      })
      return {
        kind: "retry",
        targetId: PIPELINE_NODE_IDS.copywriter,
        feedback: {
          contentPass: false,
          contentReason: `生图被上游内容安全策略拒绝，原始报错：${message}。请检查画面描述中是否包含血腥、色情、暴力等敏感内容，改用安全、可过审的意象与表述重写画面，保持牌义与主体不变。`,
          aestheticScore: null,
          aestheticReason: null,
          consistencyScore: null,
          consistencyReason: null,
        },
      }
    }
    throw err
  }
  if (urls.length === 0) throw new Error("生图全部失败（费用已退还）")

  const candidates: RoundCandidate[] = urls.map((url) => ({
    url,
    score: null,
    contentPass: null,
  }))
  await db
    .update(agentRounds)
    .set({ imageUrl: urls[0]!, candidates, costCredits })
    .where(eq(agentRounds.id, round!.id))
  state.currentRoundId = round!.id
  state.candidates = urls
  state.imageUrl = urls[0]!
  await logEvent({
    runId: env.run.id,
    nodeKey: node.id,
    nodeType: "image_gen",
    action: "done",
    status: "ok",
    detail: `第 ${roundNumber} 轮生图完成（成功 ${urls.length}/${candidateCount}）`,
    itemId: item.id,
    roundId: round!.id,
  })
  return { kind: "passed" }
}

/**
 * 一致性审核基准图：用户风格参考图（≤2）+ 已确认小样终图（≤2），上限 4 张。
 * 小样终图在 full 阶段即「风格锚点」；sample 阶段无小样终图时仅用参考图。
 */
async function loadBenchmarkImages(
  runId: string,
  referenceImages: string[],
): Promise<string[]> {
  const refs = referenceImages.slice(0, 2).map((u) => signUploadToken(u))
  const sampleFinals = await db
    .select({ imageUrl: agentRounds.imageUrl })
    .from(agentRunItems)
    .innerJoin(agentRounds, eq(agentRunItems.finalRoundId, agentRounds.id))
    .where(and(eq(agentRunItems.runId, runId), eq(agentRunItems.isSample, true)))
    .limit(2)
  const finals = sampleFinals
    .map((r) => r.imageUrl)
    .filter((u): u is string => !!u)
    .map((u) => signUploadToken(u))
  return [...refs, ...finals].slice(0, 4)
}

/**
 * 审核节点：对候选逐张 vision 评审（维度按配置）→ 选最优候选进入下游。
 * 审核必须给出理由（打回时文案改写的唯一依据——ai-card-studio 契约）。
 */
async function executeReviewNode(
  env: RunEnv,
  item: typeof agentRunItems.$inferSelect,
  state: ItemState,
  node: AgentGraphNode,
): Promise<void> {
  const config = node.config as AgentNodeConfigByType["review"]
  const model = await loadChatModel(env, config.chatModelId)
  if (!state.candidates.length || !state.currentRoundId) {
    throw new Error("缺少待审核图片")
  }
  await db
    .update(agentRunItems)
    .set({ status: "reviewing", updatedAt: new Date() })
    .where(eq(agentRunItems.id, item.id))
  await logEvent({
    runId: env.run.id,
    nodeKey: node.id,
    nodeType: "review",
    action: "start",
    status: "ok",
    detail: `审核 ${state.candidates.length} 张候选（${config.dimensions.join(" + ")}）`,
    itemId: item.id,
    roundId: state.currentRoundId,
  })

  const dims = config.dimensions.length > 0 ? config.dimensions : ["content"]
  // 各维阈值：内容/一致性可单独配置，缺省回退审美阈值
  const contentThreshold = config.contentThreshold ?? config.aestheticThreshold ?? 75
  const consistencyThreshold = config.consistencyThreshold ?? config.aestheticThreshold ?? 75
  const aestheticThreshold = config.aestheticThreshold ?? 75
  const outputSpec = dims
    .map((d) =>
      d === "content"
        ? `"contentScore": 0-100 整数（图文对齐度）, "contentReason": "具体依据"`
        : d === "aesthetic"
          ? `"aestheticScore": 0-100 整数, "aestheticReason": "具体依据"`
          : `"consistencyScore": 0-100 整数, "consistencyReason": "具体差异"`,
    )
    .join(", ")

  const defaultPrompt =
    dims.includes("content") && dims.includes("aesthetic") && dims.includes("consistency")
      ? // 三维同审（模板评审团）：与超管表单预览/内置默认同源（含花色数量逐一清点、无边框废卡规则）
        DEFAULT_REVIEWER_PROMPT
      : dims.includes("content") && dims.includes("aesthetic")
        ? "你是严格的卡牌图审核员。同时进行两项评审：1) 内容对齐：图片是否准确呈现提示词与牌名/牌义；2) 审美质量：构图、色彩、细节、风格一致性。"
        : dims.includes("content")
          ? "你是严格的内容审核员。对图片与提示词、牌名/牌义的吻合度打分（0-100），不得放过明显偏离的图。"
          : dims.includes("consistency")
            ? "你是成套一致性审核员。将待审图与给出的基准图/风格规范书比对，评估整套卡牌的风格统一性。"
            : "你是专业的审美评审。对图片的构图、色彩、细节与风格一致性打分（0-100，70 分为及格线附近，宁严勿宽）。"
  const systemPrompt = `${config.reviewPromptOverride?.trim() || defaultPrompt}\n\n【输出格式】只输出 JSON：{ ${outputSpec} }\n理由必须具体（指出问题所在），这是下游改写提示词的唯一依据。不要输出 JSON 以外的任何内容。`

  // 一致性审核的基准图：用户参考图 + 已确认小样终图（Phase=full 后小样即基准）
  const benchmarkImages = dims.includes("consistency")
    ? await loadBenchmarkImages(env.run.id, env.run.input.referenceImages ?? [])
    : []

  // 逐候选评审（单张评审可靠性优先；候选并行）
  const perCandidate = await Promise.all(
    state.candidates.map(async (url) => {
      const textPart: ChatContentPart = {
        type: "text",
        text: JSON.stringify(
          {
            prompt: state.prompt,
            // 结构化终稿分段（评审按 [画面内容] 段比对内容对齐，风格段供一致性参照；
            // 旧式无段标记提示词时为 null，评审回退按整段 prompt 比对）
            finalStyle: splitFinalPromptSegments(state.prompt ?? "")?.style ?? null,
            finalContent: splitFinalPromptSegments(state.prompt ?? "")?.content ?? null,
            cardName: state.name,
            meaning: state.meaning,
            styleDoc: (env.run.styleDoc ?? "").slice(0, 1200),
            benchmarkImageCount: benchmarkImages.length,
          },
          null,
          2,
        ),
      }
      const parts: ChatContentPart[] = [
        textPart,
        { type: "image_url", image_url: { url: signUploadToken(url) } },
        // 基准图附在待审图之后（顺序即「待审 vs 基准」）
        ...benchmarkImages.map((b) => ({ type: "image_url" as const, image_url: { url: b } })),
      ]
      const parsed = await callLlmJson<Record<string, unknown>>(env, model, {
        systemPrompt,
        messages: [{ role: "user", content: parts }],
        thinkingLevel: "medium",
      })
      return { url, parsed }
    }),
  )

  // 归并每候选结论（内容维度出数值分，pass = 分数 ≥ 内容阈值）
  const scored: RoundCandidate[] = perCandidate.map(({ url, parsed }) => {
    const contentScore =
      typeof parsed.contentScore === "number" ? Math.round(parsed.contentScore) : null
    return {
      url,
      score:
        typeof parsed.aestheticScore === "number"
          ? Math.round(parsed.aestheticScore)
          : typeof parsed.consistencyScore === "number"
            ? Math.round(parsed.consistencyScore)
            : null,
      contentPass: contentScore !== null ? contentScore >= contentThreshold : null,
    }
  })
  const reasons = perCandidate.map(({ parsed }) => ({
    contentScore:
      typeof parsed.contentScore === "number" ? Math.round(parsed.contentScore) : null,
    contentReason: strField(parsed.contentReason),
    aestheticReason: strField(parsed.aestheticReason),
    consistencyReason: strField(parsed.consistencyReason),
  }))

  // 选优：内容通过优先，其次审美分高；无评分取第一张
  const threshold = aestheticThreshold
  let bestIdx = 0
  for (let i = 1; i < scored.length; i++) {
    const a = scored[i]!
    const b = scored[bestIdx]!
    const aOk = (a.contentPass ?? true) && (a.score === null || a.score >= threshold)
    const bOk = (b.contentPass ?? true) && (b.score === null || b.score >= threshold)
    if (aOk !== bOk) {
      if (aOk) bestIdx = i
    } else if ((a.score ?? -1) > (b.score ?? -1)) {
      bestIdx = i
    }
  }
  const best = scored[bestIdx]!
  const bestReasons = reasons[bestIdx]!

  // 回写候选评分 + 选中图
  await db
    .update(agentRounds)
    .set({ candidates: scored, imageUrl: best.url })
    .where(eq(agentRounds.id, state.currentRoundId))
  state.imageUrl = best.url

  // 逐候选分维度精确分数（评审留痕与聚合用）
  const dimScores = perCandidate.map(({ parsed }) => ({
    content:
      typeof parsed.contentScore === "number" ? Math.round(parsed.contentScore) : null,
    aesthetic:
      typeof parsed.aestheticScore === "number" ? Math.round(parsed.aestheticScore) : null,
    consistency:
      typeof parsed.consistencyScore === "number" ? Math.round(parsed.consistencyScore) : null,
  }))
  const bestScores = dimScores[bestIdx]!

  // 写审核记录（选中候选的结论；每个评审节点各写一套，供前端按维度平均展示）
  const reviews: ReviewResultPayload[] = []
  if (dims.includes("content")) {
    const score = bestScores.content
    reviews.push({
      dimension: "content",
      pass: score !== null ? score >= contentThreshold : best.contentPass,
      score,
      reason: bestReasons.contentReason ?? "未给出理由",
    })
  }
  if (dims.includes("aesthetic")) {
    const score = bestScores.aesthetic
    reviews.push({
      dimension: "aesthetic",
      pass: score !== null ? score >= aestheticThreshold : null,
      score,
      reason: bestReasons.aestheticReason ?? "未给出理由",
    })
  }
  if (dims.includes("consistency")) {
    const score = bestScores.consistency
    reviews.push({
      dimension: "consistency",
      pass: score !== null ? score >= consistencyThreshold : null,
      score,
      reason: bestReasons.consistencyReason ?? "未给出理由",
    })
  }
  await db.insert(agentReviews).values(
    reviews.map((r) => ({
      runId: env.run.id,
      itemId: item.id,
      roundId: state.currentRoundId!,
      nodeKey: node.id,
      kind: "review",
      result: r,
    })),
  )

  // 汇总进 item 状态：多评审累计（分数求和取平均、通过判定多数票，见
  // refreshAggregatedReviewState；并行评审节点交错写入，全部累计后刷新）
  const agg = state.reviewAgg
  if (dims.includes("content") && bestScores.content !== null) {
    agg.content.sum += bestScores.content
    agg.content.total += 1
    if (bestScores.content >= contentThreshold) agg.content.passVotes += 1
    if (bestReasons.contentReason) agg.content.reasons.push(bestReasons.contentReason)
  }
  if (dims.includes("aesthetic") && bestScores.aesthetic !== null) {
    agg.aesthetic.sum += bestScores.aesthetic
    agg.aesthetic.total += 1
    if (bestScores.aesthetic >= aestheticThreshold) agg.aesthetic.passVotes += 1
    if (bestReasons.aestheticReason) agg.aesthetic.reasons.push(bestReasons.aestheticReason)
  }
  if (dims.includes("consistency") && bestScores.consistency !== null) {
    agg.consistency.sum += bestScores.consistency
    agg.consistency.total += 1
    if (bestScores.consistency >= consistencyThreshold) agg.consistency.passVotes += 1
    if (bestReasons.consistencyReason) agg.consistency.reasons.push(bestReasons.consistencyReason)
  }
  refreshAggregatedReviewState(state)

  await logEvent({
    runId: env.run.id,
    nodeKey: node.id,
    nodeType: "review",
    action: "done",
    status: best.contentPass === false || (best.score !== null && best.score < threshold) ? "warn" : "ok",
    detail:
      `候选 ${bestIdx + 1} 入选` +
      (dims.includes("content") ? `｜内容${best.contentPass === false ? "不通过" : "通过"}` : "") +
      (dims.includes("aesthetic") ? `｜审美 ${best.score ?? "?"} 分（及格线 ${threshold}）` : "") +
      // 一致性取该维度实际分（best.score 优先审美分，直接复用会显示成审美分）
      (dims.includes("consistency")
        ? `｜一致性 ${bestScores.consistency ?? "?"} 分（及格线 ${consistencyThreshold}）`
        : ""),
    itemId: item.id,
    roundId: state.currentRoundId,
  })
}

/**
 * 主管裁决（纯规则，不耗 LLM——省钱且可解释，ai-card-studio 同款）：
 * 内容过 + 审美达线 → approve；未过且轮数有余 → retry（打回边）；
 * 耗尽 → 按策略选历史最优继续或标记失败。
 */
async function executeSupervisorNode(
  env: RunEnv,
  item: typeof agentRunItems.$inferSelect,
  state: ItemState,
  node: AgentGraphNode,
): Promise<NodeOutcome> {
  const config = node.config as AgentNodeConfigByType["supervisor"]
  const contentPass = state.contentPass !== false // 无内容审核视为通过
  const aestheticOk = state.aestheticOk !== false
  const consistencyOk = state.consistencyOk !== false
  const roundsUsed = state.roundsUsed
  const maxRetries = Math.max(0, config.maxRetries ?? 0)

  const retryEdge = env.graph.edges.find(
    (e) => e.source === node.id && e.sourceHandle === "retry",
  )
  const mainNext = mainNextOf(env.graph, node.id)

  const writeVerdict = async (v: VerdictPayload["verdict"], detail: string) => {
    const payload: VerdictPayload = {
      verdict: v,
      contentPass,
      aestheticScore: state.aestheticScore,
      consistencyScore: state.consistencyScore,
      roundsUsed,
      maxRetries,
      detail,
    }
    await db.insert(agentReviews).values({
      runId: env.run.id,
      itemId: item.id,
      roundId: state.currentRoundId!,
      nodeKey: node.id,
      kind: "verdict",
      result: payload,
    })
    await logEvent({
      runId: env.run.id,
      nodeKey: node.id,
      nodeType: "supervisor",
      action: v === "retry" ? "retry" : v === "fallback" ? "fallback" : "done",
      status: v === "approve" ? "ok" : "warn",
      detail,
      itemId: item.id,
      roundId: state.currentRoundId,
    })
  }

  // 1) 通过（三审全过）
  if (contentPass && aestheticOk && consistencyOk) {
    await writeVerdict(
      "approve",
      `三审通过${state.aestheticScore !== null ? `（审美 ${state.aestheticScore} 分` : ""}${state.consistencyScore !== null ? `，一致性 ${state.consistencyScore} 分` : ""}），放行`,
    )
    if (!mainNext) {
      // 无下游：直接终态
      await finalizeItem(env, item.id, state, "approved_by_ai")
      return { kind: "stopped" }
    }
    return { kind: "passed" }
  }

  // 2) 打回（还有轮数余量 + 配置了打回边）
  if (retryEdge && roundsUsed < maxRetries) {
    const feedback: RetryFeedback = {
      contentPass: state.contentPass,
      contentReason: state.contentReason,
      aestheticScore: state.aestheticScore,
      aestheticReason: state.aestheticReason,
      consistencyScore: state.consistencyScore,
      consistencyReason: state.consistencyReason,
    }
    const fails: string[] = []
    if (!contentPass) fails.push("内容不对齐")
    if (!aestheticOk) fails.push(`审美 ${state.aestheticScore ?? "?"} 分未达线`)
    if (!consistencyOk) fails.push(`一致性 ${state.consistencyScore ?? "?"} 分未达线`)
    await writeVerdict(
      "retry",
      `第 ${roundsUsed + 1} 轮未过（${fails.join("；")}），打回改写（${roundsUsed + 1}/${maxRetries}）`,
    )
    return { kind: "retry", targetId: retryEdge.target, feedback }
  }

  // 3) 耗尽：按策略兜底
  if (config.exhaustedStrategy === "mark_failed") {
    await writeVerdict("fallback", "打回次数耗尽，按策略标记失败")
    await db
      .update(agentRunItems)
      .set({ status: "failed", errorMessage: "打回次数耗尽（策略：标记失败）", updatedAt: new Date() })
      .where(eq(agentRunItems.id, item.id))
    return { kind: "stopped" }
  }

  const rounds = await loadItemRoundsWithReviews(item.id)
  const best = pickBestRound(rounds)
  if (!best) {
    await writeVerdict("fallback", "打回次数耗尽且无可选历史轮次，标记失败")
    await db
      .update(agentRunItems)
      .set({ status: "failed", errorMessage: "打回耗尽且无历史成图可选", updatedAt: new Date() })
      .where(eq(agentRunItems.id, item.id))
    return { kind: "stopped" }
  }
  const warning = best.contentPass === false
  await writeVerdict(
    "fallback",
    `打回次数耗尽，自动选历史最优：第 ${best.roundNumber} 轮（${best.contentPass === false ? "⚠ 内容未通过" : "内容通过"}${best.aestheticScore !== null ? `，审美 ${best.aestheticScore} 分` : ""}）`,
  )
  await db
    .update(agentRunItems)
    .set({
      status: "fallback",
      finalRoundId: best.roundId,
      fallbackContentWarning: warning,
      updatedAt: new Date(),
    })
    .where(eq(agentRunItems.id, item.id))
  if (!mainNext) return { kind: "stopped" }
  return { kind: "passed" }
}

function mainNextOf(graph: AgentGraph, nodeId: string): string | null {
  const e = graph.edges.find((el) => el.source === nodeId && (el.sourceHandle ?? "main") === "main")
  return e ? e.target : null
}

/** item 到达终点：无人工环节时 AI 通过即终态 */
async function finalizeItem(
  env: RunEnv,
  itemId: string,
  state: ItemState,
  status: "approved_by_ai",
): Promise<void> {
  await db
    .update(agentRunItems)
    .set({ status, finalRoundId: state.currentRoundId, updatedAt: new Date() })
    .where(eq(agentRunItems.id, itemId))
}

// ═══════════════════════════ item 主流程 ═══════════════════════════

/** 处理一张卡：外层打回循环驱动内层拓扑遍历 */
async function processItem(
  env: RunEnv,
  item: typeof agentRunItems.$inferSelect,
): Promise<void> {
  const state: ItemState = {
    name: item.name,
    meaning: item.meaning,
    prompt: item.currentPrompt,
    promptSource: item.promptSource ?? "initial",
    roundsUsed: item.roundsUsed ?? 0,
    currentRoundId: item.finalRoundId,
    candidates: [],
    imageUrl: null,
    contentPass: null,
    contentReason: null,
    aestheticScore: null,
    aestheticReason: null,
    aestheticOk: null,
    consistencyScore: null,
    consistencyReason: null,
    consistencyOk: null,
    reviewAgg: {
      content: { sum: 0, passVotes: 0, total: 0, reasons: [] },
      aesthetic: { sum: 0, passVotes: 0, total: 0, reasons: [] },
      consistency: { sum: 0, passVotes: 0, total: 0, reasons: [] },
    },
  }
  // 恢复场景：finalRoundId 可能是人工提议轮，不作为当前轮
  if (item.status !== "waiting_human") state.currentRoundId = null

  const startNode = env.graph.nodes.find((n) => n.type === "start")
  if (!startNode) throw new Error("图缺少开始节点")

  let startAt = startNode.id
  // 有历史 prompt 且非打回续跑：从第一个 agent/image_gen 节点续跑（跳过起草）
  try {
    while (true) {
      const outcome = await walkItem(env, item, state, startAt)
      if (outcome.kind === "retry") {
        state.roundsUsed += 1
        // 注意：保留本轮审核结论（contentPass/aestheticOk 等）作为改写反馈——
        // agent 节点据此进入 revise 分支并在消费后清除；只清候选图与评审累计
        state.candidates = []
        state.imageUrl = null
        state.reviewAgg = {
          content: { sum: 0, passVotes: 0, total: 0, reasons: [] },
          aesthetic: { sum: 0, passVotes: 0, total: 0, reasons: [] },
          consistency: { sum: 0, passVotes: 0, total: 0, reasons: [] },
        }
        await db
          .update(agentRunItems)
          .set({ roundsUsed: state.roundsUsed, status: "pending", updatedAt: new Date() })
          .where(eq(agentRunItems.id, item.id))
        startAt = outcome.targetId
        continue
      }
      if (outcome.kind === "waiting_human") return
      // done：未设终态时置 AI 通过
      const [cur] = await db
        .select({ status: agentRunItems.status })
        .from(agentRunItems)
        .where(eq(agentRunItems.id, item.id))
      if (cur && !TERMINAL_ITEM_STATUSES.includes(cur.status as (typeof TERMINAL_ITEM_STATUSES)[number])) {
        await finalizeItem(env, item.id, state, "approved_by_ai")
        await logEvent({
          runId: env.run.id,
          action: "done",
          status: "ok",
          detail: `「${state.name ?? `第 ${item.index + 1} 张`}」流水线完成`,
          itemId: item.id,
        })
      }
      return
    }
  } catch (err) {
    if (err instanceof PauseSignal) {
      // 复位回 pending（保留 prompt/轮数），恢复后重跑本轮
      await db
        .update(agentRunItems)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(agentRunItems.id, item.id))
      return
    }
    if (err instanceof CancelSignal) {
      await db
        .update(agentRunItems)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(agentRunItems.id, item.id))
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    const isInsufficient = err instanceof CreditsInsufficientError
    await db
      .update(agentRunItems)
      .set({ status: "failed", errorMessage: message, updatedAt: new Date() })
      .where(eq(agentRunItems.id, item.id))
    await logEvent({
      runId: env.run.id,
      action: "fail",
      status: "error",
      detail: `「${state.name ?? `第 ${item.index + 1} 张`}」失败：${message}`,
      itemId: item.id,
    })
    if (isInsufficient) {
      // 积分不足属于运行级错误：中断整个 run，避免后续 item 连续失败空转
      throw err
    }
  }
}

// ═══════════════════════════ run 主流程 ═══════════════════════════

async function failRun(runId: string, message: string): Promise<void> {
  await db
    .update(agentRuns)
    .set({ status: "failed", error: message, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentRuns.id, runId))
  await logEvent({ runId, action: "fail", status: "error", detail: message })
}

/**
 * item 执行循环（滑动窗口）：固定 N 个工人，每完成一张立即补位下一张。
 * N = min(企业, 权限组) 全局用户并发限制（限值口径未改动）。相比旧
 * 「分块 Promise.allSettled」消除队头阻塞——某张卡进入评审/改写（对话
 * 阶段）时立即释放窗口给下一张卡的生图：首轮生图持续打满配置上限，
 * 评审与改写在生图后续逐步完成（与 Agent 对话槽位限流配套）。
 * 原子认领（pending→drafting 条件更新）防多工人重入与人工操作竞态。
 * 积分不足等运行级错误原样上抛由调用方处置。
 */
async function runItemBatches(env: RunEnv): Promise<void> {
  const runId = env.run.id
  // 生产并发纯跟随全局用户并发限制：min(企业并发上限, 权限组并发上限)，
  // 不再读模板配置的固定值（默认配置下 = min(5, 2) = 2，与旧行为一致；
  // 企业调大上限后自动放宽）。生图调用仍与企业/模型/组三层 Redis 槽位
  // 共享额度；LLM 调用另按对话槽位（llm-slots）三层限流。
  const concurrency = effectiveConcurrentLimit({
    enterprise: env.enterpriseMaxConcurrent,
    group: env.groupMaxConcurrent,
  })

  // 原子认领下一张 pending 卡：选最早一张 → 条件更新 pending→drafting；
  // 被其他工人/人工操作抢先（返回空）则重查下一张
  const claimNext = async (): Promise<typeof agentRunItems.$inferSelect | null> => {
    for (;;) {
      const alive = await assertRunActive(runId)
      if (alive.status !== "running") return null
      // 两阶段：sample 阶段只取小样卡；full 阶段取全部 pending
      const phaseFilter =
        alive.phase === "sample" ? eq(agentRunItems.isSample, true) : undefined
      const [candidate] = await db
        .select({ id: agentRunItems.id })
        .from(agentRunItems)
        .where(
          phaseFilter
            ? and(
                eq(agentRunItems.runId, runId),
                eq(agentRunItems.status, "pending"),
                phaseFilter,
              )
            : and(eq(agentRunItems.runId, runId), eq(agentRunItems.status, "pending")),
        )
        .orderBy(asc(agentRunItems.index))
        .limit(1)
      if (!candidate) return null
      const claimed = await db
        .update(agentRunItems)
        .set({ status: "drafting", updatedAt: new Date() })
        .where(and(eq(agentRunItems.id, candidate.id), eq(agentRunItems.status, "pending")))
        .returning()
      if (claimed.length > 0) return claimed[0]!
      // 认领失败：并发竞态，立即重试（下一轮查询会取到更晚的卡）
    }
  }

  let stopped = false
  let fatal: unknown = null
  const worker = async (): Promise<void> => {
    while (!stopped) {
      await heartbeat(runId)
      const item = await claimNext()
      if (!item) return
      try {
        await processItem(env, item)
      } catch (err) {
        if (err instanceof CreditsInsufficientError) {
          // 积分不足等运行级错误：停止补位，等全部在途卡收尾后中断（由调用方处置）
          fatal = err
          stopped = true
          return
        }
        // 其余失败：processItem 已把该卡置 failed 并记事件（与旧分块 allSettled 语义一致）
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (fatal) throw fatal
}

/**
 * 塔罗模板卡面生产（pendingAction = produce_cards；agent-processor 认领后经
 * executeTemplateAction 调入）。与经典路径共用 item 流水线，差异：
 * - 跳过 run 级风格/结构节点：简报 + 已确认方向合成《风格规范书》（幂等，
 *   纯拼接不耗 LLM），78 张清单卡已由 prompt 阶段建好（有提示词的卡自动
 *   跳过文案起草，仅在打回时改写）；
 * - run 已由 processor 原子认领为 running，此处不重复认领；
 * - 小样批次收口为 waiting_human（模板语义，区别于经典的 waiting_style）；
 * - 运行级错误（如积分不足）不把 pending 卡判死：保留 pendingAction 交给
 *   用户充值后一键重试（processor 捕获后复位 waiting_human + error）。
 */
export async function executeTemplateProduction(input: { runId: string }): Promise<void> {
  const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.id, input.runId))
  if (!runRow) throw new Error("项目不存在")
  if (runRow.template !== "tarot") throw new Error("该项目不是塔罗模板项目")
  if (runRow.status !== "running") throw new Error("项目不在执行中（worker 未认领或已中断）")

  const validation = validateAgentGraph(runRow.graphSnapshot)
  if (!validation.ok) {
    throw new Error(`生产流水线结构无效：${validation.error}，请联系管理员检查配置`)
  }

  const env = await buildRunEnv(runRow)
  await heartbeat(runRow.id)
  await ensureTemplateStyleDoc(env)

  const isSample = runRow.phase === "sample"
  await logEvent({
    runId: runRow.id,
    nodeKey: "artist",
    nodeType: "agent",
    action: "start",
    status: "ok",
    detail: isSample
      ? "开始生成风格小样（文案 → 生图 → 三审 → 裁决）"
      : "开始全套卡面生产（小样终图将作为成套一致性基准）",
  })

  try {
    await runItemBatches(env)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logEvent({
      runId: runRow.id,
      nodeKey: "artist",
      nodeType: "agent",
      action: "fail",
      status: "error",
      detail: `卡面生产中断：${message}（未完成的卡牌已保留，处理后可一键重试）`,
    })
    throw err
  }

  await checkRunCompletion(runRow.id)
}

/**
 * 模板流程《风格规范书》：由已确认的创作简报 + 内容方向确定性拼接
 * （幂等；不调 LLM），供文案改写与三审（一致性维度）引用。
 */
async function ensureTemplateStyleDoc(env: RunEnv): Promise<void> {
  if (env.run.styleDoc) return
  const run = env.run
  const direction = (run.directions ?? []).find((d) => d.id === run.selectedDirectionId)
  const sections = [
    run.brief ? `【创作简报】\n${run.brief}` : "",
    direction ? `【内容方向】${direction.name}：${direction.concept || direction.description}` : "",
    direction?.worldview ? `【世界观】${direction.worldview}` : "",
    direction?.visualLanguage ? `【视觉语言】${direction.visualLanguage}` : "",
    direction?.palette ? `【色调】${direction.palette}` : "",
    direction?.suitMapping?.length
      ? `【四花色意象】${direction.suitMapping.map((s) => `${s.suit}=${s.mapping}`).join("；")}`
      : "",
    direction?.majorArcana ? `【大阿卡纳演绎】${direction.majorArcana}` : "",
  ].filter(Boolean)
  const styleDoc = sections.join("\n\n")
  if (!styleDoc) return
  await db
    .update(agentRuns)
    .set({ styleDoc, updatedAt: new Date() })
    .where(eq(agentRuns.id, run.id))
  env.run = { ...env.run, styleDoc }
}

/**
 * 收口检查（executeAgentRun 与确认风格/人工操作 Action 共用）：
 * - sample 阶段：小样全部终态 → waiting_human（等用户确认风格）；
 * - full 阶段：全部终态 → completed / failed。
 */
export async function checkRunCompletion(runId: string): Promise<void> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
  if (!run) return
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return

  const items = await db
    .select({ status: agentRunItems.status, isSample: agentRunItems.isSample })
    .from(agentRunItems)
    .where(eq(agentRunItems.runId, runId))
  if (items.length === 0) return

  const isBusy = (s: string) =>
    s === "pending" || (TRANSIENT_ITEM_STATUSES as readonly string[]).includes(s)

  // sample 阶段收口：小样全部终态 → 等待用户确认（模板语义 waiting_human，
  // 由工作台小样确认横幅承接后进入全套）
  if (run.phase === "sample") {
    const samples = items.filter((i) => i.isSample)
    if (samples.length === 0 || samples.some((i) => isBusy(i.status))) return
    if (run.status !== "waiting_human") {
      await db
        .update(agentRuns)
        .set({ status: "waiting_human", updatedAt: new Date() })
        .where(eq(agentRuns.id, runId))
      await logEvent({
        runId,
        action: "done",
        status: "ok",
        detail: `风格小样完成（${samples.filter((i) => i.status !== "failed" && i.status !== "cancelled").length}/${samples.length} 张成图），等待确认风格后开始全套`,
      })
    }
    return
  }

  // full 阶段收口
  const statuses = items.map((i) => i.status)
  if (statuses.some(isBusy)) return

  if (statuses.includes("waiting_human")) {
    if (run.status !== "waiting_human") {
      await db
        .update(agentRuns)
        .set({ status: "waiting_human", updatedAt: new Date() })
        .where(eq(agentRuns.id, runId))
      await logEvent({ runId, action: "start", status: "ok", detail: "全部在途卡牌已到达人工确认环节" })
    }
    return
  }

  // 全部终态
  const successCount = statuses.filter(
    (s) => s === "confirmed" || s === "approved_by_ai" || s === "fallback",
  ).length
  const failedCount = statuses.filter((s) => s === "failed" || s === "cancelled").length
  if (successCount > 0 && failedCount > 0) {
    // 有成功也有失败：等待用户处理失败卡（工作台批量重试横幅承接），
    // 全部成功后才收口 completed——避免「completed 却缺卡」的状态语义漂移
    if (run.status !== "waiting_human") {
      await db
        .update(agentRuns)
        .set({ status: "waiting_human", updatedAt: new Date() })
        .where(eq(agentRuns.id, runId))
      await logEvent({
        runId,
        action: "start",
        status: "warn",
        detail: `生产收口：${successCount}/${statuses.length} 张产出，${failedCount} 张失败待处理（可重试）`,
      })
    }
  } else if (successCount > 0) {
    await db
      .update(agentRuns)
      .set({ status: "completed", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRuns.id, runId))
    await logEvent({
      runId,
      action: "done",
      status: "ok",
      detail: `运行完成：${successCount}/${statuses.length} 张产出`,
    })
  } else {
    await failRun(runId, "全部卡牌处理失败")
  }
}
