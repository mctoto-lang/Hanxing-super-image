"use server"

import { and, asc, desc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { agentAssets, agentRuns } from "@/db/schema"
import { requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import { validateAgentAsset } from "@/lib/agent/assets"
import { buildTarotAssetPrompt, assetGenerationOrder } from "@/lib/agent/asset-prompts"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { readBodyBounded } from "@/lib/net/read-body-bounded"
import { listAgentAssetsSchema, createAgentAssetSchema, confirmAgentAssetSchema } from "@/server/schemas/agent-assets"

/** 边框 PNG 服务端代取的大小上限与超时 */
const MAX_BORDER_PNG_BYTES = 20 * 1024 * 1024
const BORDER_FETCH_TIMEOUT_MS = 30_000

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

export async function listTarotAssetsAction(runId: string) {
  const ctx = await requireEnterpriseContext()
  deny(ctx)
  const id = listAgentAssetsSchema.parse({ runId }).runId
  await ownedRun(ctx, id)
  return db.select().from(agentAssets).where(eq(agentAssets.runId, id)).orderBy(asc(agentAssets.createdAt))
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
    }),
  }))
}
