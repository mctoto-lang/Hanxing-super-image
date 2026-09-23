"use server"

import { z } from "zod"
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { cardImages, generationTasks, models, promptCards } from "@/db/schema"
import { getCurrentEnterpriseScope, requireUserContext } from "@/lib/auth/session"
import { checkModuleAccess, isEnterpriseAdmin } from "@/lib/auth/permissions"
import { deepenPrompt, getExecutableTemplate, translatePrompt } from "@/server/services/workspace-ai"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { addCardSchema, addUploadedCardImageSchema, cardPromptTemplateSchema, generateCardImageSchema, templateOnlySchema, updateCardReferenceImagesSchema, updateCardSchema, wsCardIdsSchema, wsIdSchema } from "@/server/schemas/workspace"
import { revalidatePath } from "next/cache"
import { requireActionGuard } from "@/server/actions/action-kit"
import { getReferenceImageLimit, normalizeReferenceImages } from "@/lib/workspace/helpers"
import type { CardImageRow, PromptCardRow, TaskCardImagesPayload } from "@/lib/workspace/types"
import { PromptMutationKind, cardImageSelectFields, cardRowSelectFields, fetchOwnedCard, fetchOwnedTask, generateCardImageInternal, updateTaskCardCount } from "./shared"


/**
 * 聚合查询任务下所有卡片的图片状态（轮询核心）。
 *
 * 增量模式（传 since，上一轮返回的 serverTime）：
 *   - 计数来自一条 GROUP BY 聚合（替代全量图片行 + O(卡×图) filter）；
 *   - images 只返回 updatedAt > since 的变化行 + 各卡当前选中行
 *     （保证 selectedImage 可构建），客户端按 id upsert 合并；
 *   - 未变化的卡片 images 为空数组，客户端保留原数组引用（memo 生效）。
 * 不传 since 返回全量（首次轮询）。
 */
export async function getTaskCardImagesAction(
  taskId: string,
  since?: string,
): Promise<TaskCardImagesPayload> {
  // serverTime 取在查询之前：查询执行期间落库的行下一轮 since 一定能覆盖到
  const serverTime = new Date()
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { cards: {}, serverTime: new Date().toISOString() }
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { cards: {} }

  const cards = await db
    .select({
      id: promptCards.id,
      selectedImageId: promptCards.selectedImageId,
    })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
    .orderBy(promptCards.cardIndex)

  const cardIds = cards.map((c) => c.id)
  if (cardIds.length === 0) {
    return { cards: {}, serverTime: serverTime.toISOString() }
  }

  // 计数聚合（一条 GROUP BY）
  const countRows = await db
    .select({
      cardId: cardImages.cardId,
      status: cardImages.status,
      count: sql<number>`count(*)`,
    })
    .from(cardImages)
    .where(
      and(
        eq(cardImages.enterpriseId, scope.enterpriseId),
        inArray(cardImages.cardId, cardIds),
      ),
    )
    .groupBy(cardImages.cardId, cardImages.status)

  const countMap = new Map<
    string,
    { pending: number; completed: number; failed: number }
  >()
  for (const row of countRows) {
    const entry = countMap.get(row.cardId) ?? {
      pending: 0,
      completed: 0,
      failed: 0,
    }
    const n = Number(row.count)
    if (row.status === "pending" || row.status === "generating") {
      entry.pending += n
    } else if (row.status === "completed") {
      entry.completed += n
    } else if (row.status === "failed") {
      entry.failed += n
    }
    countMap.set(row.cardId, entry)
  }

  const incremental = Boolean(since)
  const sinceDate = incremental ? new Date(since!) : null
  if (incremental && Number.isNaN(sinceDate!.getTime())) {
    // 非法 since 按全量处理
    return getTaskCardImagesAction(taskId)
  }

  // 增量窗口回看 3s：worker 写入的 updatedAt（worker 进程时钟）可能落在上一轮
  // serverTime（web 进程时钟）附近甚至之前，跨界行会被所有后续增量永久跳过。
  // 重发的未变化行由客户端 mergeImageRows 幂等吸收，代价仅为 3s 内的变化行。
  const DELTA_OVERLAP_MS = 3_000
  const deltaSinceDate =
    sinceDate && !Number.isNaN(sinceDate.getTime())
      ? new Date(sinceDate.getTime() - DELTA_OVERLAP_MS)
      : null

  const selectedIds = cards
    .map((c) => c.selectedImageId)
    .filter((v): v is string => Boolean(v))

  const imageConditions = [
    eq(cardImages.enterpriseId, scope.enterpriseId),
    inArray(cardImages.cardId, cardIds),
  ]
  if (deltaSinceDate) {
    const deltaCondition = selectedIds.length > 0
      ? or(
          gt(cardImages.updatedAt, deltaSinceDate),
          inArray(cardImages.id, selectedIds),
        )
      : gt(cardImages.updatedAt, deltaSinceDate)
    imageConditions.push(deltaCondition!)
  }

  const images = await db
    .select(cardImageSelectFields)
    .from(cardImages)
    .leftJoin(models, eq(cardImages.imageApiId, models.id))
    .leftJoin(
      generationTasks,
      eq(cardImages.generationTaskId, generationTasks.id),
    )
    .where(and(...imageConditions))
    .orderBy(desc(cardImages.createdAt))

  const imagesByCard = new Map<string, typeof images>()
  for (const img of images) {
    const list = imagesByCard.get(img.cardId)
    if (list) list.push(img)
    else imagesByCard.set(img.cardId, [img])
  }

  const payload: TaskCardImagesPayload = {
    serverTime: serverTime.toISOString(),
    incremental,
    cards: {},
  }
  for (const card of cards) {
    const counts = countMap.get(card.id) ?? {
      pending: 0,
      completed: 0,
      failed: 0,
    }
    const cardImgs = imagesByCard.get(card.id) ?? []
    const sel = cardImgs.find((i) => i.id === card.selectedImageId) ?? null
    payload.cards[card.id] = {
      cardId: card.id,
      pendingCount: counts.pending,
      completedCount: counts.completed,
      failedCount: counts.failed,
      // 增量模式下未取到选中行时省略该字段，客户端保留上一轮的选中图信息
      selectedImage: sel
        ? {
            id: sel.id,
            imageUrl: sel.imageUrl,
            modelName: sel.modelName,
            size: sel.size,
            startedAt: sel.generationStartedAt,
            completedAt: sel.generationCompletedAt,
            createdAt: sel.createdAt,
          }
        : incremental
          ? undefined
          : null,
      images: cardImgs as CardImageRow[],
    }
  }
  return payload
}

// ═══════════════ 卡片管理 ═══════════════

/** 获取任务的卡片列表（JOIN 选中图信息 + 模型名） */



// ═══════════════ 卡片管理 ═══════════════

/** 获取任务的卡片列表（JOIN 选中图信息 + 模型名） */
export async function getTaskCardsAction(
  taskId: string,
  opts?: { pageSize?: number },
): Promise<{ cards: PromptCardRow[]; total: number }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { cards: [], total: 0 }
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { cards: [], total: 0 }
  const pageSize = opts?.pageSize ?? 1000

  const [cards, totalRow] = await Promise.all([
    db
      .select(cardRowSelectFields)
      .from(promptCards)
      .leftJoin(cardImages, eq(promptCards.selectedImageId, cardImages.id))
      .leftJoin(models, eq(cardImages.imageApiId, models.id))
      .leftJoin(
        generationTasks,
        eq(cardImages.generationTaskId, generationTasks.id),
      )
      .where(
        and(
          eq(promptCards.taskId, taskId),
          eq(promptCards.enterpriseId, scope.enterpriseId),
        ),
      )
      .orderBy(promptCards.cardIndex)
      .limit(pageSize),
    db
      .select({ c: sql<number>`count(*)` })
      .from(promptCards)
      .where(
        and(
          eq(promptCards.taskId, taskId),
          eq(promptCards.enterpriseId, scope.enterpriseId),
        ),
      ),
  ])

  return { cards: cards as PromptCardRow[], total: Number(totalRow[0]?.c ?? 0) }
}

/** 添加卡片（cardIndex = MAX+1） */



/** 添加卡片（cardIndex = MAX+1） */
export async function addCardAction(
  taskId: string,
  input: { prompt: string },
) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(taskId).success) return { ok: false, error: "参数错误（id 非法）" }
  const parsed = addCardSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { ok: false, error: "任务不存在" }
  // 允许空白卡片：点击「添加卡片」直接创建，提示词后续在卡片背面编辑
  const prompt = input.prompt.trim()

  const [maxRow] = await db
    .select({ m: sql<number>`coalesce(max(${promptCards.cardIndex}), 0)` })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
  const nextIndex = Number(maxRow?.m ?? 0) + 1

  const [card] = await db
    .insert(promptCards)
    .values({
      enterpriseId: scope.enterpriseId,
      taskId,
      cardIndex: nextIndex,
      prompt,
    })
    .returning()
  await updateTaskCardCount(taskId, scope.enterpriseId)
  revalidatePath("/workspace")
  return { ok: true, error: null, cardId: card!.id }
}

/** 更新卡片提示词/显示语言 */



/** 更新卡片提示词/显示语言 */
export async function updateCardAction(
  cardId: string,
  input: { prompt?: string; displayLanguage?: "zh" | "en" },
) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(cardId).success) return { ok: false, error: "参数错误（id 非法）" }
  const parsed = updateCardSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  await db
    .update(promptCards)
    .set({
      ...(input.prompt !== undefined
        ? { prompt: input.prompt, translationStatus: "outdated" }
        : {}),
      ...(input.displayLanguage !== undefined
        ? { displayLanguage: input.displayLanguage }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(promptCards.id, cardId))
  revalidatePath("/workspace")
  return { ok: true, error: null }
}

/** 删除卡片 */



/** 删除卡片 */
export async function deleteCardAction(cardId: string) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(cardId).success) return { ok: false, error: "参数错误（id 非法）" }
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  const taskId = owned.task.id
  await db
    .delete(promptCards)
    .where(
      and(
        eq(promptCards.id, cardId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
  await updateTaskCardCount(taskId, scope.enterpriseId)
  revalidatePath("/workspace")
  return { ok: true, error: null }
}

/** 批量删除卡片 */



/** 批量删除卡片 */
export async function batchDeleteCardsAction(cardIds: string[]) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, deletedIds: [], deletedCount: 0 }
  if (!wsCardIdsSchema.safeParse(cardIds).success) return { ok: false, deletedIds: [], deletedCount: 0 }
  const scope = getCurrentEnterpriseScope(ctx)
  const validIds: string[] = []
  const taskIds = new Set<string>()
  for (const id of cardIds) {
    const owned = await fetchOwnedCard(ctx, id)
    if (owned) {
      validIds.push(id)
      taskIds.add(owned.task.id)
    }
  }
  if (validIds.length > 0) {
    await db
      .delete(promptCards)
      .where(
        and(
          inArray(promptCards.id, validIds),
          eq(promptCards.enterpriseId, scope.enterpriseId),
        ),
      )
  }
  for (const tid of taskIds) await updateTaskCardCount(tid, scope.enterpriseId)
  revalidatePath("/workspace")
  return { ok: true, deletedIds: validIds, deletedCount: validIds.length }
}

/** 提示词变形类型：deepen 细化 / regenerate 重生成共用一条链路（写回 prompt），
 *  translate 翻译走独立链路（写回 translatedPrompt） */



const PROMPT_MUTATION_FAIL_LABEL: Record<PromptMutationKind, string> = {
  deepen: "细化失败",
  regenerate: "重新生成失败",
  translate: "翻译失败",
}

/**
 * 同步提示词变形共享实现（deepenCardPrompt / regenerateCardPrompt /
 * translateCardPrompt 三个 action 的合一内核；导出包装保持原签名与返回结构）
 */



/**
 * 同步提示词变形共享实现（deepenCardPrompt / regenerateCardPrompt /
 * translateCardPrompt 三个 action 的合一内核；导出包装保持原签名与返回结构）
 */
async function mutateCardPrompt(
  kind: PromptMutationKind,
  cardId: string,
  input: { prompt?: string; templateId: string },
): Promise<{
  ok: boolean
  error: string | null
  newPrompt?: string
  translatedPrompt?: string
}> {
  const g = await requireActionGuard(
    "workspace",
    z.tuple([wsIdSchema, kind === "translate" ? templateOnlySchema : cardPromptTemplateSchema]),
    [cardId, input],
  )
  if (!g.ok) return { ok: false, error: g.error }
  const { ctx, enterpriseId } = g
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  try {
    const tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: kind,
      enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
    const logCtx = {
      config: tpl.chatApi,
      template: tpl.content,
      enterpriseId,
      userId: ctx.user.id,
      cardId,
      workspaceTaskId: owned.task.id,
      apiConfigId: tpl.chatApi.id,
      apiConfigName: tpl.chatApi.name,
    }
    if (kind === "translate") {
      const translatedPrompt = await translatePrompt({
        ...logCtx,
        currentPrompt: owned.card.prompt,
      })
      await db
        .update(promptCards)
        .set({
          translatedPrompt,
          translationSourcePrompt: owned.card.prompt,
          translationStatus: "synced",
          translationTemplateId: tpl.id,
          updatedAt: new Date(),
        })
        .where(eq(promptCards.id, cardId))
      revalidatePath("/workspace")
      return { ok: true, error: null, translatedPrompt }
    }
    const newPrompt = await deepenPrompt({
      ...logCtx,
      currentPrompt: input.prompt!,
      templateType: kind,
    })
    await db
      .update(promptCards)
      .set({
        prompt: newPrompt,
        translationStatus: "outdated",
        updatedAt: new Date(),
      })
      .where(eq(promptCards.id, cardId))
    revalidatePath("/workspace")
    return { ok: true, error: null, newPrompt }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : PROMPT_MUTATION_FAIL_LABEL[kind],
    }
  }
}

/** 同步细化卡片提示词 */



/** 同步细化卡片提示词 */
export async function deepenCardPromptAction(
  cardId: string,
  input: { prompt: string; templateId: string },
): Promise<{ ok: boolean; error: string | null; newPrompt?: string }> {
  return mutateCardPrompt("deepen", cardId, input)
}

/** 同步重新生成卡片提示词 */



/** 同步重新生成卡片提示词 */
export async function regenerateCardPromptAction(
  cardId: string,
  input: { prompt: string; templateId: string },
): Promise<{ ok: boolean; error: string | null; newPrompt?: string }> {
  return mutateCardPrompt("regenerate", cardId, input)
}

/** 同步翻译卡片提示词 */



/** 同步翻译卡片提示词 */
export async function translateCardPromptAction(
  cardId: string,
  input: { templateId: string },
): Promise<{ ok: boolean; error: string | null; translatedPrompt?: string }> {
  return mutateCardPrompt("translate", cardId, input)
}

/** 单卡生图内部实现 */



/** 单卡生图 */
export async function generateCardImageAction(
  cardId: string,
  input: { prompt: string; apiId: string; size: string },
): Promise<{
  ok: boolean
  error: string | null
  cardImageId?: string
  generationTaskId?: string
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(cardId).success) return { ok: false, error: "参数错误（id 非法）" }
  const parsed = generateCardImageSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  const res = await generateCardImageInternal({
    ctx,
    enterpriseId: scope.enterpriseId,
    card: { id: owned.card.id, referenceImages: owned.card.referenceImages },
    prompt: input.prompt,
    apiId: input.apiId,
    size: input.size,
  })
  if (!res.ok) return res
  revalidatePath("/workspace")
  return {
    ok: true,
    error: null,
    cardImageId: res.cardImageId,
    generationTaskId: res.generationTaskId,
  }
}

/** 重新生成卡片图片 */



/** 重新生成卡片图片 */
export async function regenerateCardImageAction(
  cardId: string,
  input: { prompt: string; apiId: string; size: string },
): Promise<{
  ok: boolean
  error: string | null
  cardImageId?: string
  generationTaskId?: string
}> {
  return generateCardImageAction(cardId, input)
}

/** 获取卡片下所有图片 */



/** 获取卡片下所有图片 */
export async function getCardImagesAction(
  cardId: string,
): Promise<{ images: CardImageRow[]; referenceImages: string[] }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { images: [], referenceImages: [] }
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { images: [], referenceImages: [] }
  const images = await db
    .select(cardImageSelectFields)
    .from(cardImages)
    .leftJoin(models, eq(cardImages.imageApiId, models.id))
    .leftJoin(
      generationTasks,
      eq(cardImages.generationTaskId, generationTasks.id),
    )
    .where(
      and(
        eq(cardImages.cardId, cardId),
        eq(cardImages.enterpriseId, scope.enterpriseId),
      ),
    )
    .orderBy(desc(cardImages.createdAt))
  return {
    images: images as CardImageRow[],
    referenceImages: owned.card.referenceImages,
  }
}

/** 选定图片（同卡其他取消选中） */



/** 选定图片（同卡其他取消选中） */
export async function selectCardImageAction(imageId: string) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(imageId).success) return { ok: false, error: "参数错误（id 非法）" }
  const scope = getCurrentEnterpriseScope(ctx)
  const [img] = await db
    .select()
    .from(cardImages)
    .where(
      and(
        eq(cardImages.id, imageId),
        eq(cardImages.enterpriseId, scope.enterpriseId),
      ),
    )
    .limit(1)
  if (!img) return { ok: false, error: "图片不存在" }

  const owned = await fetchOwnedCard(ctx, img.cardId)
  if (!owned) return { ok: false, error: "无权操作该卡片" }

  await db
    .update(cardImages)
    .set({ isSelected: false, updatedAt: new Date() })
    .where(
      and(
        eq(cardImages.cardId, img.cardId),
        eq(cardImages.enterpriseId, scope.enterpriseId),
      ),
    )
  await db
    .update(cardImages)
    .set({ isSelected: true, updatedAt: new Date() })
    .where(eq(cardImages.id, imageId))
  await db
    .update(promptCards)
    .set({ selectedImageId: imageId, updatedAt: new Date() })
    .where(eq(promptCards.id, img.cardId))

  revalidatePath("/workspace")
  return { ok: true, error: null }
}

/** 更新卡片参考图（校验模型支持 + 数量上限） */



/** 更新卡片参考图（校验模型支持 + 数量上限） */
export async function updateCardReferenceImagesAction(
  cardId: string,
  input: { apiId: string; referenceImages: string[] },
) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(cardId).success) return { ok: false, error: "参数错误（id 非法）" }
  const parsed = updateCardReferenceImagesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, input.apiId))
    .limit(1)
  if (!model) return { ok: false, error: "模型不存在" }
  if (!model.supportsReferenceImage) {
    return { ok: false, error: "该模型不支持参考图" }
  }
  const limit = getReferenceImageLimit(model)
  const normalized = normalizeReferenceImages(input.referenceImages)
  if (normalized.length > limit) {
    return { ok: false, error: `参考图数量超过上限（${limit}）` }
  }
  // 参考图归属校验（防跨租户引用 / 把上游 AI 当 SSRF 代理拉任意 URL）
  const refErr = await validateReferenceImageUrls(
    normalized,
    ctx.user.enterpriseId!,
  )
  if (refErr) return { ok: false, error: refErr }
  await db
    .update(promptCards)
    .set({ referenceImages: normalized, updatedAt: new Date() })
    .where(eq(promptCards.id, cardId))
  revalidatePath("/workspace")
  return { ok: true, error: null, referenceImages: normalized }
}

/** 添加上传图片记录 */



/** 添加上传图片记录 */
export async function addUploadedCardImageAction(
  cardId: string,
  input: { imageUrl: string },
) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(cardId).success) return { ok: false, error: "参数错误（id 非法）" }
  const parsed = addUploadedCardImageSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  const imageUrl = input.imageUrl.trim()
  if (!imageUrl) return { ok: false, error: "图片地址无效" }
  // 图片归属校验：上传图 URL 会被参考图链路转给上游、被导出链路在服务端
  // 二次拉取，必须困在本企业上传的存储对象内（防 SSRF / 跨租户引用）
  const refErr = await validateReferenceImageUrls(
    [imageUrl],
    scope.enterpriseId,
  )
  if (refErr) return { ok: false, error: refErr }
  const [img] = await db
    .insert(cardImages)
    .values({
      enterpriseId: scope.enterpriseId,
      cardId,
      imageUrl,
      source: "uploaded",
      status: "completed",
      isSelected: false,
    })
    .returning()
  revalidatePath("/workspace")
  return { ok: true, error: null, imageId: img!.id }
}

// ═══════════════ 批量操作 ═══════════════

/** 批量生图 */
/**
 * 批量生图：模型校验 + 卡片归属校验各一次，总额一次扣费，
 * 批量 INSERT 任务/图片行 + pipeline 一次入队。
 * 相比逐卡串行（每卡 ~8 次 DB 往返 + 1 事务），100 卡从 ~800 次往返降到 ~8 次。
 * 扣费成功后的任一步失败：全额退款 + 已插入行批量置 failed（补偿语义）。
 */


