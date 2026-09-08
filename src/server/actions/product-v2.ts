"use server"

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  generationTasks,
  models,
  platformSizeSpecs,
  productDirections,
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
import { callAiJson, AI_SYNC_TIMEOUT_MS } from "@/server/services/ai-json"
import {
  listActiveLanguages,
  listActivePlatforms,
  resolveLanguage,
  resolvePlatform,
  resolvePromptTemplate,
} from "@/server/services/product-config"
import {
  buildDirectionPrompt,
  directionInScope,
  formatCardList,
  formatDirectionPool,
  normalizeSlotCounts,
  parseProductBrief,
} from "@/lib/product/prompt"
import type {
  AiBriefResult,
  AiDegradeReason,
  PlatformSizeSpecRow,
  ProductBatchRow,
  ProductBatchTaskRow,
  ProductDirectionRow,
  ProductModelRow,
  SmartMatchResult,
  SmartMatchSlot,
  SuiteCard,
} from "@/lib/product/types"
import {
  aiAssistSchema,
  generateProductV2Schema,
  generateSuiteCardsSchema,
  regenerateSuiteCardSchema,
  smartMatchSchema,
  type GenerateProductV2Input,
  type GenerateSuiteCardsInput,
  type RegenerateSuiteCardInput,
} from "@/server/schemas/product-v2"
import { revalidatePath } from "next/cache"

/**
 * 商品主图 V2 Server Actions（四 tab：商品套图 / A+详情页 / 爆款复刻 / 产品精修）
 *
 * 旧三层模板体系已下线；方向池与平台尺寸规范为超管配置主数据。
 * 生图沿用 generationTasks（source="product"），批次靠 templateInfo.batchTag 聚合。
 */

// ─── 内部辅助 ───

/** 批量出卡超时（一次调用生成全部卡片提示词，输出较长放宽到 90s） */
const AI_BATCH_TIMEOUT_MS = 90_000

// ═══════════════ 基础数据查询 ═══════════════

/** 方向池（按子功能过滤 appliesTo） */
export async function listProductDirectionsAction(
  scope: "suite" | "detail" | "refine",
): Promise<ProductDirectionRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
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

  return rows.filter((r) => directionInScope(r.appliesTo as string[] | null, scope)).map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    // 前端不需要模板全文（组装在服务端），裁剪传输体积
    promptTemplate: "",
    supportsCount: r.supportsCount,
    maxCount: r.maxCount,
    sortOrder: r.sortOrder,
    isHidden: r.isHidden,
    isHero: r.isHero,
  }))
}

/** 尺寸规范（可按平台过滤；suite/detail 通用） */
export async function listPlatformSizeSpecsAction(opts?: {
  platformKey?: string
}): Promise<PlatformSizeSpecRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
  if (denied) return []
  const rows = await db
    .select({
      id: platformSizeSpecs.id,
      platformKey: platformSizeSpecs.platformKey,
      label: platformSizeSpecs.label,
      width: platformSizeSpecs.width,
      height: platformSizeSpecs.height,
      ratioLabel: platformSizeSpecs.ratioLabel,
      note: platformSizeSpecs.note,
    })
    .from(platformSizeSpecs)
    .where(eq(platformSizeSpecs.isActive, true))
    .orderBy(platformSizeSpecs.platformKey, platformSizeSpecs.sortOrder)
  if (opts?.platformKey) {
    return rows.filter((r) => r.platformKey === opts.platformKey)
  }
  return rows
}

/** 上架平台下拉（DB 化配置；表空回退代码常量） */
export async function listProductPlatformsAction(): Promise<
  { key: string; label: string }[]
> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
  if (denied) return []
  const rows = await listActivePlatforms()
  return rows.map((p) => ({ key: p.key, label: p.label }))
}

/** 语言下拉（DB 化配置；表空回退代码常量） */
export async function listProductLanguagesAction(): Promise<
  { key: string; label: string }[]
> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
  if (denied) return []
  const rows = await listActiveLanguages()
  return rows.map((l) => ({ key: l.key, label: l.label }))
}

/** 模型列表（V2：必须支持参考图） */
export async function listProductV2ModelsAction(): Promise<ProductModelRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
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
        eq(models.visibleInProduct, true),
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

// ═══════════════ AI 帮写 ═══════════════

/** AI 帮写：分析商品图 + 平台/语言，产出编号格式商品信息文本块（填入合并输入框） */
export async function aiAssistSellingPointsAction(input: {
  mode: "suite" | "detail"
  referenceImages: string[]
  platform: string
  language: string
  userNotes?: string
}): Promise<{
  ok: boolean
  error: string | null
  data?: AiBriefResult
  degraded?: AiDegradeReason
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属" }
  const scope = getCurrentEnterpriseScope(ctx)

  const parsed = aiAssistSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data
  const lang = await resolveLanguage(d.language)
  const platform = await resolvePlatform(d.platform)
  if (!lang || !platform) return { ok: false, error: "平台或语言不可用" }

  if (await aiActionRateLimiter.consume(scope.enterpriseId, ctx.user.id)) {
    return { ok: false, error: "操作过于频繁，请稍后再试" }
  }

  // 提示词来自超管配置模板（缺行回退内置默认）；全部用户选择以变量暴露，
  // 模板未引用即不注入（V2.7 全模板化：服务端不再拼接固定文案）
  const system = await resolvePromptTemplate(`${d.mode}.ai_write`, {
    platformKey: platform.key,
    platformLabel: platform.label,
    outputLanguage: lang.outputName,
    userNotes: d.userNotes,
  })
  if (!system) return { ok: false, error: "提示词模板不可用，请联系管理员" }

  try {
    const { data, degraded } = await callAiJson<AiBriefResult>({
      enterpriseId: scope.enterpriseId,
      system,
      userText: d.userNotes?.trim() ?? "",
      images: d.referenceImages,
    })
    // 基本形状校验
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

// ═══════════════ 智能匹配（仅套图 tab） ═══════════════

/** 智能匹配：AI 分析商品 → 从方向池挑选并给每方向定制变量 */
export async function smartMatchStructureAction(input: {
  referenceImages: string[]
  platform: string
  language: string
  sellingPoints: string
  productName?: string
}): Promise<{
  ok: boolean
  error: string | null
  data?: SmartMatchResult
  degraded?: AiDegradeReason
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属" }
  const scope = getCurrentEnterpriseScope(ctx)

  const parsed = smartMatchSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data
  const lang = await resolveLanguage(d.language)
  const platform = await resolvePlatform(d.platform)
  if (!lang || !platform) return { ok: false, error: "平台或语言不可用" }

  if (await aiActionRateLimiter.consume(scope.enterpriseId, ctx.user.id)) {
    return { ok: false, error: "操作过于频繁，请稍后再试" }
  }

  // 套图方向池（描述拼给 AI）
  const poolRows = await db
    .select({
      key: productDirections.key,
      name: productDirections.name,
      description: productDirections.description,
      maxCount: productDirections.maxCount,
      isHero: productDirections.isHero,
      appliesTo: productDirections.appliesTo,
    })
    .from(productDirections)
    .where(eq(productDirections.isActive, true))
    .orderBy(productDirections.sortOrder)
  const pool = poolRows.filter((r) =>
    directionInScope(r.appliesTo as string[] | null, "suite"),
  )
  if (pool.length === 0) return { ok: false, error: "方向池为空，请联系管理员配置" }

  // 规划提示词来自超管配置模板（缺行回退内置默认）；模块池以 {{directionPool}}
  // 变量注入（模板未引用即不注入），商品信息原文透传在 user 消息
  const system = await resolvePromptTemplate("suite.smart_match", {
    platformKey: platform.key,
    platformLabel: platform.label,
    outputLanguage: lang.outputName,
    productName: d.productName,
    directionPool: formatDirectionPool(pool),
  })
  if (!system) return { ok: false, error: "提示词模板不可用，请联系管理员" }

  try {
    const { data, degraded } = await callAiJson<SmartMatchResult>({
      enterpriseId: scope.enterpriseId,
      system,
      userText: d.sellingPoints,
      images: d.referenceImages,
    })
    // 清洗：只保留池内 key，count 夹取 maxCount；总量规范化到 7~9
    //（模板软约束的服务端保底：<7 轮转补齐，>9 从最多者递减）
    const entries = pool.map((p) => {
      const hit = Array.isArray(data.slots)
        ? data.slots.find((s) => s?.key === p.key)
        : undefined
      if (!hit || hit.selected !== true) {
        return { key: p.key, selected: false, count: 1, maxCount: p.maxCount }
      }
      const count = Math.max(1, Math.min(p.maxCount, Number(hit.count) || 1))
      return {
        key: p.key,
        selected: true,
        count,
        maxCount: p.maxCount,
        angle: hit.angle || undefined,
        focus: hit.focus || undefined,
        copyHint: hit.copyHint || undefined,
        target: hit.target || undefined,
      }
    })
    const slots: SmartMatchSlot[] = normalizeSlotCounts(entries, 7, 9).map(
      (e) =>
        e.selected
          ? {
              key: e.key,
              selected: true,
              angle: e.angle,
              focus: e.focus,
              copyHint: e.copyHint,
              target: e.target,
              count: e.count,
            }
          : { key: e.key, selected: false },
    )
    return {
      ok: true,
      error: null,
      data: { productAnalysis: data.productAnalysis ?? {}, slots },
      degraded,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "AI 调用失败，请手动选择方向",
    }
  }
}

// ═══════════════ 套图卡片提示词生成（卡片确认阶段） ═══════════════

/** 套图方向池（含前端隐藏方向；出卡与提交校验共用） */
async function loadSuiteDirectionMap() {
  const rows = await db
    .select()
    .from(productDirections)
    .where(eq(productDirections.isActive, true))
  return new Map(
    rows
      .filter((r) => directionInScope(r.appliesTo as string[] | null, "suite"))
      .map((r) => [r.key, r]),
  )
}

/**
 * 出卡核心（批量/单卡共用）：解析配置 → 校验方向 → 一次 AI 调用 →
 * 按序号对齐每卡提示词；缺失/空回退旧方向模板拼装（卡片始终有内容可编辑）
 */
async function runCardPromptGeneration(opts: {
  enterpriseId: string
  userId: string
  input: GenerateSuiteCardsInput
  timeoutMs: number
}): Promise<
  | { ok: false; error: string }
  | {
      ok: true
      cards: SuiteCard[]
      degraded: AiDegradeReason
    }
> {
  const d = opts.input
  const lang = await resolveLanguage(d.language)
  const platform = await resolvePlatform(d.platform)
  if (!lang || !platform) return { ok: false, error: "平台或语言不可用" }

  if (await aiActionRateLimiter.consume(opts.enterpriseId, opts.userId)) {
    return { ok: false, error: "操作过于频繁，请稍后再试" }
  }

  const dirMap = await loadSuiteDirectionMap()
  for (const c of d.cards) {
    if (!dirMap.has(c.directionKey)) {
      return { ok: false, error: `方向 ${c.directionKey} 不可用` }
    }
  }

  // 出卡提示词来自超管配置模板；方向清单以 {{cards}}/{{cardCount}} 变量注入
  //（模板未引用即不注入），商品信息原文透传在 user 消息
  const cardsWithDir = d.cards.map((c) => {
    const dir = dirMap.get(c.directionKey)!
    return { ...c, name: dir.name, description: dir.description }
  })
  const system = await resolvePromptTemplate("suite.card_prompt", {
    platformKey: platform.key,
    platformLabel: platform.label,
    outputLanguage: lang.outputName,
    cardCount: String(cardsWithDir.length),
    cards: formatCardList(cardsWithDir),
  })
  if (!system) return { ok: false, error: "提示词模板不可用，请联系管理员" }

  const briefVars = parseProductBrief(d.sellingPoints)
  const fallbackPrompt = (c: (typeof cardsWithDir)[number]) => {
    const dir = dirMap.get(c.directionKey)!
    return buildDirectionPrompt({
      mode: "suite",
      platformKey: d.platform,
      languageKey: d.language,
      promptTemplate: dir.promptTemplate,
      directionKey: dir.key,
      isHero: dir.isHero,
      baseVars: { ...briefVars },
      smartVars: c.vars,
      resolvedPlatform: platform,
      resolvedLanguage: lang,
    })
  }

  try {
    const { data, degraded } = await callAiJson<{
      prompts?: Array<{ index?: number; prompt?: string }>
    }>({
      enterpriseId: opts.enterpriseId,
      system,
      userText: d.sellingPoints,
      images: d.referenceImages,
      timeoutMs: opts.timeoutMs,
    })
    const byIndex = new Map<number, string>()
    if (Array.isArray(data.prompts)) {
      for (const p of data.prompts) {
        const idx = Math.trunc(Number(p?.index))
        const text = typeof p?.prompt === "string" ? p.prompt.trim() : ""
        if (Number.isFinite(idx) && idx >= 1 && text) byIndex.set(idx, text)
      }
    }
    const cards: SuiteCard[] = cardsWithDir.map((c, i) => ({
      directionKey: c.directionKey,
      directionName: c.name,
      prompt: byIndex.get(i + 1) ?? fallbackPrompt(c),
      vars: c.vars,
      isHero: dirMap.get(c.directionKey)?.isHero ?? false,
    }))
    return {
      ok: true,
      cards,
      degraded,
    }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "AI 生成卡片提示词失败，请重试",
    }
  }
}

/** 批量出卡：一次对话调用生成全部卡片的画面提示词（计 1 次 AI 限流，90s） */
export async function generateSuiteCardPromptsAction(
  input: GenerateSuiteCardsInput,
): Promise<{
  ok: boolean
  error: string | null
  cards?: SuiteCard[]
  degraded?: AiDegradeReason
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属" }
  const scope = getCurrentEnterpriseScope(ctx)

  const parsed = generateSuiteCardsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const res = await runCardPromptGeneration({
    enterpriseId: scope.enterpriseId,
    userId: ctx.user.id,
    input: parsed.data,
    timeoutMs: AI_BATCH_TIMEOUT_MS,
  })
  if (!res.ok) return { ok: false, error: res.error }
  return {
    ok: true,
    error: null,
    cards: res.cards,
    degraded: res.degraded,
  }
}

/** 单卡重新生成画面提示词（计 1 次 AI 限流，30s） */
export async function regenerateSuiteCardPromptAction(
  input: RegenerateSuiteCardInput,
): Promise<{
  ok: boolean
  error: string | null
  prompt?: string
  degraded?: AiDegradeReason
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属" }
  const scope = getCurrentEnterpriseScope(ctx)

  const parsed = regenerateSuiteCardSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const { card, ...rest } = parsed.data
  const res = await runCardPromptGeneration({
    enterpriseId: scope.enterpriseId,
    userId: ctx.user.id,
    input: { ...rest, cards: [card] },
    timeoutMs: AI_SYNC_TIMEOUT_MS,
  })
  if (!res.ok) return { ok: false, error: res.error }
  return {
    ok: true,
    error: null,
    prompt: res.cards[0]?.prompt ?? "",
    degraded: res.degraded,
  }
}

// ═══════════════ 生成（四模式统一入口） ═══════════════

/** 提交生成（四模式）：校验 → 批量建任务 → 扣费 → 入队（失败退款） */
export async function generateProductV2Action(
  input: GenerateProductV2Input,
): Promise<{
  ok: boolean
  error: string | null
  taskIds?: string[]
  batchTag?: string
  totalCost?: number
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属，无法生图" }
  const scope = getCurrentEnterpriseScope(ctx)

  const parsed = generateProductV2Schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  // 1. 模型校验（可见性/白名单/权限组，同旧 product 逻辑）
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, d.modelId))
    .limit(1)
  if (!model || !model.isActive || !model.visibleInProduct) {
    return { ok: false, error: "模型不存在或不可用" }
  }
  if (model.enterpriseId !== null && model.enterpriseId !== scope.enterpriseId) {
    return { ok: false, error: "无权使用该模型" }
  }
  if (model.enterpriseId === null) {
    const visiblePreset =
      (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
    if (visiblePreset.length > 0 && !visiblePreset.includes(model.id)) {
      return { ok: false, error: "该平台预置模型未对本企业开放" }
    }
  }
  if (!model.supportsReferenceImage) {
    return { ok: false, error: "该模型不支持参考图" }
  }
  const accessErr = checkModelAccess(ctx, d.modelId)
  if (accessErr) return { ok: false, error: accessErr }

  // 复刻：爆款图附加在参考图末尾（不计入商品图上限，但计入总参考图数）
  const allReferenceImages = [...d.referenceImages]
  if (d.mode === "replicate" && d.benchmarkImage) {
    allReferenceImages.push(d.benchmarkImage)
  }
  const refLimit = Math.max(1, model.maxReferenceImages || 1)
  if (allReferenceImages.length > refLimit) {
    return {
      ok: false,
      error: `参考图数量超出上限（模型最多 ${refLimit} 张，含爆款图）`,
    }
  }
  // 参考图归属校验（防跨租户引用 / 把上游 AI 当 SSRF 代理拉任意 URL）
  const refErr = await validateReferenceImageUrls(
    allReferenceImages,
    scope.enterpriseId,
  )
  if (refErr) return { ok: false, error: refErr }

  // 2. 尺寸解析
  let imageSize: string | null = null
  if (d.sizeSpecId) {
    const [spec] = await db
      .select()
      .from(platformSizeSpecs)
      .where(eq(platformSizeSpecs.id, d.sizeSpecId))
      .limit(1)
    if (!spec || !spec.isActive) return { ok: false, error: "尺寸规范不存在" }
    if (
      d.platform &&
      spec.platformKey !== d.platform
    ) {
      return { ok: false, error: "尺寸规范与所选平台不匹配" }
    }
    imageSize = `${spec.width}x${spec.height}`
  } else if (d.size) {
    imageSize = d.size
  }

  // 3. 组装 taskItems（每项 = 1 个生图任务）
  const batchTag = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
  // 商品信息合并文本块 → 模板变量（编号格式解析，解析不出则整段作为卖点）
  const briefVars = parseProductBrief(d.sellingPoints)
  const baseVars: Record<string, string | undefined> = {
    productName: briefVars.productName,
    sellingPoints: briefVars.sellingPoints,
    topSellingPoint: briefVars.topSellingPoint,
    targetAudience: briefVars.targetAudience,
  }
  // 平台/语言：DB 化配置（表空/缺行回退代码常量）
  const [resolvedPlatform, resolvedLanguage] = await Promise.all([
    d.platform ? resolvePlatform(d.platform) : null,
    d.language ? resolveLanguage(d.language) : null,
  ])
  if (d.platform && !resolvedPlatform) return { ok: false, error: "上架平台不可用" }
  if (d.language && !resolvedLanguage) return { ok: false, error: "语言不可用" }
  const lang = resolvedLanguage

  const taskItems: Array<{
    prompt: string
    templateInfo: Record<string, unknown>
  }> = []

  if (d.mode === "suite" || d.mode === "detail" || d.mode === "refine") {
    // 方向类：按 appliesTo 校验 + 组装
    const wantScope =
      d.mode === "refine" ? "refine" : d.mode
    const dirRows = await db
      .select()
      .from(productDirections)
      .where(eq(productDirections.isActive, true))
    const dirMap = new Map(
      dirRows
        .filter((r) =>
          directionInScope(r.appliesTo as string[] | null, wantScope),
        )
        .map((r) => [r.key, r]),
    )
    if (d.mode === "suite" && d.cards?.length) {
      // 卡片确认流程：每卡 1 任务，prompt = 用户确认的卡片文本原样
      //（平台偏好与图内文字语言已在出卡阶段约束 AI；规范段是否使用由方向模板变量决定）
      for (const card of d.cards) {
        if (!dirMap.has(card.directionKey)) {
          return { ok: false, error: `方向 ${card.directionKey} 不可用` }
        }
        taskItems.push({
          prompt: card.prompt.trim(),
          templateInfo: {
            mode: "suite",
            batchTag,
            platform: d.platform,
            language: d.language,
            directionKey: card.directionKey,
            directionName: card.directionName,
            fromCard: true,
          },
        })
      }
    } else {
      // 方向选择路径（suite 旧路径 / detail / refine）
      for (const sel of d.directions ?? []) {
        const dir = dirMap.get(sel.key)
        if (!dir) return { ok: false, error: `方向 ${sel.key} 不可用` }
        // A+详情页：点击即 1 张，不展开数量
        const count =
          d.mode === "detail"
            ? 1
            : dir.supportsCount
              ? Math.max(1, Math.min(dir.maxCount, sel.count ?? 1))
              : 1
        if (d.mode === "refine") {
          // 精修：所有优化项合并为 1 个任务（补充要求走 {{additionalPrompt}}
          // 变量，模板未引用即丢弃——严格模式；平台/语言变量仅模板引用时生效）
          taskItems.push({
            prompt: buildDirectionPrompt({
              mode: "refine",
              platformKey: d.platform ?? undefined,
              languageKey: d.language ?? undefined,
              promptTemplate: dir.promptTemplate,
              directionKey: dir.key,
              baseVars,
              additionalPrompt: d.additionalPrompt,
              resolvedPlatform,
              resolvedLanguage,
            }),
            templateInfo: {
              mode: "refine",
              batchTag,
              directionKeys: (d.directions ?? []).map((s) => s.key),
            },
          })
          break // 只取第一个方向做载体，prompt 已含全部
        }
        for (let i = 0; i < count; i++) {
          taskItems.push({
            prompt: buildDirectionPrompt({
              mode: d.mode,
              platformKey: d.platform!,
              languageKey: d.language!,
              promptTemplate: dir.promptTemplate,
              directionKey: dir.key,
              isHero: dir.isHero,
              baseVars,
              smartVars: sel.vars,
              additionalPrompt: d.additionalPrompt,
              resolvedPlatform,
              resolvedLanguage,
            }),
            templateInfo: {
              mode: d.mode,
              batchTag,
              platform: d.platform,
              language: d.language,
              directionKey: dir.key,
              directionName: dir.name,
            },
          })
        }
      }
    }
    if (taskItems.length === 0) {
      return { ok: false, error: "请至少选择 1 个方向" }
    }
  } else {
    // replicate：1 任务。复刻程度模板即最终生图 prompt（参考图语义句已内置于
    // 默认正文）；平台/语言规范段与补充要求全部以变量注入，模板未引用即不注入
    if (d.replicateLevel !== "style" && d.replicateLevel !== "strict") {
      return { ok: false, error: "复刻程度不合法" }
    }
    const prompt = await resolvePromptTemplate(
      `replicate.level_${d.replicateLevel}`,
      {
        platformKey: resolvedPlatform?.key ?? d.platform,
        platformLabel: resolvedPlatform?.label ?? undefined,
        outputLanguage: lang?.outputName ?? undefined,
        platformGeneralSegment: resolvedPlatform?.generalPromptSegment ?? undefined,
        platformHeroSegment: resolvedPlatform?.heroPromptSegment ?? undefined,
        platformSegment: [
          resolvedPlatform?.generalPromptSegment,
          resolvedPlatform?.heroPromptSegment,
        ]
          .filter(Boolean)
          .join(" "),
        languageDirective: lang?.imageDirective ?? undefined,
        additionalPrompt: d.additionalPrompt?.trim() || undefined,
      },
    )
    if (!prompt) return { ok: false, error: "复刻程度提示词不可用" }
    taskItems.push({
      prompt,
      templateInfo: {
        mode: "replicate",
        batchTag,
        platform: d.platform,
        language: d.language,
        replicateLevel: d.replicateLevel,
      },
    })
    imageSize = imageSize ?? null // 未显式选比例则跟随参考图
  }

  if (d.mode !== "replicate" && !imageSize) {
    imageSize = "1024x1024"
  }

  // 4. 计费
  const totalCost = model.costPerImage * taskItems.length
  if (ctx.user.creditsBalance < totalCost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${totalCost}，当前 ${ctx.user.creditsBalance}`,
    }
  }

  // 5~7. 建任务 + 扣费 + 均摊记账（单事务，任一步失败整体回滚）。此前
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
            modelId: d.modelId,
            prompt: item.prompt,
            imageSize,
            imageCount: 1,
            status: "queued",
            taskType: "product",
            source: "product",
            priority: ctx.group?.priority ?? 0,
            creditsCharged: 0,
            referenceImages: allReferenceImages,
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
        remark: `商品图片V2 ${model.displayName} x${taskItems.length}`,
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

  // 8. 入队（失败全额退款兜底）
  try {
    for (let i = 0; i < createdTasks.length; i++) {
      await enqueue({
        taskId: createdTasks[i]!.id,
        enterpriseId: scope.enterpriseId,
        modelId: d.modelId,
        prompt: taskItems[i]!.prompt,
        imageSize: imageSize ?? "1024x1024",
        imageCount: 1,
        referenceImages: allReferenceImages,
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
      remark: "商品图片V2任务入队失败，全额退还",
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
      `[product-v2] 批量任务入队失败，已退款 ${totalCost}:`,
      err instanceof Error ? err.message : err,
    )
    return { ok: false, error: "任务入队失败，积分已退还，请稍后重试" }
  }

  revalidatePath("/product")
  return {
    ok: true,
    error: null,
    taskIds: createdTasks.map((t) => t.id),
    batchTag,
    totalCost,
  }
}

// ═══════════════ 批次查询 / 轮询 / 重试 ═══════════════

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
}): ProductBatchTaskRow {
  const info = (t.templateInfo ?? {}) as Record<string, unknown>
  return {
    id: t.id,
    status: t.status as ProductBatchTaskRow["status"],
    directionKey: (info.directionKey as string) ?? null,
    directionName: (info.directionName as string) ?? null,
    replicateLevel: (info.replicateLevel as string) ?? null,
    imageUrl: Array.isArray(t.resultImages) ? t.resultImages[0] ?? null : null,
    errorMessage: t.errorMessage,
    refunded: t.status === "failed" ? t.costPerImage ?? 0 : 0,
    createdAt: t.createdAt,
    model: t.modelDisplayName,
    prompt: t.prompt,
  }
}

const V2_MODES = ["suite", "detail", "replicate", "refine"]

/** 历史批次列表（batchTag 聚合；mode 可筛） */
export async function listProductBatchesAction(opts?: {
  mode?: string
}): Promise<ProductBatchRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
  if (denied) return []
  const scope = getCurrentEnterpriseScope(ctx)
  const where = [
    eq(generationTasks.enterpriseId, scope.enterpriseId),
    eq(generationTasks.userId, ctx.user.id),
    eq(generationTasks.source, "product"),
  ]
  if (opts?.mode && V2_MODES.includes(opts.mode)) {
    where.push(sql`template_info->>'mode' = ${opts.mode}`)
  } else {
    // 排除旧版 single/template 任务
    where.push(sql`template_info->>'mode' IN ('suite','detail','replicate','refine')`)
  }

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
  const batches = new Map<string, ProductBatchRow>()
  for (const row of rows) {
    const info = (row.templateInfo ?? {}) as Record<string, unknown>
    const tag = (info.batchTag as string) ?? row.id // 理论都有；防御单任务
    const mode = (info.mode as string) ?? "suite"
    let batch = batches.get(tag)
    if (!batch) {
      batch = {
        batchTag: tag,
        mode,
        platform: (info.platform as string) ?? null,
        language: (info.language as string) ?? null,
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
export async function getProductBatchStatusAction(
  batchTag: string,
): Promise<ProductBatchTaskRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
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
        eq(generationTasks.source, "product"),
        sql`template_info->>'batchTag' = ${batchTag}`,
      ),
    )
    .orderBy(generationTasks.createdAt)
  return rows.map(toBatchTaskRow)
}

/** 重试失败任务（首次失败已退款，重试按未成功张数重新扣费） */
export async function retryProductV2TaskAction(
  taskId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "product")
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
        eq(generationTasks.source, "product"),
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

  // 仅重试未成功的图片序号（product 任务 imageCount=1，通常为 [0]）
  const succeeded = task.succeededIndexes ?? []
  const pendingIndexes = Array.from(
    { length: task.imageCount },
    (_, i) => i,
  ).filter((i) => !succeeded.includes(i))
  if (pendingIndexes.length === 0) {
    return { ok: false, error: "所有图片均已生成，无需重试" }
  }

  // 重新扣费：首次失败时退款已把 creditsCharged 归零，重试必须重新计费，
  // 否则重试成功 = 免费出图
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
  // 先翻转 DB 状态再入队（消费端终态守卫读 DB status，入队先于状态
  // 翻转会让重试以 failed 终态被消费端直接丢弃）
  try {
    await db.transaction(async (tx) => {
      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: retryCost,
        userId: ctx.user.id,
        taskId: task.id,
        remark: `重试商品图片 ${model.displayName} x${pendingIndexes.length}`,
        tx,
      })
      await tx
        .update(generationTasks)
        .set({
          status: "queued",
          retryCount: task.retryCount + 1,
          errorMessage: null,
          creditsCharged: task.creditsCharged + retryCost, // 累加：保留已成功张计费
          // 回写单价使后续按张退款精确；仅无已成功张时回写——有已成功张时
          // creditsCharged 与按张公式结构不匹配，回写反而会把退款算错
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
      `[product-v2] 任务 ${task.id} 重试入队失败，已退款:`,
      err instanceof Error ? err.message : err,
    )
    return { ok: false, error: "任务入队失败，积分已退还，请稍后重试" }
  }

  revalidatePath("/product")
  return { ok: true, error: null }
}

export type { UserContext }
