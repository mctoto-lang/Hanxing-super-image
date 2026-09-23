"use server"

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"
import { after } from "next/server"
import { db } from "@/db/client"
import { generationTasks, mockupBatches, mockupCards, mockupGroupItems, models, type MockupBindingConfig, type MockupBindingDef } from "@/db/schema"
import { getCurrentEnterpriseScope, requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import { checkModelAccess } from "@/lib/auth/permissions"
import { getTemplate } from "@/lib/mockup/client"
import { loadMockupConfig } from "@/lib/mockup/settings"
import { parseMockupAiInfo, parseMockupInfo, type MockupTaskInfo } from "@/lib/mockup/task-info"
import type { MockupBackgroundTaskView, MockupBatchDetail, MockupBatchTaskView, MockupBatchView, MockupStatusUpdate, RenderMockupResult } from "@/lib/mockup/types"
import { enqueue } from "@/lib/queue/task-queue"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { deductUserCredits, refundFailedTask } from "@/server/services/credits-service"
import { mockupRenderWebhookUrl, submitExternalRenderJobsBatch, submitMockupTasksToExternal, syncMockupTasks } from "@/server/services/mockup-service"
import { MOCKUP_BATCH_MAX_TASKS, applyMockupAiBackgroundSchema, renderMockupCardsSchema, submitMockupBackgroundSchema, submitMockupBatchSchema } from "@/server/schemas/mockup"
import { ReadyItem, apiErrMsg, latestRenderedImageUrl, loadBackgroundBindingIds, loadMockupAiBackgroundPrompt, mockupUser, moduleDenied, overlayBackgroundRole, toBindingSnapshot } from "./shared"


/**
 * 渲染核心（整卡/多卡/单样机共用）：
 * 校验 → 建任务 → 扣费 → 逐任务素材中转 + 提交外部（失败单个退款）。
 *
 * 仅首次渲染规则：已成功出图/渲染中的方块直接跳过（skipped 说明原因），
 * 彻底规避模板后续变动导致的重渲染失败；AI背景落地重渲染传
 * allowCompleted 旁路（该重渲染本身是 AI背景功能的一环）。
 */
async function renderInternal(
  ctx: UserContext,
  cardIds: string[],
  onlyGroupItemId?: string,
  opts?: {
    allowCompleted?: boolean
    outputFormat?: MockupTaskInfo["outputFormat"]
  },
): Promise<RenderMockupResult> {
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  const renderUser = mockupUser(ctx)
  if (!cfg) {
    return {
      ok: false,
      error: "样机渲染服务未配置，请联系平台管理员",
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped: [],
      cost: 0,
    }
  }

  const cards = await db
    .select()
    .from(mockupCards)
    .where(
      and(
        inArray(mockupCards.id, cardIds),
        eq(mockupCards.enterpriseId, scope.enterpriseId),
        eq(mockupCards.userId, ctx.user.id),
      ),
    )
  if (cards.length === 0) {
    return {
      ok: false,
      error: "卡片不存在",
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped: [],
      cost: 0,
    }
  }

  const items = await db
    .select()
    .from(mockupGroupItems)
    .where(
      inArray(
        mockupGroupItems.groupId,
        cards.map((c) => c.groupId),
      ),
    )
    .orderBy(asc(mockupGroupItems.sortOrder))
  const itemsByGroup = new Map<string, typeof items>()
  for (const item of items) {
    const list = itemsByGroup.get(item.groupId) ?? []
    list.push(item)
    itemsByGroup.set(item.groupId, list)
  }

  // 「仅首次渲染」过滤基准：曾成功出图 / 渲染中的方块集合（跨全部批次）
  const renderedKeys = new Set<string>()
  const busyKeys = new Set<string>()
  if (!opts?.allowCompleted) {
    const historyRows = await db
      .select({
        status: generationTasks.status,
        resultImages: generationTasks.resultImages,
        templateInfo: generationTasks.templateInfo,
      })
      .from(generationTasks)
      .where(
        and(
          eq(generationTasks.taskType, "mockup"),
          eq(generationTasks.enterpriseId, scope.enterpriseId),
          eq(generationTasks.userId, ctx.user.id),
          inArray(
            sql`${generationTasks.templateInfo}->>'cardId'`,
            cards.map((c) => c.id),
          ),
        ),
      )
      .orderBy(desc(generationTasks.createdAt))
      .limit(2000)
    for (const row of historyRows) {
      const info = parseMockupInfo(row.templateInfo)
      if (!info) continue
      const key = `${info.cardId}:${info.groupItemId}`
      if (row.status === "completed" && row.resultImages?.[0]) {
        renderedKeys.add(key)
      } else if (row.status === "queued" || row.status === "processing") {
        busyKeys.add(key)
      }
    }
  }

  // 逐项校验必填绑定
  const ready: ReadyItem[] = []
  const skipped: RenderMockupResult["skipped"] = []
  for (const card of cards) {
    const config = (card.bindingConfig ?? {}) as MockupBindingConfig
    for (const item of itemsByGroup.get(card.groupId) ?? []) {
      if (onlyGroupItemId && item.id !== onlyGroupItemId) continue
      if (!opts?.allowCompleted) {
        if (renderedKeys.has(`${card.id}:${item.id}`)) {
          skipped.push({
            cardId: card.id,
            displayName: item.displayName,
            reason: "已渲染出图，不可重复渲染",
          })
          continue
        }
        if (busyKeys.has(`${card.id}:${item.id}`)) {
          skipped.push({
            cardId: card.id,
            displayName: item.displayName,
            reason: "渲染中，请等待完成",
          })
          continue
        }
      }
      const defs = (item.bindings ?? []) as MockupBindingDef[]
      const settings = config[item.id] ?? {}
      const input: ReadyItem["input"] = {}
      const missing: string[] = []
      for (const def of defs) {
        const value = settings[def.bindingId]
        if (def.type === "text") {
          const text = value?.text?.trim()
          if (text) input[def.bindingId] = { text }
          else if (def.required) missing.push(def.label || def.bindingId)
        } else {
          const imageUrl = value?.imageUrl
          if (imageUrl) input[def.bindingId] = { imageUrl }
          else if (def.required) missing.push(def.label || def.bindingId)
        }
      }
      if (missing.length > 0) {
        skipped.push({
          cardId: card.id,
          displayName: item.displayName,
          reason: `缺少：${missing.join("、")}`,
        })
        continue
      }
      ready.push({
        cardId: card.id,
        groupItemId: item.id,
        displayName: item.displayName,
        templateVersionId: item.templateVersionId,
        canvasWidth: item.canvasWidth,
        canvasHeight: item.canvasHeight,
        input,
      })
    }
  }

  if (ready.length === 0) {
    return {
      ok: true,
      error: null,
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped,
      cost: 0,
    }
  }

  const totalCost = ready.length * cfg.costPerRender
  if (ctx.user.creditsBalance < totalCost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${totalCost}，当前 ${ctx.user.creditsBalance}`,
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped,
      cost: totalCost,
    }
  }

  // 建任务 + 扣费 + 记账（单事务，任一步失败整体回滚）。此前三步分离
  // 提交，崩溃在中间窗口会出现「任务已建未扣费」（孤儿回收/双通道同步
  // 判失败退款时无费可退 = 免费渲染）或「已扣费未记账」（退款按记账额
  // 少退）。（status=queued，未提交外部前无 externalJobId）
  const batchTag = randomUUID().replace(/-/g, "").slice(0, 16)
  const imageUrls = [
    ...new Set(
      ready.flatMap((r) =>
        Object.values(r.input)
          .map((v) => v.imageUrl)
          .filter((u): u is string => Boolean(u)),
      ),
    ),
  ]
  let createdTasks: Array<{ id: string; taskUuid: string; item: ReadyItem }>
  try {
    createdTasks = await db.transaction(async (tx) => {
      const rows: Array<{ id: string; taskUuid: string; item: ReadyItem }> = []
      for (const item of ready) {
        const taskUuid = randomUUID().replace(/-/g, "")
        const [task] = await tx
          .insert(generationTasks)
          .values({
            enterpriseId: scope.enterpriseId,
            userId: ctx.user.id,
            prompt: `样机渲染 · ${item.displayName}`,
            imageSize:
              item.canvasWidth && item.canvasHeight
                ? `${item.canvasWidth}x${item.canvasHeight}`
                : null,
            imageCount: 1,
            status: "queued",
            taskType: "mockup",
            source: "mockup",
            priority: ctx.group?.priority ?? 0,
            creditsCharged: 0,
            costPerImage: cfg.costPerRender,
            referenceImages: imageUrls.length > 0 ? imageUrls : null,
            taskUuid,
            templateInfo: {
              kind: "mockup",
              cardId: item.cardId,
              groupItemId: item.groupItemId,
              templateVersionId: item.templateVersionId,
              templateName: item.displayName,
              batchTag,
              input: item.input,
              outputFormat: opts?.outputFormat ?? "jpeg",
            },
          })
          .returning({ id: generationTasks.id })
        rows.push({ id: task!.id, taskUuid, item })
      }

      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: totalCost,
        userId: ctx.user.id,
        taskId: rows[0]!.id,
        remark: `样机渲染 x${rows.length}`,
        tx,
      })

      for (const r of rows) {
        await tx
          .update(generationTasks)
          .set({ creditsCharged: cfg.costPerRender })
          .where(eq(generationTasks.id, r.id))
      }
      return rows
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped,
      cost: totalCost,
    }
  }

  // 批量提交外部（一次 HTTP；旧版服务/单项素材失效自动回退逐个）；单个失败即退款该张
  let submitted = 0
  const failedSubmits: RenderMockupResult["failedSubmits"] = []
  const submitResults = await submitExternalRenderJobsBatch(
    cfg,
    scope.enterpriseId,
    {
      items: createdTasks.map((t) => ({
        templateVersionId: t.item.templateVersionId,
        input: t.item.input,
        idempotencyKey: t.taskUuid,
        outputFormat: opts?.outputFormat,
      })),
      user: renderUser,
      webhookUrl: mockupRenderWebhookUrl(cfg, scope.enterpriseId),
    },
  )
  for (let i = 0; i < createdTasks.length; i++) {
    const t = createdTasks[i]!
    const result = submitResults[i]!
    if (result.ok) {
      await db
        .update(generationTasks)
        .set({
          status: "processing",
          startedAt: new Date(),
          templateInfo: sql`jsonb_set(coalesce(${generationTasks.templateInfo}, '{}'::jsonb), '{externalJobId}', ${JSON.stringify(result.externalJobId)}::jsonb)`,
        })
        .where(eq(generationTasks.id, t.id))
      submitted++
    } else {
      // result.message 已是可读字符串（service 层产出的具体原因），直接透传；
      // 勿过 apiErrMsg（它只认 Error 实例，传字符串会恒回落兜底文案）
      const message = result.message || "提交渲染失败"
      await db
        .update(generationTasks)
        .set({ status: "failed", errorMessage: message, completedAt: new Date() })
        .where(eq(generationTasks.id, t.id))
      await refundFailedTask(t.id)
      failedSubmits.push({ displayName: t.item.displayName, message })
    }
  }

  // 更新涉及卡片最近批次
  const cardIdsTouched = [...new Set(createdTasks.map((t) => t.item.cardId))]
  await db
    .update(mockupCards)
    .set({ lastBatchTag: batchTag, updatedAt: new Date() })
    .where(inArray(mockupCards.id, cardIdsTouched))

  revalidatePath("/mockup")
  return {
    ok: true,
    error: null,
    batchTag,
    submitted,
    failedSubmits,
    skipped,
    cost: totalCost,
  }
}

/** 渲染一张/多张卡片（顶部「渲染」= 传入全部卡片 ID） */



/** 渲染一张/多张卡片（顶部「渲染」= 传入全部卡片 ID） */
export async function renderMockupCardsAction(
  cardIds: string[],
  outputFormat?: MockupTaskInfo["outputFormat"],
): Promise<RenderMockupResult> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) {
    return {
      ok: false,
      error: denied,
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped: [],
      cost: 0,
    }
  }
  const parsed = renderMockupCardsSchema.safeParse({ cardIds, outputFormat })
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "参数错误",
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped: [],
      cost: 0,
    }
  }
  return renderInternal(ctx, parsed.data.cardIds, undefined, {
    outputFormat: parsed.data.outputFormat,
  })
}

/** 仅渲染卡片上的一个小模板（图层替换弹窗内触发） */



/** 仅渲染卡片上的一个小模板（图层替换弹窗内触发） */
export async function renderCardItemAction(
  cardId: string,
  groupItemId: string,
  outputFormat?: MockupTaskInfo["outputFormat"],
): Promise<RenderMockupResult> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) {
    return {
      ok: false,
      error: denied,
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped: [],
      cost: 0,
    }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  // 最近一次渲染失败（如 AI背景落地后的自动重渲染失败）→ 放行重试，
  // 否则会被「仅首次渲染」规则以「已渲染出图」为由跳过
  const [latest] = await db
    .select({ status: generationTasks.status })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        sql`${generationTasks.templateInfo}->>'cardId' = ${cardId}`,
        sql`${generationTasks.templateInfo}->>'groupItemId' = ${groupItemId}`,
      ),
    )
    .orderBy(desc(generationTasks.createdAt))
    .limit(1)
  return renderInternal(ctx, [cardId], groupItemId, {
    outputFormat,
    allowCompleted: latest?.status === "failed",
  })
}

/** 轮询：我在途任务实时状态（透传外部进度，终态即时收敛） */



/** 轮询：我在途任务实时状态（透传外部进度，终态即时收敛） */
export async function getMockupStatusAction(): Promise<{
  ok: boolean
  updates: MockupStatusUpdate[]
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const active = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        inArray(generationTasks.status, ["queued", "processing"]),
      ),
    )
    .limit(60)

  // 双通道收敛：轮询时顺带推进（外部终态 → 落库 + 退款）；
  // 一次批量查询外部状态（旧版服务自动回退逐个）
  await syncMockupTasks(active)

  const ids = active.map((t) => t.id)
  const rows = ids.length
    ? await db
        .select()
        .from(generationTasks)
        .where(inArray(generationTasks.id, ids))
    : []

  const updates: MockupStatusUpdate[] = []
  for (const task of rows) {
    const info = parseMockupInfo(task.templateInfo)
    if (!info) continue
    updates.push({
      taskId: task.id,
      cardId: info.cardId,
      groupItemId: info.groupItemId,
      batchTag: info.batchTag,
      status: task.status,
      progress: info.progress ?? 0,
      stage: info.stage ?? null,
      errorMessage: task.errorMessage,
      resultImage: task.resultImages?.[0] ?? null,
    })
  }
  // 刚从在途转为完成的渲染图 → 失效资产页缓存（此前 mockup 完成链路
  // 从不 revalidate /assets，用户随后导航到资产管理看到的还是旧列表）。
  // active 只含 queued/processing，completed 只会在收敛的那一轮出现，
  // 不会反复触发
  if (rows.some((t) => t.status === "completed")) {
    revalidatePath("/assets")
  }
  return { ok: true, updates }
}

/* ═══════════════ 批量替换（小模板级） ═══════════════ */

/** 批量替换页初始数据 */



/* ═══════════════ 批量替换（小模板级） ═══════════════ */

/** 批量替换页初始数据 */
export async function getMockupBatchPageDataAction(): Promise<{
  available: boolean
  costPerRender: number
  creditsBalance: number
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  return {
    available: cfg != null,
    costPerRender: cfg?.costPerRender ?? 0,
    creditsBalance: ctx.user.creditsBalance,
  }
}

/**
 * 提交批量替换批次：
 * 固定绑定（背景图/固定文字）+ 逐任务轮换的图片/文字（第 i 张图 + 第 i 行文字）
 * → 建批次 + N 个 mockup 任务 → 整批扣费 → after() 后台提交外部
 * （素材中转 + createRenderJob 不占用户请求；失败任务条件更新 failed+退款，
 * 进度与失败明细经生成历史/批次详情轮询可见）。
 */



/**
 * 提交批量替换批次：
 * 固定绑定（背景图/固定文字）+ 逐任务轮换的图片/文字（第 i 张图 + 第 i 行文字）
 * → 建批次 + N 个 mockup 任务 → 整批扣费 → after() 后台提交外部
 * （素材中转 + createRenderJob 不占用户请求；失败任务条件更新 failed+退款，
 * 进度与失败明细经生成历史/批次详情轮询可见）。
 */
export async function submitMockupBatchAction(input: unknown): Promise<{
  ok: boolean
  error: string | null
  batchId: string | null
  submitted: number
  failedSubmits: Array<{ displayName: string; message: string }>
  cost: number
}> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) {
    return { ok: false, error: denied, batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
  }
  const parsed = submitMockupBatchSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "参数错误",
      batchId: null,
      submitted: 0,
      failedSubmits: [],
      cost: 0,
    }
  }
  const d = parsed.data
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) {
    return { ok: false, error: "样机渲染服务未配置", batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
  }

  // 任务数 = 轮换图片数（未配图片则以文字行数为准）；多组图片必须等长
  const imageEntries = Object.entries(d.batchImages)
  const textEntries = Object.entries(d.batchTexts)
  let count = 0
  if (imageEntries.length > 0) {
    count = imageEntries[0]![1].length
    if (imageEntries.some(([, urls]) => urls.length !== count)) {
      return { ok: false, error: "多个轮换图片绑定的文件数不一致", batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
    }
  } else {
    count = textEntries[0]![1].length
    if (textEntries.some(([, texts]) => texts.length !== count)) {
      return { ok: false, error: "多个轮换文字绑定的行数不一致", batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
    }
  }
  if (count === 0 || count > MOCKUP_BATCH_MAX_TASKS) {
    return {
      ok: false,
      error: `单批次任务数须在 1~${MOCKUP_BATCH_MAX_TASKS} 之间（当前 ${count}）`,
      batchId: null,
      submitted: 0,
      failedSubmits: [],
      cost: 0,
    }
  }
  if (d.labels && d.labels.length !== count) {
    return { ok: false, error: "任务标签数与任务数不一致", batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
  }

  // 模板可见 + 已发布，快照绑定（含背景角色）
  const user = mockupUser(ctx)
  let displayName = ""
  let templateVersionId = ""
  let defs: MockupBindingDef[] = []
  try {
    const detail = await getTemplate(cfg, d.templateId, user)
    const version = detail.latestVersion
    if (!version || !version.published) {
      return { ok: false, error: "该小模板未发布，不能批量替换", batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
    }
    displayName = detail.name
    templateVersionId = version.versionId
    defs = await toBindingSnapshot(scope.enterpriseId, d.templateId, version.layerSchema.bindings)
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "模板信息获取失败"), batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
  }

  // 组装每个任务的 input 并校验绑定/必填
  const defMap = new Map(defs.map((b) => [b.bindingId, b]))
  const knownBindingIds = new Set(
    [...Object.keys(d.fixed), ...Object.keys(d.batchImages), ...Object.keys(d.batchTexts)].filter((id) => defMap.has(id)),
  )
  for (const id of [...Object.keys(d.fixed), ...Object.keys(d.batchImages), ...Object.keys(d.batchTexts)]) {
    if (!defMap.has(id)) {
      return { ok: false, error: `绑定 ${id} 不存在于该模板`, batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
    }
  }

  const imageUrls = [
    ...new Set([
      ...Object.values(d.fixed).flatMap((v) => (v.imageUrl ? [v.imageUrl] : [])),
      ...imageEntries.flatMap(([, urls]) => urls),
    ]),
  ]
  const urlErr = await validateReferenceImageUrls(imageUrls, scope.enterpriseId)
  if (urlErr) return { ok: false, error: urlErr, batchId: null, submitted: 0, failedSubmits: [], cost: 0 }

  const taskInputs: Array<{ input: Record<string, { imageUrl?: string; text?: string }>; label: string }> = []
  for (let i = 0; i < count; i++) {
    const input: Record<string, { imageUrl?: string; text?: string }> = {}
    for (const [bindingId, value] of Object.entries(d.fixed)) {
      if (!knownBindingIds.has(bindingId)) continue
      if (value.imageUrl) input[bindingId] = { imageUrl: value.imageUrl }
      else if (value.text?.trim()) input[bindingId] = { text: value.text.trim() }
    }
    for (const [bindingId, urls] of imageEntries) {
      if (urls[i]) input[bindingId] = { imageUrl: urls[i] }
    }
    for (const [bindingId, texts] of textEntries) {
      const text = texts[i]?.trim()
      if (text) input[bindingId] = { text }
    }
    // 必填校验（第 i 张）
    const missing = defs
      .filter((def) => {
        if (!def.required) return false
        const value = input[def.bindingId]
        if (def.type === "text") return !value?.text
        return !value?.imageUrl
      })
      .map((def) => def.label || def.bindingId)
    if (missing.length > 0) {
      return {
        ok: false,
        error: `第 ${i + 1} 张缺少必填绑定：${missing.join("、")}`,
        batchId: null,
        submitted: 0,
        failedSubmits: [],
        cost: 0,
      }
    }
    taskInputs.push({ input, label: d.labels?.[i] ?? `第 ${i + 1} 张` })
  }

  const totalCost = count * cfg.costPerRender
  if (ctx.user.creditsBalance < totalCost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${totalCost}，当前 ${ctx.user.creditsBalance}`,
      batchId: null,
      submitted: 0,
      failedSubmits: [],
      cost: totalCost,
    }
  }

  // 建批次 + 任务 + 扣费 + 记账（单事务，任一步失败整体回滚，批次行也
  // 一并回滚，无需手工清理）。此前分离提交，崩溃在中间窗口会出现「任务
  // 已建未扣费」（孤儿清扫判失败时无费可退 = 免费渲染）或「已扣费未记
  // 账」（退款按记账额少退）。
  const taskUuids = taskInputs.map(() => randomUUID().replace(/-/g, ""))
  let batchId: string
  let createdTasks: Array<{
    id: string
    taskUuid: string
    input: Record<string, { imageUrl?: string; text?: string }>
  }>
  try {
    const r = await db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(mockupBatches)
        .values({
          enterpriseId: scope.enterpriseId,
          userId: ctx.user.id,
          externalTemplateId: d.templateId,
          templateVersionId,
          displayName,
          bindings: defs,
          fixedConfig: d.fixed,
          totalCount: count,
        })
        .returning({ id: mockupBatches.id })
      const bid = batch!.id
      const batchTag = bid.replace(/-/g, "").slice(0, 32)

      // 一次多行 INSERT 建全部任务（按 taskUuid 映射回填 id）
      const inserted = await tx
        .insert(generationTasks)
        .values(
          taskInputs.map((t, i) => ({
            enterpriseId: scope.enterpriseId,
            userId: ctx.user.id,
            prompt: `样机批量替换 · ${displayName} · ${t.label}`,
            imageCount: 1,
            status: "queued" as const,
            taskType: "mockup" as const,
            source: "mockup" as const,
            priority: ctx.group?.priority ?? 0,
            creditsCharged: 0,
            costPerImage: cfg.costPerRender,
            referenceImages: imageUrls.length > 0 ? imageUrls : null,
            taskUuid: taskUuids[i]!,
            templateInfo: {
              kind: "mockup",
              batchId: bid,
              batchIndex: i + 1,
              batchLabel: t.label,
              templateVersionId,
              templateName: displayName,
              batchTag,
              input: t.input,
              outputFormat: parsed.data.outputFormat,
            },
          })),
        )
        .returning({ id: generationTasks.id, taskUuid: generationTasks.taskUuid })
      const idByUuid = new Map(inserted.map((row) => [row.taskUuid, row.id]))
      const rows = taskInputs.map((t, i) => ({
        id: idByUuid.get(taskUuids[i]!)!,
        taskUuid: taskUuids[i]!,
        input: t.input,
      }))

      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: totalCost,
        userId: ctx.user.id,
        taskId: rows[0]!.id,
        remark: `样机批量替换 x${count}`,
        tx,
      })

      await tx
        .update(generationTasks)
        .set({ creditsCharged: cfg.costPerRender })
        .where(inArray(generationTasks.id, rows.map((row) => row.id)))
      return { batchId: bid, createdTasks: rows }
    })
    batchId = r.batchId
    createdTasks = r.createdTasks
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
      batchId: null,
      submitted: 0,
      failedSubmits: [],
      cost: totalCost,
    }
  }

  // 后台提交外部（after()：响应返回后执行，素材中转/批量创建不再占住用户
  // 请求——大批量素材导入可达数分钟）。失败任务由 service 条件更新到
  // failed+退款并写 api 日志；提交中断（进程退出等）由孤儿清扫 10 分钟
  // 宽限兜底判失败退款；幂等键 = taskUuid，重复提交不会重复渲染。
  after(async () => {
    try {
      await submitMockupTasksToExternal(cfg, scope.enterpriseId, {
        tasks: createdTasks.map((t) => ({
          id: t.id,
          idempotencyKey: t.taskUuid,
          input: t.input,
        })),
        templateVersionId,
        outputFormat: parsed.data.outputFormat,
        user,
        webhookUrl: mockupRenderWebhookUrl(cfg, scope.enterpriseId),
        labels: taskInputs.map((t) => t.label),
      })
    } catch (err) {
      // 整批提交异常（网络全断/DB 故障等）：任务留在 queued，孤儿清扫宽限
      // 后判失败退款；这里只记日志便于排查
      console.error("[mockup] 批量任务后台提交异常:", err)
    }
  })

  revalidatePath("/mockup/batch")
  return {
    ok: true,
    error: null,
    batchId,
    submitted: createdTasks.length,
    failedSubmits: [],
    cost: totalCost,
  }
}

/** 批次任务行 → 视图（计数聚合共用） */



/** 批次任务行 → 视图（计数聚合共用） */
function toBatchTaskView(
  task: typeof generationTasks.$inferSelect,
): MockupBatchTaskView {
  const info = parseMockupInfo(task.templateInfo)
  return {
    taskId: task.id,
    batchIndex: info?.batchIndex ?? 0,
    label: info?.batchLabel ?? `第 ${(info?.batchIndex ?? 0)} 张`,
    status: task.status,
    progress: info?.progress ?? 0,
    stage: info?.stage ?? null,
    errorMessage: task.errorMessage,
    resultImage: task.resultImages?.[0] ?? null,
  }
}

/** 我的批次列表（任务计数实时聚合） */



/** 我的批次列表（任务计数实时聚合） */
export async function listMockupBatchesAction(): Promise<{
  ok: boolean
  error: string | null
  batches: MockupBatchView[]
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const rows = await db
    .select()
    .from(mockupBatches)
    .where(
      and(
        eq(mockupBatches.enterpriseId, scope.enterpriseId),
        eq(mockupBatches.userId, ctx.user.id),
      ),
    )
    .orderBy(desc(mockupBatches.createdAt))
    .limit(30)
  if (rows.length === 0) return { ok: true, error: null, batches: [] }

  const tags = rows.map((b) => b.id.replace(/-/g, "").slice(0, 32))
  const tasks = await db
    .select({
      status: generationTasks.status,
      batchTag: sql<string>`${generationTasks.templateInfo}->>'batchTag'`,
      resultImages: generationTasks.resultImages,
    })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        inArray(sql`${generationTasks.templateInfo}->>'batchTag'`, tags),
      ),
    )
  const countsByTag = new Map<string, { succeeded: number; failed: number; processing: number; cover: string | null }>()
  for (const t of tasks) {
    const c = countsByTag.get(t.batchTag) ?? { succeeded: 0, failed: 0, processing: 0, cover: null }
    if (t.status === "completed") {
      c.succeeded++
      if (!c.cover && t.resultImages?.[0]) c.cover = t.resultImages[0]
    } else if (t.status === "failed") c.failed++
    else c.processing++
    countsByTag.set(t.batchTag, c)
  }

  return {
    ok: true,
    error: null,
    batches: rows.map((b) => {
      const tag = b.id.replace(/-/g, "").slice(0, 32)
      const c = countsByTag.get(tag) ?? { succeeded: 0, failed: 0, processing: 0, cover: null }
      return {
        id: b.id,
        displayName: b.displayName,
        totalCount: b.totalCount,
        succeededCount: c.succeeded,
        failedCount: c.failed,
        processingCount: c.processing,
        createdAt: b.createdAt.toISOString(),
        coverImage: c.cover,
      }
    }),
  }
}

/** 批次详情（含任务明细；顺带推进在途任务与主页面轮询一致） */



/** 批次详情（含任务明细；顺带推进在途任务与主页面轮询一致） */
export async function getMockupBatchStatusAction(
  batchId: string,
): Promise<{
  ok: boolean
  error: string | null
  batch: MockupBatchDetail | null
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const [row] = await db
    .select()
    .from(mockupBatches)
    .where(
      and(
        eq(mockupBatches.id, batchId),
        eq(mockupBatches.enterpriseId, scope.enterpriseId),
        eq(mockupBatches.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!row) return { ok: false, error: "批次不存在", batch: null }

  const batchTag = row.id.replace(/-/g, "").slice(0, 32)
  const active = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        sql`${generationTasks.templateInfo}->>'batchTag' = ${batchTag}`,
        inArray(generationTasks.status, ["queued", "processing"]),
      ),
    )
  // 双通道收敛：轮询时顺带推进（一次批量查询外部状态，旧版服务回退逐个）
  await syncMockupTasks(active)

  const tasks = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        sql`${generationTasks.templateInfo}->>'batchTag' = ${batchTag}`,
      ),
    )
    .orderBy(asc(generationTasks.createdAt))
    .limit(MOCKUP_BATCH_MAX_TASKS * 4)

  const views = tasks.map(toBatchTaskView).sort((a, b) => a.batchIndex - b.batchIndex)
  const succeeded = views.filter((t) => t.status === "completed").length
  const failed = views.filter((t) => t.status === "failed").length
  const processing = views.filter(
    (t) => t.status === "queued" || t.status === "processing",
  ).length

  return {
    ok: true,
    error: null,
    batch: {
      id: row.id,
      displayName: row.displayName,
      totalCount: row.totalCount,
      succeededCount: succeeded,
      failedCount: failed,
      processingCount: processing,
      createdAt: row.createdAt.toISOString(),
      externalTemplateId: row.externalTemplateId,
      tasks: views,
    },
  }
}

/** 重试批次中失败的单个任务（重新扣费 + 新幂等键提交） */



/** 重试批次中失败的单个任务（重新扣费 + 新幂等键提交） */
export async function retryBatchTaskAction(taskId: string): Promise<{
  ok: boolean
  error: string | null
}> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) return { ok: false, error: denied }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }

  const [task] = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, taskId),
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!task) return { ok: false, error: "任务不存在" }
  const info = parseMockupInfo(task.templateInfo)
  if (!info?.batchId) return { ok: false, error: "非批量替换任务" }
  if (task.status !== "failed") return { ok: false, error: "仅失败任务可重试" }

  const cost = cfg.costPerRender
  if (ctx.user.creditsBalance < cost) {
    return { ok: false, error: `个人配额不足，需要 ${cost}，当前 ${ctx.user.creditsBalance}` }
  }
  // 重新扣费 + 记账（单事务）：扣费与记账分离提交的崩溃窗口会造成
  // 「已扣费未记账 → 提交失败退款按记账额少退」。提交失败时
  // refundFailedTask 仍按 creditsCharged 原子退款
  try {
    await db.transaction(async (tx) => {
      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: cost,
        userId: ctx.user.id,
        taskId: task.id,
        remark: `样机批量重试 · ${info.batchLabel ?? info.templateName}`,
        tx,
      })
      await tx
        .update(generationTasks)
        .set({ creditsCharged: task.creditsCharged + cost })
        .where(eq(generationTasks.id, task.id))
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "积分扣减失败" }
  }

  // 新幂等键（旧键可能命中外部已失败任务的幂等记录）
  const taskUuid = randomUUID().replace(/-/g, "")
  try {
    // 单任务提交走批量函数（内部自动回退逐个 + 带 webhook 地址）
    const [result] = await submitExternalRenderJobsBatch(
      cfg,
      scope.enterpriseId,
      {
        items: [
          {
            templateVersionId: info.templateVersionId,
            input: info.input,
            idempotencyKey: taskUuid,
            outputFormat: info.outputFormat,
          },
        ],
        user: mockupUser(ctx),
        webhookUrl: mockupRenderWebhookUrl(cfg, scope.enterpriseId),
      },
    )
    if (!result || !result.ok) {
      throw new Error(result?.message ?? "提交渲染失败")
    }
    const externalJobId = result.externalJobId
    await db
      .update(generationTasks)
      .set({
        status: "processing",
        startedAt: new Date(),
        completedAt: null,
        errorMessage: null,
        retryCount: task.retryCount + 1,
        taskUuid,
        templateInfo: sql`jsonb_set(coalesce(${generationTasks.templateInfo}, '{}'::jsonb), '{externalJobId}', ${JSON.stringify(externalJobId)}::jsonb)`,
      })
      .where(eq(generationTasks.id, task.id))
    return { ok: true, error: null }
  } catch (err) {
    const message = apiErrMsg(err, "提交渲染失败")
    await db
      .update(generationTasks)
      .set({ errorMessage: message })
      .where(eq(generationTasks.id, task.id))
    await refundFailedTask(task.id)
    return { ok: false, error: message }
  }
}

/* ═══════════════ AI 生图（背景等固定图绑定 / 方块 AI背景 / AI渲染） ═══════════════ */

/** 样机页可用生图模型（isActive + visibleInMockup → 企业归属/白名单 → 权限组） */



/* ═══════════════ AI 生图（背景等固定图绑定 / 方块 AI背景 / AI渲染） ═══════════════ */

/** 样机页可用生图模型（isActive + visibleInMockup → 企业归属/白名单 → 权限组） */
export async function listMockupModelsAction(): Promise<
  Array<{
    id: string
    name: string
    displayName: string
    costPerImage: number
    sizePresets: Array<{ label: string; width: number; height: number; enabled?: boolean }> | null
    supportsReferenceImage: boolean
    maxReferenceImages: number
  }>
> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const rows = await db
    .select({
      id: models.id,
      name: models.name,
      displayName: models.displayName,
      costPerImage: models.costPerImage,
      sizePresets: models.sizePresets,
      supportsReferenceImage: models.supportsReferenceImage,
      maxReferenceImages: models.maxReferenceImages,
      enterpriseId: models.enterpriseId,
    })
    .from(models)
    .where(
      and(eq(models.isActive, true), eq(models.visibleInMockup, true)),
    )
    .orderBy(asc(models.sortOrder), asc(models.createdAt))

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
    return filtered.filter((m) =>
      ctx.group!.allowedModels.includes(m.id),
    )
  }
  return filtered
}

/**
 * 提交 AI 生图任务（统一生图链路：Redis 队列/并发槽/转存 COS）：
 * - 无方块上下文：绑定弹窗/批量页手动生成（prompt=用户输入）；
 * - aiKind=background：菜单一键 AI背景（prompt=平台提示词模板，参考图=方块渲染原图）；
 * - aiKind=render：菜单 AI渲染（prompt=用户输入，参考图=方块渲染原图）。
 */



/**
 * 提交 AI 生图任务（统一生图链路：Redis 队列/并发槽/转存 COS）：
 * - 无方块上下文：绑定弹窗/批量页手动生成（prompt=用户输入）；
 * - aiKind=background：菜单一键 AI背景（prompt=平台提示词模板，参考图=方块渲染原图）；
 * - aiKind=render：菜单 AI渲染（prompt=用户输入，参考图=方块渲染原图）。
 */
export async function submitMockupBackgroundAction(input: {
  modelId: string
  prompt: string
  imageSize: string
  referenceImages?: string[]
  cardId?: string
  groupItemId?: string
  aiKind?: "background" | "render"
}): Promise<{ ok: boolean; error: string | null; taskId: string | null; cost: number }> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) return { ok: false, error: denied, taskId: null, cost: 0 }
  const parsed = submitMockupBackgroundSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误", taskId: null, cost: 0 }
  }
  const d = parsed.data
  const scope = getCurrentEnterpriseScope(ctx)

  // 方块上下文：参考图固定为该方块渲染原图（服务端自查，不信任前端）
  let refImageUrl: string | null = null
  if (d.cardId && d.groupItemId && d.aiKind) {
    refImageUrl = await latestRenderedImageUrl(
      scope.enterpriseId,
      ctx.user.id,
      d.cardId,
      d.groupItemId,
    )
    if (!refImageUrl) {
      return { ok: false, error: "请先完成一次样机渲染，再使用 AI 功能", taskId: null, cost: 0 }
    }
  }

  const referenceImages = refImageUrl ? [refImageUrl] : (d.referenceImages ?? [])
  const refErr = await validateReferenceImageUrls(referenceImages, scope.enterpriseId)
  if (refErr) return { ok: false, error: refErr, taskId: null, cost: 0 }

  // 模型可见性链（isActive + visibleInMockup → 企业/白名单 → 权限组）
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, d.modelId))
    .limit(1)
  if (!model || !model.isActive || !model.visibleInMockup) {
    return { ok: false, error: "模型不存在或未在样机渲染页开放", taskId: null, cost: 0 }
  }
  if (model.enterpriseId !== null && model.enterpriseId !== scope.enterpriseId) {
    return { ok: false, error: "无权使用该模型", taskId: null, cost: 0 }
  }
  if (model.enterpriseId === null) {
    const visiblePreset =
      (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
    if (visiblePreset.length > 0 && !visiblePreset.includes(model.id)) {
      return { ok: false, error: "该平台预置模型未对本企业开放", taskId: null, cost: 0 }
    }
  }
  const accessErr = checkModelAccess(ctx, d.modelId)
  if (accessErr) return { ok: false, error: accessErr, taskId: null, cost: 0 }
  if (refImageUrl && !model.supportsReferenceImage) {
    return { ok: false, error: `模型 ${model.displayName} 不支持参考图`, taskId: null, cost: 0 }
  }

  const cost = model.costPerImage
  if (ctx.user.creditsBalance < cost) {
    return { ok: false, error: `个人配额不足，需要 ${cost}，当前 ${ctx.user.creditsBalance}`, taskId: null, cost }
  }

  // prompt：AI背景=平台提示词模板；AI渲染/手动=用户输入
  const prompt = (
    d.aiKind === "background" && d.cardId
      ? await loadMockupAiBackgroundPrompt()
      : d.prompt.trim()
  ).slice(0, 4000)
  // 建任务 + 扣费 + 记账（单事务，任一步失败整体回滚）：分离提交的崩溃
  // 窗口会造成「任务已建未扣费」（孤儿回收重新入队 = 免费生成）或「已扣
  // 费未记账」（失败退款按记账额少退）
  let taskId: string
  try {
    taskId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(generationTasks)
        .values({
          enterpriseId: scope.enterpriseId,
          userId: ctx.user.id,
          modelId: d.modelId,
          prompt,
          imageSize: d.imageSize,
          imageCount: 1,
          status: "queued",
          taskType: "normal",
          source: "mockup",
          priority: ctx.group?.priority ?? 0,
          creditsCharged: 0,
          costPerImage: model.costPerImage,
          referenceImages: referenceImages.length > 0 ? referenceImages : null,
          templateInfo:
            d.cardId && d.groupItemId && d.aiKind
              ? {
                  kind: "mockup-ai",
                  aiKind: d.aiKind,
                  cardId: d.cardId,
                  groupItemId: d.groupItemId,
                  refImageUrl: refImageUrl ?? "",
                }
              : undefined,
        })
        .returning({ id: generationTasks.id })

      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: cost,
        userId: ctx.user.id,
        taskId: row!.id,
        remark: `样机AI生图 ${model.displayName} x1`,
        tx,
      })

      await tx
        .update(generationTasks)
        .set({ creditsCharged: cost })
        .where(eq(generationTasks.id, row!.id))
      return row!.id
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "积分扣减失败", taskId: null, cost }
  }

  try {
    await enqueue({
      taskId,
      enterpriseId: scope.enterpriseId,
      modelId: d.modelId,
      prompt,
      imageSize: d.imageSize,
      imageCount: 1,
      referenceImages,
      priority: ctx.group?.priority ?? 0,
      costPerImage: model.costPerImage,
      apiTimeout: model.apiTimeout,
      taskTimeout: model.taskTimeout,
      maxRetries: model.maxRetries,
    })
  } catch (err) {
    await refundFailedTask(taskId)
    await db
      .update(generationTasks)
      .set({ status: "failed", errorMessage: "任务入队失败，积分已退还" })
      .where(eq(generationTasks.id, taskId))
    console.error(
      `[mockup] AI 生图任务 ${taskId} 入队失败，已退款:`,
      err instanceof Error ? err.message : err,
    )
    return { ok: false, error: "任务入队失败，积分已退还", taskId: null, cost }
  }

  return { ok: true, error: null, taskId, cost }
}

/**
 * AI背景落地：生成完成的 AI 背景图 → 填入卡片背景绑定 → 自动重渲染该样机。
 * appliedAt 原子认领保证幂等（页面兜底续做与在线轮询并发不会双落地/双渲染）。
 */



/**
 * AI背景落地：生成完成的 AI 背景图 → 填入卡片背景绑定 → 自动重渲染该样机。
 * appliedAt 原子认领保证幂等（页面兜底续做与在线轮询并发不会双落地/双渲染）。
 */
export async function applyMockupAiBackgroundAction(input: unknown): Promise<{
  ok: boolean
  error: string | null
  render?: RenderMockupResult
}> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) return { ok: false, error: denied }
  const parsed = applyMockupAiBackgroundSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)

  const [task] = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, parsed.data.taskId),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  const info = parseMockupAiInfo(task?.templateInfo)
  const imageUrl = task?.resultImages?.[0]
  if (!task || !info || info.aiKind !== "background") {
    return { ok: false, error: "AI背景任务不存在" }
  }
  if (task.status !== "completed" || !imageUrl) {
    return { ok: false, error: "AI背景图尚未生成完成" }
  }

  // 校验卡片与小模板仍在，且存在背景绑定（先于认领：校验失败不烧掉 appliedAt，
  // 修复卡片/小模板/背景图层后仍可重新落地）
  const [card] = await db
    .select()
    .from(mockupCards)
    .where(
      and(
        eq(mockupCards.id, info.cardId),
        eq(mockupCards.enterpriseId, scope.enterpriseId),
        eq(mockupCards.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!card) return { ok: false, error: "卡片已删除，AI背景图保留在生成记录中" }
  const [item] = await db
    .select()
    .from(mockupGroupItems)
    .where(eq(mockupGroupItems.id, info.groupItemId))
    .limit(1)
  if (!item || item.groupId !== card.groupId) {
    return { ok: false, error: "小模板已变更，无法应用 AI 背景" }
  }
  const defs = overlayBackgroundRole(
    (item.bindings ?? []) as MockupBindingDef[],
    new Set(
      await loadBackgroundBindingIds(scope.enterpriseId, item.externalTemplateId),
    ),
  )
  const bgDef = defs.find((b) => b.role === "background" && b.type !== "text")
  if (!bgDef) {
    return { ok: false, error: "该小模板没有标记为「背景」的图片图层，请先在模板管理中编辑绑定" }
  }

  // 幂等认领：仅当未落地时继续（并发/重复调用直接短路）
  const claimed = await db
    .update(generationTasks)
    .set({
      templateInfo: sql`jsonb_set(coalesce(${generationTasks.templateInfo}, '{}'::jsonb), '{appliedAt}', ${JSON.stringify(new Date().toISOString())}::jsonb)`,
    })
    .where(
      and(
        eq(generationTasks.id, task.id),
        sql`${generationTasks.templateInfo}->>'appliedAt' IS NULL`,
      ),
    )
    .returning({ id: generationTasks.id })
  if (claimed.length === 0) {
    return { ok: true, error: null }
  }

  // 填入背景绑定并保存
  const config = { ...((card.bindingConfig ?? {}) as MockupBindingConfig) }
  const itemConfig = { ...(config[info.groupItemId] ?? {}) }
  itemConfig[bgDef.bindingId] = { imageUrl }
  config[info.groupItemId] = itemConfig
  await db
    .update(mockupCards)
    .set({ bindingConfig: config, updatedAt: new Date() })
    .where(eq(mockupCards.id, card.id))

  // 自动重渲染该样机（计费 costPerRender；失败仅提示，配置已保存）
  // allowCompleted：AI背景落地重渲染是「仅首次渲染」规则的唯一例外
  const render = await renderInternal(ctx, [card.id], info.groupItemId, {
    allowCompleted: true,
  })
  revalidatePath("/mockup")
  return { ok: true, error: null, render }
}

/** AI 生图任务状态轮询（弹窗内驱动到终态） */



/** AI 生图任务状态轮询（弹窗内驱动到终态） */
export async function getMockupBackgroundStatusAction(
  taskId: string,
): Promise<{ ok: boolean; task: MockupBackgroundTaskView | null }> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const [task] = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, taskId),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!task) return { ok: false, task: null }
  return {
    ok: true,
    task: {
      taskId: task.id,
      status: task.status,
      resultImage: task.resultImages?.[0] ?? null,
      errorMessage: task.errorMessage,
    },
  }
}


