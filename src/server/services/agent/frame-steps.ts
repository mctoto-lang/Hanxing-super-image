import { and, asc, eq, inArray } from "drizzle-orm"
import { db } from "@/db/client"
import { agentAssets, agentDirectionConfigs, agentEvents, agentRunItems, agentRuns, agentRounds, enterprises, models } from "@/db/schema"
import { callImageApi } from "@/lib/ai"
import { signUploadToken } from "@/lib/storage/upload-token"
import { getStorage } from "@/lib/storage"
import { buildAiFramePrompt, AI_FRAME_PREVIEW_COUNT } from "@/lib/agent/compose"
import { acquireImageSlot, releaseImageSlot } from "@/lib/queue/task-queue"
import type { AgentPendingAction } from "@/lib/agent/graph"

export async function runAiFrameComposition(run: typeof agentRuns.$inferSelect, action: AgentPendingAction): Promise<void> {
  if (!action.borderAssetId) throw new Error("缺少透明边框素材")
  const [border] = await db.select().from(agentAssets).where(and(eq(agentAssets.id, action.borderAssetId), eq(agentAssets.runId, run.id)))
  if (!border || border.kind !== "border") throw new Error("透明边框素材不存在")
  const items = await db.select().from(agentRunItems).where(eq(agentRunItems.runId, run.id)).orderBy(asc(agentRunItems.index))
  // 重跑幂等：已融合完成的卡跳过（崩溃恢复/重复认领不会重复生图计费）
  const candidates = action.itemId
    ? items.filter((item) => item.id === action.itemId)
    : action.kind === "compose_preview"
      ? items.filter((item) => item.finalRoundId && item.frameStatus !== "framed").slice(0, AI_FRAME_PREVIEW_COUNT)
      : items.filter((item) => item.finalRoundId && item.frameStatus !== "framed")
  const selected = candidates.filter((item) => item.frameStatus !== "framed")
  if (selected.length === 0) throw new Error("没有待融合的已确认卡面")
  const [config] = await db.select().from(agentDirectionConfigs).where(eq(agentDirectionConfigs.direction, "tarot"))
  const templateConfig = config?.templateConfig as { aiFrameModelId?: string | null } | null | undefined
  const modelId = templateConfig?.aiFrameModelId
  if (!modelId) throw new Error("未配置 AI 融合生图模型，请联系管理员")
  const [model] = await db.select().from(models).where(and(eq(models.id, modelId), eq(models.isActive, true)))
  if (!model) throw new Error("AI 融合生图模型不可用")
  // 企业归属校验（enterpriseId 为空 = 平台级共享；企业私有模型仅归属企业可用）
  if (model.enterpriseId !== null && model.enterpriseId !== run.enterpriseId) {
    throw new Error("AI 融合生图模型不在本企业可用范围内，请联系管理员调整配置")
  }
  const [entRow] = await db.select({ maxConcurrent: enterprises.maxConcurrent }).from(enterprises).where(eq(enterprises.id, run.enterpriseId))
  const rounds = await db.select().from(agentRounds).where(inArray(agentRounds.id, selected.map((item) => item.finalRoundId!)))
  const storage = await getStorage()
  // trustedHostHints 期望 hostname（与 orchestrator 同款解析）：传完整 endpoint URL
  // 会让同站放行规则永不命中，非默认 CDN 上游的融合图转存被白名单拒绝
  const endpointHost = (() => {
    try {
      return new URL(model.apiEndpoint).hostname
    } catch {
      return null
    }
  })()
  const slotTtlSec = Math.max(30, model.taskTimeout || 600) + 300
  const enterpriseMaxConcurrent = entRow?.maxConcurrent ?? 5

  for (const item of selected) {
    const round = rounds.find((candidate) => candidate.id === item.finalRoundId)
    if (!round?.imageUrl) continue
    // 心跳：全量 78 张串行融合远超崩溃恢复阈值（5 分钟），逐张续期
    // updatedAt 防止被另一 worker 的 stale 恢复重置重跑（双执行/双倍上游成本）
    await db.update(agentRuns).set({ updatedAt: new Date() }).where(eq(agentRuns.id, run.id))
    await db.update(agentRunItems).set({ frameStatus: "framing", updatedAt: new Date() }).where(eq(agentRunItems.id, item.id))
    // 与生图队列共享的全局并发额度（企业/模型维度），不再绕行直连上游
    const gotSlot = await acquireImageSlot({
      enterpriseId: run.enterpriseId,
      modelId: model.id,
      enterpriseMaxConcurrent,
      modelMaxConcurrent: model.maxConcurrent,
      ttlSec: slotTtlSec,
    })
    try {
      const result = await callImageApi({
        model,
        prompt: buildAiFramePrompt({ cardName: item.name, meaning: item.meaning }),
        imageSize: model.sizePresets?.[0] ? `${model.sizePresets[0].width}x${model.sizePresets[0].height}` : "1024x1024",
        imageCount: 1,
        referenceImages: [signUploadToken(border.url), signUploadToken(round.imageUrl)],
        downloadAndUpload: (url) => storage.saveFromUrl(url, run.enterpriseId, "generate", endpointHost ? [endpointHost] : undefined),
      })
      const output = result.find((candidate) => candidate.url)?.url
      if (!output) throw new Error("AI 融合未返回图片")
      await db.update(agentRunItems).set({ framedImageUrl: output, frameStatus: "framed", updatedAt: new Date() }).where(eq(agentRunItems.id, item.id))
      await db.insert(agentEvents).values({ runId: run.id, nodeKey: "compositor", nodeType: "agent", action: "done", status: "ok", detail: `AI 融合完成第 ${item.index + 1} 张`, itemId: item.id })
    } catch (error) {
      await db.update(agentRunItems).set({ frameStatus: "failed", updatedAt: new Date() }).where(eq(agentRunItems.id, item.id))
      await db.insert(agentEvents).values({ runId: run.id, nodeKey: "compositor", nodeType: "agent", action: "fail", status: "error", detail: error instanceof Error ? error.message : String(error), itemId: item.id })
    } finally {
      if (gotSlot) {
        await releaseImageSlot({
          enterpriseId: run.enterpriseId,
          modelId: model.id,
          modelMaxConcurrent: model.maxConcurrent,
        }).catch(() => {})
      }
    }
  }
}
