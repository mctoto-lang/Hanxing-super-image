/**
 * 工作台域共享类型与内部助手（自 actions/workspace.ts 拆出；非 "use server"
 * 模块，供同目录各 action 文件复用）
 */

import { and, eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { cardImages, chatApiConfigs, generationTasks, models, promptCards, workspaceTasks } from "@/db/schema"
import { getCurrentEnterpriseScope, type UserContext } from "@/lib/auth/session"
import { checkModelAccess } from "@/lib/auth/permissions"
import { type ChatApiConfig } from "@/server/services/workspace-ai"
import { deductUserCredits, refundFailedTask } from "@/server/services/credits-service"
import { enqueue } from "@/lib/queue/task-queue"


/**
 * 工作台 Server Actions（手册 M5，1:1 对齐旧项目 REST API）
 *
 * 任务/卡片/批量/模板/导出全能力。多租户：所有查询按 enterpriseId 隔离，
 * 任务级数据再按 userId 收敛为当前用户私有。
 */

// ─── 导出票据（Redis 存储，2 分钟过期；核心逻辑在 services/export-ticket） ───

// ─── 复用 select 字段 ───

export const cardImageSelectFields = {
  id: cardImages.id,
  cardId: cardImages.cardId,
  generationTaskId: cardImages.generationTaskId,
  generationPrompt: cardImages.generationPrompt,
  imageApiId: cardImages.imageApiId,
  imageUrl: cardImages.imageUrl,
  modelName: models.displayName,
  size: cardImages.size,
  format: cardImages.format,
  status: cardImages.status,
  errorMessage: cardImages.errorMessage,
  isSelected: cardImages.isSelected,
  source: cardImages.source,
  generationStartedAt: generationTasks.startedAt,
  generationCompletedAt: generationTasks.completedAt,
  createdAt: cardImages.createdAt,
}



export const cardRowSelectFields = {
  id: promptCards.id,
  taskId: promptCards.taskId,
  cardIndex: promptCards.cardIndex,
  prompt: promptCards.prompt,
  translatedPrompt: promptCards.translatedPrompt,
  translationSourcePrompt: promptCards.translationSourcePrompt,
  translationStatus: promptCards.translationStatus,
  translationTemplateId: promptCards.translationTemplateId,
  displayLanguage: promptCards.displayLanguage,
  selectedImageId: promptCards.selectedImageId,
  referenceImages: promptCards.referenceImages,
  selImgId: cardImages.id,
  selImgUrl: cardImages.imageUrl,
  selImgModelName: models.displayName,
  selImgSize: cardImages.size,
  selImgStartedAt: generationTasks.startedAt,
  selImgCompletedAt: generationTasks.completedAt,
  selImgCreatedAt: cardImages.createdAt,
  createdAt: promptCards.createdAt,
  updatedAt: promptCards.updatedAt,
}

// ─── 内部辅助 ───

/**
 * 默认任务标题（用户未填写时）：只用时间戳，不含提示词内容——
 * 任务名称以用户创建/重命名时输入的名字为准，主题/提示词不再填入名称
 */



// ─── 内部辅助 ───

/**
 * 默认任务标题（用户未填写时）：只用时间戳，不含提示词内容——
 * 任务名称以用户创建/重命名时输入的名字为准，主题/提示词不再填入名称
 */
export function defaultTaskTitle(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `批量任务 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** 取当前用户拥有的工作台任务（enterpriseId + userId 双重隔离） */



/** 取当前用户拥有的工作台任务（enterpriseId + userId 双重隔离） */
export async function fetchOwnedTask(ctx: UserContext, taskId: string) {
  const scope = getCurrentEnterpriseScope(ctx)
  const [task] = await db
    .select()
    .from(workspaceTasks)
    .where(
      and(
        eq(workspaceTasks.id, taskId),
        eq(workspaceTasks.enterpriseId, scope.enterpriseId),
        eq(workspaceTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  return task ?? null
}

/** 取当前用户拥有的卡片（含其任务，校验 task.userId） */



/** 取当前用户拥有的卡片（含其任务，校验 task.userId） */
export async function fetchOwnedCard(ctx: UserContext, cardId: string) {
  const scope = getCurrentEnterpriseScope(ctx)
  const [row] = await db
    .select({ card: promptCards, task: workspaceTasks })
    .from(promptCards)
    .innerJoin(workspaceTasks, eq(promptCards.taskId, workspaceTasks.id))
    .where(
      and(
        eq(promptCards.id, cardId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
        eq(workspaceTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  return row ?? null
}

/** 重算任务 cardCount */



/** 重算任务 cardCount */
export async function updateTaskCardCount(taskId: string, enterpriseId: string) {
  const [row] = await db
    .select({ c: sql<number>`count(*)` })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, enterpriseId),
      ),
    )
  await db
    .update(workspaceTasks)
    .set({ cardCount: Number(row?.c ?? 0), updatedAt: new Date() })
    .where(eq(workspaceTasks.id, taskId))
}

/** 规范化 chatApi 行为 ChatApiConfig */



/** 规范化 chatApi 行为 ChatApiConfig */
export function toChatApiConfig(
  api: typeof chatApiConfigs.$inferSelect,
): ChatApiConfig {
  return {
    id: api.id,
    name: api.name,
    displayName: api.displayName,
    apiEndpoint: api.apiEndpoint,
    apiKeyEncrypted: api.apiKeyEncrypted,
    formatType: api.formatType,
    extraConfig: api.extraConfig,
    maxConcurrent: api.maxConcurrent,
    maxRetries: api.maxRetries,
    apiTimeout: api.apiTimeout,
  }
}

// ═══════════════ 任务管理 ═══════════════

/**
 * 列出当前用户的工作台任务（增强版：搜索/状态过滤/缩略图/置顶/图片计数/分页）。
 */



/** 提示词变形类型：deepen 细化 / regenerate 重生成共用一条链路（写回 prompt），
 *  translate 翻译走独立链路（写回 translatedPrompt） */
export type PromptMutationKind = "deepen" | "regenerate" | "translate"



/** 单卡生图内部实现 */
export async function generateCardImageInternal(opts: {
  ctx: UserContext
  enterpriseId: string
  card: { id: string; referenceImages: string[] }
  prompt: string
  apiId: string
  size: string
}): Promise<
  | { ok: true; cardImageId: string; generationTaskId: string }
  | { ok: false; error: string }
> {
  const { ctx, enterpriseId, card, prompt, apiId, size } = opts
  const ent = ctx.enterprise
  if (!ent) return { ok: false, error: "无企业归属" }
  // 空白卡片（无提示词）不可生图
  if (!prompt.trim()) return { ok: false, error: "提示词为空，请先填写提示词" }

  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, apiId))
    .limit(1)
  if (!model || !model.isActive || !model.visibleInWorkspace) {
    return { ok: false, error: "模型不存在或不可用" }
  }
  if (model.enterpriseId !== null && model.enterpriseId !== enterpriseId) {
    return { ok: false, error: "无权使用该模型" }
  }
  // 平台预置模型按企业 visiblePresetModels 白名单校验（需求 2c）
  if (model.enterpriseId === null) {
    const visiblePreset =
      (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
    if (visiblePreset.length > 0 && !visiblePreset.includes(model.id)) {
      return { ok: false, error: "该平台预置模型未对本企业开放" }
    }
  }
  const accessErr = checkModelAccess(ctx, apiId)
  if (accessErr) return { ok: false, error: accessErr }

  const cost = model.costPerImage
  if (ctx.user.creditsBalance < cost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${cost}，当前 ${ctx.user.creditsBalance}`,
    }
  }

  // 建图片行 + 任务 + 扣费 + 记账（单事务，任一步失败整体回滚）。此前
  // 分离提交，崩溃在中间窗口会出现「任务已建未扣费」（孤儿回收重新入队
  // = 免费生成）或「已扣费未记账」（失败退款按记账额少退）。
  let genTaskId: string
  let cardImageId: string
  try {
    const r = await db.transaction(async (tx) => {
      const [cardImage] = await tx
        .insert(cardImages)
        .values({
          enterpriseId,
          cardId: card.id,
          imageApiId: apiId,
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
          userId: ctx.user.id,
          modelId: apiId,
          prompt,
          imageSize: size || "1024x1024",
          imageCount: 1,
          status: "queued",
          taskType: "workspace_single",
          source: "workspace",
          priority: ctx.group?.priority ?? 0,
          creditsCharged: 0,
          costPerImage: model.costPerImage, // 记录提交时单价（部分失败按张退款用）
          referenceImages:
            card.referenceImages.length > 0 ? card.referenceImages : null,
        })
        .returning({ id: generationTasks.id })

      await tx
        .update(cardImages)
        .set({ generationTaskId: genTask!.id, updatedAt: new Date() })
        .where(eq(cardImages.id, cardImage!.id))

      await deductUserCredits({
        enterpriseId,
        amount: cost,
        userId: ctx.user.id,
        taskId: genTask!.id,
        remark: `工作台生图 ${model.displayName} x1`,
        tx,
      })

      await tx
        .update(generationTasks)
        .set({ creditsCharged: cost })
        .where(eq(generationTasks.id, genTask!.id))
      return { cardImageId: cardImage!.id, genTaskId: genTask!.id }
    })
    cardImageId = r.cardImageId
    genTaskId = r.genTaskId
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
    }
  }

  // 入队（Redis）。失败必须退款，否则用户积分已扣但任务永不处理。
  try {
    await enqueue({
      taskId: genTaskId,
      enterpriseId,
      modelId: apiId,
      prompt,
      imageSize: size || "1024x1024",
      imageCount: 1,
      referenceImages: card.referenceImages,
      priority: ctx.group?.priority ?? 0,
      costPerImage: model.costPerImage,
      apiTimeout: model.apiTimeout,
      taskTimeout: model.taskTimeout,
      maxRetries: model.maxRetries,
    })
  } catch (err) {
    // 入队失败（如 Redis 闪断）：退还积分并标记失败
    await refundFailedTask(genTaskId)
    await db
      .update(generationTasks)
      .set({ status: "failed", errorMessage: "任务入队失败，积分已退还" })
      .where(eq(generationTasks.id, genTaskId))
    await db
      .update(cardImages)
      .set({
        status: "failed",
        errorMessage: "任务入队失败，积分已退还",
        updatedAt: new Date(),
      })
      .where(eq(cardImages.id, cardImageId))
    console.error(
      `[workspace] 任务 ${genTaskId} 入队失败，已退款:`,
      err instanceof Error ? err.message : err,
    )
    return {
      ok: false,
      error: "任务入队失败，积分已退还，请稍后重试",
    }
  }

  return {
    ok: true,
    cardImageId,
    generationTaskId: genTaskId,
  }
}

/** 单卡生图 */


