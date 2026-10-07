"use server"

import { and, desc, eq, notInArray } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db/client"
import { agentAssets, agentRuns } from "@/db/schema"
import { requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import { validateAgentAsset } from "@/lib/agent/assets"
import { buildTarotAssetPrompt, assetGenerationOrder } from "@/lib/agent/asset-prompts"
import { resolveCardImageSize } from "@/lib/agent/pipelines"
import { loadFullDirectionConfig } from "@/server/services/agent/direction-config"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { readBodyBounded } from "@/lib/net/read-body-bounded"
import { listAgentAssetsSchema, createAgentAssetSchema, confirmAgentAssetSchema, agentAssetKindSchema } from "@/server/schemas/agent-assets"
import type { AgentPendingAction } from "@/lib/agent/graph"
import { normalizeTemplateStage } from "@/lib/agent/graph"

/** 边框 PNG 服务端代取的大小上限与超时 */
const MAX_BORDER_PNG_BYTES = 20 * 1024 * 1024
const BORDER_FETCH_TIMEOUT_MS = 30_000

/** 周边资产生成请求：每项独立提示词，1-6 项（全部 6 项 = 一键生成） */
const assetGenSchema = z.object({
  runId: z.string().uuid(),
  tasks: z
    .array(
      z.object({
        kind: agentAssetKindSchema,
        prompt: z.string().trim().min(10, "提示词太短").max(10000),
      }),
    )
    .min(1, "请至少选择一项资产")
    .max(6),
})

function deny(ctx: UserContext): void {
  const error = checkModuleAccess(ctx, "agent")
  if (error) throw new Error(error)
}

async function ownedRun(ctx: UserContext, runId: string) {
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.enterpriseId, ctx.user.enterpriseId!), eq(agentRuns.userId, ctx.user.id)))
  if (!run || run.template !== "tarot") throw new Error("塔罗项目不存在或无权访问")
  return run
}

function metaFor(asset: { meta: unknown }): Record<string, unknown> {
  return asset.meta && typeof asset.meta === "object" && !Array.isArray(asset.meta) ? asset.meta as Record<string, unknown> : {}
}

/** 上传结果由 /api/upload 完成；这里负责校验边框透明度并记录素材。 */
export async function saveTarotAssetAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = createAgentAssetSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  // 资产 URL 只允许本企业上传到本平台存储的地址：
  // 服务端会代为拉取边框 PNG，且 URL 会进入交付物 ZIP 回源链路（防 SSRF / 跨租户引用）
  const invalid = await validateReferenceImageUrls([parsed.url], ctx.user.enterpriseId!)
  if (invalid) throw new Error(invalid)
  let hasAlpha: boolean | null = null
  if (parsed.kind === "border") {
    const response = await fetch(parsed.url, { signal: AbortSignal.timeout(BORDER_FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error("无法读取边框 PNG")
    const validation = await validateAgentAsset(await readBodyBounded(response, MAX_BORDER_PNG_BYTES), "border")
    if (!validation.ok) throw new Error(`边框必须是透明 PNG：${validation.reason}`)
    hasAlpha = validation.hasAlpha
    // 边框与卡面同比例融合：宽高比偏差 >5% 拒绝（方形边框 + 2:3 卡面会融合错位）
    const config = await loadFullDirectionConfig("tarot")
    const cardSize = resolveCardImageSize(run, config)
    const match = /^(\d+)x(\d+)$/.exec(cardSize)
    if (match) {
      const cardRatio = Number(match[1]) / Number(match[2])
      const borderRatio = validation.width / validation.height
      if (Math.abs(borderRatio - cardRatio) / cardRatio > 0.05) {
        throw new Error(
          `边框宽高比与卡面不一致：边框 ${validation.width}x${validation.height}，卡面 ${cardSize}（偏差需 ≤5%），请上传同比例透明边框`,
        )
      }
    }
  }
  const [asset] = await db.insert(agentAssets).values({
    runId: run.id,
    kind: parsed.kind,
    name: parsed.name ?? parsed.kind,
    url: parsed.url,
    meta: { status: "uploaded", source: parsed.source, prompt: parsed.prompt ?? null, hasAlpha, confirmedAt: null },
  }).returning()
  return asset
}

export async function confirmTarotAssetAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = confirmAgentAssetSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  const [asset] = await db.select().from(agentAssets).where(and(eq(agentAssets.id, parsed.assetId), eq(agentAssets.runId, run.id)))
  if (!asset) throw new Error("资产不存在")
  await db.update(agentAssets).set({ meta: { ...metaFor(asset), status: "confirmed", confirmedAt: new Date().toISOString() } }).where(eq(agentAssets.id, asset.id))
  return { ok: true }
}

export async function getTarotAssetPromptsAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const id = listAgentAssetsSchema.parse({ runId }).runId
  const run = await ownedRun(ctx, id)
  const selected = run.directions.find((item) => item.id === run.selectedDirectionId)
  // 构图措辞与卡面出图比例一致（快照优先；与 worker 生图尺寸同一取值链）
  const config = await loadFullDirectionConfig("tarot")
  const cardSize = resolveCardImageSize(run, config)
  // 已确认的牌盒正面图作为其余盒面的成套一致性参考（取最新已确认的一条）
  const fronts = await db
    .select()
    .from(agentAssets)
    .where(and(eq(agentAssets.runId, run.id), eq(agentAssets.kind, "box_front")))
    .orderBy(desc(agentAssets.createdAt))
  const frontUrl = fronts.find((asset) => metaFor(asset).status === "confirmed")?.url ?? null
  return assetGenerationOrder().map((kind) => ({
    kind,
    prompt: buildTarotAssetPrompt({
      kind,
      styleDoc: run.styleDoc,
      direction: selected?.visualLanguage ?? run.brief,
      frontImageUrl: kind === "box_back" || kind === "box_side" || kind === "box_top" ? frontUrl : null,
      cardSize,
    }),
  }))
}

/**
 * 提交周边资产 AI 生图（排队执行）：每项携带独立提示词（模板词可编辑），
 * 由 worker 的 asset_gen 步骤逐项生成并落 agent_assets（source = ai）。
 */
export async function requestTarotAssetGenerationAction(input: unknown) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const parsed = assetGenSchema.parse(input)
  const run = await ownedRun(ctx, parsed.runId)
  // 周边资产属生产/交付阶段（UI 已限制；直接调用 action 同样拦截）
  const stage = normalizeTemplateStage(run.stage)
  if (stage !== "art" && stage !== "compose") {
    throw new Error("周边资产生成需在卡面生产或融合交付阶段进行")
  }
  // 同一资产类型一次只排一项（重复点击防抖）
  const kinds = new Set(parsed.tasks.map((task) => task.kind))
  if (kinds.size !== parsed.tasks.length) throw new Error("存在重复的资产类型")
  const action: AgentPendingAction = {
    kind: "asset_gen",
    assetTasks: parsed.tasks,
    requestedAt: new Date().toISOString(),
  }
  // 条件更新守住 SELECT→UPDATE 间隙（与 agent-template.enqueueTemplateAction 同款防重入）
  const updated = await db
    .update(agentRuns)
    .set({ pendingAction: action, status: "queued", error: null, updatedAt: new Date() })
    .where(and(eq(agentRuns.id, run.id), notInArray(agentRuns.status, ["running", "queued"])))
    .returning({ id: agentRuns.id })
  if (updated.length === 0) throw new Error("AI 团队正在处理中，请稍候")
  return { ok: true, count: parsed.tasks.length }
}
