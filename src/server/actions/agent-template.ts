"use server"

import { and, asc, desc, eq, isNotNull, notInArray, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db/client"
import {
  agentAssets,
  agentEvents,
  agentMessages,
  agentNodeRuns,
  agentReviews,
  agentRunItems,
  agentRounds,
  agentRuns,
} from "@/db/schema"
import { requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import { buildTemplateProductionGraph } from "@/lib/agent/pipelines"
import { majorityVotePassed } from "@/lib/agent/review"
import { ensureTarotCardPlan } from "@/server/services/agent/card-plan"
import { loadFullDirectionConfig } from "@/server/services/agent/direction-config"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { AgentRunNotFoundError } from "@/lib/agent/errors"
import {
  AGENT_TEMPLATE_STAGES,
  type AgentAssetKind,
  type AgentPendingAction,
  type AgentTemplateStage,
} from "@/lib/agent/graph"
import { getDeckTemplate } from "@/lib/agent/templates"

/** 用户质量要求（发起时可选；滑块以管理员默认为基准步进，服务端只做范围校验） */
const qualitySchema = z.object({
  contentThreshold: z.number().int().min(0).max(100),
  aestheticThreshold: z.number().int().min(0).max(100),
  consistencyThreshold: z.number().int().min(0).max(100),
  maxRetries: z.number().int().min(0).max(3),
})

const startSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(5, "请先描述你的主题、风格或设计方向").max(2000),
  referenceImages: z.array(z.string().url()).max(4).default([]),
  quality: qualitySchema.optional(),
})

const messageSchema = z.object({
  runId: z.string().uuid(),
  content: z.string().trim().min(1).max(8000),
})

const briefSchema = z.object({
  runId: z.string().uuid(),
  brief: z.string().trim().min(1).max(20000),
})

const directionSchema = z.object({
  runId: z.string().uuid(),
  /** run.directions[].id（AI 生成的方向标识） */
  directionId: z.string().trim().min(1).max(40),
  note: z.string().trim().max(2000).optional(),
})

const regenerateDirectionsSchema = z.object({
  runId: z.string().uuid(),
  feedback: z.string().trim().max(2000).optional(),
})

const stageSchema = z.object({
  runId: z.string().uuid(),
  stage: z.enum(AGENT_TEMPLATE_STAGES),
})

const assetSchema = z.object({
  runId: z.string().uuid(),
  kind: z.enum(["border", "back", "box_front", "box_back", "box_side", "box_top"]),
  name: z.string().trim().max(200).optional(),
  url: z.string().url(),
  meta: z.record(z.string(), z.unknown()).optional(),
})

const aiFramePreviewSchema = z.object({ runId: z.string().uuid(), borderAssetId: z.string().uuid() })
const aiFrameItemSchema = z.object({ runId: z.string().uuid(), itemId: z.string().uuid(), borderAssetId: z.string().uuid() })

function deny(ctx: UserContext): void {
  const error = checkModuleAccess(ctx, "agent")
  if (error) throw new Error(error)
}

async function ownedRun(ctx: UserContext, runId: string) {
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.enterpriseId, ctx.user.enterpriseId!), eq(agentRuns.userId, ctx.user.id)))
  if (!run) throw new AgentRunNotFoundError("项目不存在或无权访问")
  return run
}

function assertTarotRun(run: { template: string | null }): void {
  if (run.template !== "tarot") throw new AgentRunNotFoundError("该项目不是塔罗模板项目")
}

/**
 * 模板动作排队：写入 pendingAction 并置 queued，由 agent-processor 认领执行。
 * 运行已在处理中（running / queued）时拒绝，避免并发重入。
 */
async function enqueueTemplateAction(runId: string, action: AgentPendingAction): Promise<void> {
  const [row] = await db.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, runId))
  if (!row) throw new AgentRunNotFoundError("项目不存在或无权访问")
  if (row.status === "running" || row.status === "queued") throw new Error("AI 团队正在处理中，请稍候")
  // 条件更新守住 SELECT→UPDATE 间隙：状态被并发改变（如 worker 已认领）时不覆盖
  const updated = await db
    .update(agentRuns)
    .set({ pendingAction: action, status: "queued", error: null, updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), notInArray(agentRuns.status, ["running", "queued"])))
    .returning({ id: agentRuns.id })
  if (updated.length === 0) throw new Error("AI 团队正在处理中，请稍候")
}

/** 创建模板项目：落用户开场白后排队首轮需求澄清（追问由创意总监 LLM 生成）。 */
export async function startTarotTemplateAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = startSchema.parse(input)
  const template = getDeckTemplate("tarot")
  if (!template) throw new Error("塔罗模板未注册")

  // 参考图 URL 只允许本企业上传到本平台存储（会被转发给上游视觉模型拉取）
  if (parsed.referenceImages.length > 0) {
    const invalid = await validateReferenceImageUrls(parsed.referenceImages, ctx.user.enterpriseId!)
    if (invalid) throw new Error(invalid)
  }

  const config = await loadFullDirectionConfig("tarot")
  // 初始快照用模板生产图（graphSnapshot 非空约束；确认卡牌清单时按当前配置+用户质量参数重建）
  const graph = buildTemplateProductionGraph(config)
  const [run] = await db
    .insert(agentRuns)
    .values({
      direction: "tarot",
      enterpriseId: ctx.user.enterpriseId!,
      userId: ctx.user.id,
      // 模板项目由阶段动作推进，不能被旧版图流水线 worker 误消费。
      status: "waiting_human",
      phase: "sample",
      template: "tarot",
      stage: "clarify",
      title: parsed.title ?? `${template.meta.name} · ${parsed.prompt.slice(0, 40)}`,
      brief: null,
      directions: [],
      selectedDirection: null,
      selectedDirectionId: null,
      frameMode: "ai",
      input: {
        prompt: parsed.prompt,
        cardCount: template.meta.cardCount,
        // 并行度跟随模板配置（管理员可调 1-4），不再硬编码
        concurrency: config.templateConfig?.concurrency ?? 2,
        referenceImages: parsed.referenceImages,
        ...(parsed.quality ? { quality: parsed.quality } : {}),
      },
      graphSnapshot: graph,
    })
    .returning({ id: agentRuns.id })
  if (!run) throw new Error("创建项目失败")

  await db.insert(agentMessages).values({
    runId: run.id,
    role: "user",
    content: parsed.prompt,
    nodeKey: "creative_director",
  })
  await enqueueTemplateAction(run.id, { kind: "clarify_turn", requestedAt: new Date().toISOString() })
  return { runId: run.id }
}

/** 重试上一个失败的模板动作（失败时 processor 保留了 pendingAction）。 */
export async function retryTemplateActionAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const id = z.string().uuid().parse(runId)
  const run = await ownedRun(ctx, id)
  assertTarotRun(run)
  if (!run.error || !run.pendingAction) throw new Error("没有需要重试的步骤")
  await enqueueTemplateAction(run.id, { ...run.pendingAction, requestedAt: new Date().toISOString() })
  return { ok: true }
}

/** 需求澄清对话消息留痕，并排队下一轮澄清（创意总监基于全部历史继续追问）。 */
export async function appendTemplateMessageAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = messageSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  assertTarotRun(run)
  if (run.stage !== "clarify") throw new Error("当前阶段不接受需求澄清消息")
  await db.insert(agentMessages).values({ runId: run.id, role: "user", content: parsed.content, nodeKey: "creative_director" })
  await enqueueTemplateAction(run.id, { kind: "clarify_turn", requestedAt: new Date().toISOString() })
  return { ok: true }
}

/** 请求 AI 把已有澄清结论整理成《设计简报》（阶段停留在 clarify，等用户确认）。 */
export async function requestBriefAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const id = z.string().uuid().parse(runId)
  const run = await ownedRun(ctx, id)
  assertTarotRun(run)
  if (run.stage !== "clarify") throw new Error("当前项目不在需求澄清阶段")
  await enqueueTemplateAction(run.id, { kind: "finalize_brief", requestedAt: new Date().toISOString() })
  return { ok: true }
}

/** 保存用户确认的创作简报并进入内容方向阶段（方向由世界观策划 LLM 生成）。 */
export async function saveTemplateBriefAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = briefSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  assertTarotRun(run)
  if (run.stage !== "clarify") throw new Error("当前项目不在需求澄清阶段")
  await db.update(agentRuns).set({ brief: parsed.brief, stage: "world", updatedAt: new Date() }).where(eq(agentRuns.id, run.id))
  await enqueueTemplateAction(run.id, { kind: "gen_directions", requestedAt: new Date().toISOString() })
  return { ok: true }
}

/** 根据用户反馈重新构思 3 个内容方向（世界观策划会避开已出现过的方向名）。 */
export async function regenerateDirectionsAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = regenerateDirectionsSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  assertTarotRun(run)
  if (run.stage !== "world") throw new Error("当前项目不在内容方向阶段")
  await enqueueTemplateAction(run.id, {
    kind: "gen_directions",
    feedback: parsed.feedback || undefined,
    requestedAt: new Date().toISOString(),
  })
  return { ok: true }
}

/** 保存用户选定的内容方向并进入提示词设计阶段。 */
export async function selectTemplateDirectionAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = directionSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  assertTarotRun(run)
  if (run.stage !== "world") throw new Error("当前项目不在内容方向阶段")
  const direction = (run.directions ?? []).find((item) => item.id === parsed.directionId)
  if (!direction) throw new Error("内容方向不存在或已更新，请刷新后重试")
  const briefSection =
    `【用户确认的内容方向】${direction.name}\n${direction.concept || direction.description}` +
    (parsed.note ? `\n（用户备注：${parsed.note}）` : "")
  const newBrief = `${run.brief ?? ""}\n\n${briefSection}`.trim()
  // 先落 78 张卡牌清单、再推进阶段：清单生成失败时项目停留在 world，
  // 用户重试即自愈（重选方向 → ensure 幂等返回已有清单 → 推进 stage）
  await ensureTarotCardPlan({ ...run, brief: newBrief, selectedDirectionId: direction.id }, direction)
  await db
    .update(agentRuns)
    .set({
      selectedDirectionId: direction.id,
      selectedDirection: "tarot",
      brief: newBrief,
      stage: "prompt",
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, run.id))
  await db.insert(agentEvents).values({
    runId: run.id,
    nodeKey: "world_planner",
    nodeType: "agent",
    action: "done",
    status: "ok",
    detail: `内容方向「${direction.name}」已确认，开始准备 78 张卡牌清单`,
  })
  return { ok: true }
}

/** 手动推进/回看模板阶段；仅允许单步前进，避免跳过确认门槛。 */
export async function setTemplateStageAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = stageSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  assertTarotRun(run)
  const current = AGENT_TEMPLATE_STAGES.indexOf(run.stage as AgentTemplateStage)
  const target = AGENT_TEMPLATE_STAGES.indexOf(parsed.stage)
  if (target < 0 || (current >= 0 && target > current + 1)) throw new Error("不能跳过模板阶段")
  await db.update(agentRuns).set({ stage: parsed.stage, updatedAt: new Date() }).where(eq(agentRuns.id, run.id))
  return { ok: true, stage: parsed.stage }
}

/** 保存一项套件资产（AI 生成结果或用户上传结果）。 */
export async function createTemplateAssetAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = assetSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  assertTarotRun(run)
  // 资产 URL 只允许本企业上传到本平台存储（后续会被 ZIP 回源/融合流程代取）
  const invalid = await validateReferenceImageUrls([parsed.url], ctx.user.enterpriseId!)
  if (invalid) throw new Error(invalid)
  const [asset] = await db.insert(agentAssets).values({ runId: run.id, kind: parsed.kind, name: parsed.name ?? parsed.kind, url: parsed.url, meta: parsed.meta ?? null }).returning()
  return asset
}

/** AI 融合动作排队（与 enqueueTemplateAction 同语义，供预览/批量/单张重做复用）。 */
async function enqueueComposeAction(runId: string, action: AgentPendingAction): Promise<void> {
  const run = await db.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, runId)).then((rows) => rows[0])
  if (!run) throw new AgentRunNotFoundError("项目不存在")
  if (run.status === "running" || run.status === "queued") throw new Error("AI 团队正在处理中，请稍候")
  // 条件更新守住 SELECT→UPDATE 间隙：状态被并发改变（如 worker 已认领）时不覆盖
  const updated = await db
    .update(agentRuns)
    .set({ pendingAction: action, status: "queued", error: null, updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), notInArray(agentRuns.status, ["running", "queued"])))
    .returning({ id: agentRuns.id })
  if (updated.length === 0) throw new Error("AI 团队正在处理中，请稍候")
}

/** art 阶段小样确认：小样全部终态且至少一张成图后，开始全套 78 张生产。 */
export async function confirmSampleBatchAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const id = z.string().uuid().parse(runId)
  const run = await ownedRun(ctx, id)
  assertTarotRun(run)
  if (run.stage !== "art") throw new Error("当前项目不在卡面生产阶段")
  if (run.phase !== "sample") throw new Error("小样已确认，正在全套生产")
  if (run.status === "running" || run.status === "queued") throw new Error("AI 团队正在处理中，请稍候")

  const items = await db
    .select({ status: agentRunItems.status, isSample: agentRunItems.isSample })
    .from(agentRunItems)
    .where(eq(agentRunItems.runId, run.id))
  const samples = items.filter((item) => item.isSample)
  if (samples.length === 0) throw new Error("尚无风格小样，请先确认卡牌清单开始生产")
  const busy = samples.filter((item) => ["pending", "drafting", "generating", "reviewing"].includes(item.status))
  if (busy.length > 0) throw new Error(`仍有 ${busy.length} 张小样在处理中，请稍候`)
  const okSamples = samples.filter((item) => ["approved_by_ai", "fallback", "confirmed"].includes(item.status))
  if (okSamples.length === 0) throw new Error("小样全部失败，请先在卡面列表重开失败卡或点击重试")

  // 条件更新守住读取→写入间隙：状态被并发改变（如 worker 已认领）时不覆盖
  const updated = await db
    .update(agentRuns)
    .set({
      phase: "full",
      status: "queued",
      error: null,
      pendingAction: { kind: "produce_cards", phase: "full", requestedAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, run.id), notInArray(agentRuns.status, ["running", "queued"])))
    .returning({ id: agentRuns.id })
  if (updated.length === 0) throw new Error("AI 团队正在处理中，请稍候")
  await db.insert(agentEvents).values({
    runId: run.id,
    nodeKey: "artist",
    nodeType: "agent",
    action: "start",
    status: "ok",
    detail: `风格已确认（${okSamples.length}/${samples.length} 张小样成图），开始全套生产 ${items.length} 张；小样终图将作为成套一致性基准`,
  })
  return { ok: true, fullCount: items.length }
}

export async function requestAiFramePreviewAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = aiFramePreviewSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  assertTarotRun(run)
  const [border] = await db.select().from(agentAssets).where(and(eq(agentAssets.id, parsed.borderAssetId), eq(agentAssets.runId, run.id)))
  if (!border || border.kind !== "border") throw new Error("请先确认透明边框资产")
  const items = await db.select().from(agentRunItems).where(eq(agentRunItems.runId, run.id)).orderBy(asc(agentRunItems.index))
  if (items.length !== 78 || items.some((item) => !item.finalRoundId)) throw new Error("请先确认 78 张卡面")
  // 预览不切换阶段：仍停留在 art，等用户看到 3 张预览后点「批量融合」时
  // 才进入 compose——否则发起预览就卸载确认按钮，批量入口在真实流程不可达
  await db.update(agentRuns).set({ frameAssetId: border.id, frameMode: "ai", updatedAt: new Date() }).where(eq(agentRuns.id, run.id))
  await enqueueComposeAction(run.id, { kind: "compose_preview", borderAssetId: border.id, requestedAt: new Date().toISOString() })
  return { ok: true, previewCount: 3, estimatedImages: 3 }
}

export async function confirmAiFrameBatchAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const id = z.string().uuid().parse(runId)
  const run = await ownedRun(ctx, id)
  assertTarotRun(run)
  const items = await db.select().from(agentRunItems).where(eq(agentRunItems.runId, run.id))
  if (items.filter((item) => item.frameStatus === "framed").length < 3) throw new Error("请先完成 3 张 AI 融合预览")
  // 批量确认时才进入交付（compose）阶段（与预览不切阶段配套）
  await db.update(agentRuns).set({ stage: "compose", updatedAt: new Date() }).where(eq(agentRuns.id, run.id))
  await enqueueComposeAction(run.id, { kind: "compose_batch", borderAssetId: run.frameAssetId ?? undefined, requestedAt: new Date().toISOString() })
  return { ok: true, estimatedImages: 78 }
}

export async function retryAiFrameItemAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = aiFrameItemSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  assertTarotRun(run)
  await enqueueComposeAction(run.id, { kind: "compose_batch", itemId: parsed.itemId, borderAssetId: parsed.borderAssetId, requestedAt: new Date().toISOString() })
  return { ok: true }
}

/** 交付物类型标签（compose 阶段总览与 ZIP 打包共用） */
const ASSET_KIND_LABELS: Record<string, string> = {
  border: "透明边框",
  back: "卡背",
  box_front: "牌盒正面",
  box_back: "牌盒背面",
  box_side: "牌盒侧面",
  box_top: "牌盒顶面",
}

export interface TarotDeliverable {
  id: string
  /** cards/{index+1:02d}-{name}.{ext} 或 assets/{kind}.{ext} */
  filename: string
  title: string
  kind: "card" | AgentAssetKind
  url: string
}

export interface TarotDeliverablesResult {
  cards: {
    id: string
    index: number
    name: string | null
    status: string
    frameStatus: string | null
    /** 成品图：融合图优先，回退终版轮次图；null = 尚未产出 */
    finalImage: string | null
  }[]
  assets: { kind: AgentAssetKind; label: string; url: string; confirmed: boolean }[]
  /** 待打包文件（cards + assets 中已就绪的部分） */
  files: TarotDeliverable[]
  readyCount: number
  totalCount: number
}

function fileExtOf(url: string): string {
  const clean = url.split("?")[0]!.split("#")[0]!
  const ext = clean.slice(clean.lastIndexOf(".") + 1)
  return /^\w{2,5}$/.test(ext) && ext.length <= 5 ? ext.toLowerCase() : "png"
}

/** compose 阶段交付物聚合：78 张成品卡（融合图优先）+ 6 项套件资产 + 就绪统计。 */
export async function getTarotDeliverablesAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const run = await ownedRun(ctx, runId)
  assertTarotRun(run)

  const [itemRows, roundRows, assetRows] = await Promise.all([
    db
      .select({
        id: agentRunItems.id,
        index: agentRunItems.index,
        name: agentRunItems.name,
        status: agentRunItems.status,
        frameStatus: agentRunItems.frameStatus,
        framedImageUrl: agentRunItems.framedImageUrl,
        finalRoundId: agentRunItems.finalRoundId,
      })
      .from(agentRunItems)
      .where(eq(agentRunItems.runId, run.id))
      .orderBy(asc(agentRunItems.index)),
    db
      .select({ id: agentRounds.id, imageUrl: agentRounds.imageUrl })
      .from(agentRounds)
      .where(eq(agentRounds.runId, run.id)),
    db
      .select()
      .from(agentAssets)
      .where(eq(agentAssets.runId, run.id))
      .orderBy(asc(agentAssets.createdAt)),
  ])

  const roundImageById = new Map(roundRows.map((r) => [r.id, r.imageUrl]))
  const cards = itemRows.map((item) => {
    const finalRoundImage = item.finalRoundId ? roundImageById.get(item.finalRoundId) ?? null : null
    const finalImage = item.framedImageUrl ?? finalRoundImage
    return {
      id: item.id,
      index: item.index,
      name: item.name,
      status: item.status,
      frameStatus: item.frameStatus,
      finalImage: finalImage ?? null,
    }
  })

  // 资产按 kind 取最新一条（有已确认的取最新已确认，否则最新上传）
  const latestByKind = new Map<string, (typeof assetRows)[number]>()
  const confirmedByKind = new Map<string, (typeof assetRows)[number]>()
  for (const asset of assetRows) {
    latestByKind.set(asset.kind, asset)
    if ((asset.meta as { status?: string } | null)?.status === "confirmed") {
      confirmedByKind.set(asset.kind, asset)
    }
  }
  const assetKinds = ["border", "back", "box_front", "box_back", "box_side", "box_top"] as const
  const assets = assetKinds.map((kind) => {
    const asset = confirmedByKind.get(kind) ?? latestByKind.get(kind)
    return {
      kind,
      label: ASSET_KIND_LABELS[kind] ?? kind,
      url: asset?.url ?? "",
      confirmed: confirmedByKind.has(kind),
    }
  })

  const files: TarotDeliverable[] = []
  for (const card of cards) {
    if (!card.finalImage) continue
    const seq = String(card.index + 1).padStart(2, "0")
    files.push({
      id: card.id,
      filename: `cards/${seq}-${(card.name ?? `第${card.index + 1}张`).replace(/[\\/:*?"<>|]/g, "_")}.${fileExtOf(card.finalImage)}`,
      title: card.name ?? `第 ${card.index + 1} 张`,
      kind: "card",
      url: card.finalImage,
    })
  }
  for (const asset of assets) {
    if (!asset.url) continue
    files.push({
      id: `${asset.kind}`,
      filename: `assets/${asset.kind}.${fileExtOf(asset.url)}`,
      title: asset.label,
      kind: asset.kind,
      url: asset.url,
    })
  }

  return { cards, assets, files, readyCount: files.length, totalCount: cards.length + assets.length } satisfies TarotDeliverablesResult
}

/** 整副评分聚合（art 阶段评分卡）：终版轮次的三维评分均分与及格统计 */
export async function getTarotDeckScoresAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const run = await ownedRun(ctx, runId)
  assertTarotRun(run)
  const rows = await db
    .select({
      itemId: agentReviews.itemId,
      dimension: sql<string>`${agentReviews.result} ->> 'dimension'`,
      score: sql<number | null>`NULLIF(${agentReviews.result} ->> 'score', '')::float8`,
      pass: sql<boolean | null>`NULLIF(${agentReviews.result} ->> 'pass', '')::boolean`,
    })
    .from(agentReviews)
    .innerJoin(agentRunItems, eq(agentReviews.itemId, agentRunItems.id))
    .where(
      and(
        eq(agentRunItems.runId, run.id),
        eq(agentReviews.kind, "review"),
        isNotNull(agentRunItems.finalRoundId),
        sql`${agentReviews.roundId} = ${agentRunItems.finalRoundId}`,
      ),
    )
    // 定序保证归并结果确定（同 item 行集中返回）
    .orderBy(asc(agentRunItems.index))

  // 终版轮评审按「卡 × 维度」归并：多评审取平均分、内容按多数票（对齐
  // aggregateReviewerScores 语义；单评审一票否决）
  const byItem = new Map<string, { aesthetic: number[]; consistency: number[]; contentPass: number[] }>()
  for (const row of rows) {
    const entry = byItem.get(row.itemId) ?? { aesthetic: [], consistency: [], contentPass: [] }
    if (row.dimension === "content") {
      if (row.pass !== null) entry.contentPass.push(row.pass ? 1 : 0)
    } else {
      if (row.dimension === "aesthetic" && row.score !== null) entry.aesthetic.push(row.score)
      if (row.dimension === "consistency" && row.score !== null) entry.consistency.push(row.score)
    }
    byItem.set(row.itemId, entry)
  }
  let contentPass = 0
  let contentTotal = 0
  const items: { content: null; aesthetic: number | null; consistency: number | null }[] = []
  for (const entry of byItem.values()) {
    items.push({
      content: null,
      aesthetic: entry.aesthetic.length > 0 ? Math.round(entry.aesthetic.reduce((s, v) => s + v, 0) / entry.aesthetic.length) : null,
      consistency: entry.consistency.length > 0 ? Math.round(entry.consistency.reduce((s, v) => s + v, 0) / entry.consistency.length) : null,
    })
    if (entry.contentPass.length > 0) {
      contentTotal += 1
      const votes = entry.contentPass.reduce((s, v) => s + v, 0)
      if (majorityVotePassed(votes, entry.contentPass.length)) contentPass += 1
    }
  }

  // 及格线：从生产图快照读取（缺省回退内置默认）
  const thresholds = {
    aesthetic: readSnapshotThreshold(run.graphSnapshot, "review_aesthetic", 75),
    consistency: readSnapshotThreshold(run.graphSnapshot, "review_consistency", 70),
  }
  return {
    items,
    contentPass,
    contentTotal,
    thresholds,
    sampled: items.length,
  }
}

function readSnapshotThreshold(snapshot: unknown, nodeId: string, fallback: number): number {
  const node = (snapshot as { nodes?: { id: string; config?: { aestheticThreshold?: unknown } }[] } | null)?.nodes?.find(
    (n) => n.id === nodeId,
  )
  const raw = node?.config?.aestheticThreshold
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? Math.round(raw) : fallback
}

/** 模板工作台聚合查询：阶段、消息、套件资产、卡面（含最新轮图）、状态统计、事件与节点聚合，供轮询。 */
export async function getTemplateWorkspaceAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const run = await ownedRun(ctx, runId)
  assertTarotRun(run)
  const [messages, assets, itemRows, latestEvents, rounds, nodes] = await Promise.all([
    db.select().from(agentMessages).where(eq(agentMessages.runId, run.id)).orderBy(asc(agentMessages.createdAt)),
    db.select().from(agentAssets).where(eq(agentAssets.runId, run.id)).orderBy(asc(agentAssets.createdAt)),
    db
      .select({
        id: agentRunItems.id,
        index: agentRunItems.index,
        name: agentRunItems.name,
        meaning: agentRunItems.meaning,
        visualBrief: agentRunItems.visualBrief,
        currentPrompt: agentRunItems.currentPrompt,
        status: agentRunItems.status,
        isSample: agentRunItems.isSample,
        roundsUsed: agentRunItems.roundsUsed,
        finalRoundId: agentRunItems.finalRoundId,
        fallbackContentWarning: agentRunItems.fallbackContentWarning,
        manualRegenCount: agentRunItems.manualRegenCount,
        errorMessage: agentRunItems.errorMessage,
        framedImageUrl: agentRunItems.framedImageUrl,
        frameStatus: agentRunItems.frameStatus,
      })
      .from(agentRunItems)
      .where(eq(agentRunItems.runId, run.id))
      .orderBy(asc(agentRunItems.index)),
    // 事件取最新 100 条（desc 取尾后反转回升序，保证数组末尾恒为最新事件；
    // 全套生产事件远超 100 条，asc+limit 会冻结在最旧事件上导致悬浮球停更）
    db.select().from(agentEvents).where(eq(agentEvents.runId, run.id)).orderBy(desc(agentEvents.createdAt)).limit(100),
    db
      .select({ id: agentRounds.id, itemId: agentRounds.itemId, roundNumber: agentRounds.roundNumber, imageUrl: agentRounds.imageUrl })
      .from(agentRounds)
      .where(eq(agentRounds.runId, run.id))
      .orderBy(asc(agentRounds.roundNumber)),
    db.select().from(agentNodeRuns).where(eq(agentNodeRuns.runId, run.id)),
  ])
  // 时间线升序（数组末尾 = 最新事件，与前端「最新在上」的展示契约一致）
  const events = [...latestEvents].reverse()
  // 每卡最新一轮（升序遍历后留下的即最大轮次）——卡面网格缩略图
  const latestRoundByItem = new Map<string, { id: string; roundNumber: number; imageUrl: string | null }>()
  for (const round of rounds) {
    latestRoundByItem.set(round.itemId, { id: round.id, roundNumber: round.roundNumber, imageUrl: round.imageUrl })
  }
  const items = itemRows.map((item) => {
    const latest = latestRoundByItem.get(item.id)
    return {
      ...item,
      latestRoundId: latest?.id ?? null,
      latestRoundNumber: latest?.roundNumber ?? null,
      latestImageUrl: latest?.imageUrl ?? null,
    }
  })
  const statusCounts = new Map<string, number>()
  for (const item of items) statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1)
  return {
    run,
    messages,
    assets,
    items,
    itemStats: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
    events,
    nodes,
  }
}
