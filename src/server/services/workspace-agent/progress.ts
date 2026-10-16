/**
 * 工作台 Agent 进度聚合（getWorkspaceAgentProgressAction 的服务端载荷）
 *
 * 单次查询聚合：workflow 状态 / 四阶段计数与展示状态 / 七角色状态 / 用量
 * 统计 / 卡片计数 / 候选方向 / 事件时间线，并附「弹窗兼容」dialog 投影
 * （workspace-agent-dialog 的 stats/cardSummary/agents 与进度弹窗的固定
 * 四阶段 logs）。载荷整体包在 ActionResult.progress 下（UI normalize 侧
 * 先看 ok 再取 progress）。
 *
 * 状态推导只读不落库：阶段游标 = styleDoc 是否定稿（clarify → draft）→
 * 提示词全量完成后进入 art（生图/评审循环，approved/fallback/failed 均计
 * 落定）；compose 交付阶段本期未接入恒 locked。
 */
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  workspaceAgentCards,
  workspaceAgentDirections,
  workspaceAgentEvents,
  workspaceAgentJobs,
  workspaceAgentOracleCopies,
  workspaceAgentPreviews,
  workspaceAgentReviews,
  workspaceAgentUsage,
  workspaceAgentWorkflows,
  type WorkspaceAgentWorkflowRow,
} from "@/db/schema"
import {
  WORKSPACE_AGENT_ROLE_IDS,
  type WorkspaceAgentCardStatus,
  type WorkspaceAgentRoleId,
  type WorkspaceAgentRoleState,
  type WorkspaceAgentRoleStatus,
  type WorkspaceAgentStage,
  type WorkspaceAgentStageProgress,
  type WorkspaceAgentStageStatus,
} from "@/lib/workspace/agent-types"
import { readWorkflowInput } from "./input"

// ---------------------------------------------------------------------------
// 载荷类型
// ---------------------------------------------------------------------------

export interface WorkspaceAgentProgressDirection {
  id: string
  name: string
  concept: string | null
  worldview: string | null
  palette: string | null
  visualLanguage: string | null
  stylePhrase: string | null
  sampleCards: { name: string; scene: string }[]
  exampleImageUrl: string | null
  /** 示例图生成状态（null = 未入队，如主题轮方向） */
  exampleImageStatus: "pending" | "generating" | "completed" | "failed" | null
  status: string
  /** theme = 主题轮（第一轮）；direction = 创作方向轮（第二轮） */
  round: "theme" | "direction"
}

export interface WorkspaceAgentProgressPayload {
  workflow: {
    id: string
    title: string | null
    status: WorkspaceAgentWorkflowRow["status"]
    currentStage: WorkspaceAgentStage
    styleDoc: string | null
    error: string | null
    createdAt: string
    updatedAt: string
  }
  input: {
    templateKey: string
    cardCount: number
    prompt: string
    stylePrompt: string | null
    referenceStyleAnalysis: string | null
    referenceStyleAnalysisStatus: "pending" | "completed" | "failed" | null
    referenceStyleAnalysisError: string | null
    chatModelId: string | null
    reviewerChatModelIds: string[]
    imageModelId: string | null
    sizes: Record<string, string> | null
    quality: {
      contentThreshold: number
      aestheticThreshold: number
      consistencyThreshold: number
      maxRetries: number
    }
    imaginationLevel: string | null
    styleConfirmedAt: string | null
    referenceImages: string[]
    /** 第一轮（主题）批次 id（区分两轮行；旧数据为 null） */
    themeDirectionIds: string[] | null
    /** 第二轮（创作方向）批次 id（回退恢复范围与展示口径；旧数据为 null） */
    directionBatchIds: string[] | null
    /** 回退留档的原选中 id（展示「上次选择」徽标；未回退为 null） */
    lastSelectedThemeId: string | null
    lastSelectedDirectionId: string | null
    /** 回退次数（单调递增；前端据此让视图步骤跟随服务端推导回跳） */
    rollbackCount: number
  }
  stages: WorkspaceAgentStageProgress[]
  /** 服务端聚合推导的当前阶段（与 stageStatuses 同口径；优先于 DB workflow.currentStage） */
  currentStage: WorkspaceAgentStage
  stageStatuses: Record<WorkspaceAgentStage, WorkspaceAgentStageStatus>
  roles: WorkspaceAgentRoleState[]
  usage: {
    llmCallCount: number
    costCenticredits: number
    unbilledCenticredits: number
    imageCount: number
    imageCostCredits: number
    inputTokens: number
    outputTokens: number
  }
  cards: {
    total: number
    byStatus: Partial<Record<WorkspaceAgentCardStatus, number>>
    promptsWritten: number
    /** 打回耗尽兜底（fallback）张数 */
    exhausted: number
    /** 已产生的评审记录条数（kind = review，按评审员 × 轮计） */
    reviewCount: number
    /** 打回总轮次（所有卡 roundsUsed 累计） */
    totalRetries: number
  }
  directions: WorkspaceAgentProgressDirection[]
  selectedThemeId: string | null
  selectedDirectionId: string | null
  jobs: { queued: number; processing: number }
  /** 神谕文案交付进度（仅 oracle58 模板；其余为 null） */
  oracleCopy: { written: number; total: number; confirmed: boolean } | null
  events: {
    id: string
    nodeKey: string | null
    action: string
    status: string
    detail: string | null
    /** 所属流水线模块（style_confirm/theme/…/art；旧行与系统级事件为空） */
    stage: string | null
    createdAt: string
  }[]
  /** 弹窗兼容投影（workspace-agent-dialog / 进度弹窗统计与团队面板） */
  dialog: {
    stats: {
      conversationCount: number
      imageCount: number
      tokenUsed: number
      /** 生图调用次数（usage 台账 kind=image，全部状态含失败/超时） */
      imageCallCount: number
      /** 对话调用次数（usage 台账 kind=llm，全部状态含失败/超时） */
      llmCallCount: number
    }
    cardSummary: { total: number; completed: number; generating: number; failed: number }
    agents: {
      id: string
      name: string
      duty: string
      status: string
      currentTask: string | null
      color: string
      progressPercent: number | null
    }[]
  }
}

// ---------------------------------------------------------------------------
// 角色推导
// ---------------------------------------------------------------------------

const ROLE_META: Record<WorkspaceAgentRoleId, { name: string; duty: string; color: string }> = {
  creative_director: { name: "创意总监", duty: "需求澄清与风格确认", color: "#7c5cff" },
  style_director: { name: "风格策划", duty: "主题与方向拟定、方向示例图", color: "#2dd4bf" },
  prompt_designer: { name: "提示词设计师", duty: "逐张撰写卡牌提示词", color: "#f59e0b" },
  artist: { name: "画师", duty: "卡面生图（冻结模型与尺寸）", color: "#38bdf8" },
  review_panel: { name: "评审团", duty: "三维评审（40/30/30 加权总分）", color: "#fb7185" },
  compositor: { name: "合成师", duty: "套件装配与交付（未接入）", color: "#a3e635" },
  supervisor: { name: "总控", duty: "任务调度与裁决", color: "#94a3b8" },
}

function roleStatusFromEventAction(action: string): WorkspaceAgentRoleStatus {
  switch (action) {
    case "start":
      return "active"
    case "done":
    case "confirm":
    case "resume":
      return "done"
    case "fail":
      return "failed"
    default:
      return "idle"
  }
}

// ---------------------------------------------------------------------------
// 主聚合
// ---------------------------------------------------------------------------

export async function loadWorkspaceAgentProgress(
  workflowId: string,
): Promise<WorkspaceAgentProgressPayload | null> {
  const [workflow] = await db
    .select()
    .from(workspaceAgentWorkflows)
    .where(eq(workspaceAgentWorkflows.id, workflowId))
  if (!workflow) return null
  const input = readWorkflowInput(workflow)

  const [directionRows, cardStatusRows, usageRows, usageKindRows, eventRows, jobRows, reviewCountRows, previewRows, oracleRows, faceCountRows] =
    await Promise.all([
      db
        .select()
        .from(workspaceAgentDirections)
        .where(eq(workspaceAgentDirections.workflowId, workflowId))
        .orderBy(asc(workspaceAgentDirections.sortOrder), asc(workspaceAgentDirections.createdAt)),
      db
        .select({
          status: workspaceAgentCards.status,
          count: sql<number>`count(*)::int`,
          prompts: sql<number>`count(*) FILTER (WHERE ${workspaceAgentCards.currentPrompt} IS NOT NULL AND ${workspaceAgentCards.currentPrompt} <> '')::int`,
          retries: sql<number>`COALESCE(SUM(${workspaceAgentCards.roundsUsed}), 0)::int`,
        })
        .from(workspaceAgentCards)
        .where(eq(workspaceAgentCards.workflowId, workflowId))
        .groupBy(workspaceAgentCards.status),
      db
        .select({
          inputTokens: sql<number>`COALESCE(SUM(${workspaceAgentUsage.inputTokens}), 0)::int`,
          outputTokens: sql<number>`COALESCE(SUM(${workspaceAgentUsage.outputTokens}), 0)::int`,
        })
        .from(workspaceAgentUsage)
        .where(eq(workspaceAgentUsage.workflowId, workflowId)),
      // 调用次数（台账每行一次 API 调用，按 kind 分组；全部状态含失败/超时）
      db
        .select({ kind: workspaceAgentUsage.kind, count: sql<number>`count(*)::int` })
        .from(workspaceAgentUsage)
        .where(eq(workspaceAgentUsage.workflowId, workflowId))
        .groupBy(workspaceAgentUsage.kind),
      db
        .select()
        .from(workspaceAgentEvents)
        .where(eq(workspaceAgentEvents.workflowId, workflowId))
        .orderBy(desc(workspaceAgentEvents.createdAt))
        // 面板日志按 stage 模块过滤，需保留各模块历史行（客户端每面板再截 20 条）
        .limit(200),
      db
        .select({ status: workspaceAgentJobs.status, count: sql<number>`count(*)::int` })
        .from(workspaceAgentJobs)
        .where(eq(workspaceAgentJobs.workflowId, workflowId))
        .groupBy(workspaceAgentJobs.status),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(workspaceAgentReviews)
        .where(
          and(
            eq(workspaceAgentReviews.workflowId, workflowId),
            eq(workspaceAgentReviews.kind, "review"),
          ),
        ),
      // 方向示例图状态（向导按 pending/generating/completed/failed 渲染）
      db
        .select({
          directionId: workspaceAgentPreviews.directionId,
          status: workspaceAgentPreviews.status,
        })
        .from(workspaceAgentPreviews)
        .where(
          and(
            eq(workspaceAgentPreviews.workflowId, workflowId),
            eq(workspaceAgentPreviews.kind, "direction"),
          ),
        ),
      // 神谕文案交付进度（oracle 模板；其余模板为 0 行）
      db
        .select({
          locale: workspaceAgentOracleCopies.locale,
          status: workspaceAgentOracleCopies.status,
          count: sql<number>`count(*)::int`,
        })
        .from(workspaceAgentOracleCopies)
        .innerJoin(
          workspaceAgentCards,
          eq(workspaceAgentOracleCopies.cardId, workspaceAgentCards.id),
        )
        .where(
          and(
            eq(workspaceAgentOracleCopies.workflowId, workflowId),
            eq(workspaceAgentCards.kind, "face"),
          ),
        )
        .groupBy(workspaceAgentOracleCopies.locale, workspaceAgentOracleCopies.status),
      // 牌面卡总数（神谕文案 total 的分母）
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(workspaceAgentCards)
        .where(
          and(
            eq(workspaceAgentCards.workflowId, workflowId),
            eq(workspaceAgentCards.kind, "face"),
          ),
        ),
    ])

  const themeDirectionIds = new Set(input.themeDirectionIds ?? [])
  // 每方向取最新一条示例图 preview（重生成方向批时旧行不干扰）
  const previewStatusByDirection = new Map<string, (typeof previewRows)[number]["status"]>()
  for (const row of previewRows) {
    if (row.directionId) previewStatusByDirection.set(row.directionId, row.status)
  }
  const directions: WorkspaceAgentProgressDirection[] = directionRows.map((d) => ({
    id: d.id,
    name: d.name,
    concept: d.concept,
    worldview: d.worldview,
    palette: d.palette,
    visualLanguage: d.visualLanguage,
    stylePhrase: d.stylePhrase,
    sampleCards: Array.isArray(d.sampleCards) ? d.sampleCards : [],
    exampleImageUrl: d.exampleImageUrl,
    exampleImageStatus: previewStatusByDirection.get(d.id) ?? null,
    status: d.status,
    round: themeDirectionIds.has(d.id) ? "theme" : "direction",
  }))
  const selectedTheme =
    directionRows.find((d) => d.status === "selected" && themeDirectionIds.has(d.id)) ?? null

  const byStatus: Partial<Record<WorkspaceAgentCardStatus, number>> = {}
  let total = 0
  let promptsWritten = 0
  let totalRetries = 0
  for (const row of cardStatusRows) {
    byStatus[row.status] = Number(row.count)
    total += Number(row.count)
    promptsWritten += Number(row.prompts)
    totalRetries += Number(row.retries)
  }
  const exhausted = byStatus.fallback ?? 0
  const reviewCount = Number(reviewCountRows[0]?.count ?? 0)

  const queued = Number(jobRows.find((r) => r.status === "queued")?.count ?? 0)
  const processing = Number(jobRows.find((r) => r.status === "processing")?.count ?? 0)
  const completedJobs = Number(jobRows.find((r) => r.status === "completed")?.count ?? 0)

  // ── 阶段推导（对齐向导五步语义：主题选择 → 想象力程度 → 落地方向 → 提示词撰写）──
  // 每阶段对应一个业务里程碑：主题已选（clarify）/ 想象力档位已选（draft）/
  // 方向已定稿（art）/ 提示词全部写完（compose）。compose 写完即 done——
  // 生图/评审进度由卡片网格与工具面板承接，流水线不再等卡片落定。
  const cardCount = input.frozenConfig?.cardCount ?? input.cardCount ?? total
  const drafting = byStatus.drafting ?? 0
  const artInFlight = (byStatus.generating ?? 0) + (byStatus.reviewing ?? 0)
  const themeDone = selectedTheme != null
  const imaginationDone = !!input.imaginationLevel
  const directionDone = !!workflow.selectedDirectionId && !!workflow.styleDoc
  const promptsDone = cardCount > 0 && promptsWritten >= cardCount
  const workflowCompleted = workflow.status === "completed"
  const currentStage: WorkspaceAgentStage = !themeDone
    ? "clarify"
    : !imaginationDone
      ? "draft"
      : !directionDone
        ? "art"
        : "compose"
  const stages: WorkspaceAgentStageProgress[] = [
    {
      stage: "clarify",
      total: 0,
      completed: 0,
      failed: 0,
      inFlight: processing > 0 && !themeDone ? 1 : 0,
    },
    { stage: "draft", total: 0, completed: 0, failed: 0, inFlight: 0 },
    { stage: "art", total: 0, completed: 0, failed: 0, inFlight: 0 },
    {
      stage: "compose",
      total: cardCount,
      completed: promptsWritten,
      failed: byStatus.failed ?? 0,
      inFlight: drafting,
    },
  ]
  const stageStatuses: Record<WorkspaceAgentStage, WorkspaceAgentStageStatus> = {
    clarify: themeDone ? "done" : "active",
    draft: !themeDone ? "locked" : imaginationDone ? "done" : "active",
    art: !imaginationDone ? "locked" : directionDone ? "done" : "active",
    compose: !directionDone
      ? "locked"
      : workflowCompleted || (promptsDone && drafting === 0)
        ? "done"
        : "active",
  }

  // ── 角色推导（按角色最新事件；supervisor 跟随 job 状态） ──
  const latestEventByRole = new Map<string, (typeof eventRows)[number]>()
  for (const ev of eventRows) {
    if (ev.nodeKey && WORKSPACE_AGENT_ROLE_IDS.includes(ev.nodeKey as WorkspaceAgentRoleId)) {
      if (!latestEventByRole.has(ev.nodeKey)) latestEventByRole.set(ev.nodeKey, ev)
    }
  }
  const completedUnits: Partial<Record<WorkspaceAgentRoleId, number>> = {
    style_director: directions.filter((d) => d.round === "direction").length,
    prompt_designer: promptsWritten,
    artist: workflow.imageCount,
    supervisor: completedJobs,
  }
  const roles: WorkspaceAgentRoleState[] = WORKSPACE_AGENT_ROLE_IDS.map((roleId) => {
    let status: WorkspaceAgentRoleStatus
    if (roleId === "supervisor") {
      status = processing > 0 ? "active" : queued > 0 ? "waiting" : "idle"
    } else {
      const ev = latestEventByRole.get(roleId)
      status = ev ? roleStatusFromEventAction(ev.action) : "idle"
      if (status === "active" && processing === 0) status = "idle"
    }
    return {
      roleId,
      status,
      currentCardId: null,
      completedUnits: completedUnits[roleId] ?? 0,
      updatedAt: latestEventByRole.get(roleId)?.createdAt?.toISOString() ?? null,
    }
  })

  // 神谕文案交付进度（oracle58）：英文行 written/牌面 total + 是否全部定稿
  const progressTemplateKey = input.frozenConfig?.templateKey ?? "tarot81"
  const oracleEnRows = oracleRows.filter((r) => r.locale === "en")
  const oracleCopy =
    progressTemplateKey === "oracle58"
      ? {
          written: oracleEnRows.reduce((s, r) => s + Number(r.count), 0),
          total: Number(faceCountRows[0]?.count ?? 0),
          confirmed:
            Number(faceCountRows[0]?.count ?? 0) > 0 &&
            oracleEnRows.length > 0 &&
            oracleEnRows.every((r) => r.status === "confirmed") &&
            oracleEnRows.reduce((s, r) => s + Number(r.count), 0) >=
              Number(faceCountRows[0]?.count ?? 0),
        }
      : null

  const eventsAsc = [...eventRows].reverse()
  const tokenInput = Number(usageRows[0]?.inputTokens ?? 0)
  const tokenOutput = Number(usageRows[0]?.outputTokens ?? 0)
  const imageCallCount = Number(
    usageKindRows.find((r) => r.kind === "image")?.count ?? 0,
  )
  const llmCallCount = Number(
    usageKindRows.find((r) => r.kind === "llm")?.count ?? 0,
  )

  return {
    workflow: {
      id: workflow.id,
      title: workflow.title,
      status: workflow.status,
      currentStage,
      styleDoc: workflow.styleDoc,
      error: workflow.error,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    },
    input: {
      templateKey: input.frozenConfig?.templateKey ?? "tarot81",
      cardCount,
      prompt: input.prompt,
      stylePrompt: input.stylePrompt ?? null,
      referenceStyleAnalysis: input.referenceStyleAnalysis ?? null,
      referenceStyleAnalysisStatus: input.referenceStyleAnalysisStatus ?? null,
      referenceStyleAnalysisError: input.referenceStyleAnalysisError ?? null,
      chatModelId: input.chatModelId ?? null,
      reviewerChatModelIds: input.reviewerChatModelIds ?? [],
      imageModelId: input.imageModelId ?? null,
      sizes: input.frozenConfig?.sizes ?? null,
      quality: {
        contentThreshold:
          input.frozenConfig?.quality.contentThreshold ?? input.quality?.contentThreshold ?? 75,
        aestheticThreshold:
          input.frozenConfig?.quality.aestheticThreshold ?? input.quality?.aestheticThreshold ?? 75,
        consistencyThreshold:
          input.frozenConfig?.quality.consistencyThreshold ?? input.quality?.consistencyThreshold ?? 75,
        maxRetries: input.frozenConfig?.quality.maxRetries ?? input.quality?.maxRetries ?? 2,
      },
      imaginationLevel: input.imaginationLevel ?? null,
      styleConfirmedAt: input.styleConfirmedAt ?? null,
      referenceImages: input.referenceImages ?? [],
      themeDirectionIds: input.themeDirectionIds ?? null,
      directionBatchIds: input.directionBatchIds ?? null,
      lastSelectedThemeId: input.lastSelectedThemeId ?? null,
      lastSelectedDirectionId: input.lastSelectedDirectionId ?? null,
      rollbackCount: input.rollbackCount ?? 0,
    },
    stages,
    currentStage,
    stageStatuses,
    roles,
    usage: {
      llmCallCount: workflow.llmCallCount,
      costCenticredits: workflow.costCenticredits,
      unbilledCenticredits: workflow.unbilledCenticredits,
      imageCount: workflow.imageCount,
      imageCostCredits: workflow.imageCostCredits,
      inputTokens: tokenInput,
      outputTokens: tokenOutput,
    },
    cards: { total, byStatus, promptsWritten, exhausted, reviewCount, totalRetries },
    directions,
    selectedThemeId: selectedTheme?.id ?? null,
    selectedDirectionId: workflow.selectedDirectionId,
    jobs: { queued, processing },
    oracleCopy,
    events: eventRows.map((ev) => ({
      id: ev.id,
      nodeKey: ev.nodeKey,
      action: ev.action,
      status: ev.status,
      detail: ev.detail,
      stage: ev.stage,
      createdAt: ev.createdAt.toISOString(),
    })),
    dialog: {
      stats: {
        conversationCount: workflow.llmCallCount,
        imageCount: workflow.imageCount,
        tokenUsed: tokenInput + tokenOutput,
        imageCallCount,
        llmCallCount,
      },
      cardSummary: {
        total,
        completed:
          (byStatus.approved_by_ai ?? 0) + (byStatus.confirmed ?? 0) + (byStatus.fallback ?? 0),
        generating: drafting + artInFlight,
        failed: byStatus.failed ?? 0,
      },
      agents: roles.map((r) => ({
        id: r.roleId,
        name: ROLE_META[r.roleId].name,
        duty: ROLE_META[r.roleId].duty,
        status: r.status,
        currentTask:
          r.status === "active"
            ? ([...eventsAsc].reverse().find((ev) => ev.nodeKey === r.roleId)?.detail ?? null)
            : null,
        color: ROLE_META[r.roleId].color,
        progressPercent:
          r.roleId === "prompt_designer" && cardCount > 0
            ? Math.round((promptsWritten / cardCount) * 100)
            : null,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// 受限查询入口（enterpriseId + userId 双过滤）
// ---------------------------------------------------------------------------

export async function loadOwnedWorkflow(
  enterpriseId: string,
  userId: string,
  workflowId: string,
): Promise<WorkspaceAgentWorkflowRow | null> {
  const [row] = await db
    .select()
    .from(workspaceAgentWorkflows)
    .where(
      and(
        eq(workspaceAgentWorkflows.id, workflowId),
        eq(workspaceAgentWorkflows.enterpriseId, enterpriseId),
        eq(workspaceAgentWorkflows.userId, userId),
      ),
    )
    .limit(1)
  return row ?? null
}

/** 按挂靠的工作台任务取最新工作流（进度轮询入口：UI 以 taskId 调用） */
export async function loadLatestWorkflowForTask(
  enterpriseId: string,
  userId: string,
  workspaceTaskId: string,
): Promise<WorkspaceAgentWorkflowRow | null> {
  const [row] = await db
    .select()
    .from(workspaceAgentWorkflows)
    .where(
      and(
        eq(workspaceAgentWorkflows.workspaceTaskId, workspaceTaskId),
        eq(workspaceAgentWorkflows.enterpriseId, enterpriseId),
        eq(workspaceAgentWorkflows.userId, userId),
      ),
    )
    .orderBy(desc(workspaceAgentWorkflows.createdAt))
    .limit(1)
  return row ?? null
}
