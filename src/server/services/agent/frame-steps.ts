import { and, asc, eq, inArray } from "drizzle-orm"
import { db } from "@/db/client"
import { agentAssets, agentEvents, agentRunItems, agentRuns, agentRounds, enterprises, models, permissionGroups, users } from "@/db/schema"
import { callImageApi, summarizeImageErrors } from "@/lib/ai"
import { signUploadToken } from "@/lib/storage/upload-token"
import { getStorage } from "@/lib/storage"
import { buildAiFramePrompt, AI_FRAME_PREVIEW_COUNT } from "@/lib/agent/compose"
import { resolveCardImageSize } from "@/lib/agent/pipelines"
import { recordAgentImageTask } from "./image-gen-log"
import { acquireImageSlot, releaseImageSlot } from "@/lib/queue/task-queue"
import { loadFullDirectionConfig } from "./direction-config"
import type { AgentPendingAction } from "@/lib/agent/graph"

/** 融合并发池的进程内保护上限（三层 Redis 槽位仍是跨进程总闸门） */
export const FRAME_MAX_CONCURRENCY = 8

/**
 * 融合批的进程内并发数：企业/权限组上限（≤0 = 该维度不限，与
 * effectiveConcurrentLimit / 生图槽位同口径，从 min 中剔除而非当 0
 * 参与）与保护上限、待处理张数取最小值，恒 ≥1；两个维度都不限时
 * 回退保护上限。
 */
export function computeFrameConcurrency(input: {
  enterpriseMax: number
  groupMax: number
  pending: number
  cap?: number
}): number {
  const cap = input.cap ?? FRAME_MAX_CONCURRENCY
  const limits = [input.enterpriseMax, input.groupMax].filter((n) => n > 0)
  return Math.max(1, Math.min(...(limits.length > 0 ? limits : [cap]), cap, Math.max(1, input.pending)))
}

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
  const fullConfig = await loadFullDirectionConfig("tarot")
  const modelId = fullConfig.templateConfig?.aiFrameModelId ?? null
  if (!modelId) throw new Error("未配置 AI 融合生图模型，请联系管理员")
  // AI 融合延用卡面生图比例（与卡面/边框素材一致，避免成品比例漂移）
  const cardImageSize = resolveCardImageSize(run, fullConfig)
  const [model] = await db.select().from(models).where(and(eq(models.id, modelId), eq(models.isActive, true)))
  if (!model) throw new Error("AI 融合生图模型不可用")
  // 企业归属校验（enterpriseId 为空 = 平台级共享；企业私有模型仅归属企业可用）
  if (model.enterpriseId !== null && model.enterpriseId !== run.enterpriseId) {
    throw new Error("AI 融合生图模型不在本企业可用范围内，请联系管理员调整配置")
  }
  const [entRow] = await db.select({ maxConcurrent: enterprises.maxConcurrent }).from(enterprises).where(eq(enterprises.id, run.enterpriseId))
  // 属主权限组维度（与生图队列/buildRunEnv 同款 join）：组并发上限参与槽位检查
  const [groupRow] = await db
    .select({ groupId: permissionGroups.id, maxConcurrent: permissionGroups.maxConcurrent, allowedModels: permissionGroups.allowedModels })
    .from(users)
    .innerJoin(permissionGroups, eq(users.groupId, permissionGroups.id))
    .where(eq(users.id, run.userId))
  const groupId = groupRow?.groupId ?? null
  const groupMaxConcurrent = groupRow?.maxConcurrent ?? 0
  // 权限组生图白名单兜底（与 loadImageModel 同口径）：融合模型来自平台配置
  // 而非用户选择，但受限组同样不应经融合路径越权使用白名单外模型
  const groupAllowedModels = Array.isArray(groupRow?.allowedModels) ? (groupRow!.allowedModels as string[]) : []
  if (groupAllowedModels.length > 0 && !groupAllowedModels.includes(model.id)) {
    throw new Error("当前权限组无权使用 AI 融合生图模型，请联系管理员调整配置")
  }
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

  // 滑动窗口并发池：进程内并发取企业/权限组上限与保护上限的最小值
  // （三层 Redis 槽位仍兜底限流，这里只避免单进程打爆上游与 DB 连接）
  const concurrency = computeFrameConcurrency({
    enterpriseMax: enterpriseMaxConcurrent,
    groupMax: groupMaxConcurrent,
    pending: selected.length,
  })

  const composeOne = async (item: (typeof selected)[number]) => {
    const round = rounds.find((candidate) => candidate.id === item.finalRoundId)
    if (!round?.imageUrl) return
    // 心跳：逐张续期 updatedAt 防止被另一 worker 的 stale 恢复重置重跑
    // （双执行/双倍上游成本）
    await db.update(agentRuns).set({ updatedAt: new Date() }).where(eq(agentRuns.id, run.id))
    await db.update(agentRunItems).set({ frameStatus: "framing", updatedAt: new Date() }).where(eq(agentRunItems.id, item.id))
    // 与生图队列共享的全局并发额度（企业/模型/权限组维度）：经 slots 回调
    // 交给适配器逐张占用/释放（与 orchestrator 主路径同款）——抢不到槽位时
    // 适配器内 waitForSlot 轮询等待，不再单次尝试失败就绕行直连上游
    let slotWaitWarnedAt = 0
    const slots = {
      acquireSlot: async () => {
        const got = await acquireImageSlot({
          enterpriseId: run.enterpriseId,
          modelId: model.id,
          groupId,
          enterpriseMaxConcurrent,
          modelMaxConcurrent: model.maxConcurrent,
          groupMaxConcurrent,
          ttlSec: slotTtlSec,
        })
        if (!got) {
          const now = Date.now()
          if (now - slotWaitWarnedAt > 30_000) {
            slotWaitWarnedAt = now
            console.warn(`[agent-frame] 生图并发槽位已满，融合任务排队等待中（run=${run.id} model=${model.name}）`)
          }
        }
        return got
      },
      releaseSlot: async () => {
        await releaseImageSlot({
          enterpriseId: run.enterpriseId,
          modelId: model.id,
          groupId,
          modelMaxConcurrent: model.maxConcurrent,
          groupMaxConcurrent,
        }).catch(() => {})
      },
    }
    const startedAt = Date.now()
    const framePrompt = buildAiFramePrompt({ cardName: item.name, meaning: item.meaning })
    try {
      const result = await callImageApi({
        model,
        prompt: framePrompt,
        imageSize: cardImageSize,
        imageCount: 1,
        referenceImages: [signUploadToken(border.url), signUploadToken(round.imageUrl)],
        downloadAndUpload: (url) => storage.saveFromUrl(url, run.enterpriseId, "generate", endpointHost ? [endpointHost] : undefined),
        slots,
      })
      const output = result.find((candidate) => candidate.url)?.url
      if (!output) throw new Error(summarizeImageErrors(result) ?? "AI 融合未返回图片")
      await db.update(agentRunItems).set({ framedImageUrl: output, frameStatus: "framed", updatedAt: new Date() }).where(eq(agentRunItems.id, item.id))
      await db.insert(agentEvents).values({ runId: run.id, nodeKey: "compositor", nodeType: "agent", action: "done", status: "ok", detail: `AI 融合完成第 ${item.index + 1} 张`, itemId: item.id })
      // 补录生图任务（资产管理画廊 + 操作日志生图 Tab 可见；融合路径不计积分）
      await recordAgentImageTask({
        run,
        model,
        prompt: framePrompt,
        imageSize: cardImageSize,
        kindLabel: "AI 融合",
        itemLabel: item.name,
        imageCount: 1,
        resultImages: [output],
        creditsCharged: 0,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      await db.update(agentRunItems).set({ frameStatus: "failed", updatedAt: new Date() }).where(eq(agentRunItems.id, item.id))
      await db.insert(agentEvents).values({ runId: run.id, nodeKey: "compositor", nodeType: "agent", action: "fail", status: "error", detail: error instanceof Error ? error.message : String(error), itemId: item.id })
      await recordAgentImageTask({
        run,
        model,
        prompt: framePrompt,
        imageSize: cardImageSize,
        kindLabel: "AI 融合",
        itemLabel: item.name,
        imageCount: 1,
        resultImages: [],
        errorMessage: error instanceof Error ? error.message : String(error),
        creditsCharged: 0,
        durationMs: Date.now() - startedAt,
      })
    }
  }

  let nextIndex = 0
  const worker = async () => {
    while (true) {
      const index = nextIndex++
      if (index >= selected.length) return
      await composeOne(selected[index]!)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
}
