"use server"

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  generationTasks,
  models,
  productDirections,
  weartryFigures,
} from "@/db/schema"
import {
  requireUserContext,
  getCurrentEnterpriseScope,
  type UserContext,
} from "@/lib/auth/session"
import { checkModelAccess, checkModuleAccess } from "@/lib/auth/permissions"
import { deductUserCredits, refundFailedTask, refundUserCredits } from "@/server/services/credits-service"
import { enqueue } from "@/lib/queue/task-queue"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { aiActionRateLimiter } from "@/lib/rate-limit"
import { callAiJson } from "@/server/services/ai-json"
import {
  loadWeartryPromptTemplate,
  listActiveWeartryScenes,
  resolveWeartryScene,
} from "@/server/services/weartry-config"
import { directionInScope, parseProductBrief, fillVars } from "@/lib/product/prompt"
import {
  formatCmyk,
  hexToRgb,
  rgbToCmyk,
} from "@/lib/color/convert"
import {
  buildColorPrompt,
  buildModelImagePrompt,
  buildOutfitPrompt,
  buildTryonPrompt,
} from "@/lib/weartry/prompt"
import type {
  WeartryAiBriefResult,
  WeartryBatchRow,
  WeartryBatchTaskRow,
  WeartryFigureRow,
  WeartryModelRow,
  WeartrySceneRow,
} from "@/lib/weartry/types"
import type { ProductDirectionRow } from "@/lib/product/types"
import type { AiDegradeReason } from "@/lib/product/types"
import {
  generateColorChangeSchema,
  generateModelImageSchema,
  generateOutfitSchema,
  generateTryonSchema,
  weartryAiAssistSchema,
  type GenerateColorChangeInput,
  type GenerateModelImageInput,
  type GenerateOutfitInput,
  type GenerateTryonInput,
} from "@/server/schemas/weartry"
import { revalidatePath } from "next/cache"

/**
 * 穿戴图片 Server Actions（四 tab：服装组图 / 模特穿戴 / AI万戴 / AI换色）
 *
 * 生图沿用 generationTasks（source="weartry"），批次靠 templateInfo.batchTag
 * 聚合；计费/退款/重试链路与商品主图 V2 完全同构。
 */

// ═══════════════ 基础数据查询 ═══════════════

/** 服装组图方向池（appliesTo="weartry"；promptTemplate 裁剪不下发） */
export async function listWeartryDirectionsAction(): Promise<
  ProductDirectionRow[]
> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return []
  const rows = await db
    .select({
      id: productDirections.id,
      key: productDirections.key,
      name: productDirections.name,
      description: productDirections.description,
      promptTemplate: productDirections.promptTemplate,
      supportsCount: productDirections.supportsCount,
      maxCount: productDirections.maxCount,
      sortOrder: productDirections.sortOrder,
      isHidden: productDirections.isHidden,
      isHero: productDirections.isHero,
      appliesTo: productDirections.appliesTo,
    })
    .from(productDirections)
    .where(eq(productDirections.isActive, true))
    .orderBy(asc(productDirections.sortOrder))

  return rows
    .filter((r) => directionInScope(r.appliesTo as string[] | null, "weartry"))
    .map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      promptTemplate: "",
      supportsCount: r.supportsCount,
      maxCount: r.maxCount,
      sortOrder: r.sortOrder,
      isHidden: r.isHidden,
      isHero: r.isHero,
    }))
}

/** 预置场景下拉（超管配置；promptTemplate 裁剪不下发，组装在服务端） */
export async function listWeartryScenesAction(): Promise<WeartrySceneRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return []
  const rows = await listActiveWeartryScenes()
  return rows.map((s) => ({
    id: s.key,
    key: s.key,
    name: s.name,
    description: s.description ?? null,
  }))
}

// ═══════════════ 模特形象库（用户个人维度） ═══════════════

/**
 * 入库（幂等）：AI 生成完成后自动调用（source="ai"），自行上传成功即调用
 * （source="upload"）；同用户同图已存在时静默跳过。
 */
export async function addWeartryFigureAction(input: {
  imageUrl: string
  source: "ai" | "upload"
}): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属" }
  const scope = getCurrentEnterpriseScope(ctx)
  if (!input.imageUrl || !/^https?:\/\//.test(input.imageUrl)) {
    return { ok: false, error: "图片地址不合法" }
  }
  try {
    await db
      .insert(weartryFigures)
      .values({
        enterpriseId: scope.enterpriseId,
        userId: ctx.user.id,
        imageUrl: input.imageUrl,
        source: input.source,
      })
      .onConflictDoNothing({
        target: [weartryFigures.userId, weartryFigures.imageUrl],
      })
    return { ok: true, error: null }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "入库失败",
    }
  }
}

/** 本人模特库（倒序，最近优先；上限 60 条足够覆盖日常选用） */
export async function listWeartryFiguresAction(): Promise<WeartryFigureRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return []
  const rows = await db
    .select({
      id: weartryFigures.id,
      imageUrl: weartryFigures.imageUrl,
      source: weartryFigures.source,
      createdAt: weartryFigures.createdAt,
    })
    .from(weartryFigures)
    .where(eq(weartryFigures.userId, ctx.user.id))
    .orderBy(desc(weartryFigures.createdAt))
    .limit(60)
  return rows.map((r) => ({
    id: r.id,
    imageUrl: r.imageUrl,
    source: r.source === "upload" ? "upload" : "ai",
    createdAt: r.createdAt,
  }))
}

/** 从模特库移除（仅本人） */
export async function deleteWeartryFigureAction(
  id: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return { ok: false, error: denied }
  const deleted = await db
    .delete(weartryFigures)
    .where(
      and(
        eq(weartryFigures.id, id),
        eq(weartryFigures.userId, ctx.user.id),
      ),
    )
    .returning({ id: weartryFigures.id })
  if (deleted.length === 0) return { ok: false, error: "记录不存在" }
  return { ok: true, error: null }
}

/** 模型列表（必须穿戴页可见且支持参考图） */
export async function listWeartryModelsAction(): Promise<WeartryModelRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return []
  if (!ctx.enterprise) return []
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({
      id: models.id,
      name: models.name,
      displayName: models.displayName,
      sizePresets: models.sizePresets,
      iconUrl: models.iconUrl,
      supportsReferenceImage: models.supportsReferenceImage,
      maxReferenceImages: models.maxReferenceImages,
      costPerImage: models.costPerImage,
      apiFormat: models.apiFormat,
      enterpriseId: models.enterpriseId,
    })
    .from(models)
    .where(
      and(
        eq(models.isActive, true),
        eq(models.visibleInWeartry, true),
        eq(models.supportsReferenceImage, true),
      ),
    )
  const accessible = rows.filter(
    (m) => m.enterpriseId === null || m.enterpriseId === scope.enterpriseId,
  )
  const visiblePreset =
    (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
  const filtered =
    visiblePreset.length === 0
      ? accessible
      : accessible.filter(
          (m) => m.enterpriseId !== null || visiblePreset.includes(m.id),
        )
  if (ctx.group && ctx.group.allowedModels.length > 0) {
    return filtered.filter((m) => ctx.group!.allowedModels.includes(m.id))
  }
  return filtered
}

// ═══════════════ AI 帮写（服装组图） ═══════════════

/** AI 帮写：分析服装图，产出编号格式服装信息文本块（填入合并输入框） */
export async function aiAssistOutfitAction(input: {
  referenceImages: string[]
  userNotes?: string
}): Promise<{
  ok: boolean
  error: string | null
  data?: WeartryAiBriefResult
  degraded?: AiDegradeReason
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属" }
  const scope = getCurrentEnterpriseScope(ctx)

  const parsed = weartryAiAssistSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  if (await aiActionRateLimiter.consume(scope.enterpriseId, ctx.user.id)) {
    return { ok: false, error: "操作过于频繁，请稍后再试" }
  }

  const template = await loadWeartryPromptTemplate("weartry.outfit_ai_write")
  if (!template) return { ok: false, error: "提示词模板不可用，请联系管理员" }
  const system = fillVars(template, { userNotes: d.userNotes })

  try {
    const { data, degraded } = await callAiJson<WeartryAiBriefResult>({
      enterpriseId: scope.enterpriseId,
      system,
      userText: d.userNotes?.trim() ?? "",
      images: d.referenceImages,
    })
    if (!data.brief || typeof data.brief !== "string" || !data.brief.trim()) {
      return { ok: false, error: "AI 返回格式异常，请重试或手动填写" }
    }
    return { ok: true, error: null, data: { brief: data.brief.trim() }, degraded }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "AI 调用失败，请手动填写",
    }
  }
}

// ═══════════════ 内部共享：模型校验 + 批次提交 ═══════════════

/** 生成结果统一返回（四个生成 action 共用；客户端提交接管批次轮询） */
export type GenerateWeartryResult = {
  ok: boolean
  error: string | null
  taskIds?: string[]
  batchTag?: string
  totalCost?: number
}

/** 穿戴模型校验（可见性/企业归属/预置白名单/权限组/参考图支持） */
async function loadWeartryModel(
  ctx: UserContext,
  modelId: string,
): Promise<{ model: typeof models.$inferSelect } | { error: string }> {
  const scope = getCurrentEnterpriseScope(ctx)
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, modelId))
    .limit(1)
  if (!model || !model.isActive || !model.visibleInWeartry) {
    return { error: "模型不存在或不可用" }
  }
  if (model.enterpriseId !== null && model.enterpriseId !== scope.enterpriseId) {
    return { error: "无权使用该模型" }
  }
  if (model.enterpriseId === null) {
    const visiblePreset =
      (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
    if (visiblePreset.length > 0 && !visiblePreset.includes(model.id)) {
      return { error: "该平台预置模型未对本企业开放" }
    }
  }
  if (!model.supportsReferenceImage) {
    return { error: "该模型不支持参考图" }
  }
  const accessErr = checkModelAccess(ctx, modelId)
  if (accessErr) return { error: accessErr }
  return { model }
}

/**
 * 批次提交核心（与商品 V2 步骤 4~8 同构）：
 * 计费 → 建任务 → 扣费（失败标 failed）→ 均摊 → 入队（失败全额退款）。
 * taskItems 的 prompt/templateInfo 已由各模式组装完成。
 */
async function submitWeartryBatch(opts: {
  ctx: UserContext
  model: typeof models.$inferSelect
  taskItems: Array<{ prompt: string; templateInfo: Record<string, unknown> }>
  imageSize: string | null
  referenceImages: string[]
  remark: string
}): Promise<GenerateWeartryResult> {
  const { ctx, model } = opts
  const scope = getCurrentEnterpriseScope(ctx)
  const batchTag = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
  const taskItems = opts.taskItems.map((t) => ({
    ...t,
    templateInfo: { ...t.templateInfo, batchTag },
  }))

  // 1. 计费
  const totalCost = model.costPerImage * taskItems.length
  if (ctx.user.creditsBalance < totalCost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${totalCost}，当前 ${ctx.user.creditsBalance}`,
    }
  }

  // 2~4. 建任务 + 扣费 + 均摊记账（单事务，任一步失败整体回滚）。此前
  // 三步分离提交，崩溃在中间窗口会出现「任务已建未扣费」（孤儿回收重新
  // 入队 = 免费生成）或「已扣费未记账」（失败退款按记账额少退）。
  let createdTasks: Array<{ id: string }>
  try {
    createdTasks = await db.transaction(async (tx) => {
      const rows: Array<{ id: string }> = []
      for (const item of taskItems) {
        const [task] = await tx
          .insert(generationTasks)
          .values({
            enterpriseId: scope.enterpriseId,
            userId: ctx.user.id,
            modelId: model.id,
            prompt: item.prompt,
            imageSize: opts.imageSize,
            imageCount: 1,
            status: "queued",
            taskType: "weartry",
            source: "weartry",
            priority: ctx.group?.priority ?? 0,
            creditsCharged: 0,
            referenceImages: opts.referenceImages,
            templateInfo: item.templateInfo,
          })
          .returning({ id: generationTasks.id })
        rows.push({ id: task!.id })
      }

      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: totalCost,
        userId: ctx.user.id,
        taskId: rows[0]!.id,
        remark: opts.remark,
        tx,
      })

      const perTaskCost = Math.floor(totalCost / taskItems.length)
      const remainder = totalCost - perTaskCost * taskItems.length
      for (let i = 0; i < rows.length; i++) {
        const share = perTaskCost + (i === 0 ? remainder : 0)
        await tx
          .update(generationTasks)
          .set({ creditsCharged: share })
          .where(eq(generationTasks.id, rows[i]!.id))
      }
      return rows
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
    }
  }

  // 5. 入队（失败全额退款兜底）
  try {
    for (let i = 0; i < createdTasks.length; i++) {
      await enqueue({
        taskId: createdTasks[i]!.id,
        enterpriseId: scope.enterpriseId,
        modelId: model.id,
        prompt: taskItems[i]!.prompt,
        imageSize: opts.imageSize ?? "1024x1024",
        imageCount: 1,
        referenceImages: opts.referenceImages,
        priority: ctx.group?.priority ?? 0,
        costPerImage: model.costPerImage,
        apiTimeout: model.apiTimeout,
        taskTimeout: model.taskTimeout,
        maxRetries: model.maxRetries,
      })
    }
  } catch (err) {
    await refundUserCredits({
      enterpriseId: scope.enterpriseId,
      amount: totalCost,
      userId: ctx.user.id,
      taskId: createdTasks[0]!.id,
      remark: "穿戴图片任务入队失败，全额退还",
    })
    await db
      .update(generationTasks)
      .set({
        creditsCharged: 0,
        status: "failed",
        errorMessage: "任务入队失败，积分已退还",
      })
      .where(
        inArray(
          generationTasks.id,
          createdTasks.map((t) => t.id),
        ),
      )
    console.error(
      `[weartry] 批量任务入队失败，已退款 ${totalCost}:`,
      err instanceof Error ? err.message : err,
    )
    return { ok: false, error: "任务入队失败，积分已退还，请稍后重试" }
  }

  revalidatePath("/weartry")
  return {
    ok: true,
    error: null,
    taskIds: createdTasks.map((t) => t.id),
    batchTag,
    totalCost,
  }
}

/** 参考图上限 + 归属校验（防跨租户引用 / SSRF） */
async function checkReferenceImages(
  ctx: UserContext,
  images: string[],
  model: typeof models.$inferSelect,
): Promise<string | null> {
  const refLimit = Math.max(1, model.maxReferenceImages || 1)
  if (images.length > refLimit) {
    return `参考图数量超出上限（模型最多 ${refLimit} 张）`
  }
  const scope = getCurrentEnterpriseScope(ctx)
  return validateReferenceImageUrls(images, scope.enterpriseId)
}

// ═══════════════ 生成：服装组图 ═══════════════

export async function generateWeartryOutfitAction(
  input: GenerateOutfitInput,
): Promise<GenerateWeartryResult> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属，无法生图" }

  const parsed = generateOutfitSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  const loaded = await loadWeartryModel(ctx, d.modelId)
  if ("error" in loaded) return { ok: false, error: loaded.error }
  const { model } = loaded

  const refErr = await checkReferenceImages(ctx, d.referenceImages, model)
  if (refErr) return { ok: false, error: refErr }

  // 方向校验 + prompt 组装（每方向×数量 1 任务；模板来自超管配置行）
  const dirRows = await db
    .select()
    .from(productDirections)
    .where(eq(productDirections.isActive, true))
  const dirMap = new Map(
    dirRows
      .filter((r) => directionInScope(r.appliesTo as string[] | null, "weartry"))
      .map((r) => [r.key, r]),
  )
  const briefVars = parseProductBrief(d.sellingPoints)
  const baseVars: Record<string, string | undefined> = {
    productName: briefVars.productName,
    sellingPoints: briefVars.sellingPoints,
    topSellingPoint: briefVars.topSellingPoint,
    targetAudience: briefVars.targetAudience,
  }
  const taskItems: Array<{
    prompt: string
    templateInfo: Record<string, unknown>
  }> = []
  for (const sel of d.directions) {
    const dir = dirMap.get(sel.key)
    if (!dir) return { ok: false, error: `方向 ${sel.key} 不可用` }
    const count = dir.supportsCount
      ? Math.max(1, Math.min(dir.maxCount, sel.count ?? 1))
      : 1
    for (let i = 0; i < count; i++) {
      taskItems.push({
        // 合并输入框文本只走编号解析变量（{{productName}}/{{sellingPoints}} 等），
        // 与商品套图一致；模板要原文时引用 {{sellingPoints}}
        prompt: buildOutfitPrompt({
          promptTemplate: dir.promptTemplate,
          baseVars,
        }),
        templateInfo: {
          mode: "outfit",
          directionKey: dir.key,
          directionName: dir.name,
        },
      })
    }
  }
  if (taskItems.length === 0) {
    return { ok: false, error: "请至少选择 1 个方向" }
  }

  return submitWeartryBatch({
    ctx,
    model,
    taskItems,
    imageSize: d.size ?? "1024x1024",
    referenceImages: d.referenceImages,
    remark: `穿戴-服装组图 ${model.displayName} x${taskItems.length}`,
  })
}

// ═══════════════ 生成：模特形象（两步流第一步） ═══════════════

export async function generateWeartryModelImageAction(
  input: GenerateModelImageInput,
): Promise<GenerateWeartryResult> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属，无法生图" }

  const parsed = generateModelImageSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  const loaded = await loadWeartryModel(ctx, d.modelId)
  if ("error" in loaded) return { ok: false, error: loaded.error }
  const { model } = loaded

  const template = await loadWeartryPromptTemplate("weartry.model_image")
  if (!template) return { ok: false, error: "提示词模板不可用，请联系管理员" }
  const prompt = buildModelImagePrompt({
    template,
    attrs: d.attrs,
    details: d.details,
  })

  return submitWeartryBatch({
    ctx,
    model,
    taskItems: [
      {
        prompt,
        templateInfo: {
          mode: "model_image",
          attrs: d.attrs,
        },
      },
    ],
    imageSize: d.size ?? "1024x1024",
    referenceImages: [],
    remark: `穿戴-生成模特形象 ${model.displayName} x1`,
  })
}

// ═══════════════ 生成：穿戴图（模特穿戴 / AI万戴） ═══════════════

export async function generateWeartryTryonAction(
  input: GenerateTryonInput,
): Promise<GenerateWeartryResult> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属，无法生图" }

  const parsed = generateTryonSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  const loaded = await loadWeartryModel(ctx, d.modelId)
  if ("error" in loaded) return { ok: false, error: loaded.error }
  const { model } = loaded

  // 模特形象附加在参考图末尾（模板语义：最后一张是模特形象），合计校验上限
  const allReferenceImages = [...d.referenceImages, d.modelImage]
  const refErr = await checkReferenceImages(ctx, allReferenceImages, model)
  if (refErr) return { ok: false, error: refErr }

  // 场景校验（wear 可选；选定后注入 {{sceneSegment}}）
  let scene: { key: string; name: string; promptTemplate: string } | null = null
  if (d.mode === "wear" && d.sceneKey) {
    const resolved = await resolveWeartryScene(d.sceneKey)
    if (!resolved) return { ok: false, error: "预置场景不可用" }
    scene = {
      key: resolved.key,
      name: resolved.name,
      promptTemplate: resolved.promptTemplate,
    }
  }

  const sceneKeyTemplate =
    d.mode === "wear" ? "weartry.tryon" : "weartry.tryon_accessory"
  const template = await loadWeartryPromptTemplate(sceneKeyTemplate)
  if (!template) return { ok: false, error: "提示词模板不可用，请联系管理员" }
  const prompt = buildTryonPrompt({
    template,
    attrs: d.attrs,
    details: d.details,
    additionalPrompt: d.additionalPrompt,
    scene,
  })

  return submitWeartryBatch({
    ctx,
    model,
    taskItems: [
      {
        prompt,
        templateInfo: {
          mode: d.mode,
          sceneKey: scene?.key ?? null,
          sceneName: scene?.name ?? null,
        },
      },
    ],
    imageSize: d.size ?? "1024x1024",
    referenceImages: allReferenceImages,
    remark:
      d.mode === "wear"
        ? `穿戴-模特穿戴 ${model.displayName} x1`
        : `穿戴-AI万戴 ${model.displayName} x1`,
  })
}

// ═══════════════ 生成：AI换色 ═══════════════

export async function generateWeartryColorAction(
  input: GenerateColorChangeInput,
): Promise<GenerateWeartryResult> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属，无法生图" }

  const parsed = generateColorChangeSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  const loaded = await loadWeartryModel(ctx, d.modelId)
  if ("error" in loaded) return { ok: false, error: loaded.error }
  const { model } = loaded

  const refErr = await checkReferenceImages(ctx, [d.referenceImage], model)
  if (refErr) return { ok: false, error: refErr }

  const template = await loadWeartryPromptTemplate("weartry.color")
  if (!template) return { ok: false, error: "提示词模板不可用，请联系管理员" }
  // 兼容变量：旧模板 {{colorCmyk}} 由 HEX 派生（新模板用 {{colorHsb}}）
  const cmykDerived = (() => {
    const rgb = hexToRgb(d.colorHex)
    return rgb ? formatCmyk(rgbToCmyk(rgb)) : undefined
  })()
  const prompt = buildColorPrompt({
    template,
    part: d.part,
    colorName: d.colorName,
    colorHex: d.colorHex,
    colorHsb: d.colorHsb,
    colorRgb: d.colorRgb,
    colorCmyk: cmykDerived,
    additionalPrompt: d.additionalPrompt,
  })

  return submitWeartryBatch({
    ctx,
    model,
    taskItems: [
      {
        prompt,
        templateInfo: {
          mode: "color",
          part: d.part,
          colorName: d.colorName,
          colorHex: d.colorHex,
        },
      },
    ],
    imageSize: d.size ?? "1024x1024",
    referenceImages: [d.referenceImage],
    remark: `穿戴-AI换色 ${model.displayName} x1`,
  })
}

// ═══════════════ 批次查询 / 轮询 / 重试 / 历史 ═══════════════

/** 任务行 → 批次任务展示行 */
function toBatchTaskRow(t: {
  id: string
  status: string
  templateInfo: unknown
  resultImages: string[] | null
  errorMessage: string | null
  costPerImage: number | null
  createdAt: Date
  prompt: string | null
  modelDisplayName: string | null
}): WeartryBatchTaskRow {
  const info = (t.templateInfo ?? {}) as Record<string, unknown>
  return {
    id: t.id,
    status: t.status as WeartryBatchTaskRow["status"],
    directionKey: (info.directionKey as string) ?? null,
    directionName: (info.directionName as string) ?? null,
    replicateLevel: null,
    sceneName: (info.sceneName as string) ?? null,
    imageUrl: Array.isArray(t.resultImages) ? t.resultImages[0] ?? null : null,
    errorMessage: t.errorMessage,
    refunded: t.status === "failed" ? t.costPerImage ?? 0 : 0,
    createdAt: t.createdAt,
    model: t.modelDisplayName,
    prompt: t.prompt,
  }
}

/** templateInfo.mode 合法值（历史/筛选用） */
const WEARTRY_TASK_MODES = ["outfit", "model_image", "wear", "accessory", "color"]

/** tab（穿戴图片页二级页）→ 批次 mode 过滤值 */
const TAB_MODE_FILTER: Record<string, string[]> = {
  outfit: ["outfit"],
  model: ["model_image", "wear"],
  accessory: ["accessory"],
  color: ["color"],
}

/** 历史批次列表（batchTag 聚合；mode 为 tab 级筛选） */
export async function listWeartryBatchesAction(opts?: {
  mode?: string
}): Promise<WeartryBatchRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return []
  const scope = getCurrentEnterpriseScope(ctx)
  const where = [
    eq(generationTasks.enterpriseId, scope.enterpriseId),
    eq(generationTasks.userId, ctx.user.id),
    eq(generationTasks.source, "weartry"),
  ]
  const filterModes =
    opts?.mode && opts.mode in TAB_MODE_FILTER
      ? TAB_MODE_FILTER[opts.mode]!
      : WEARTRY_TASK_MODES
  where.push(
    sql`template_info->>'mode' IN (${sql.join(
      filterModes.map((m) => sql`${m}`),
      sql`, `,
    )})`,
  )

  const rows = await db
    .select({
      id: generationTasks.id,
      status: generationTasks.status,
      templateInfo: generationTasks.templateInfo,
      resultImages: generationTasks.resultImages,
      errorMessage: generationTasks.errorMessage,
      costPerImage: generationTasks.costPerImage,
      createdAt: generationTasks.createdAt,
      prompt: generationTasks.prompt,
      modelDisplayName: models.displayName,
    })
    .from(generationTasks)
    .leftJoin(models, eq(models.id, generationTasks.modelId))
    .where(and(...where))
    .orderBy(desc(generationTasks.createdAt))
    .limit(200)

  // 按 batchTag 聚合（保持提交时间倒序）
  const batches = new Map<string, WeartryBatchRow>()
  for (const row of rows) {
    const info = (row.templateInfo ?? {}) as Record<string, unknown>
    const tag = (info.batchTag as string) ?? row.id // 理论都有；防御单任务
    const mode = (info.mode as string) ?? "outfit"
    let batch = batches.get(tag)
    if (!batch) {
      batch = {
        batchTag: tag,
        mode,
        total: 0,
        completed: 0,
        failed: 0,
        status: "processing",
        createdAt: row.createdAt,
        tasks: [],
      }
      batches.set(tag, batch)
    }
    const task = toBatchTaskRow(row)
    batch.total++
    if (task.status === "completed") batch.completed++
    if (task.status === "failed") batch.failed++
    batch.tasks.push(task)
  }
  for (const b of batches.values()) {
    b.status =
      b.failed > 0
        ? b.completed + b.failed === b.total
          ? "partial_failed"
          : "processing"
        : b.completed === b.total
          ? "completed"
          : "processing"
  }
  return [...batches.values()]
}

/** 批次任务状态（轮询用） */
export async function getWeartryBatchStatusAction(
  batchTag: string,
): Promise<WeartryBatchTaskRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return []
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({
      id: generationTasks.id,
      status: generationTasks.status,
      templateInfo: generationTasks.templateInfo,
      resultImages: generationTasks.resultImages,
      errorMessage: generationTasks.errorMessage,
      costPerImage: generationTasks.costPerImage,
      createdAt: generationTasks.createdAt,
      prompt: generationTasks.prompt,
      modelDisplayName: models.displayName,
    })
    .from(generationTasks)
    .leftJoin(models, eq(models.id, generationTasks.modelId))
    .where(
      and(
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        eq(generationTasks.source, "weartry"),
        sql`template_info->>'batchTag' = ${batchTag}`,
      ),
    )
    .orderBy(generationTasks.createdAt)
  return rows.map(toBatchTaskRow)
}

/** 重试失败任务（首次失败已退款，重试按未成功张数重新扣费） */
export async function retryWeartryTaskAction(
  taskId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "weartry")
  if (denied) return { ok: false, error: denied }
  const scope = getCurrentEnterpriseScope(ctx)
  const [task] = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, taskId),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        eq(generationTasks.source, "weartry"),
      ),
    )
    .limit(1)
  if (!task) return { ok: false, error: "任务不存在" }
  if (task.status !== "failed") return { ok: false, error: "仅失败任务可重试" }
  // 样机渲染等无模型任务不走图像队列，不由此 action 重试
  if (!task.modelId) {
    return { ok: false, error: "该任务类型不支持在此重试" }
  }

  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, task.modelId))
    .limit(1)
  if (!model || !model.isActive) {
    return { ok: false, error: "模型不存在或已下线，无法重试" }
  }

  const succeeded = task.succeededIndexes ?? []
  const pendingIndexes = Array.from(
    { length: task.imageCount },
    (_, i) => i,
  ).filter((i) => !succeeded.includes(i))
  if (pendingIndexes.length === 0) {
    return { ok: false, error: "所有图片均已生成，无需重试" }
  }

  // 重新扣费：首次失败时退款已把 creditsCharged 归零，重试必须重新计费
  const unitPrice = task.costPerImage ?? model.costPerImage
  const retryCost = unitPrice * pendingIndexes.length
  if (ctx.user.creditsBalance < retryCost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${retryCost}，当前 ${ctx.user.creditsBalance}`,
    }
  }

  // 重新扣费 + 翻转状态（单事务）：扣费与记账分离提交的崩溃窗口会造成
  // 「已扣费但 creditsCharged 未累加 → 失败退款按记账额少退」。
  // 先翻转 DB 状态再入队（消费端终态守卫读 DB status）
  try {
    await db.transaction(async (tx) => {
      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: retryCost,
        userId: ctx.user.id,
        taskId: task.id,
        remark: `重试穿戴图片 ${model.displayName} x${pendingIndexes.length}`,
        tx,
      })
      await tx
        .update(generationTasks)
        .set({
          status: "queued",
          retryCount: task.retryCount + 1,
          errorMessage: null,
          creditsCharged: task.creditsCharged + retryCost,
          costPerImage:
            succeeded.length === 0 ? unitPrice : task.costPerImage,
        })
        .where(eq(generationTasks.id, taskId))
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
    }
  }

  try {
    await enqueue({
      taskId: task.id,
      enterpriseId: scope.enterpriseId,
      modelId: task.modelId,
      prompt: task.prompt,
      imageSize: task.imageSize ?? "1024x1024",
      imageCount: task.imageCount,
      pendingIndexes,
      referenceImages: (task.referenceImages as string[]) ?? [],
      priority: task.priority,
      costPerImage: unitPrice,
      apiTimeout: model.apiTimeout,
      taskTimeout: model.taskTimeout,
      maxRetries: model.maxRetries,
    })
  } catch (err) {
    // 入队失败：退还重试扣费并标记失败，避免资金损失
    await refundFailedTask(task.id)
    await db
      .update(generationTasks)
      .set({ status: "failed", errorMessage: "任务入队失败，积分已退还" })
      .where(eq(generationTasks.id, taskId))
    console.error(
      `[weartry] 任务 ${task.id} 重试入队失败，已退款:`,
      err instanceof Error ? err.message : err,
    )
    return { ok: false, error: "任务入队失败，积分已退还，请稍后重试" }
  }

  revalidatePath("/weartry")
  return { ok: true, error: null }
}
