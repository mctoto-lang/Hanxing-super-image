"use server"

import { z } from "zod"
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { cardImages, chatTasks, generationTasks, models, promptCards, workspaceTasks } from "@/db/schema"
import { getCurrentEnterpriseScope, requireUserContext } from "@/lib/auth/session"
import { checkModelAccess, checkModuleAccess, isEnterpriseAdmin } from "@/lib/auth/permissions"
import { extractNumberedPromptReplacements, getExecutableTemplate } from "@/server/services/workspace-ai"
import { deductUserCredits, refundUserCredits } from "@/server/services/credits-service"
import { enqueueMany } from "@/lib/queue/task-queue"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { batchAttachUrlsSchema, batchGenerateImageSchema, batchReplacePromptsSchema, extractNumberedPromptsSchema, templateOnlySchema, wsCardIdsSchema, wsIdSchema } from "@/server/schemas/workspace"
import { revalidatePath } from "next/cache"
import { requireActionGuard } from "@/server/actions/action-kit"
import { getGenerationPrompt, normalizeReferenceImages } from "@/lib/workspace/helpers"
import type { BatchGenerationLanguage, CardImageRow } from "@/lib/workspace/types"
import { PromptMutationKind, fetchOwnedCard, fetchOwnedTask, lockedWorkspaceAgentCardError } from "./shared"
import { generateAgentCardImageForAction } from "@/server/services/workspace-agent/production"


// ═══════════════ 批量操作 ═══════════════

/** 批量生图 */
/**
 * 批量生图：模型校验 + 卡片归属校验各一次，总额一次扣费，
 * 批量 INSERT 任务/图片行 + pipeline 一次入队。
 * 相比逐卡串行（每卡 ~8 次 DB 往返 + 1 事务），100 卡从 ~800 次往返降到 ~8 次。
 * 扣费成功后的任一步失败：全额退款 + 已插入行批量置 failed（补偿语义）。
 */
export async function batchGenerateImageAction(
  cardIds: string[],
  input: {
    /** Agent 管线（task.source = "agent"）忽略 apiId/size（一律用冻结值），
     *  Agent 任务视图无生成配置入口，两者允许缺省；纯 Agent 批次可在模型
     *  缺省时直接提交 */
    apiId?: string
    size?: string
    languagePreference?: BatchGenerationLanguage
  },
): Promise<{
  ok: boolean
  submitted: number
  tasks: Array<{
    cardId: string
    cardImageId: string
    generationTaskId: string
  }>
  errors: Array<{ cardId: string; error: string }>
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, submitted: 0, tasks: [], errors: [] }
  if (!wsCardIdsSchema.safeParse(cardIds).success) return { ok: false, submitted: 0, tasks: [], errors: [] }
  const parsed = batchGenerateImageSchema.safeParse(input)
  if (!parsed.success) return { ok: false, submitted: 0, tasks: [], errors: [] }
  const scope = getCurrentEnterpriseScope(ctx)
  const enterpriseId = scope.enterpriseId
  const tasks: Array<{
    cardId: string
    cardImageId: string
    generationTaskId: string
  }> = []
  const errors: Array<{ cardId: string; error: string }> = []

  const uniqueIds = [...new Set(cardIds)]
  if (uniqueIds.length === 0) return { ok: true, submitted: 0, tasks, errors }

  // ── 批量取归属卡片（一次查询复刻 fetchOwnedCard 的归属校验；
  //    附带任务 source，用于把 Agent 任务卡片分流到 Agent 生图管线）──
  const ownedRows = await db
    .select({ card: promptCards, taskSource: workspaceTasks.source, taskId: workspaceTasks.id })
    .from(promptCards)
    .innerJoin(workspaceTasks, eq(promptCards.taskId, workspaceTasks.id))
    .where(
      and(
        inArray(promptCards.id, uniqueIds),
        eq(promptCards.enterpriseId, enterpriseId),
        eq(workspaceTasks.userId, ctx.user.id),
      ),
    )

  // ── Agent 任务卡片（task.source = "agent"）：强制走冻结模型 + kind 尺寸的
  //    Agent 管线（generation_task source = "agent" + round + 终态自动评审），
  //    不进入下方普通批量管线；同一批次卡类（face/back/box/border）必须严格
  //    相同，混类批次整组拒绝 ──
  const agentRows = ownedRows.filter((r) => r.taskSource === "agent")
  const normalRows = ownedRows.filter((r) => r.taskSource !== "agent")
  if (agentRows.length > 0) {
    const agentKinds = new Set(
      agentRows.map((r) => r.card.agentKind ?? "face"),
    )
    if (agentKinds.size > 1) {
      // 混类批次（如卡面 + 牌背混选）：同批严格同类的硬规则，整组拒绝
      for (const row of agentRows) {
        errors.push({
          cardId: row.card.id,
          error: "Agent 批量生图禁止混类：face/back/box/border 须同批严格相同",
        })
      }
    } else {
      for (const row of agentRows) {
        if (row.card.isLocked && row.card.agentKind) {
          errors.push({
            cardId: row.card.id,
            error: "Agent 工作流尚未完成提示词阶段，卡片暂不可操作",
          })
          continue
        }
        const prompt = getGenerationPrompt(
          {
            prompt: row.card.prompt,
            translatedPrompt: row.card.translatedPrompt,
            displayLanguage: row.card.displayLanguage as "zh" | "en",
          },
          input.languagePreference,
        )
        if (!prompt.trim()) {
          errors.push({ cardId: row.card.id, error: "提示词为空，请先填写提示词" })
          continue
        }
        const res = await generateAgentCardImageForAction({
          ctx,
          enterpriseId,
          taskId: row.taskId,
          promptCardId: row.card.id,
          prompt,
        })
        if (res.ok) {
          tasks.push({
            cardId: row.card.id,
            cardImageId: res.cardImageId,
            generationTaskId: res.generationTaskId,
          })
        } else {
          errors.push({ cardId: row.card.id, error: res.error })
        }
      }
    }
  }
  const agentSubmitted = tasks.length
  const missingIdErrors = uniqueIds
    .filter((id) => !ownedRows.some((r) => r.card.id === id))
    .map((cardId) => ({ cardId, error: "卡片不存在" }))

  // ── 模型查询 + 权限校验（普通卡片整个批次只做一次；Agent 卡片走冻结模型
  //    不受此处影响——模型不可用时仅普通卡片报错）。apiId 缺省（Agent 任务
  //    视图无生成配置入口）不查库，直接按模型不可用处理；纯 Agent 批次在
  //    下方提前返回，普通卡片逐卡收到明确报错 ──
  const [model] = input.apiId
    ? await db
        .select()
        .from(models)
        .where(eq(models.id, input.apiId))
        .limit(1)
    : []
  let modelError: string | null = null
  if (!model || !model.isActive || !model.visibleInWorkspace) {
    modelError = "模型不存在或不可用"
  } else if (model.enterpriseId !== null && model.enterpriseId !== enterpriseId) {
    modelError = "无权使用该模型"
  } else if (model.enterpriseId === null) {
    // 平台预置模型按企业 visiblePresetModels 白名单校验（需求 2c）
    const visiblePreset =
      (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
    if (visiblePreset.length > 0 && !visiblePreset.includes(model.id)) {
      modelError = "该平台预置模型未对本企业开放"
    }
  }
  if (!modelError && input.apiId) modelError = checkModelAccess(ctx, input.apiId)
  if (modelError && normalRows.length === 0) {
    // 全部为 Agent 卡：Agent 结果已就绪（成功或错误均在 tasks/errors 中）
    return { ok: true, submitted: agentSubmitted, tasks, errors: [...errors, ...missingIdErrors] }
  }
  if (modelError) {
    return {
      ok: true,
      submitted: agentSubmitted,
      tasks,
      errors: [
        ...errors,
        ...normalRows.map((r) => ({ cardId: r.card.id, error: modelError! })),
        ...missingIdErrors,
      ],
    }
  }

  const ownedMap = new Map(normalRows.map((r) => [r.card.id, r.card]))
  // Agent 卡已在上方分流处理（成功入 tasks 或错误入 errors），不得再进普通
  // 卡校验循环——否则已成功提交的 Agent 卡会被误报「卡片不存在」（与成功
  // 记录同卡并存，前端批量结果展示错乱）
  const agentCardIds = new Set(agentRows.map((r) => r.card.id))

  // ── 内存中逐卡校验提示词（普通卡片） ──
  const valid: Array<{
    card: typeof promptCards.$inferSelect
    prompt: string
  }> = []
  for (const cardId of uniqueIds) {
    if (agentCardIds.has(cardId)) continue
    const card = ownedMap.get(cardId)
    if (!card) {
      errors.push({ cardId, error: "卡片不存在" })
      continue
    }
    if (card.isLocked && card.agentKind) {
      errors.push({ cardId, error: "Agent 工作流尚未完成提示词阶段，卡片暂不可操作" })
      continue
    }
    const prompt = getGenerationPrompt(
      {
        prompt: card.prompt,
        translatedPrompt: card.translatedPrompt,
        displayLanguage: card.displayLanguage as "zh" | "en",
      },
      input.languagePreference,
    )
    if (!prompt.trim()) {
      errors.push({ cardId, error: "提示词为空，请先填写提示词" })
      continue
    }
    valid.push({ card, prompt })
  }
  if (valid.length === 0) return { ok: true, submitted: agentSubmitted, tasks, errors }

  // ── 一次性总额扣费 + 建任务/图片行（单事务，任一步失败整体回滚）。
  // 此前先扣费提交、再插行：崩溃在中间窗口会出现「已扣费但无任务行」，
  // 退款与对账都无凭据。余额不足快速失败，什么都不写。
  const cost = model!.costPerImage
  const totalCost = cost * valid.length
  let insertedTaskIds: string[] = []
  let imageIdByCard = new Map<string, string>()
  try {
    const r = await db.transaction(async (tx) => {
      await deductUserCredits({
        enterpriseId,
        amount: totalCost,
        userId: ctx.user.id,
        taskId: null,
        remark: `工作台批量生图 ${model!.displayName} x${valid.length}`,
        tx,
      })

      // ── 批量 INSERT 任务行（creditsCharged 逐行记录，退款逻辑不变）──
      const insertedTasks = await tx
        .insert(generationTasks)
        .values(
          valid.map((v) => ({
            enterpriseId,
            userId: ctx.user.id,
            modelId: model!.id,
            prompt: v.prompt,
            imageSize: input.size || "1024x1024",
            imageCount: 1,
            status: "queued" as const,
            taskType: "workspace_single" as const,
            source: "workspace" as const,
            priority: ctx.group?.priority ?? 0,
            creditsCharged: cost,
            costPerImage: cost, // 记录提交时单价（部分失败按张退款用）
            referenceImages:
              v.card.referenceImages.length > 0 ? v.card.referenceImages : null,
          })),
        )
        .returning({ id: generationTasks.id })
      const taskIds = insertedTasks.map((t) => t.id)

      // ── 批量 INSERT 图片行，直接带 generationTaskId（省掉逐卡 UPDATE）──
      const insertedImages = await tx
        .insert(cardImages)
        .values(
          valid.map((v, i) => ({
            enterpriseId,
            cardId: v.card.id,
            generationTaskId: taskIds[i]!,
            imageApiId: model!.id,
            imageUrl: "",
            size: input.size,
            status: "pending" as const,
            isSelected: false,
            generationPrompt: v.prompt,
            source: "generated",
          })),
        )
        .returning({ id: cardImages.id, cardId: cardImages.cardId })

      // 已有选中图的卡片（重新生成场景）清空当前选中：成功后
      // ensureCardSelection 兜底选最新完成图（即本次新图），卡面才会
      // 从旧模型的图切到新结果；失败时三级回退仍显示旧图
      const validCardIds = valid.map((v) => v.card.id)
      await tx
        .update(promptCards)
        .set({ selectedImageId: null, updatedAt: new Date() })
        .where(
          and(
            inArray(promptCards.id, validCardIds),
            isNotNull(promptCards.selectedImageId),
          ),
        )
      await tx
        .update(cardImages)
        .set({ isSelected: false, updatedAt: new Date() })
        .where(
          and(
            inArray(cardImages.cardId, validCardIds),
            eq(cardImages.isSelected, true),
          ),
        )

      return {
        taskIds,
        imageIdByCard: new Map(
          insertedImages.map((row) => [row.cardId, row.id] as const),
        ),
      }
    })
    insertedTaskIds = r.taskIds
    imageIdByCard = r.imageIdByCard
  } catch (err) {
    const msg = err instanceof Error ? err.message : "批量提交失败"
    console.error("[workspace] 批量生图扣费/建行失败（事务已回滚）:", msg)
    // Agent 卡片已各自独立提交成功（独立事务/扣费），不随普通批次回滚丢弃
    return {
      ok: true,
      submitted: agentSubmitted,
      tasks,
      errors: [...errors, ...valid.map((v) => ({ cardId: v.card.id, error: msg }))],
    }
  }

  // ── pipeline 一次入队（事务外：Redis 不可用不能吞掉已落库的任务，
  // 失败走补偿——全额退款 + 已提交行批量置 failed）──
  try {
    await enqueueMany(
      valid.map((v, i) => ({
        taskId: insertedTaskIds[i]!,
        enterpriseId,
        modelId: model!.id,
        prompt: v.prompt,
        imageSize: input.size || "1024x1024",
        imageCount: 1,
        referenceImages: v.card.referenceImages,
        priority: ctx.group?.priority ?? 0,
        costPerImage: model!.costPerImage,
        apiTimeout: model!.apiTimeout,
        taskTimeout: model!.taskTimeout,
        maxRetries: model!.maxRetries,
      })),
    )

    const resultTasks = valid.map((v, i) => ({
      cardId: v.card.id,
      cardImageId: imageIdByCard.get(v.card.id)!,
      generationTaskId: insertedTaskIds[i]!,
    }))

    revalidatePath("/workspace")
    return {
      ok: true,
      submitted: agentSubmitted + valid.length,
      tasks: [...tasks, ...resultTasks],
      errors,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "批量提交失败"
    console.error("[workspace] 批量生图入队失败，执行补偿:", msg)
    // 全额退款 + 已插入行批量置 failed，保证积分与任务状态一致
    try {
      await refundUserCredits({
        enterpriseId,
        amount: totalCost,
        userId: ctx.user.id,
        taskId: null,
        remark: `工作台批量生图失败退还 x${valid.length}`,
      })
    } catch (refundErr) {
      console.error(
        "[workspace] 批量生图退款失败（需人工对账）:",
        refundErr instanceof Error ? refundErr.message : refundErr,
      )
    }
    if (insertedTaskIds.length > 0) {
      await db
        .update(generationTasks)
        .set({ status: "failed", errorMessage: `批量提交失败：${msg}` })
        .where(inArray(generationTasks.id, insertedTaskIds))
      await db
        .update(cardImages)
        .set({
          status: "failed",
          errorMessage: `批量提交失败：${msg}`,
          updatedAt: new Date(),
        })
        .where(inArray(cardImages.generationTaskId, insertedTaskIds))
    }
    return {
      ok: true,
      submitted: agentSubmitted,
      tasks,
      errors: [...errors, ...valid.map((v) => ({ cardId: v.card.id, error: msg }))],
    }
  }
}

/** 批量提示词变形共享实现（batchDeepen / batchRegeneratePrompt / batchTranslate
 *  三个 action 的合一内核：创建 chatTask 交由对话队列处理；translate 额外跳过
 *  已有有效译文的卡片并在返回中带 skippedCardIds） */



/** 批量提示词变形共享实现（batchDeepen / batchRegeneratePrompt / batchTranslate
 *  三个 action 的合一内核：创建 chatTask 交由对话队列处理；translate 额外跳过
 *  已有有效译文的卡片并在返回中带 skippedCardIds） */
async function batchMutatePrompt(
  kind: PromptMutationKind,
  cardIds: string[],
  input: { templateId: string },
): Promise<{
  ok: boolean
  submitted: string[]
  cardIds: string[]
  skippedCardIds: string[]
  errors: Array<{ cardId: string; error: string }>
}> {
  const isTranslate = kind === "translate"
  const empty = () => ({
    ok: false as const,
    submitted: [] as string[],
    cardIds: [] as string[],
    skippedCardIds: [] as string[],
    errors: [] as Array<{ cardId: string; error: string }>,
  })
  const g = await requireActionGuard(
    "workspace",
    z.tuple([wsCardIdsSchema, templateOnlySchema]),
    [cardIds, input],
  )
  if (!g.ok) return empty()
  const { ctx, enterpriseId } = g
  const submitted: string[] = []
  const skippedCardIds: string[] = []
  const errors: Array<{ cardId: string; error: string }> = []

  let tpl
  try {
    tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: kind,
      enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
  } catch (err) {
    return {
      ok: false as const,
      submitted: [] as string[],
      cardIds: [] as string[],
      skippedCardIds: [] as string[],
      errors: cardIds.map((cardId) => ({
        cardId,
        error: err instanceof Error ? err.message : "模板不可用",
      })),
    }
  }

  for (const cardId of cardIds) {
    const owned = await fetchOwnedCard(ctx, cardId)
    if (!owned) {
      errors.push({ cardId, error: "卡片不存在" })
      continue
    }
    const c = owned.card
    const lockedError = lockedWorkspaceAgentCardError(owned)
    if (lockedError) {
      errors.push({ cardId, error: lockedError })
      continue
    }
    // 翻译跳过已有有效译文（译文存在 + 源提示词未变 + 状态已同步）
    if (isTranslate) {
      const hasValid =
        !!c.translatedPrompt &&
        c.translationSourcePrompt === c.prompt &&
        c.translationStatus === "synced"
      if (hasValid) {
        skippedCardIds.push(cardId)
        continue
      }
    }
    await db.insert(chatTasks).values({
      enterpriseId,
      userId: ctx.user.id,
      apiConfigId: tpl.chatApi.id ?? null,
      taskType: kind,
      cardId,
      workspaceTaskId: owned.task.id,
      templateId: tpl.id,
      originalPrompt: c.prompt,
      status: "queued",
    })
    submitted.push(cardId)
  }

  revalidatePath("/workspace")
  // skippedCardIds 恒返回（非翻译为空数组）：客户端按 string[] 消费，不需判空
  return {
    ok: true,
    submitted,
    cardIds: submitted,
    skippedCardIds: isTranslate ? skippedCardIds : [],
    errors,
  }
}

/** 批量细化（创建 chatTask，由 cron 处理） */



/** 批量细化（创建 chatTask，由 cron 处理） */
export async function batchDeepenAction(
  cardIds: string[],
  input: { templateId: string },
) {
  return batchMutatePrompt("deepen", cardIds, input)
}

/** 批量重生成提示词 */



/** 批量重生成提示词 */
export async function batchRegeneratePromptAction(
  cardIds: string[],
  input: { templateId: string },
) {
  return batchMutatePrompt("regenerate", cardIds, input)
}

/** 批量翻译（跳过已有有效译文的卡片） */



/** 批量翻译（跳过已有有效译文的卡片） */
export async function batchTranslatePromptAction(
  cardIds: string[],
  input: { templateId: string },
) {
  return batchMutatePrompt("translate", cardIds, input)
}

/** 批量替换提示词 */



/** 批量替换提示词 */
export async function batchReplacePromptsAction(
  taskId: string,
  input: {
    selectedCardIds: string[]
    items: Array<{ cardIndex: number; prompt: string }>
  },
): Promise<{
  ok: boolean
  updatedCount: number
  createdCount: number
  conflictCount: number
  cardCount: number
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, updatedCount: 0, createdCount: 0, conflictCount: 0, cardCount: 0 }
  if (!wsIdSchema.safeParse(taskId).success) return { ok: false, updatedCount: 0, createdCount: 0, conflictCount: 0, cardCount: 0 }
  const parsed = batchReplacePromptsSchema.safeParse(input)
  if (!parsed.success) return { ok: false, updatedCount: 0, createdCount: 0, conflictCount: 0, cardCount: 0 }
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) {
    return { ok: false, updatedCount: 0, createdCount: 0, conflictCount: 0, cardCount: 0 }
  }
  if (task.source === "agent") {
    return { ok: false, updatedCount: 0, createdCount: 0, conflictCount: 0, cardCount: task.cardCount }
  }

  const allCards = await db
    .select({ id: promptCards.id, cardIndex: promptCards.cardIndex })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
  const selectedSet = new Set(input.selectedCardIds)
  const selectedIndexSet = new Set(
    allCards.filter((c) => selectedSet.has(c.id)).map((c) => c.cardIndex),
  )
  const allIndexSet = new Set(allCards.map((c) => c.cardIndex))

  let updatedCount = 0
  let createdCount = 0
  let conflictCount = 0

  for (const item of input.items) {
    const prompt = item.prompt.trim()
    if (!prompt) continue
    if (selectedIndexSet.has(item.cardIndex)) {
      const card = allCards.find(
        (c) => c.cardIndex === item.cardIndex && selectedSet.has(c.id),
      )
      if (card) {
        await db
          .update(promptCards)
          .set({
            prompt,
            translationStatus: "outdated",
            updatedAt: new Date(),
          })
          .where(eq(promptCards.id, card.id))
        updatedCount++
      }
    } else if (allIndexSet.has(item.cardIndex)) {
      conflictCount++
    } else {
      await db.insert(promptCards).values({
        enterpriseId: scope.enterpriseId,
        taskId,
        cardIndex: item.cardIndex,
        prompt,
      })
      createdCount++
      allIndexSet.add(item.cardIndex)
    }
  }

  const [countRow] = await db
    .select({ c: sql<number>`count(*)` })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
  const cardCount = Number(countRow?.c ?? 0)
  await db
    .update(workspaceTasks)
    .set({ cardCount, updatedAt: new Date() })
    .where(eq(workspaceTasks.id, taskId))

  revalidatePath("/workspace")
  return { ok: true, updatedCount, createdCount, conflictCount, cardCount }
}

/** 批量绑定上传图片到多张卡片（去重） */



/** 批量绑定上传图片到多张卡片（去重） */
export async function batchAttachUploadedImagesAction(
  cardIds: string[],
  imageUrls: string[],
): Promise<{
  ok: boolean
  updatedCardIds: string[]
  imagesByCard: Record<string, CardImageRow[]>
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, updatedCardIds: [], imagesByCard: {} }
  if (!wsCardIdsSchema.safeParse(cardIds).success) return { ok: false, updatedCardIds: [], imagesByCard: {} }
  const parsed = batchAttachUrlsSchema.safeParse(imageUrls)
  if (!parsed.success) return { ok: false, updatedCardIds: [], imagesByCard: {} }
  const scope = getCurrentEnterpriseScope(ctx)
  const urls = normalizeReferenceImages(imageUrls)
  // 归属校验同 addUploadedCardImageAction：批量绑定前校验全部 URL，
  // 防止外域/跨租户 URL 借此落库（导出时会被服务端拉取，构成 SSRF）
  const refErr = await validateReferenceImageUrls(urls, scope.enterpriseId)
  if (refErr) return { ok: false, updatedCardIds: [], imagesByCard: {} }
  const updatedCardIds: string[] = []
  const imagesByCard: Record<string, CardImageRow[]> = {}

  for (const cardId of cardIds) {
    const owned = await fetchOwnedCard(ctx, cardId)
    if (!owned) continue
    const existing = await db
      .select({ imageUrl: cardImages.imageUrl })
      .from(cardImages)
      .where(
        and(
          eq(cardImages.cardId, cardId),
          eq(cardImages.enterpriseId, scope.enterpriseId),
          eq(cardImages.source, "uploaded"),
        ),
      )
    const existingSet = new Set(existing.map((e) => e.imageUrl))
    const toInsert = urls.filter((u) => !existingSet.has(u))
    if (toInsert.length === 0) continue
    const inserted = await db
      .insert(cardImages)
      .values(
        toInsert.map((url) => ({
          enterpriseId: scope.enterpriseId,
          cardId,
          imageUrl: url,
          source: "uploaded" as const,
          status: "completed" as const,
          isSelected: false,
        })),
      )
      .returning()
    updatedCardIds.push(cardId)
    imagesByCard[cardId] = inserted.map((r) => ({
      id: r.id,
      cardId: r.cardId,
      generationTaskId: r.generationTaskId,
      generationPrompt: r.generationPrompt,
      imageApiId: r.imageApiId,
      imageUrl: r.imageUrl,
      modelName: null,
      size: r.size,
      format: r.format,
      status: r.status as CardImageRow["status"],
      errorMessage: r.errorMessage,
      isSelected: r.isSelected,
      source: r.source as CardImageRow["source"],
      generationStartedAt: null,
      generationCompletedAt: null,
      createdAt: r.createdAt,
    }))
  }

  revalidatePath("/workspace")
  return { ok: true, updatedCardIds, imagesByCard }
}

/** 提取编号提示词 */



/** 提取编号提示词 */
export async function extractNumberedPromptsAction(
  taskId: string,
  input: { templateId: string; input: string },
): Promise<{
  ok: boolean
  error: string | null
  items: Array<{ cardIndex: number; prompt: string }>
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied, items: [] }
  if (!wsIdSchema.safeParse(taskId).success) return { ok: false, error: "参数错误（id 非法）", items: [] }
  const parsed = extractNumberedPromptsSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误", items: [] }
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { ok: false, error: "任务不存在", items: [] }
  try {
    const tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: "extract",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
    const items = await extractNumberedPromptReplacements({
      config: tpl.chatApi,
      rawText: input.input,
      template: tpl.content,
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      workspaceTaskId: taskId,
      apiConfigId: tpl.chatApi.id,
      apiConfigName: tpl.chatApi.name,
    })
    return { ok: true, error: null, items }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "提取失败",
      items: [],
    }
  }
}

// ═══════════════ 模板管理 ═══════════════

/** 按类型查询模板（JOIN chatApiConfigs 获取 api_name） */


