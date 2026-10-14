"use server"

/**
 * 工作台 Agent Server Actions（/workspace 内嵌 Agent 域）
 *
 * 最小可运行流程（风格/主题/方向/提示词阶段）：
 *   发起（事务：workspace_task + workflow + 模板骨架 prompt_card/agent_card，
 *   风格不随创建确认）→ 打开向导自动入队参考图风格分析（analyze_reference_style，
 *   仅提取艺术风格；无参考图跳过）→ 用户确认风格（styleConfirmedAt + 默认
 *   入队生成 3 主题；模型/四类尺寸在方向定稿前可经 updateImageConfig 修改）→
 *   worker 生成 3 主题 → 选主题 → 选想象力（自动生成 3 创作方向 + 每方向
 *   best-effort 1 张示例图）→ 选择方向（styleDoc 定稿，模型/尺寸随之冻结）→
 *   生成提示词（全套写入、卡片解锁等人工编辑）→ 卡片生图与评审循环由
 *   production.ts 承接，卡片停在 waiting_human 等人工确认，绝不虚标完成。
 *
 * 多租户：所有读写按 enterpriseId + userId 双过滤；action 内不做 LLM 调用，
 * 异步执行全部经 workspace_agent_job 队列由独立 worker（scripts/worker.ts）
 * 原子认领。
 */
import { and, eq, inArray, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  promptCards,
  workspaceAgentCards,
  workspaceAgentDirections,
  workspaceAgentEvents,
  workspaceAgentJobs,
  workspaceAgentWorkflows,
  workspaceTasks,
  type WorkspaceAgentWorkflowRow,
} from "@/db/schema"
import { getCurrentEnterpriseScope, requireUserContext, type UserContext } from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import type {
  WorkspaceAgentQuality,
  WorkspaceAgentTemplateKey,
  WorkspaceAgentTemplateSizes,
} from "@/lib/workspace/agent-types"
import { buildFrozenConfig } from "@/lib/workspace/agent-templates"
import {
  isWorkspaceAgentTemplateKey,
  isValidMaxRetriesValue,
  isValidThresholdValue,
  requireWorkspaceAgentTemplate,
  skeletonKindToCardKind,
} from "@/server/services/workspace-agent/templates"
import {
  listWorkspaceAgentImageModels,
  listWorkspaceAgentVisionChatModels,
  resolveAgentChatModelChoice,
  resolveAgentReviewerChoice,
  resolveDefaultVisionChatModel,
  resolveWorkspaceAgentImageChoice,
  type WorkspaceAgentChatModelOption,
  type WorkspaceAgentImageModelOption,
} from "@/server/services/workspace-agent/models"
import {
  isWorkspaceAgentImaginationLevel,
  readWorkflowInput,
  type WorkspaceAgentInputExt,
} from "@/server/services/workspace-agent/input"
import { assembleStyleDoc } from "@/server/services/workspace-agent/run"
import { loadWorkspaceAgentOracleCsv } from "@/server/services/workspace-agent/oracle"
import {
  loadLatestWorkflowForTask,
  loadOwnedWorkflow,
  loadWorkspaceAgentProgress,
  type WorkspaceAgentProgressPayload,
} from "@/server/services/workspace-agent/progress"
import {
  hasInFlightGeneration,
  hasPendingReviewJob,
  loadOwnedAgentCardByPromptCard,
  loadWorkspaceAgentCardReview,
  startAgentCardGeneration,
  type WorkspaceAgentCardReviewPayload,
} from "@/server/services/workspace-agent/production"
import { fetchOwnedTask } from "./shared"
import { wsIdSchema } from "@/server/schemas/workspace"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { revalidatePath } from "next/cache"

type ActionResult<T extends object = object> =
  | ({ ok: true; error: null } & T)
  | { ok: false; error: string }

/** 模块准入 + 企业作用域（受限入口；失败抛错由调用方提示） */
async function requireWaContext(): Promise<{ ctx: UserContext; enterpriseId: string }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) throw new Error(denied)
  const scope = getCurrentEnterpriseScope(ctx)
  return { ctx, enterpriseId: scope.enterpriseId }
}

function isWorkflowRow(
  value: WorkspaceAgentWorkflowRow | { ok: false; error: string },
): value is WorkspaceAgentWorkflowRow {
  return "id" in value
}

async function loadOwnedWorkflowOrError(
  ctx: UserContext,
  enterpriseId: string,
  workflowId: string,
): Promise<WorkspaceAgentWorkflowRow | { ok: false; error: string }> {
  const workflow = await loadOwnedWorkflow(enterpriseId, ctx.user.id, workflowId)
  if (!workflow) return { ok: false, error: "工作流不存在" }
  return workflow
}

/** 入队一个异步任务（拒绝并发重复入队；状态守卫在调用方） */
async function enqueueWaJob(
  workflow: WorkspaceAgentWorkflowRow,
  jobType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const active = await db
    .select({ id: workspaceAgentJobs.id })
    .from(workspaceAgentJobs)
    .where(
      and(
        eq(workspaceAgentJobs.workflowId, workflow.id),
        inArray(workspaceAgentJobs.status, ["queued", "processing"]),
      ),
    )
    .limit(1)
  if (active.length > 0) {
    throw new Error("已有排队中或执行中的任务，请等待完成后再操作")
  }
  await db.insert(workspaceAgentJobs).values({
    enterpriseId: workflow.enterpriseId,
    userId: workflow.userId,
    workflowId: workflow.id,
    jobType,
    payload: { requestedAt: new Date().toISOString(), ...payload },
  })
  await db
    .update(workspaceAgentWorkflows)
    .set({ status: "queued", error: null, updatedAt: new Date() })
    .where(eq(workspaceAgentWorkflows.id, workflow.id))
}

/** workflow.input 扩展字段增量更新（jsonb 整体写回；扩展形状见 input.ts） */
async function patchWorkflowInput(
  workflowId: string,
  patch: Partial<WorkspaceAgentInputExt>,
): Promise<void> {
  const [row] = await db
    .select({ input: workspaceAgentWorkflows.input })
    .from(workspaceAgentWorkflows)
    .where(eq(workspaceAgentWorkflows.id, workflowId))
  if (!row) throw new Error("工作流不存在")
  await db
    .update(workspaceAgentWorkflows)
    .set({
      input: { ...row.input, ...patch },
      updatedAt: new Date(),
    })
    .where(eq(workspaceAgentWorkflows.id, workflowId))
}

async function logEvent(
  workflow: WorkspaceAgentWorkflowRow,
  input: { nodeKey?: string | null; action: string; status: "ok" | "warn" | "error"; detail: string },
): Promise<void> {
  await db.insert(workspaceAgentEvents).values({
    workflowId: workflow.id,
    enterpriseId: workflow.enterpriseId,
    nodeKey: input.nodeKey ?? null,
    action: input.action.slice(0, 12),
    status: input.status,
    detail: input.detail,
  })
}

// ═══════════════════ 1. 发起选项（视觉主/评审对话模型 + 生图模型及尺寸预设） ═══════════════════

/**
 * 列举发起弹窗所需模型选项：
 * - chatModels：支持视觉的对话模型（主控与评审共用候选，主模型须能读参考图）；
 * - imageModels：工作台可见生图模型（结构化尺寸预设优先，附启用 "WxH" 串）。
 */
export async function listWorkspaceAgentModelsAction(): Promise<{
  chatModels: WorkspaceAgentChatModelOption[]
  imageModels: WorkspaceAgentImageModelOption[]
}> {
  const { ctx } = await requireWaContext()
  const [chatModels, imageModels] = await Promise.all([
    listWorkspaceAgentVisionChatModels(ctx),
    listWorkspaceAgentImageModels(ctx),
  ])
  return { chatModels, imageModels }
}

/** 参考图风格分析入队；同一工作流只允许一个分析任务在途。 */
export async function requestWorkspaceAgentReferenceStyleAnalysisAction(
  workflowId: string,
): Promise<ActionResult> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    return await db.transaction(async (tx) => {
      const [workflow] = await tx
        .select()
        .from(workspaceAgentWorkflows)
        .where(
          and(
            eq(workspaceAgentWorkflows.id, workflowId),
            eq(workspaceAgentWorkflows.enterpriseId, enterpriseId),
            eq(workspaceAgentWorkflows.userId, ctx.user.id),
          ),
        )
        .for("update")
      if (!workflow) return { ok: false as const, error: "工作流不存在" }
      const ext = readWorkflowInput(workflow)
      if (!ext.referenceImages?.length) return { ok: true as const, error: null }
      if (ext.referenceStyleAnalysisStatus === "pending" || ext.referenceStyleAnalysisStatus === "completed") {
        return { ok: true as const, error: null }
      }
      if (workflow.selectedDirectionId || workflow.styleDoc) {
        return { ok: false as const, error: "方向已定稿，不能再分析参考图风格" }
      }
      if (["cancelled", "completed"].includes(workflow.status)) {
        return { ok: false as const, error: "当前工作流状态不可分析参考图" }
      }
      const [active] = await tx
        .select({ id: workspaceAgentJobs.id })
        .from(workspaceAgentJobs)
        .where(
          and(
            eq(workspaceAgentJobs.workflowId, workflowId),
            inArray(workspaceAgentJobs.status, ["queued", "processing"]),
          ),
        )
        .limit(1)
      if (active) return { ok: false as const, error: "已有任务执行中，请稍后重试" }

      await tx.insert(workspaceAgentJobs).values({
        enterpriseId,
        userId: ctx.user.id,
        workflowId,
        jobType: "analyze_reference_style",
        payload: { requestedAt: new Date().toISOString() },
      })
      await tx
        .update(workspaceAgentWorkflows)
        .set({
          status: "queued",
          error: null,
          input: {
            ...ext,
            referenceStyleAnalysisStatus: "pending",
            referenceStyleAnalysisError: undefined,
          },
          updatedAt: new Date(),
        })
        .where(eq(workspaceAgentWorkflows.id, workflowId))
      return { ok: true as const, error: null }
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "参考图风格分析入队失败" }
  }
}

/** 修改方向定稿前的生图模型与四类尺寸；已入队任务仍使用自己的模型/尺寸快照。 */
export async function updateWorkspaceAgentImageConfigAction(
  workflowId: string,
  input: { imageModelId: string; sizes: WorkspaceAgentTemplateSizes },
): Promise<ActionResult> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    const owned = await loadOwnedWorkflowOrError(ctx, enterpriseId, workflowId)
    if (!isWorkflowRow(owned)) return owned
    const ext = readWorkflowInput(owned)
    const templateKey = ext.frozenConfig?.templateKey ?? "tarot81"
    const choice = await resolveWorkspaceAgentImageChoice(ctx, {
      templateKey,
      imageModelId: input.imageModelId,
      sizes: input.sizes,
    })
    if (!choice.ok) return { ok: false, error: choice.error }
    if (!choice.imageModelId) return { ok: false, error: "请选择可用的生图模型" }

    return await db.transaction(async (tx) => {
      const [workflow] = await tx
        .select()
        .from(workspaceAgentWorkflows)
        .where(
          and(
            eq(workspaceAgentWorkflows.id, workflowId),
            eq(workspaceAgentWorkflows.enterpriseId, enterpriseId),
            eq(workspaceAgentWorkflows.userId, ctx.user.id),
          ),
        )
        .for("update")
      if (!workflow) return { ok: false as const, error: "工作流不存在" }
      if (workflow.selectedDirectionId || workflow.styleDoc) {
        return { ok: false as const, error: "方向已定稿，模型与尺寸已锁定" }
      }
      if (["cancelled", "completed"].includes(workflow.status)) {
        return { ok: false as const, error: `当前状态（${workflow.status}）不可修改模型与尺寸` }
      }
      const [active] = await tx
        .select({ id: workspaceAgentJobs.id })
        .from(workspaceAgentJobs)
        .where(
          and(
            eq(workspaceAgentJobs.workflowId, workflowId),
            inArray(workspaceAgentJobs.status, ["queued", "processing"]),
          ),
        )
        .limit(1)
      if (active) return { ok: false as const, error: "Agent 任务执行中，请等待本轮完成后再修改模型与尺寸" }

      const current = readWorkflowInput(workflow)
      const frozenConfig = buildFrozenConfig({
        templateKey,
        quality: current.frozenConfig?.quality ?? current.quality,
        sizes: choice.sizes,
        frozenAt: new Date().toISOString(),
      })
      const nextInput: WorkspaceAgentInputExt = {
        ...current,
        imageModelId: choice.imageModelId,
        imageSize: choice.sizes.card,
        frozenConfig,
      }
      await tx
        .update(workspaceAgentWorkflows)
        .set({
          input: nextInput,
          updatedAt: new Date(),
        })
        .where(eq(workspaceAgentWorkflows.id, workflowId))
      return { ok: true as const, error: null }
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "模型与尺寸更新失败" }
  }
}

// ═══════════════════ 2. 发起（事务建任务/工作流/骨架卡片 + 首个 job） ═══════════════════

/**
 * Agent 发起入参（对齐 new-task-dialog 的 CreateWorkspaceAgentTaskInput =
 * WorkspaceAgentInput & { templateKey; title?; sizes? }；cardCount 以模板骨架
 * 长度为准，服务端忽略入参值）。
 */
export interface CreateWorkspaceAgentTaskInput {
  templateKey: WorkspaceAgentTemplateKey
  title?: string
  prompt: string
  stylePrompt?: string
  cardCount?: number
  referenceImages?: string[]
  quality?: WorkspaceAgentQuality
  imageModelId?: string | null
  imageSize?: string | null
  chatModelId?: string | null
  reviewerChatModelIds?: string[]
  sizes?: WorkspaceAgentTemplateSizes
  workspaceTaskId?: string | null
}

export async function createWorkspaceAgentTaskAction(
  input: CreateWorkspaceAgentTaskInput,
): Promise<ActionResult<{ taskId: string; workflowId: string; cardCount: number }>> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()

    // ── 契约校验 ──
    if (!isWorkspaceAgentTemplateKey(input.templateKey)) {
      return { ok: false, error: "未知的模板类型" }
    }
    const template = requireWorkspaceAgentTemplate(input.templateKey)
    const prompt = (input.prompt ?? "").trim()
    if (!prompt) return { ok: false, error: "主题提示词不能为空" }
    if (prompt.length > 500) return { ok: false, error: "主题提示词过长（上限 500 字）" }
    const stylePrompt = (input.stylePrompt ?? "").trim().slice(0, 500) || undefined
    const referenceImages = normalizeReferenceUrls(input.referenceImages ?? [])
    // 参考图归属校验（同手动任务链路 createWorkspaceTaskAction）：Agent 发起
    // 的参考图会被 signUploadToken 透传给上游 LLM 读图，放任任意外域 URL
    // 等于把上游 AI 当 SSRF 代理拉任意地址 / 跨租户引用他企图片
    const refErr = await validateReferenceImageUrls(referenceImages, enterpriseId)
    if (refErr) return { ok: false, error: refErr }

    // 主控模型：指定 id 须在候选池且支持视觉；空 = 平台默认（池内首个视觉模型）
    let chatModelId: string
    if (input.chatModelId) {
      const choice = await resolveAgentChatModelChoice(ctx, input.chatModelId)
      if (!choice.ok) return { ok: false, error: choice.error }
      const visionPool = await listWorkspaceAgentVisionChatModels(ctx)
      if (!visionPool.some((m) => m.id === choice.modelId)) {
        return { ok: false, error: "主控模型必须支持视觉（多模态读图）" }
      }
      chatModelId = choice.modelId
    } else {
      const fallbackModel: WorkspaceAgentChatModelOption | null =
        await resolveDefaultVisionChatModel(ctx)
      if (!fallbackModel) {
        return { ok: false, error: "平台未配置支持视觉的对话模型，无法发起 Agent 任务" }
      }
      chatModelId = fallbackModel.id
    }

    // 评审模型：0 个 = 平台默认（回退主控模型）；1-3 个且均须支持视觉
    let reviewerChatModelIds: string[]
    const rawReviewers = (input.reviewerChatModelIds ?? []).filter(Boolean)
    if (rawReviewers.length === 0) {
      reviewerChatModelIds = [chatModelId]
    } else {
      const choice = await resolveAgentReviewerChoice(ctx, rawReviewers)
      if (!choice.ok) return { ok: false, error: choice.error }
      reviewerChatModelIds = choice.reviewerModelIds
    }

    // 生图模型 + 四类尺寸（模型启用预设校验；未选模型用模板默认尺寸）
    const imageChoice = await resolveWorkspaceAgentImageChoice(ctx, {
      templateKey: input.templateKey,
      imageModelId: input.imageModelId ?? null,
      sizes: input.sizes ?? null,
    })
    if (!imageChoice.ok) return { ok: false, error: imageChoice.error }

    // 质量阈值（40-95、5 分一档）与打回上限（1-3）
    const q: Partial<WorkspaceAgentQuality> = input.quality ?? {}
    for (const [label, value] of [
      ["内容对齐及格线", q.contentThreshold],
      ["审美及格线", q.aestheticThreshold],
      ["成套一致性及格线", q.consistencyThreshold],
    ] as const) {
      if (value != null && !isValidThresholdValue(value)) {
        return { ok: false, error: `${label}须为 40-95 且按 5 分一档` }
      }
    }
    if (q.maxRetries != null && !isValidMaxRetriesValue(q.maxRetries)) {
      return { ok: false, error: "打回上限须为 1-3" }
    }
    const frozenConfig = buildFrozenConfig({
      templateKey: input.templateKey,
      quality: q,
      sizes: imageChoice.sizes,
      frozenAt: new Date().toISOString(),
    })

    // 挂靠任务：校验归属，且必须是无任何卡片的空任务（或新建）。挂靠已有
    // 卡片的任务会导致骨架卡 cardIndex 与既有卡重复（prompt_card 无
    // (task_id, card_index) 唯一约束）；挂靠后统一改写 source = "agent"，
    // 否则占位锁保护（lockedWorkspaceAgentCardError）与 Agent 生图分流失效
    let workspaceTaskId = input.workspaceTaskId ?? null
    if (workspaceTaskId) {
      const owned = await fetchOwnedTask(ctx, workspaceTaskId)
      if (!owned) return { ok: false, error: "挂靠的工作台任务不存在" }
      const [countRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(promptCards)
        .where(
          and(
            eq(promptCards.taskId, workspaceTaskId),
            eq(promptCards.enterpriseId, enterpriseId),
          ),
        )
      if (Number(countRow?.count ?? 0) > 0) {
        return {
          ok: false,
          error: "挂靠的工作台任务已存在卡片，无法发起 Agent 工作流（请新建任务）",
        }
      }
    }

    const title =
      (input.title ?? "").trim().slice(0, 120) ||
      `${template.meta.name} · ${prompt.slice(0, 20)}`

    const workflowInput: WorkspaceAgentInputExt = {
      prompt,
      stylePrompt,
      cardCount: template.meta.cardCount,
      referenceImages,
      quality: frozenConfig.quality,
      imageModelId: imageChoice.imageModelId,
      imageSize: frozenConfig.sizes.card,
      chatModelId,
      reviewerChatModelIds,
      // 风格需在向导中完成参考图分析与用户确认后才触发主题生成
      frozenConfig,
    }

    // ── 事务：任务 + 工作流 + 骨架卡（agent 卡与工作台 prompt 卡互链）+ 首个 job ──
    const created = await db.transaction(async (tx) => {
      if (!workspaceTaskId) {
        const [task] = await tx
          .insert(workspaceTasks)
          .values({
            enterpriseId,
            userId: ctx.user.id,
            title,
            themePrompt: prompt,
            // source = agent：列表元数据据此切换 Agent 视图；状态直接落
            // completed——卡片是占位骨架（isLocked），不能走 legacy 生成流
            // 转 spinner，实际推进由 Agent 工作流承担
            status: "completed",
            source: "agent",
          })
          .returning({ id: workspaceTasks.id })
        workspaceTaskId = task!.id
      } else {
        // 挂靠既有空任务：改写 source = "agent"（骨架卡写保护、Agent 生图
        // 分流与列表元数据均按 task.source 判定），状态对齐新建 Agent 任务
        // （completed：占位骨架不走 legacy 生成流，推进由工作流承担）
        await tx
          .update(workspaceTasks)
          .set({ source: "agent", status: "completed", updatedAt: new Date() })
          .where(eq(workspaceTasks.id, workspaceTaskId))
      }
      const [workflow] = await tx
        .insert(workspaceAgentWorkflows)
        .values({
          enterpriseId,
          userId: ctx.user.id,
          workspaceTaskId,
          title,
          // 不随创建入队主题任务：四阶段向导的「风格确认」步骤先落定风格
          // （可编辑一次），确认后才由 flow dialog 触发生成 3 主题
          status: "waiting_human",
          input: workflowInput,
        })
        .returning({ id: workspaceAgentWorkflows.id })

      // 骨架卡分块插入（互链 id 一次到位；wac_workflow_index_unique 兜底防重）。
      // prompt 卡占位：isLocked = true + agentKind 标注交付卡类——锁定态
      // 骨架提示词不进入任何生图/批量链路，write_prompts 写入真实提示词时解锁。
      const CHUNK = 40
      for (let i = 0; i < template.cards.length; i += CHUNK) {
        const chunk = template.cards.slice(i, i + CHUNK)
        const promptCardRows = await tx
          .insert(promptCards)
          .values(
            chunk.map((card) => ({
              enterpriseId,
              taskId: workspaceTaskId!,
              cardIndex: card.index,
              prompt: `【骨架】${card.name}：${card.hint}`,
              isLocked: true,
              agentKind: skeletonKindToCardKind(card),
            })),
          )
          .returning({ id: promptCards.id })
        await tx.insert(workspaceAgentCards).values(
          chunk.map((card, j) => ({
            workflowId: workflow!.id,
            enterpriseId,
            userId: ctx.user.id,
            cardIndex: card.index,
            kind: skeletonKindToCardKind(card),
            name: card.name,
            meaning: card.hint,
            status: "pending" as const,
            promptCardId: promptCardRows[j]!.id,
          })),
        )
      }

      return { workflowId: workflow!.id, workspaceTaskId: workspaceTaskId! }
    })

    await db.insert(workspaceAgentEvents).values({
      workflowId: created.workflowId,
      enterpriseId,
      nodeKey: "creative_director",
      action: "start",
      status: "ok",
      detail: `工作流已创建（${template.meta.name}，骨架 ${template.meta.cardCount} 张已就绪），等待风格确认后生成 3 个候选主题`,
    })

    return {
      ok: true,
      error: null,
      taskId: created.workspaceTaskId,
      workflowId: created.workflowId,
      cardCount: template.meta.cardCount,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "创建工作流失败" }
  }
}

/** 参考图 URL 规范化：trim/去重/去空，≤4 张，须为上传返回的相对路径或 http(s) URL */
function normalizeReferenceUrls(images: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const img of images) {
    if (typeof img !== "string") continue
    const trimmed = img.trim()
    if (!trimmed || seen.has(trimmed)) continue
    if (!/^(https?:\/\/|\/)/i.test(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result.slice(0, 4)
}

// ═══════════════════ 3. 受限进度查询（UI 以挂靠 taskId 轮询） ═══════════════════

/**
 * 进度查询：载荷包在 ActionResult.progress 下（ok:false 时轮询侧归一空态，
 * 不打断轮询）。progress 形状对齐 workspace-client.normalizeAgentProgress
 * （workflow/stages/stageStatuses/dialog 投影）。
 */
export async function getWorkspaceAgentProgressAction(
  taskId: string,
): Promise<ActionResult<{ progress: WorkspaceAgentProgressPayload }>> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    const workflow = await loadLatestWorkflowForTask(enterpriseId, ctx.user.id, taskId)
    if (!workflow) return { ok: false, error: "工作流不存在" }
    const progress = await loadWorkspaceAgentProgress(workflow.id)
    if (!progress) return { ok: false, error: "工作流不存在" }
    return { ok: true, error: null, progress }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "查询进度失败" }
  }
}

// ═══════════════════ 4. 风格确认（主题产出前微调风格输入） ═══════════════════

/**
 * 风格确认/微调：风格在向导「风格确认」步骤由用户显式落定（参考图 AI 分析
 * 结果在用户未手写描述时作为默认草稿）；确认即写 styleConfirmedAt，主题尚未
 * 产出前可再次微调——排队中的主题任务在执行时读取最新 input，无需重新入队；
 * 主题已产出或任务执行中时拒绝。
 */
export async function confirmWorkspaceAgentStyleAction(
  workflowId: string,
  input: { stylePrompt?: string } = {},
): Promise<ActionResult> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    const workflow = await loadOwnedWorkflowOrError(ctx, enterpriseId, workflowId)
    if (!isWorkflowRow(workflow)) return workflow
    const ext = readWorkflowInput(workflow)
    const [existingDirections, processingJobs] = await Promise.all([
      db
        .select({ id: workspaceAgentDirections.id })
        .from(workspaceAgentDirections)
        .where(eq(workspaceAgentDirections.workflowId, workflowId))
        .limit(1),
      db
        .select({ id: workspaceAgentJobs.id })
        .from(workspaceAgentJobs)
        .where(
          and(
            eq(workspaceAgentJobs.workflowId, workflowId),
            eq(workspaceAgentJobs.status, "processing"),
          ),
        )
        .limit(1),
    ])
    if (processingJobs.length > 0) {
      return { ok: false, error: "任务执行中，请等待本轮完成后再调整风格" }
    }
    if (existingDirections.length > 0) {
      return { ok: false, error: "主题已产出；如需调整请使用「重新生成主题」并附反馈" }
    }
    if (workflow.status === "cancelled" || workflow.status === "completed") {
      return { ok: false, error: `当前状态（${workflow.status}）不可调整风格` }
    }
    const stylePrompt =
      (input.stylePrompt ?? ext.stylePrompt ?? ext.referenceStyleAnalysis ?? "")
        .trim()
        .slice(0, 500) || undefined
    await patchWorkflowInput(workflowId, {
      stylePrompt,
      styleConfirmedAt: new Date().toISOString(),
    })
    await logEvent(workflow, {
      nodeKey: "creative_director",
      action: "confirm",
      status: "ok",
      detail: stylePrompt
        ? `风格已确认（风格描述：${stylePrompt.slice(0, 60)}），等待生成主题`
        : "风格已确认（无附加风格描述），等待生成主题",
    })
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "风格确认失败" }
  }
}

// ═══════════════════ 5. 生成 3 主题（重新生成/按反馈） ═══════════════════

export async function generateWorkspaceAgentThemesAction(
  workflowId: string,
  input: { feedback?: string } = {},
): Promise<ActionResult> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    const workflow = await loadOwnedWorkflowOrError(ctx, enterpriseId, workflowId)
    if (!isWorkflowRow(workflow)) return workflow
    if (!readWorkflowInput(workflow).styleConfirmedAt) {
      return { ok: false, error: "请先确认风格" }
    }
    if (workflow.selectedDirectionId) {
      return { ok: false, error: "方向已定稿，不可重生成主题" }
    }
    const ext = readWorkflowInput(workflow)
    if (ext.themeDirectionIds?.length) {
      const [selectedTheme] = await db
        .select({ id: workspaceAgentDirections.id })
        .from(workspaceAgentDirections)
        .where(
          and(
            eq(workspaceAgentDirections.workflowId, workflowId),
            eq(workspaceAgentDirections.status, "selected"),
            inArray(workspaceAgentDirections.id, ext.themeDirectionIds),
          ),
        )
        .limit(1)
      if (selectedTheme) return { ok: false, error: "主题已选定，不能重新生成主题" }
    }
    await enqueueWaJob(workflow, "gen_directions", {
      round: "themes",
      feedback: (input.feedback ?? "").trim().slice(0, 500) || undefined,
    })
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "生成主题失败" }
  }
}

// ═══════════════════ 6. 选主题 ═══════════════════

export async function selectWorkspaceAgentThemeAction(
  workflowId: string,
  directionId: string,
): Promise<ActionResult> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    const workflow = await loadOwnedWorkflowOrError(ctx, enterpriseId, workflowId)
    if (!isWorkflowRow(workflow)) return workflow
    if (workflow.selectedDirectionId) return { ok: false, error: "方向已定稿" }
    const ext = readWorkflowInput(workflow)
    if (ext.themeDirectionIds?.length) {
      const [selectedTheme] = await db
        .select({ id: workspaceAgentDirections.id })
        .from(workspaceAgentDirections)
        .where(
          and(
            eq(workspaceAgentDirections.workflowId, workflowId),
            eq(workspaceAgentDirections.status, "selected"),
            inArray(workspaceAgentDirections.id, ext.themeDirectionIds),
          ),
        )
        .limit(1)
      if (selectedTheme) return { ok: false, error: "主题已选定，不可更换" }
    }
    if (!ext.themeDirectionIds?.includes(directionId)) {
      return { ok: false, error: "该方向不是候选主题" }
    }
    const [direction] = await db
      .select()
      .from(workspaceAgentDirections)
      .where(
        and(
          eq(workspaceAgentDirections.id, directionId),
          eq(workspaceAgentDirections.workflowId, workflowId),
          eq(workspaceAgentDirections.status, "candidate"),
        ),
      )
    if (!direction) return { ok: false, error: "候选主题不存在或已不可选" }
    await db.transaction(async (tx) => {
      await tx
        .update(workspaceAgentDirections)
        .set({ status: "selected", updatedAt: new Date() })
        .where(eq(workspaceAgentDirections.id, directionId))
      await tx
        .update(workspaceAgentDirections)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(
          and(
            eq(workspaceAgentDirections.workflowId, workflowId),
            eq(workspaceAgentDirections.status, "candidate"),
          ),
        )
    })
    await logEvent(workflow, {
      nodeKey: "creative_director",
      action: "confirm",
      status: "ok",
      detail: `已选定主题「${direction.name}」，请选择想象力档位后生成创作方向`,
    })
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "选择主题失败" }
  }
}

// ═══════════════════ 7. 选想象力（确认后自动入队生成 3 创作方向） ═══════════════════

export async function chooseWorkspaceAgentImaginationAction(
  workflowId: string,
  level: string,
): Promise<ActionResult> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    const workflow = await loadOwnedWorkflowOrError(ctx, enterpriseId, workflowId)
    if (!isWorkflowRow(workflow)) return workflow
    if (!isWorkspaceAgentImaginationLevel(level)) {
      return { ok: false, error: "想象力档位须为 conservative / balanced / bold" }
    }
    const ext = readWorkflowInput(workflow)
    if (!ext.themeDirectionIds?.length) {
      return { ok: false, error: "请先选定主题" }
    }
    const [selectedTheme] = await db
      .select({ id: workspaceAgentDirections.id })
      .from(workspaceAgentDirections)
      .where(
        and(
          eq(workspaceAgentDirections.workflowId, workflowId),
          eq(workspaceAgentDirections.status, "selected"),
          inArray(workspaceAgentDirections.id, ext.themeDirectionIds),
        ),
      )
    if (!selectedTheme) return { ok: false, error: "请先选定主题" }
    if (workflow.selectedDirectionId) return { ok: false, error: "方向已定稿" }
    if (ext.imaginationLevel) return { ok: false, error: "想象力档位已选定，不可更改" }
    if (!ext.imageModelId) return { ok: false, error: "请先在向导顶部选择生图模型和尺寸" }
    await patchWorkflowInput(workflowId, { imaginationLevel: level })
    await logEvent(workflow, {
      nodeKey: "creative_director",
      action: "confirm",
      status: "ok",
      detail: `想象力档位已选定为「${level}」，开始生成 3 个创作方向`,
    })
    await enqueueWaJob(workflow, "gen_directions", {
      round: "directions",
      imagination: level,
    })
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "选择想象力档位失败" }
  }
}

// ═══════════════════ 8. 生成创作方向（重新生成/按反馈） ═══════════════════

export async function generateWorkspaceAgentDirectionsAction(
  workflowId: string,
  input: { feedback?: string } = {},
): Promise<ActionResult> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    const workflow = await loadOwnedWorkflowOrError(ctx, enterpriseId, workflowId)
    if (!isWorkflowRow(workflow)) return workflow
    if (!readWorkflowInput(workflow).imaginationLevel) {
      return { ok: false, error: "请先选择想象力档位" }
    }
    if (workflow.selectedDirectionId) {
      return { ok: false, error: "方向已定稿，不可重生成" }
    }
    const ext = readWorkflowInput(workflow)
    if (!ext.imageModelId) return { ok: false, error: "请先在向导顶部选择生图模型和尺寸" }
    await enqueueWaJob(workflow, "gen_directions", {
      round: "directions",
      feedback: (input.feedback ?? "").trim().slice(0, 500) || undefined,
    })
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "生成创作方向失败" }
  }
}

// ═══════════════════ 9. 选择方向（styleDoc 定稿） ═══════════════════

export async function selectWorkspaceAgentDirectionAction(
  workflowId: string,
  directionId: string,
): Promise<ActionResult> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    const workflow = await loadOwnedWorkflowOrError(ctx, enterpriseId, workflowId)
    if (!isWorkflowRow(workflow)) return workflow
    if (workflow.selectedDirectionId) return { ok: false, error: "方向已定稿" }
    if (readWorkflowInput(workflow).themeDirectionIds?.includes(directionId)) {
      return { ok: false, error: "请选择创作方向（而非主题）" }
    }
    const [direction] = await db
      .select()
      .from(workspaceAgentDirections)
      .where(
        and(
          eq(workspaceAgentDirections.id, directionId),
          eq(workspaceAgentDirections.workflowId, workflowId),
          eq(workspaceAgentDirections.status, "candidate"),
        ),
      )
    if (!direction) return { ok: false, error: "候选方向不存在或已不可选" }
    const styleDoc = assembleStyleDoc(direction, direction.sampleCards ?? [])
    await db.transaction(async (tx) => {
      await tx
        .update(workspaceAgentDirections)
        .set({ status: "selected", updatedAt: new Date() })
        .where(eq(workspaceAgentDirections.id, directionId))
      await tx
        .update(workspaceAgentDirections)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(
          and(
            eq(workspaceAgentDirections.workflowId, workflowId),
            eq(workspaceAgentDirections.status, "candidate"),
          ),
        )
      await tx
        .update(workspaceAgentWorkflows)
        .set({
          styleDoc,
          selectedDirectionId: directionId,
          status: "waiting_human",
          updatedAt: new Date(),
        })
        .where(eq(workspaceAgentWorkflows.id, workflowId))
    })
    await logEvent(workflow, {
      nodeKey: "style_director",
      action: "confirm",
      status: "ok",
      detail: `风格规范书已定稿（方向「${direction.name}」），可开始生成卡牌提示词`,
    })
    // 神谕模板：方向定稿即自动入队 55 组英文文案撰写（与提示词撰写并行；
    // enqueueWaJob 自带「已有排队/执行任务」防重入守卫）
    const ext = readWorkflowInput(workflow)
    if ((ext.frozenConfig?.templateKey ?? "tarot81") === "oracle58") {
      await enqueueWaJob(workflow, "write_oracle_copy", {
        reason: "方向定稿",
      })
    }
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "选择方向失败" }
  }
}

// ═══════════════════ 10. 生成提示词（全套写入、解锁卡片） ═══════════════════

export async function generateWorkspaceAgentPromptsAction(
  workflowId: string,
  input: { cardIds?: string[]; feedback?: string } = {},
): Promise<ActionResult> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    const workflow = await loadOwnedWorkflowOrError(ctx, enterpriseId, workflowId)
    if (!isWorkflowRow(workflow)) return workflow
    if (!workflow.styleDoc || !workflow.selectedDirectionId) {
      return { ok: false, error: "请先选定方向（风格规范书定稿）再生成提示词" }
    }
    await enqueueWaJob(workflow, "write_prompts", {
      cardIds:
        Array.isArray(input.cardIds) && input.cardIds.length > 0
          ? input.cardIds.slice(0, 200)
          : undefined,
      feedback: (input.feedback ?? "").trim().slice(0, 500) || undefined,
    })
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "生成提示词失败" }
  }
}

// ═══════════════════ 11. 取消 ═══════════════════

export async function cancelWorkspaceAgentWorkflowAction(
  workflowId: string,
): Promise<ActionResult> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    const workflow = await loadOwnedWorkflowOrError(ctx, enterpriseId, workflowId)
    if (!isWorkflowRow(workflow)) return workflow
    if (workflow.status === "completed" || workflow.status === "cancelled") {
      return { ok: true, error: null }
    }
    // 终态守卫：仅非终态可取消；processing 任务由 worker 完成时按取消状态收口
    await db
      .update(workspaceAgentWorkflows)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(workspaceAgentWorkflows.id, workflowId),
          sql`${workspaceAgentWorkflows.status} NOT IN ('completed', 'cancelled')`,
        ),
      )
    await db
      .update(workspaceAgentJobs)
      .set({ status: "failed", errorMessage: "工作流已取消", completedAt: new Date() })
      .where(
        and(
          eq(workspaceAgentJobs.workflowId, workflowId),
          eq(workspaceAgentJobs.status, "queued"),
        ),
      )
    await db
      .update(workspaceAgentCards)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(workspaceAgentCards.workflowId, workflowId),
          inArray(workspaceAgentCards.status, ["pending", "drafting"]),
        ),
      )
    await logEvent(workflow, {
      nodeKey: "supervisor",
      action: "cancel",
      status: "warn",
      detail: "工作流已取消：排队任务作废，未产出的卡片标记取消",
    })
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "取消失败" }
  }
}

// ═══════════════════ 12. 重新 Agent 生成（单卡新周期：重置打回轮数） ═══════════════════

/**
 * 重新 Agent 生成：唯一允许重置 roundsUsed 开启新评审周期的入口。
 * - 前置：提示词卡已解锁（提示词阶段完成）且卡片无在途生图轮；
 * - 动作：manualRegenCount + 1（成本软限流计数）、roundsUsed → 0、
 *   兜底警示复位，随后按当前提示词（prompt_card.prompt）走冻结模型 +
 *   kind 尺寸的 Agent 生图管线，终态自动进入评审循环。
 */
export async function restartWorkspaceAgentCardAction(
  cardId: string,
): Promise<
  ActionResult<{ roundId: string; generationTaskId: string; cardImageId: string }>
> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    if (!wsIdSchema.safeParse(cardId).success) {
      return { ok: false, error: "参数错误（id 非法）" }
    }
    const owned = await loadOwnedAgentCardByPromptCard(
      enterpriseId,
      ctx.user.id,
      cardId,
    )
    if (!owned) return { ok: false, error: "卡片不存在或不属于当前工作流" }
    const { card, workflow } = owned
    if (workflow.status === "cancelled") {
      return { ok: false, error: "工作流已取消" }
    }

    // 提示词卡必须已解锁（提示词阶段完成）；锁定卡不可生图
    const promptCard = card.promptCardId
      ? (await db
          .select()
          .from(promptCards)
          .where(eq(promptCards.id, card.promptCardId))
          .limit(1))[0]
      : undefined
    if (!promptCard) return { ok: false, error: "未找到对应的提示词卡" }
    if (promptCard.isLocked) {
      return { ok: false, error: "Agent 工作流尚未完成提示词阶段，卡片暂不可操作" }
    }
    const prompt = promptCard.prompt.trim()
    if (!prompt) return { ok: false, error: "提示词为空，请先填写提示词" }

    if (["pending", "drafting"].includes(card.status)) {
      return { ok: false, error: "该卡片尚未完成提示词撰写，请先生成提示词" }
    }
    if (["generating", "reviewing"].includes(card.status)) {
      return { ok: false, error: "该卡片正在生成/评审中，请等待本轮完成" }
    }
    if (await hasInFlightGeneration(card.id)) {
      return { ok: false, error: "该卡片存在在途生图任务，请等待完成后再重新生成" }
    }
    if (await hasPendingReviewJob(card.id)) {
      return { ok: false, error: "该卡片评审任务待执行，请等待评审完成后再重新生成" }
    }

    // 新周期：roundsUsed 复位 + 兜底警示复位 + 手动重开计数 +1
    await db
      .update(workspaceAgentCards)
      .set({
        roundsUsed: 0,
        fallbackContentWarning: false,
        manualRegenCount: card.manualRegenCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(workspaceAgentCards.id, card.id))

    const res = await startAgentCardGeneration({
      enterpriseId,
      userId: ctx.user.id,
      workflow,
      card: { ...card, roundsUsed: 0 },
      prompt,
      promptSource: "manual",
    })
    if (!res.ok) return { ok: false, error: res.error }

    await logEvent(workflow, {
      nodeKey: "supervisor",
      action: "regen",
      status: "ok",
      detail: `重新 Agent 生成：已重置打回轮数（第 ${card.manualRegenCount + 1} 次手动重开），按当前提示词开始新一轮生图与评审`,
    })
    revalidatePath("/workspace")
    return {
      ok: true,
      error: null,
      roundId: res.roundId,
      generationTaskId: res.generationTaskId,
      cardImageId: res.cardImageId,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "重新 Agent 生成失败",
    }
  }
}

// ═══════════════════ 13. 单卡评审查询（跨轮评分 / 裁决 / 阈值） ═══════════════════

/**
 * 评审查询：返回该卡全部生成轮的评审明细（每轮各评审员三维分 + 加权总分 +
 * 总控裁决），以及质量线 / 打回上限等判定上下文。UI 评分卡与打回回放共用。
 */
export async function getWorkspaceAgentCardReviewAction(
  cardId: string,
): Promise<
  ActionResult<{ review: WorkspaceAgentCardReviewPayload }>
> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    if (!wsIdSchema.safeParse(cardId).success) {
      return { ok: false, error: "参数错误（id 非法）" }
    }
    const review = await loadWorkspaceAgentCardReview(
      enterpriseId,
      ctx.user.id,
      cardId,
    )
    if (!review) return { ok: false, error: "卡片不存在或不属于当前工作流" }
    return { ok: true, error: null, review }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "查询评审失败",
    }
  }
}

// ═══════════════════ 14. 神谕文案 CSV 下载（oracle58 交付物） ═══════════════════

/**
 * 神谕文案 CSV 下载：按 taskId 取最新工作流（双租户过滤）→ 校验 oracle58
 * 且 55 组英文文案已全部定稿 → 返回 CSV 文本与文件名，前端 Blob 触发下载。
 */
export async function downloadWorkspaceAgentOracleCsvAction(
  taskId: string,
): Promise<ActionResult<{ csv: string; filename: string }>> {
  try {
    const { ctx, enterpriseId } = await requireWaContext()
    if (!wsIdSchema.safeParse(taskId).success) {
      return { ok: false, error: "参数错误（id 非法）" }
    }
    const result = await loadWorkspaceAgentOracleCsv(
      enterpriseId,
      ctx.user.id,
      taskId,
    )
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, error: null, csv: result.csv, filename: result.filename }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "下载神谕文案失败",
    }
  }
}

// ═══════════════════ 结束 ═══════════════════
