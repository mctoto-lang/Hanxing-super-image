/**
 * 工作台 Agent 正式卡片生产（生图 → 自动评审 → 打回/兜底循环）
 *
 * 链路（worker 与 action 共用同一套内核，避免行为漂移）：
 * 1. startAgentCardGeneration：单卡正式生图（action 主动触发 / 评审打回后
 *    自动重试共用）。使用 workflow 冻结的 imageModelId 与该卡 kind 对应的
 *    冻结尺寸；单事务内建 card_image + generation_task（source = "agent"）
 *    + workspace_agent_round + 个人配额扣费（deductUserCredits，沿用工作台
 *    通用计费规则）+ workspace_agent_usage 记账，事务外入标准生图队列。
 * 2. 生图队列终态（processor.ts）→ maybeEnqueueWorkspaceAgentReview 入
 *    review_image job（幂等：同一生图任务已有活跃评审任务则跳过；非 agent
 *    来源任务 / 用户上传图一律不触发评审）。
 * 3. runReviewImageJob：每个评审模型（input.reviewerChatModelIds，1-3 个
 *    视觉模型）取 vision 输入（选定方向概念 + 风格规范书 + 卡片提示词 +
 *    实际生成图），三维 0-100 评分；加权总分 = round(0.4×审美 + 0.3×一致性
 *    + 0.3×内容)，仅以总分 ≥ qualityThreshold 通过（单项不否决）。
 * 4. 低分打回：prompt_designer 依据当前提示词 + 评审意见改写，自动按同一
 *    模型同一尺寸生成下一轮（promptSource = auto_revise），至多重试
 *    maxRetries 次；耗尽标 fallback，selected image 取全部尝试中最高加权分。
 * 5. 评分 / Token / cost 经 callWorkspaceAgentLlmJson 与 usage 账本真实入账
 *    （LLM 走企业池结算，生图走个人配额，同域内既有口径）。
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  cardImages,
  generationTasks,
  models,
  promptCards,
  users,
  workspaceAgentCards,
  workspaceAgentDirections,
  workspaceAgentJobs,
  workspaceAgentPreviews,
  workspaceAgentReviews,
  workspaceAgentRounds,
  workspaceAgentUsage,
  workspaceAgentWorkflows,
  workspaceTasks,
  type WorkspaceAgentCardRow,
  type WorkspaceAgentJobRow,
  type WorkspaceAgentWorkflowRow,
} from "@/db/schema"
import type { UserContext } from "@/lib/auth/session"
import { enqueue } from "@/lib/queue/task-queue"
import { deductUserCredits, refundUserCredits } from "@/server/services/credits-service"
import { signUploadToken } from "@/lib/storage/upload-token"
import type { ChatContentPart } from "@/lib/ai/chat/chat-model-config"
import { LlmValidationError } from "@/server/services/agent/llm-errors"
import type {
  WorkspaceAgentCardKind,
  WorkspaceAgentPromptSource,
  WorkspaceAgentReviewerReviewPayload,
  WorkspaceAgentVerdictPayload,
} from "@/lib/workspace/agent-types"
import {
  cardKindToSizeKind,
  computeWeightedTotalScore,
  pickBestScoredRound,
  resolveReviewVerdict,
  templateSizeOf,
} from "@/lib/workspace/agent-templates"
import {
  readQualityThresholds,
  readWorkflowInput,
} from "./input"
import {
  callWorkspaceAgentLlmJson,
  loadWorkspaceAgentChatModel,
  recordWorkspaceAgentLlmFailure,
  type WorkspaceAgentChatModelRow,
} from "./llm"
import { logWaEvent } from "./run"
import { loadLatestWorkflowForTask } from "./progress"

// ---------------------------------------------------------------------------
// 卡类映射与文案
// ---------------------------------------------------------------------------

export { cardKindToSizeKind as sizeKindOfCardKind } from "@/lib/workspace/agent-templates"

export const WORKSPACE_AGENT_KIND_LABELS: Record<WorkspaceAgentCardKind, string> = {
  face: "卡面",
  back: "牌背",
  box: "牌盒",
  border: "卡框",
}

/** 评审员留痕 nodeKey（schema varchar(60)；review_panel: + 36 位 uuid = 49） */
function reviewerNodeKey(reviewerId: string): string {
  return `review_panel:${reviewerId}`.slice(0, 60)
}

// ---------------------------------------------------------------------------
// 单卡正式生图（action 主动 / 评审打回自动重试共用内核）
// ---------------------------------------------------------------------------

export interface StartAgentCardGenerationInput {
  enterpriseId: string
  userId: string
  workflow: WorkspaceAgentWorkflowRow
  card: WorkspaceAgentCardRow
  /** 本轮完整提示词（含固定风格提示词段） */
  prompt: string
  promptSource: WorkspaceAgentPromptSource
}

/**
 * 单卡正式生图：冻结模型 + kind 尺寸，单事务建 card_image / generation_task
 * （source = "agent"）/ workspace_agent_round + 个人配额扣费 + usage 记账，
 * 事务外入标准生图队列（失败退款补偿，同 generateCardImageInternal 口径）。
 * 参考图不进入生图请求（发起输入的参考图仅用于风格提取，见 WorkspaceAgentInput 契约）。
 */
export async function startAgentCardGeneration(
  input: StartAgentCardGenerationInput,
): Promise<
  | { ok: true; roundId: string; generationTaskId: string; cardImageId: string }
  | { ok: false; error: string }
> {
  const { enterpriseId, userId, workflow, card } = input
  const prompt = input.prompt.trim()
  if (!prompt) return { ok: false, error: "提示词为空，请先填写提示词" }
  if (!card.promptCardId) return { ok: false, error: "卡片未回链工作台提示词卡，无法生图" }

  const ext = readWorkflowInput(workflow)
  if (!ext.imageModelId) {
    return {
      ok: false,
      error: "工作流未冻结生图模型（发起时未选择生图模型），无法进入生图阶段",
    }
  }
  const templateKey = ext.frozenConfig?.templateKey ?? "tarot81"
  const sizeKind = cardKindToSizeKind(card.kind)
  const size =
    ext.frozenConfig?.sizes?.[sizeKind] ?? templateSizeOf(templateKey, sizeKind)

  // 冻结模型复验（停用/删除后明确报错，不静默换模型）
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, ext.imageModelId))
    .limit(1)
  if (!model || !model.isActive || !model.visibleInWorkspace) {
    return { ok: false, error: "冻结的生图模型不存在或已停用，请重新发起工作流" }
  }
  if (model.enterpriseId !== null && model.enterpriseId !== enterpriseId) {
    return { ok: false, error: "冻结的生图模型不在本企业可用范围内" }
  }
  const cost = model.costPerImage

  // 余额预检（温和失败；事务内 deduct 仍是最终防线）
  const [user] = await db
    .select({ creditsBalance: users.creditsBalance })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (user && user.creditsBalance < cost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${cost}，当前 ${user.creditsBalance}`,
    }
  }

  const [maxRow] = await db
    .select({ m: sql<number>`coalesce(max(${workspaceAgentRounds.roundNumber}), 0)` })
    .from(workspaceAgentRounds)
    .where(eq(workspaceAgentRounds.cardId, card.id))
  const roundNumber = Number(maxRow?.m ?? 0) + 1

  let ids: { roundId: string; generationTaskId: string; cardImageId: string }
  try {
    ids = await db.transaction(async (tx) => {
      const [cardImage] = await tx
        .insert(cardImages)
        .values({
          enterpriseId,
          cardId: card.promptCardId!,
          imageApiId: model.id,
          imageUrl: "",
          size,
          status: "pending",
          isSelected: false,
          generationPrompt: prompt,
          source: "generated",
        })
        .returning({ id: cardImages.id })

      const [genTask] = await tx
        .insert(generationTasks)
        .values({
          enterpriseId,
          userId,
          modelId: model.id,
          prompt,
          imageSize: size,
          imageCount: 1,
          status: "queued",
          taskType: "workspace_single",
          // Agent 管线任务统一 source = "agent"：终态据此触发 review_image；
          // 普通 workspace 单/批生图不受影响（仍为 "workspace"）
          source: "agent",
          priority: 0,
          creditsCharged: 0,
          costPerImage: cost,
        })
        .returning({ id: generationTasks.id })

      await tx
        .update(cardImages)
        .set({ generationTaskId: genTask!.id, updatedAt: new Date() })
        .where(eq(cardImages.id, cardImage!.id))

      await deductUserCredits({
        enterpriseId,
        amount: cost,
        userId,
        taskId: genTask!.id,
        remark: `工作台 Agent 生图 ${model.displayName} x1`,
        tx,
      })
      await tx
        .update(generationTasks)
        .set({ creditsCharged: cost })
        .where(eq(generationTasks.id, genTask!.id))

      const [round] = await tx
        .insert(workspaceAgentRounds)
        .values({
          workflowId: workflow.id,
          cardId: card.id,
          roundNumber,
          prompt,
          promptSource: input.promptSource,
          generationTaskId: genTask!.id,
          candidates: [],
          costCredits: cost,
        })
        .returning({ id: workspaceAgentRounds.id })

      await tx
        .update(workspaceAgentCards)
        .set({
          status: "generating",
          currentPrompt: prompt,
          promptSource: input.promptSource,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(workspaceAgentCards.id, card.id))

      await tx
        .update(workspaceAgentWorkflows)
        .set({
          imageCostCredits: sql`${workspaceAgentWorkflows.imageCostCredits} + ${cost}`,
          updatedAt: new Date(),
        })
        .where(eq(workspaceAgentWorkflows.id, workflow.id))

      await tx.insert(workspaceAgentUsage).values({
        workflowId: workflow.id,
        enterpriseId,
        userId,
        kind: "image",
        nodeKey: "artist",
        imageModelId: model.id,
        cardId: card.id,
        roundId: round!.id,
        cardImageId: cardImage!.id,
        generationTaskId: genTask!.id,
        imageCount: 1,
        costCredits: cost,
        status: "success",
      })

      return {
        roundId: round!.id,
        generationTaskId: genTask!.id,
        cardImageId: cardImage!.id,
      }
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
    }
  }

  // 入队（事务外）。失败退款并收尾，防止「已扣费但任务永不处理」。
  try {
    await enqueue({
      taskId: ids.generationTaskId,
      enterpriseId,
      modelId: model.id,
      prompt,
      imageSize: size,
      imageCount: 1,
      referenceImages: [],
      priority: 0,
      costPerImage: cost,
      apiTimeout: model.apiTimeout,
      taskTimeout: model.taskTimeout,
      maxRetries: model.maxRetries,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await refundUserCredits({
      enterpriseId,
      amount: cost,
      userId,
      taskId: ids.generationTaskId,
      remark: "工作台 Agent 生图入队失败退还 x1",
    }).catch((refundErr) => {
      console.error(
        `[workspace-agent] 生图入队失败且退款失败（需人工对账）:`,
        refundErr instanceof Error ? refundErr.message : refundErr,
      )
    })
    await Promise.all([
      db
        .update(generationTasks)
        .set({ status: "failed", errorMessage: "任务入队失败，积分已退还", completedAt: new Date() })
        .where(eq(generationTasks.id, ids.generationTaskId)),
      db
        .update(cardImages)
        .set({ status: "failed", errorMessage: "任务入队失败，积分已退还", updatedAt: new Date() })
        .where(eq(cardImages.id, ids.cardImageId)),
      db
        .update(workspaceAgentCards)
        .set({ status: "failed", errorMessage: "任务入队失败，积分已退还", updatedAt: new Date() })
        .where(eq(workspaceAgentCards.id, card.id)),
      db
        .update(workspaceAgentWorkflows)
        .set({
          imageCostCredits: sql`greatest(0, ${workspaceAgentWorkflows.imageCostCredits} - ${cost})`,
          updatedAt: new Date(),
        })
        .where(eq(workspaceAgentWorkflows.id, workflow.id)),
      db
        .update(workspaceAgentUsage)
        .set({ status: "failure", errorMessage: `任务入队失败：${reason.slice(0, 400)}` })
        .where(
          and(
            eq(workspaceAgentUsage.generationTaskId, ids.generationTaskId),
            eq(workspaceAgentUsage.kind, "image"),
          ),
        ),
    ])
    console.error(`[workspace-agent] 生图任务 ${ids.generationTaskId} 入队失败，已退款:`, reason)
    return { ok: false, error: "任务入队失败，积分已退还，请稍后重试" }
  }

  await logWaEvent({
    workflowId: workflow.id,
    enterpriseId,
    nodeKey: "artist",
    action: "start",
    status: "ok",
    detail: `画师开始绘制「${card.name ?? `第 ${card.cardIndex + 1} 张`}」（${WORKSPACE_AGENT_KIND_LABELS[card.kind]}，第 ${roundNumber} 轮，${model.displayName} ${size}，${cost} 积分/张）`,
    cardId: card.id,
  })

  return { ok: true, ...ids }
}

/** 该卡是否存在未终态的生图轮（防并发重复入队） */
export async function hasInFlightGeneration(cardId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: workspaceAgentRounds.id })
    .from(workspaceAgentRounds)
    .innerJoin(
      generationTasks,
      eq(workspaceAgentRounds.generationTaskId, generationTasks.id),
    )
    .where(
      and(
        eq(workspaceAgentRounds.cardId, cardId),
        inArray(generationTasks.status, ["queued", "processing"]),
      ),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * action 侧单卡生图入口：定位挂靠工作台的最新 workflow 与 Agent 卡后走
 * startAgentCardGeneration（忽略调用方传入的 apiId/size，一律用冻结值）。
 */
export async function generateAgentCardImageForAction(opts: {
  ctx: UserContext
  enterpriseId: string
  taskId: string
  promptCardId: string
  prompt: string
}): Promise<
  | { ok: true; roundId: string; generationTaskId: string; cardImageId: string }
  | { ok: false; error: string }
> {
  const workflow = await loadLatestWorkflowForTask(
    opts.enterpriseId,
    opts.ctx.user.id,
    opts.taskId,
  )
  if (!workflow) return { ok: false, error: "Agent 工作流不存在，无法生图" }
  const [card] = await db
    .select()
    .from(workspaceAgentCards)
    .where(
      and(
        eq(workspaceAgentCards.promptCardId, opts.promptCardId),
        eq(workspaceAgentCards.workflowId, workflow.id),
      ),
    )
    .limit(1)
  if (!card) return { ok: false, error: "未找到该卡片的 Agent 生产记录" }
  // 打回耗尽（fallback）：普通单张/批量生成一律拒绝——自动评审周期已结束，
  // 新周期只能经 restartWorkspaceAgentCardAction（重置 roundsUsed）开启
  if (card.status === "fallback") {
    return {
      ok: false,
      error: "该卡片自动评审已耗尽，请使用「重新 Agent 生成」开启新周期",
    }
  }
  if (await hasInFlightGeneration(card.id)) {
    return { ok: false, error: "该卡片正在生成/评审中，请等待本轮完成" }
  }
  if (await hasPendingReviewJob(card.id)) {
    return { ok: false, error: "该卡片评审任务待执行，请等待评审完成后再生成" }
  }
  const [roundRow] = await db
    .select({ id: workspaceAgentRounds.id })
    .from(workspaceAgentRounds)
    .where(eq(workspaceAgentRounds.cardId, card.id))
    .limit(1)
  return startAgentCardGeneration({
    enterpriseId: opts.enterpriseId,
    userId: opts.ctx.user.id,
    workflow,
    card,
    prompt: opts.prompt,
    promptSource: roundRow ? "manual" : "initial",
  })
}

// ---------------------------------------------------------------------------
// 方向示例图（不进卡片网格、不评审；生图终态由 preview 钩子回写）
// ---------------------------------------------------------------------------

/**
 * 方向示例图入队：冻结生图模型 + 卡面尺寸（frozenConfig.sizes.card）。
 * 单事务建 workspace_agent_preview（pending）+ generation_task（source =
 * "agent"）+ 个人配额扣费 + usage 记账（nodeKey = style_director），
 * 事务外入标准生图队列；入队失败退款并标 preview failed（镜像卡片生图补偿）。
 */
export async function startDirectionPreviewGeneration(input: {
  workflow: WorkspaceAgentWorkflowRow
  directionId: string
  prompt: string
}): Promise<{ ok: true; previewId: string; generationTaskId: string } | { ok: false; error: string }> {
  const { workflow, directionId } = input
  const prompt = input.prompt.trim()
  if (!prompt) return { ok: false, error: "示例图提示词为空" }
  const enterpriseId = workflow.enterpriseId
  const userId = workflow.userId
  const ext = readWorkflowInput(workflow)
  if (!ext.imageModelId) {
    return { ok: false, error: "工作流未冻结生图模型（发起时未选择生图模型），无法生成示例图" }
  }
  const templateKey = ext.frozenConfig?.templateKey ?? "tarot81"
  const size = ext.frozenConfig?.sizes?.card ?? templateSizeOf(templateKey, "card")

  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, ext.imageModelId))
    .limit(1)
  if (!model || !model.isActive || !model.visibleInWorkspace) {
    return { ok: false, error: "冻结的生图模型不存在或已停用，无法生成示例图" }
  }
  if (model.enterpriseId !== null && model.enterpriseId !== enterpriseId) {
    return { ok: false, error: "冻结的生图模型不在本企业可用范围内" }
  }
  const cost = model.costPerImage

  const [user] = await db
    .select({ creditsBalance: users.creditsBalance })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (user && user.creditsBalance < cost) {
    return { ok: false, error: `个人配额不足，示例图需要 ${cost}，当前 ${user.creditsBalance}` }
  }

  let ids: { previewId: string; generationTaskId: string }
  try {
    ids = await db.transaction(async (tx) => {
      const [preview] = await tx
        .insert(workspaceAgentPreviews)
        .values({
          workflowId: workflow.id,
          directionId,
          enterpriseId,
          kind: "direction",
          status: "pending",
          generationPrompt: prompt,
        })
        .returning({ id: workspaceAgentPreviews.id })

      const [genTask] = await tx
        .insert(generationTasks)
        .values({
          enterpriseId,
          userId,
          modelId: model.id,
          prompt,
          imageSize: size,
          imageCount: 1,
          status: "queued",
          taskType: "workspace_single",
          source: "agent",
          priority: 0,
          creditsCharged: 0,
          costPerImage: cost,
        })
        .returning({ id: generationTasks.id })

      await tx
        .update(workspaceAgentPreviews)
        .set({ generationTaskId: genTask!.id, updatedAt: new Date() })
        .where(eq(workspaceAgentPreviews.id, preview!.id))

      await deductUserCredits({
        enterpriseId,
        amount: cost,
        userId,
        taskId: genTask!.id,
        remark: `工作台 Agent 方向示例图 ${model.displayName} x1`,
        tx,
      })
      await tx
        .update(generationTasks)
        .set({ creditsCharged: cost })
        .where(eq(generationTasks.id, genTask!.id))

      await tx
        .update(workspaceAgentWorkflows)
        .set({
          imageCostCredits: sql`${workspaceAgentWorkflows.imageCostCredits} + ${cost}`,
          updatedAt: new Date(),
        })
        .where(eq(workspaceAgentWorkflows.id, workflow.id))

      await tx.insert(workspaceAgentUsage).values({
        workflowId: workflow.id,
        enterpriseId,
        userId,
        kind: "image",
        nodeKey: "style_director",
        imageModelId: model.id,
        generationTaskId: genTask!.id,
        imageCount: 1,
        costCredits: cost,
        status: "success",
      })

      return { previewId: preview!.id, generationTaskId: genTask!.id }
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "示例图积分扣减失败" }
  }

  try {
    await enqueue({
      taskId: ids.generationTaskId,
      enterpriseId,
      modelId: model.id,
      prompt,
      imageSize: size,
      imageCount: 1,
      referenceImages: [],
      priority: 0,
      costPerImage: cost,
      apiTimeout: model.apiTimeout,
      taskTimeout: model.taskTimeout,
      maxRetries: model.maxRetries,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await refundUserCredits({
      enterpriseId,
      amount: cost,
      userId,
      taskId: ids.generationTaskId,
      remark: "工作台 Agent 方向示例图入队失败退还 x1",
    }).catch((refundErr) => {
      console.error(
        `[workspace-agent] 示例图入队失败且退款失败（需人工对账）:`,
        refundErr instanceof Error ? refundErr.message : refundErr,
      )
    })
    await Promise.all([
      db
        .update(generationTasks)
        .set({ status: "failed", errorMessage: "任务入队失败，积分已退还", completedAt: new Date() })
        .where(eq(generationTasks.id, ids.generationTaskId)),
      db
        .update(workspaceAgentPreviews)
        .set({ status: "failed", errorMessage: "任务入队失败，积分已退还", updatedAt: new Date() })
        .where(eq(workspaceAgentPreviews.id, ids.previewId)),
      db
        .update(workspaceAgentWorkflows)
        .set({
          imageCostCredits: sql`greatest(0, ${workspaceAgentWorkflows.imageCostCredits} - ${cost})`,
          updatedAt: new Date(),
        })
        .where(eq(workspaceAgentWorkflows.id, workflow.id)),
      db
        .update(workspaceAgentUsage)
        .set({ status: "failure", errorMessage: `任务入队失败：${reason.slice(0, 400)}` })
        .where(
          and(
            eq(workspaceAgentUsage.generationTaskId, ids.generationTaskId),
            eq(workspaceAgentUsage.kind, "image"),
          ),
        ),
    ])
    return { ok: false, error: "示例图任务入队失败，积分已退还" }
  }

  return { ok: true, ...ids }
}

/**
 * 生图任务终态钩子（processor.ts 调用）：按 generationTaskId 反查方向示例图
 * preview，成功回写 preview/direction.imageUrl 并计 imageCount；失败标 failed
 * 并把 usage 记账与 imageCostCredits 回退（队列已按张退个人配额）。
 * 幂等：preview 已终态则跳过；无 preview 关联的任务为空操作。
 */
export async function maybeCompleteWorkspaceAgentPreview(
  generationTaskId: string,
): Promise<void> {
  const [preview] = await db
    .select()
    .from(workspaceAgentPreviews)
    .where(eq(workspaceAgentPreviews.generationTaskId, generationTaskId))
    .limit(1)
  if (!preview || preview.kind !== "direction") return
  if (preview.status === "completed" || preview.status === "failed") return

  const [genTask] = await db
    .select()
    .from(generationTasks)
    .where(eq(generationTasks.id, generationTaskId))
    .limit(1)
  if (!genTask) return

  const imageUrls = (genTask.resultImages ?? []).filter(Boolean)
  const failed = genTask.status === "failed" || imageUrls.length === 0

  if (failed) {
    await db
      .update(workspaceAgentPreviews)
      .set({
        status: "failed",
        errorMessage: (genTask.errorMessage ?? "示例图生成失败").slice(0, 400),
        updatedAt: new Date(),
      })
      .where(eq(workspaceAgentPreviews.id, preview.id))
    // 记账回退：该张费用已由生图队列按张退还个人配额
    await db
      .update(workspaceAgentUsage)
      .set({ status: "failure", errorMessage: `示例图生成失败：${(genTask.errorMessage ?? "").slice(0, 300)}` })
      .where(
        and(
          eq(workspaceAgentUsage.generationTaskId, generationTaskId),
          eq(workspaceAgentUsage.kind, "image"),
        ),
      )
    if (preview.workflowId) {
      await db
        .update(workspaceAgentWorkflows)
        .set({
          imageCostCredits: sql`greatest(0, ${workspaceAgentWorkflows.imageCostCredits} - ${genTask.costPerImage ?? 0})`,
          updatedAt: new Date(),
        })
        .where(eq(workspaceAgentWorkflows.id, preview.workflowId))
    }
    await logWaEvent({
      workflowId: preview.workflowId,
      enterpriseId: preview.enterpriseId,
      nodeKey: "style_director",
      action: "fail",
      status: "warn",
      detail: `方向示例图生成失败：${(genTask.errorMessage ?? "未知原因").slice(0, 200)}（积分已退还）`,
    })
    return
  }

  const imageUrl = imageUrls[0]!
  await db
    .update(workspaceAgentPreviews)
    .set({ status: "completed", imageUrl, errorMessage: null, updatedAt: new Date() })
    .where(eq(workspaceAgentPreviews.id, preview.id))
  if (preview.directionId) {
    await db
      .update(workspaceAgentDirections)
      .set({ exampleImageUrl: imageUrl, updatedAt: new Date() })
      .where(eq(workspaceAgentDirections.id, preview.directionId))
  }
  if (preview.workflowId) {
    await db
      .update(workspaceAgentWorkflows)
      .set({
        imageCount: sql`${workspaceAgentWorkflows.imageCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceAgentWorkflows.id, preview.workflowId))
  }
  await logWaEvent({
    workflowId: preview.workflowId,
    enterpriseId: preview.enterpriseId,
    nodeKey: "style_director",
    action: "done",
    status: "ok",
    detail: "方向示例图已生成（卡面尺寸，不计入卡片网格）",
  })
}

// ---------------------------------------------------------------------------
// 生图队列终态 → review_image job（processor.ts 调用）
// ---------------------------------------------------------------------------

/**
 * 生图任务终态钩子：source = "agent" 且关联 workspace_agent_round 的任务，
 * 入一个 review_image job（cardKind 声明批次卡类）。幂等：同一生图任务已有
 * 排队/执行中的评审 job 则跳过；非 agent 来源任务与用户上传图（无生图任务）
 * 一律不触发评审。
 */
export async function maybeEnqueueWorkspaceAgentReview(
  generationTaskId: string,
): Promise<void> {
  const [task] = await db
    .select({
      id: generationTasks.id,
      source: generationTasks.source,
      deletedAt: generationTasks.deletedAt,
    })
    .from(generationTasks)
    .where(eq(generationTasks.id, generationTaskId))
    .limit(1)
  if (!task || task.deletedAt || task.source !== "agent") return

  const [round] = await db
    .select({
      id: workspaceAgentRounds.id,
      workflowId: workspaceAgentRounds.workflowId,
      cardId: workspaceAgentRounds.cardId,
    })
    .from(workspaceAgentRounds)
    .where(eq(workspaceAgentRounds.generationTaskId, generationTaskId))
    .limit(1)
  if (!round) return

  const [workflow] = await db
    .select({
      id: workspaceAgentWorkflows.id,
      enterpriseId: workspaceAgentWorkflows.enterpriseId,
      userId: workspaceAgentWorkflows.userId,
      status: workspaceAgentWorkflows.status,
    })
    .from(workspaceAgentWorkflows)
    .where(eq(workspaceAgentWorkflows.id, round.workflowId))
    .limit(1)
  if (!workflow || workflow.status === "cancelled" || workflow.status === "completed") {
    return
  }

  const [card] = await db
    .select({
      kind: workspaceAgentCards.kind,
      status: workspaceAgentCards.status,
    })
    .from(workspaceAgentCards)
    .where(eq(workspaceAgentCards.id, round.cardId))
    .limit(1)
  if (!card || card.status === "cancelled" || card.status === "confirmed") return

  const active = await db
    .select({ id: workspaceAgentJobs.id })
    .from(workspaceAgentJobs)
    .where(
      and(
        eq(workspaceAgentJobs.workflowId, workflow.id),
        eq(workspaceAgentJobs.jobType, "review_image"),
        inArray(workspaceAgentJobs.status, ["queued", "processing"]),
        sql`${workspaceAgentJobs.payload}->>'generationTaskId' = ${generationTaskId}`,
      ),
    )
    .limit(1)
  if (active.length > 0) return

  await db.insert(workspaceAgentJobs).values({
    enterpriseId: workflow.enterpriseId,
    userId: workflow.userId,
    workflowId: workflow.id,
    cardKind: card.kind,
    jobType: "review_image",
    payload: {
      generationTaskId,
      cardId: round.cardId,
      roundId: round.id,
      reason: "generation-terminal",
      requestedAt: new Date().toISOString(),
    },
  })
}

// ---------------------------------------------------------------------------
// 评审投票解析与意见汇总
// ---------------------------------------------------------------------------

/** 单评审员解析后的投票（三维 0-100 + 违规项 + 逐维理由） */
interface ReviewerVote {
  reviewerId: string
  reviewerName: string | null
  content: number
  aesthetic: number
  consistency: number
  violations: string[]
  reasons: Partial<Record<"content" | "aesthetic" | "consistency", string>>
}

function clampScoreValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

function strField(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 600) : ""
}

function parseReviewerVote(
  reviewerId: string,
  reviewerName: string | null,
  raw: Record<string, unknown>,
): ReviewerVote {
  const pick = (key: string): number | null => clampScoreValue(raw[key])
  const content = pick("contentScore")
  const aesthetic = pick("aestheticScore")
  const consistency = pick("consistencyScore")
  if (content == null || aesthetic == null || consistency == null) {
    throw new LlmValidationError(
      "缺少三维数值评分（contentScore / aestheticScore / consistencyScore 须为 0-100 整数）",
    )
  }
  const violations = Array.isArray(raw.violations)
    ? raw.violations
        .filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
        .map((v) => v.trim().slice(0, 40))
        .slice(0, 8)
    : []
  const reasons: ReviewerVote["reasons"] = {}
  const contentReason = strField(raw.contentReason)
  const aestheticReason = strField(raw.aestheticReason)
  const consistencyReason = strField(raw.consistencyReason)
  if (contentReason) reasons.content = contentReason
  if (aestheticReason) reasons.aesthetic = aestheticReason
  if (consistencyReason) reasons.consistency = consistencyReason
  return {
    reviewerId,
    reviewerName,
    content,
    aesthetic,
    consistency,
    violations,
    reasons,
  }
}

/** 评审意见汇总（打回时 prompt designer 改写的唯一依据） */
function buildReviewFeedback(
  votes: readonly ReviewerVote[],
  aggregated: { content: number; aesthetic: number; consistency: number },
): string {
  const lines = [
    `三维聚合分：内容 ${aggregated.content} / 审美 ${aggregated.aesthetic} / 一致性 ${aggregated.consistency}`,
  ]
  const violationSet = new Set<string>()
  for (const vote of votes) {
    for (const v of vote.violations) violationSet.add(v)
    const reasonParts = [
      vote.reasons.content && `内容：${vote.reasons.content}`,
      vote.reasons.aesthetic && `审美：${vote.reasons.aesthetic}`,
      vote.reasons.consistency && `一致性：${vote.reasons.consistency}`,
    ].filter(Boolean)
    if (reasonParts.length > 0) {
      lines.push(
        `评审员${vote.reviewerName ? `（${vote.reviewerName}）` : ""}：${reasonParts.join("；")}`,
      )
    }
  }
  if (violationSet.size > 0) {
    lines.push(`违规项：${[...violationSet].join("、")}`)
  }
  return lines.join("\n").slice(0, 2000)
}

/** 从落库 review 行重建评审意见（job 重试恢复路径用） */
function buildFeedbackFromRows(
  rows: { nodeKey: string; result: unknown }[],
): string {
  const votes: ReviewerVote[] = []
  for (const row of rows) {
    const payload = row.result as WorkspaceAgentReviewerReviewPayload
    if (!payload || typeof payload !== "object" || !("scores" in payload)) continue
    votes.push({
      reviewerId: payload.reviewerId,
      reviewerName: payload.reviewerName ?? null,
      content: payload.scores.content ?? 0,
      aesthetic: payload.scores.aesthetic ?? 0,
      consistency: payload.scores.consistency ?? 0,
      violations: payload.violations ?? [],
      reasons: payload.reasons ?? {},
    })
  }
  if (votes.length === 0) return "（历史评审意见缺失）"
  const avg = (pick: (v: ReviewerVote) => number) =>
    Math.round(votes.reduce((s, v) => s + pick(v), 0) / votes.length)
  return buildReviewFeedback(votes, {
    content: avg((v) => v.content),
    aesthetic: avg((v) => v.aesthetic),
    consistency: avg((v) => v.consistency),
  })
}

// ---------------------------------------------------------------------------
// 评审 job（workspace-agent-processor 认领后执行）
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM_PROMPT = [
  "你是成套卡牌评审团的评审员。对给出的「实际生成图」做三维评审：",
  "1. contentScore 内容对齐（0-100 整数）：图片与卡片提示词、牌名/牌义的吻合度；",
  "2. aestheticScore 审美质量（0-100 整数）：构图、色彩、细节完成度、画面美感；",
  "3. consistencyScore 成套一致性（0-100 整数）：与风格规范书/选定方向的风格统一性。",
  "评分口径：70 分为及格线附近，宁严勿宽；理由必须具体（指出问题所在），理由是打回时改写提示词的唯一依据。",
  "【输出格式】只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
  '{ "contentScore": 0, "aestheticScore": 0, "consistencyScore": 0, "contentReason": "具体依据", "aestheticReason": "具体依据", "consistencyReason": "具体差异", "violations": ["出现文字/数量错误/边缘装饰等问题的短 key，无则空数组"] }',
].join("\n")

/** 生图失败收尾（队列已退个人配额；此处修正记账与卡片状态） */
async function handleGenerationFailure(
  workflow: WorkspaceAgentWorkflowRow,
  card: WorkspaceAgentCardRow,
  round: { id: string; roundNumber: number; generationTaskId: string | null },
  genTask: typeof generationTasks.$inferSelect,
): Promise<Record<string, unknown>> {
  const refunded =
    genTask.costPerImage != null
      ? Math.max(0, genTask.costPerImage * genTask.imageCount - genTask.creditsCharged)
      : 0
  if (refunded > 0) {
    await db
      .update(workspaceAgentWorkflows)
      .set({
        imageCostCredits: sql`greatest(0, ${workspaceAgentWorkflows.imageCostCredits} - ${refunded})`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceAgentWorkflows.id, workflow.id))
  }
  const message = (genTask.errorMessage ?? "生图失败").slice(0, 500)
  if (round.generationTaskId) {
    await db
      .update(workspaceAgentUsage)
      .set({ status: "failure", errorMessage: `生图失败：${message}` })
      .where(
        and(
          eq(workspaceAgentUsage.generationTaskId, round.generationTaskId),
          eq(workspaceAgentUsage.kind, "image"),
        ),
      )
  }
  await db
    .update(workspaceAgentCards)
    .set({ status: "failed", errorMessage: message, updatedAt: new Date() })
    .where(eq(workspaceAgentCards.id, card.id))
  await logWaEvent({
    workflowId: workflow.id,
    enterpriseId: workflow.enterpriseId,
    nodeKey: "artist",
    action: "fail",
    status: "error",
    detail: `第 ${round.roundNumber} 轮生图失败（积分已退还）：${message}`,
    cardId: card.id,
  })
  return { outcome: "generation_failed", refunded }
}

/** 找到生图任务下最早的已完成 card_image（本轮候选图的入库行） */
async function resolveRoundCardImageId(
  generationTaskId: string | null,
): Promise<string | null> {
  if (!generationTaskId) return null
  const [img] = await db
    .select({ id: cardImages.id })
    .from(cardImages)
    .where(
      and(
        eq(cardImages.generationTaskId, generationTaskId),
        eq(cardImages.status, "completed"),
      ),
    )
    .orderBy(asc(cardImages.createdAt))
    .limit(1)
  return img?.id ?? null
}

/** 选中图落库（同卡互斥 isSelected + prompt_card.selectedImageId，语义同 selectCardImageAction） */
async function applyCardImageSelection(
  enterpriseId: string,
  promptCardId: string,
  imageId: string,
): Promise<void> {
  const now = new Date()
  await db
    .update(cardImages)
    .set({ isSelected: false, updatedAt: now })
    .where(
      and(
        eq(cardImages.cardId, promptCardId),
        eq(cardImages.enterpriseId, enterpriseId),
      ),
    )
  await db
    .update(cardImages)
    .set({ isSelected: true, updatedAt: now })
    .where(eq(cardImages.id, imageId))
  await db
    .update(promptCards)
    .set({ selectedImageId: imageId, updatedAt: now })
    .where(eq(promptCards.id, promptCardId))
}

/** 通过收尾：round 选中本图，卡 approved_by_ai，回链 prompt_card 选中图 */
async function applyApproval(
  workflow: WorkspaceAgentWorkflowRow,
  card: WorkspaceAgentCardRow,
  round: typeof workspaceAgentRounds.$inferSelect,
  imageUrl: string,
  weightedTotalScore: number | null,
  qualityThreshold: number,
): Promise<void> {
  const cardImageId = await resolveRoundCardImageId(round.generationTaskId)
  await db
    .update(workspaceAgentRounds)
    .set({
      imageUrl,
      selectedCardImageId: cardImageId,
      candidates: [{ url: imageUrl, score: weightedTotalScore, contentPass: null }],
    })
    .where(eq(workspaceAgentRounds.id, round.id))
  await db
    .update(workspaceAgentCards)
    .set({
      status: "approved_by_ai",
      finalRoundId: round.id,
      fallbackContentWarning: false,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaceAgentCards.id, card.id))
  if (cardImageId && card.promptCardId) {
    await applyCardImageSelection(card.enterpriseId, card.promptCardId, cardImageId)
  }
  await db
    .update(workspaceAgentWorkflows)
    .set({
      imageCount: sql`${workspaceAgentWorkflows.imageCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(workspaceAgentWorkflows.id, workflow.id))
  await logWaEvent({
    workflowId: workflow.id,
    enterpriseId: workflow.enterpriseId,
    nodeKey: "review_panel",
    action: "done",
    status: "ok",
    detail: `第 ${round.roundNumber} 轮评审通过：加权总分 ${weightedTotalScore ?? "?"} ≥ 质量线 ${qualityThreshold}，已选为本卡终图`,
    cardId: card.id,
  })
}

/** 打回改写（prompt designer）：基于当前提示词 + 评审意见，产出完整新提示词 */
async function rewritePromptWithFeedback(input: {
  workflow: WorkspaceAgentWorkflowRow
  currentPrompt: string
  feedback: string
}): Promise<string> {
  const ext = readWorkflowInput(input.workflow)
  if (!ext.chatModelId) throw new Error("工作流未配置主控对话模型，无法改写提示词")
  const model = await loadWorkspaceAgentChatModel(
    ext.chatModelId,
    input.workflow.enterpriseId,
  )
  const systemPrompt = [
    "你是成套卡牌的提示词设计师。评审团打回了当前卡牌的生成图，请依据评审意见改写提示词供重新生图。",
    "要求：",
    "1. 保留原提示词中仍然成立的内容，只针对评审指出的问题做最小必要修改；",
    "2. 原提示词中的【固定风格提示词】段落（如有）必须逐字保留，不得改写；",
    "3. 改写后仍为中文画面描述（120-200 字单段），不输出任何负向禁令或「不要出现××」类表述。",
    "【输出格式】只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
    '{ "prompt": "改写后的完整提示词" }',
  ].join("\n")
  const userText = [
    `【当前提示词】${input.currentPrompt.slice(0, 2400)}`,
    `【评审意见】${input.feedback}`,
    "请输出改写后的完整提示词。",
  ].join("\n\n")
  const parsed = await callWorkspaceAgentLlmJson<{ prompt?: unknown }>({
    workflow: input.workflow,
    model,
    nodeKey: "prompt_designer",
    systemPrompt,
    messages: [{ role: "user", content: userText }],
    thinkingLevel: "medium",
    validate: (raw) => {
      const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : ""
      if (prompt.length < 40) {
        throw new LlmValidationError("改写后的提示词缺失或过短（不足 40 字）")
      }
    },
  })
  return (parsed.prompt as string).trim()
}

/**
 * 打回轮数 +1（条件更新防 job 重试恢复时重复计数：仅当 roundsUsed 仍等于
 * 读取值时才递增）。返回是否本次生效。
 */
async function consumeRetryRound(
  cardId: string,
  expectedRoundsUsed: number,
): Promise<boolean> {
  const rows = await db
    .update(workspaceAgentCards)
    .set({ roundsUsed: expectedRoundsUsed + 1, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceAgentCards.id, cardId),
        eq(workspaceAgentCards.roundsUsed, expectedRoundsUsed),
      ),
    )
    .returning({ id: workspaceAgentCards.id })
  return rows.length > 0
}

/** 该卡是否存在排队/执行中的评审任务（重启/再生成前置守卫） */
export async function hasPendingReviewJob(cardId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: workspaceAgentJobs.id })
    .from(workspaceAgentJobs)
    .where(
      and(
        eq(workspaceAgentJobs.jobType, "review_image"),
        inArray(workspaceAgentJobs.status, ["queued", "processing"]),
        sql`${workspaceAgentJobs.payload}->>'cardId' = ${cardId}`,
      ),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * 按意见改写提示词 → 写回 prompt_card → 同一冻结模型与 kind 尺寸自动生成
 * 下一轮（terminal 后再次自动评审）。打回续跑（按评审意见）与「重新
 * Agent 生成（带修改意见）」共用；startAgentCardGeneration 事务内会同步
 * 更新 agent 卡 currentPrompt / 状态 generating。
 * 生成失败（余额不足/入队失败等）时卡标 failed 并留痕，不虚标兜底。
 */
async function reviseAndRegenerate(input: {
  workflow: WorkspaceAgentWorkflowRow
  card: WorkspaceAgentCardRow
  currentPrompt: string
  feedback: string
  /** 打回续跑传当前轮号（日志展示 N → N+1）；重新 Agent 生成传 null */
  roundNumber: number | null
  /** 场景标签（打回续跑 / 重新 Agent 生成），仅用于事件日志 */
  scenario: "review_retry" | "manual_restart"
}): Promise<{ outcome: string; roundId?: string }> {
  const { workflow, card, currentPrompt, feedback, roundNumber, scenario } = input
  const isRetry = scenario === "review_retry"
  // 打回续跑必带轮数；manual_restart 无轮次概念（0 不参与其文案分支）
  const rn = roundNumber ?? 0
  await logWaEvent({
    workflowId: workflow.id,
    enterpriseId: workflow.enterpriseId,
    nodeKey: "prompt_designer",
    action: "retry",
    status: "warn",
    detail: isRetry
      ? `评审未过线，提示词设计师开始按评审意见改写（第 ${rn} 轮 → 第 ${rn + 1} 轮）`
      : "重新 Agent 生成：提示词设计师开始按修改意见改写提示词",
    cardId: card.id,
  })
  const nextPrompt = await rewritePromptWithFeedback({
    workflow,
    currentPrompt,
    feedback,
  })
  if (card.promptCardId) {
    await db
      .update(promptCards)
      .set({ prompt: nextPrompt, translationStatus: "outdated", updatedAt: new Date() })
      .where(eq(promptCards.id, card.promptCardId))
  }
  // 重读卡行（roundsUsed 等以最新落库为准）
  const [freshCard] = await db
    .select()
    .from(workspaceAgentCards)
    .where(eq(workspaceAgentCards.id, card.id))
    .limit(1)
  if (!freshCard) throw new Error("卡片不存在")
  const res = await startAgentCardGeneration({
    enterpriseId: workflow.enterpriseId,
    userId: workflow.userId,
    workflow,
    card: freshCard,
    prompt: nextPrompt,
    promptSource: "auto_revise",
  })
  if (!res.ok) {
    await db
      .update(workspaceAgentCards)
      .set({
        status: "failed",
        errorMessage: `${isRetry ? "打回后" : "重新生成"}重生成失败：${res.error}`.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(workspaceAgentCards.id, card.id))
    await logWaEvent({
      workflowId: workflow.id,
      enterpriseId: workflow.enterpriseId,
      nodeKey: "supervisor",
      action: "fail",
      status: "error",
      detail: `${isRetry ? "打回后" : "重新 Agent 生成"}自动重生成失败：${res.error}`,
      cardId: card.id,
    })
    return { outcome: "retry_aborted" }
  }
  await logWaEvent({
    workflowId: workflow.id,
    enterpriseId: workflow.enterpriseId,
    nodeKey: "prompt_designer",
    action: "done",
    status: "ok",
    detail: `已按${isRetry ? "评审意见" : "修改意见"}改写提示词并自动重新生图${
      isRetry ? `（第 ${rn + 1} 轮，同模型同尺寸）` : "（同模型同尺寸）"
    }`,
    cardId: card.id,
  })
  return { outcome: "retry", roundId: res.roundId }
}

/**
 * revise_prompt job：「重新 Agent 生成（带修改意见）」的异步执行体。
 * action 侧已完成轮数重置并把卡片置 drafting；此处按用户意见改写提示词
 * 并自动生图（终态自动进评审循环）。job 重试恢复时先把卡片复位 drafting。
 */
export async function runRevisePromptJob(
  workflow: WorkspaceAgentWorkflowRow,
  job: WorkspaceAgentJobRow,
): Promise<Record<string, unknown>> {
  const cardId = String(job.payload?.cardId ?? "")
  const feedback = String(job.payload?.feedback ?? "").trim()
  if (!cardId) throw new Error("revise_prompt 任务缺少 cardId")
  if (!feedback) throw new Error("revise_prompt 任务缺少修改意见")
  const [card] = await db
    .select()
    .from(workspaceAgentCards)
    .where(
      and(
        eq(workspaceAgentCards.id, cardId),
        eq(workspaceAgentCards.workflowId, workflow.id),
      ),
    )
    .limit(1)
  if (!card) throw new Error("卡片不存在或不属于当前工作流")
  // 在途守卫：job 排队/重试期间用户可能已手动触发生成，避免双开轮次
  if (["generating", "reviewing"].includes(card.status)) {
    throw new Error(`卡片当前为「${card.status}」，已跳过按意见改写（请等待本轮完成）`)
  }
  // 当前提示词：优先回链 prompt_card（用户可能手改过），缺省用卡片初稿
  let currentPrompt = card.currentPrompt ?? ""
  if (card.promptCardId) {
    const [pc] = await db
      .select({ prompt: promptCards.prompt })
      .from(promptCards)
      .where(eq(promptCards.id, card.promptCardId))
      .limit(1)
    if (pc?.prompt?.trim()) currentPrompt = pc.prompt
  }
  if (!currentPrompt.trim()) throw new Error("当前提示词为空，无法按意见改写")
  // 幂等复位「撰写中」（job 重试时卡片可能已被上一轮失败标 failed）
  await db
    .update(workspaceAgentCards)
    .set({ status: "drafting", errorMessage: null, updatedAt: new Date() })
    .where(eq(workspaceAgentCards.id, card.id))
  const r = await reviseAndRegenerate({
    workflow,
    card,
    currentPrompt,
    feedback,
    roundNumber: null,
    scenario: "manual_restart",
  })
  return { outcome: r.outcome, roundId: r.roundId ?? null }
}

/**
 * 打回续跑：改写提示词 → 写回 prompt_card / agent 卡 → 同一冻结模型与
 * kind 尺寸自动生成下一轮（terminal 后再次自动评审）。
 * 生成失败（余额不足/入队失败等）时卡标 failed 并留痕，不虚标兜底。
 */
async function continueWithRetry(
  workflow: WorkspaceAgentWorkflowRow,
  card: WorkspaceAgentCardRow,
  round: typeof workspaceAgentRounds.$inferSelect,
  feedback: string,
): Promise<{ outcome: string; roundId?: string }> {
  return reviseAndRegenerate({
    workflow,
    card,
    currentPrompt: round.prompt,
    feedback,
    roundNumber: round.roundNumber,
    scenario: "review_retry",
  })
}

/** 耗尽兜底：跨全部尝试选最高加权分的已评图轮为终图 */
async function applyFallback(
  workflow: WorkspaceAgentWorkflowRow,
  card: WorkspaceAgentCardRow,
): Promise<void> {
  const thresholds = readQualityThresholds(readWorkflowInput(workflow))
  const rounds = await db
    .select()
    .from(workspaceAgentRounds)
    .where(eq(workspaceAgentRounds.cardId, card.id))
    .orderBy(asc(workspaceAgentRounds.roundNumber))
  const best = pickBestScoredRound(rounds)
  await db
    .update(workspaceAgentCards)
    .set({
      status: "fallback",
      finalRoundId: best?.id ?? null,
      fallbackContentWarning: true,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaceAgentCards.id, card.id))
  if (best) {
    const cardImageId = await resolveRoundCardImageId(best.generationTaskId)
    if (cardImageId) {
      await db
        .update(workspaceAgentRounds)
        .set({ selectedCardImageId: cardImageId })
        .where(eq(workspaceAgentRounds.id, best.id))
      if (card.promptCardId) {
        await applyCardImageSelection(card.enterpriseId, card.promptCardId, cardImageId)
      }
    }
  }
  await logWaEvent({
    workflowId: workflow.id,
    enterpriseId: workflow.enterpriseId,
    nodeKey: "supervisor",
    action: "fallback",
    status: "warn",
    detail:
      `打回次数已耗尽（${card.roundsUsed}/${thresholds.maxRetries}），自动选用历史最高加权分兜底` +
      (best
        ? `（第 ${best.roundNumber} 轮，${best.candidates[0]?.score ?? "?"} 分）`
        : "（无可退回的已生成图）"),
    cardId: card.id,
  })
}

/** job 重试恢复：该轮已有裁决时按既有结论收口，不重复评审计费 */
async function resumeReviewOutcome(
  workflow: WorkspaceAgentWorkflowRow,
  card: WorkspaceAgentCardRow,
  round: typeof workspaceAgentRounds.$inferSelect,
  genTask: typeof generationTasks.$inferSelect,
  payload: WorkspaceAgentVerdictPayload,
): Promise<Record<string, unknown>> {
  const thresholds = readQualityThresholds(readWorkflowInput(workflow))
  const imageUrl = (genTask.resultImages ?? []).find(Boolean) ?? null
  // 打回/兜底裁决恢复时同样落 imageUrl 与加权分（首轮执行若崩在此前，
  // 该轮的图与分尚未写库；pickBestScoredRound 兜底选图依赖两者）
  if (payload.verdict !== "approve" && imageUrl) {
    await db
      .update(workspaceAgentRounds)
      .set({
        imageUrl,
        candidates: [
          { url: imageUrl, score: payload.weightedTotalScore ?? null, contentPass: null },
        ],
      })
      .where(eq(workspaceAgentRounds.id, round.id))
  }
  if (payload.verdict === "approve") {
    if (imageUrl) {
      await applyApproval(workflow, card, round, imageUrl, payload.weightedTotalScore ?? null, thresholds.qualityThreshold)
    }
    return { outcome: "resumed_approve" }
  }
  if (payload.verdict === "retry") {
    const [maxRow] = await db
      .select({ m: sql<number>`coalesce(max(${workspaceAgentRounds.roundNumber}), 0)` })
      .from(workspaceAgentRounds)
      .where(eq(workspaceAgentRounds.cardId, card.id))
    if (Number(maxRow?.m ?? 0) > round.roundNumber) {
      return { outcome: "resumed_retry" } // 下一轮已建，后续链路自会推进
    }
    // 补记打回轮数（条件更新：此前执行已 +1 时自动跳过，不重复计数）
    await consumeRetryRound(card.id, card.roundsUsed)
    const reviewRows = await db
      .select({ nodeKey: workspaceAgentReviews.nodeKey, result: workspaceAgentReviews.result })
      .from(workspaceAgentReviews)
      .where(
        and(
          eq(workspaceAgentReviews.roundId, round.id),
          eq(workspaceAgentReviews.kind, "review"),
        ),
      )
    const r = await continueWithRetry(workflow, card, round, buildFeedbackFromRows(reviewRows))
    return { outcome: `resumed_${r.outcome}` }
  }
  await applyFallback(workflow, card)
  return { outcome: "resumed_fallback" }
}

/**
 * review_image job：生图终态后的自动评审 / 打回 / 兜底循环。
 * 仅处理 source = "agent" 且 prompt_card 未锁定的生图任务（生成守卫的复核）。
 */
export async function runReviewImageJob(
  workflow: WorkspaceAgentWorkflowRow,
  job: WorkspaceAgentJobRow,
): Promise<Record<string, unknown>> {
  const generationTaskId = String(job.payload?.generationTaskId ?? "")
  if (!generationTaskId) throw new Error("review_image 任务缺少 generationTaskId")

  const [round] = await db
    .select()
    .from(workspaceAgentRounds)
    .where(eq(workspaceAgentRounds.generationTaskId, generationTaskId))
    .limit(1)
  if (!round) return { outcome: "skipped", reason: "generation_task_not_linked" }
  const [card] = await db
    .select()
    .from(workspaceAgentCards)
    .where(eq(workspaceAgentCards.id, round.cardId))
    .limit(1)
  if (!card) return { outcome: "skipped", reason: "card_missing" }
  const [genTask] = await db
    .select()
    .from(generationTasks)
    .where(eq(generationTasks.id, generationTaskId))
    .limit(1)
  if (!genTask) return { outcome: "skipped", reason: "generation_task_missing" }
  if (genTask.source !== "agent") return { outcome: "skipped", reason: "source_not_agent" }

  // 生成守卫复核：挂靠工作台任务须为 agent 来源，prompt_card 须已解锁
  if (workflow.workspaceTaskId) {
    const [wsTask] = await db
      .select({ source: workspaceTasks.source })
      .from(workspaceTasks)
      .where(eq(workspaceTasks.id, workflow.workspaceTaskId))
      .limit(1)
    if (wsTask && wsTask.source !== "agent") {
      return { outcome: "skipped", reason: "workspace_task_source_not_agent" }
    }
  }
  if (card.promptCardId) {
    const [promptCard] = await db
      .select({ isLocked: promptCards.isLocked })
      .from(promptCards)
      .where(eq(promptCards.id, card.promptCardId))
      .limit(1)
    if (promptCard?.isLocked) {
      return { outcome: "skipped", reason: "prompt_card_locked" }
    }
  }

  const imageUrls = (genTask.resultImages ?? []).filter(Boolean)
  if (genTask.status === "failed" || imageUrls.length === 0) {
    return handleGenerationFailure(workflow, card, round, genTask)
  }
  const imageUrl = imageUrls[0]!

  // 幂等恢复：该轮已有裁决（job 重试/backoff 后重入）→ 按既有结论收口
  const [existingVerdict] = await db
    .select()
    .from(workspaceAgentReviews)
    .where(
      and(
        eq(workspaceAgentReviews.roundId, round.id),
        eq(workspaceAgentReviews.kind, "verdict"),
      ),
    )
    .limit(1)
  if (existingVerdict) {
    return resumeReviewOutcome(
      workflow,
      card,
      round,
      genTask,
      existingVerdict.result as WorkspaceAgentVerdictPayload,
    )
  }

  const ext = readWorkflowInput(workflow)
  const thresholds = readQualityThresholds(ext)
  const reviewerIds =
    ext.reviewerChatModelIds && ext.reviewerChatModelIds.length > 0
      ? ext.reviewerChatModelIds
      : ext.chatModelId
        ? [ext.chatModelId]
        : []
  if (reviewerIds.length === 0) throw new Error("工作流未配置评审模型，无法评审")

  await db
    .update(workspaceAgentCards)
    .set({ status: "reviewing", updatedAt: new Date() })
    .where(eq(workspaceAgentCards.id, card.id))
  await logWaEvent({
    workflowId: workflow.id,
    enterpriseId: workflow.enterpriseId,
    nodeKey: "review_panel",
    action: "start",
    status: "ok",
    detail: `评审团开始评审「${card.name ?? `第 ${card.cardIndex + 1} 张`}」（${WORKSPACE_AGENT_KIND_LABELS[card.kind]}，第 ${round.roundNumber} 轮，${reviewerIds.length} 位评审员）`,
    cardId: card.id,
  })

  // 评审输入：选定方向概念 + 风格规范书 + 卡片提示词 + 实际生成图
  let directionName: string | null = null
  let directionConcept: string | null = null
  if (workflow.selectedDirectionId) {
    const [direction] = await db
      .select({
        name: workspaceAgentDirections.name,
        concept: workspaceAgentDirections.concept,
      })
      .from(workspaceAgentDirections)
      .where(eq(workspaceAgentDirections.id, workflow.selectedDirectionId))
      .limit(1)
    directionName = direction?.name ?? null
    directionConcept = direction?.concept ?? null
  }
  const reviewText = [
    `【卡片类型】${WORKSPACE_AGENT_KIND_LABELS[card.kind]}`,
    directionName
      ? `【选定方向】${directionName}${directionConcept ? `：${directionConcept}` : ""}`
      : "",
    workflow.styleDoc
      ? `【风格规范书】${workflow.styleDoc.slice(0, 1500)}`
      : "",
    `【卡片提示词】${round.prompt.slice(0, 2000)}`,
    "请对本消息附带的第一张图片（本轮实际生成图）做三维评审。",
  ]
    .filter(Boolean)
    .join("\n\n")

  const votes: ReviewerVote[] = []
  // 评审员缺失/失败原因（全失败时落卡展示给用户）
  const reviewerFailures: string[] = []
  for (const reviewerId of reviewerIds) {
    let model: WorkspaceAgentChatModelRow
    try {
      model = await loadWorkspaceAgentChatModel(reviewerId, workflow.enterpriseId)
    } catch {
      reviewerFailures.push(`评审员 ${reviewerId} 不可用`)
      await logWaEvent({
        workflowId: workflow.id,
        enterpriseId: workflow.enterpriseId,
        nodeKey: "review_panel",
        action: "fail",
        status: "warn",
        detail: `评审员 ${reviewerId} 不可用，本轮跳过`,
        cardId: card.id,
      })
      continue
    }
    if (!model.supportsVision) {
      reviewerFailures.push(`评审员 ${model.displayName} 不支持读图`)
      await logWaEvent({
        workflowId: workflow.id,
        enterpriseId: workflow.enterpriseId,
        nodeKey: "review_panel",
        action: "fail",
        status: "warn",
        detail: `评审员 ${model.displayName} 不支持读图，本轮跳过`,
        cardId: card.id,
      })
      continue
    }
    const parts: ChatContentPart[] = [
      { type: "text", text: reviewText },
      { type: "image_url", image_url: { url: signUploadToken(imageUrl) } },
    ]
    const startedAt = Date.now()
    try {
      const parsed = await callWorkspaceAgentLlmJson<Record<string, unknown>>({
        workflow,
        model,
        nodeKey: "review_panel",
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        messages: [{ role: "user", content: parts }],
        thinkingLevel: "low",
        validate: (raw) => {
          parseReviewerVote(reviewerId, model.displayName, raw)
        },
      })
      votes.push(parseReviewerVote(reviewerId, model.displayName, parsed))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reviewerFailures.push(`评审员 ${model.displayName} 调用失败：${message.slice(0, 120)}`)
      await recordWorkspaceAgentLlmFailure({
        workflow,
        model,
        nodeKey: "review_panel",
        errorMessage: message,
        durationMs: Date.now() - startedAt,
      })
      await logWaEvent({
        workflowId: workflow.id,
        enterpriseId: workflow.enterpriseId,
        nodeKey: "review_panel",
        action: "fail",
        status: "warn",
        detail: `评审员 ${model.displayName} 调用失败：${message.slice(0, 200)}`,
        cardId: card.id,
      })
    }
    // 心跳：续期 job 认领时间，防多评审长任务被 stale 恢复误判重排
    await db
      .update(workspaceAgentJobs)
      .set({ startedAt: new Date() })
      .where(eq(workspaceAgentJobs.id, job.id))
  }
  if (votes.length === 0) {
    const summary = `全部评审员评审失败：${reviewerFailures.join("；").slice(0, 400) || "未知原因"}`
    // 错误落卡：状态置 failed（卡面红色角标可展示原因，且可重新 Agent 生成），
    // 避免卡片永久停在「评审中」且无错误可查；job 照常 throw 留痕重试，
    // 重试恢复后评审流程会重新把卡片置回 reviewing，两者不冲突
    await db
      .update(workspaceAgentCards)
      .set({
        status: "failed",
        errorMessage: summary.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(workspaceAgentCards.id, card.id))
    throw new Error(summary)
  }

  // 聚合 + 加权总分（等权平均三维分 → round(0.4×审美 + 0.3×一致性 + 0.3×内容)）
  const avg = (pick: (v: ReviewerVote) => number): number =>
    Math.round(votes.reduce((s, v) => s + pick(v), 0) / votes.length)
  const aggregated = {
    content: avg((v) => v.content),
    aesthetic: avg((v) => v.aesthetic),
    consistency: avg((v) => v.consistency),
  }
  const weightedTotal = computeWeightedTotalScore(aggregated)
  const verdict = resolveReviewVerdict({
    weightedTotalScore: weightedTotal,
    qualityThreshold: thresholds.qualityThreshold,
    roundsUsed: card.roundsUsed,
    maxRetries: thresholds.maxRetries,
  })

  // 落库：按评审员 review 行 + 总控 verdict 行（写在前，重试恢复据此收口）
  const reviewRows: (typeof workspaceAgentReviews.$inferInsert)[] = votes.map(
    (vote) => {
      const payload: WorkspaceAgentReviewerReviewPayload = {
        reviewerId: vote.reviewerId,
        reviewerName: vote.reviewerName,
        scores: {
          content: vote.content,
          aesthetic: vote.aesthetic,
          consistency: vote.consistency,
        },
        violations: vote.violations,
        reasons: vote.reasons,
        weightedTotalScore: computeWeightedTotalScore({
          content: vote.content,
          aesthetic: vote.aesthetic,
          consistency: vote.consistency,
        }),
      }
      return {
        workflowId: workflow.id,
        cardId: card.id,
        roundId: round.id,
        nodeKey: reviewerNodeKey(vote.reviewerId),
        kind: "review" as const,
        result: payload,
      }
    },
  )
  const verdictPayload: WorkspaceAgentVerdictPayload = {
    verdict,
    // 信息留档（不参与通过判定）：内容维度聚合分与内容线比较
    contentPass: aggregated.content >= thresholds.contentThreshold,
    aestheticScore: aggregated.aesthetic,
    consistencyScore: aggregated.consistency,
    roundsUsed: card.roundsUsed,
    maxRetries: thresholds.maxRetries,
    detail:
      `加权总分 ${weightedTotal}（0.4×审美 ${aggregated.aesthetic} + 0.3×一致性 ${aggregated.consistency} + 0.3×内容 ${aggregated.content}）` +
      (verdict === "approve"
        ? ` ≥ 质量线 ${thresholds.qualityThreshold}，通过`
        : ` < 质量线 ${thresholds.qualityThreshold}` +
          (verdict === "retry"
            ? `，打回重写（已用 ${card.roundsUsed}/${thresholds.maxRetries} 轮）`
            : `，打回耗尽（${card.roundsUsed}/${thresholds.maxRetries}），兜底选历史最高分`)),
    contentScore: aggregated.content,
    weightedTotalScore: weightedTotal,
    qualityThreshold: thresholds.qualityThreshold,
  }
  reviewRows.push({
    workflowId: workflow.id,
    cardId: card.id,
    roundId: round.id,
    nodeKey: "supervisor",
    kind: "verdict" as const,
    result: verdictPayload,
  })
  await db.insert(workspaceAgentReviews).values(reviewRows)

  // 打回/兜底轮同样落 imageUrl 与加权分（applyApproval 仅覆盖通过路径）：
  // 打回耗尽时 applyFallback 的 pickBestScoredRound 依赖各轮 imageUrl +
  // candidates[0].score 选历史最高分兜底图，缺失则永远选不出图（finalRoundId
  // 为 null，用户只能看到兜底前的首图）；评审查询的回放图同样读 round.imageUrl
  if (verdict !== "approve") {
    await db
      .update(workspaceAgentRounds)
      .set({
        imageUrl,
        candidates: [{ url: imageUrl, score: weightedTotal, contentPass: null }],
      })
      .where(eq(workspaceAgentRounds.id, round.id))
  }

  if (verdict === "approve") {
    await applyApproval(workflow, card, round, imageUrl, weightedTotal, thresholds.qualityThreshold)
    return {
      outcome: "approved",
      weightedTotalScore: weightedTotal,
      scores: aggregated,
      roundsUsed: card.roundsUsed,
      maxRetries: thresholds.maxRetries,
    }
  }

  if (verdict === "retry") {
    // 打回：roundsUsed + 1（条件更新，与上限比较），改写并自动生成同尺寸下一轮
    await consumeRetryRound(card.id, card.roundsUsed)
    const feedback = buildReviewFeedback(votes, aggregated)
    const r = await continueWithRetry(workflow, card, round, feedback)
    return {
      outcome: r.outcome,
      weightedTotalScore: weightedTotal,
      scores: aggregated,
      roundsUsed: card.roundsUsed + 1,
      maxRetries: thresholds.maxRetries,
      nextRoundId: r.roundId ?? null,
    }
  }

  await applyFallback(workflow, card)
  return {
    outcome: "fallback",
    weightedTotalScore: weightedTotal,
    scores: aggregated,
    roundsUsed: card.roundsUsed,
    maxRetries: thresholds.maxRetries,
  }
}

// ---------------------------------------------------------------------------
// 评审查询（getWorkspaceAgentCardReviewAction 的服务端载荷）
// ---------------------------------------------------------------------------

export interface WorkspaceAgentCardReviewRound {
  roundId: string
  roundNumber: number
  promptSource: string | null
  imageUrl: string | null
  selectedCardImageId: string | null
  /** 本轮加权总分（candidates[0].score；未评为 null） */
  weightedTotalScore: number | null
  costCredits: number
  createdAt: string
  reviews: {
    reviewerId: string
    reviewerName: string | null
    scores: { content: number | null; aesthetic: number | null; consistency: number | null }
    violations: string[]
    reasons: Partial<Record<"content" | "aesthetic" | "consistency", string>>
    weightedTotalScore: number | null
    createdAt: string
  }[]
  verdict: {
    verdict: "approve" | "retry" | "fallback"
    weightedTotalScore: number | null
    scores: {
      content: number | null
      aesthetic: number | null
      consistency: number | null
    }
    roundsUsed: number
    maxRetries: number
    qualityThreshold: number | null
    detail: string
    createdAt: string
  } | null
}

export interface WorkspaceAgentCardReviewPayload {
  card: {
    id: string
    promptCardId: string | null
    kind: WorkspaceAgentCardKind
    name: string | null
    status: string
    roundsUsed: number
    maxRetries: number
    qualityThreshold: number
    finalRoundId: string | null
    fallbackContentWarning: boolean
    currentPrompt: string | null
  }
  rounds: WorkspaceAgentCardReviewRound[]
}

/** 按提示词卡 id 载入归属的 Agent 卡与工作流（enterpriseId + userId 双过滤） */
export async function loadOwnedAgentCardByPromptCard(
  enterpriseId: string,
  userId: string,
  promptCardId: string,
): Promise<{ card: WorkspaceAgentCardRow; workflow: WorkspaceAgentWorkflowRow } | null> {
  const [row] = await db
    .select({ card: workspaceAgentCards, workflow: workspaceAgentWorkflows })
    .from(workspaceAgentCards)
    .innerJoin(
      workspaceAgentWorkflows,
      eq(workspaceAgentCards.workflowId, workspaceAgentWorkflows.id),
    )
    .where(
      and(
        eq(workspaceAgentCards.promptCardId, promptCardId),
        eq(workspaceAgentWorkflows.enterpriseId, enterpriseId),
        eq(workspaceAgentWorkflows.userId, userId),
      ),
    )
    .orderBy(desc(workspaceAgentWorkflows.createdAt))
    .limit(1)
  return row ?? null
}

/** 评审查询：跨轮评审明细 + 裁决 + 阈值（action 的服务端聚合） */
export async function loadWorkspaceAgentCardReview(
  enterpriseId: string,
  userId: string,
  promptCardId: string,
): Promise<WorkspaceAgentCardReviewPayload | null> {
  const owned = await loadOwnedAgentCardByPromptCard(enterpriseId, userId, promptCardId)
  if (!owned) return null
  const { card, workflow } = owned
  const thresholds = readQualityThresholds(readWorkflowInput(workflow))

  const [rounds, reviewRows] = await Promise.all([
    db
      .select()
      .from(workspaceAgentRounds)
      .where(eq(workspaceAgentRounds.cardId, card.id))
      .orderBy(asc(workspaceAgentRounds.roundNumber)),
    db
      .select()
      .from(workspaceAgentReviews)
      .where(eq(workspaceAgentReviews.cardId, card.id))
      .orderBy(asc(workspaceAgentReviews.createdAt)),
  ])

  const byRound = new Map<string, WorkspaceAgentCardReviewRound>()
  for (const round of rounds) {
    byRound.set(round.id, {
      roundId: round.id,
      roundNumber: round.roundNumber,
      promptSource: round.promptSource,
      imageUrl: round.imageUrl,
      selectedCardImageId: round.selectedCardImageId,
      weightedTotalScore: round.candidates[0]?.score ?? null,
      costCredits: round.costCredits,
      createdAt: round.createdAt.toISOString(),
      reviews: [],
      verdict: null,
    })
  }
  for (const row of reviewRows) {
    const target = byRound.get(row.roundId)
    if (!target) continue
    if (row.kind === "verdict") {
      const payload = row.result as WorkspaceAgentVerdictPayload
      target.verdict = {
        verdict: payload.verdict,
        weightedTotalScore: payload.weightedTotalScore ?? null,
        scores: {
          content: payload.contentScore ?? null,
          aesthetic: payload.aestheticScore ?? null,
          consistency: payload.consistencyScore ?? null,
        },
        roundsUsed: payload.roundsUsed,
        maxRetries: payload.maxRetries,
        qualityThreshold: payload.qualityThreshold ?? null,
        detail: payload.detail,
        createdAt: row.createdAt.toISOString(),
      }
    } else {
      const payload = row.result as WorkspaceAgentReviewerReviewPayload
      if (!payload || typeof payload !== "object" || !("scores" in payload)) continue
      target.reviews.push({
        reviewerId: payload.reviewerId,
        reviewerName: payload.reviewerName ?? null,
        scores: {
          content: payload.scores.content ?? null,
          aesthetic: payload.scores.aesthetic ?? null,
          consistency: payload.scores.consistency ?? null,
        },
        violations: payload.violations ?? [],
        reasons: payload.reasons ?? {},
        weightedTotalScore: payload.weightedTotalScore ?? null,
        createdAt: row.createdAt.toISOString(),
      })
    }
  }

  return {
    card: {
      id: card.id,
      promptCardId: card.promptCardId,
      kind: card.kind,
      name: card.name,
      status: card.status,
      roundsUsed: card.roundsUsed,
      maxRetries: thresholds.maxRetries,
      qualityThreshold: thresholds.qualityThreshold,
      finalRoundId: card.finalRoundId,
      fallbackContentWarning: card.fallbackContentWarning,
      currentPrompt: card.currentPrompt,
    },
    rounds: [...byRound.values()],
  }
}
