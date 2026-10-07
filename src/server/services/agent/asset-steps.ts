/**
 * 周边资产生图执行器（asset_gen；由 agent-processor 认领触发）
 *
 * 每项资产独立提示词，执行与卡面生产同构的「AI 生成 → AI 评审 → 打回重试 →
 * 历史最优兜底」循环（border → back → box_front → box_back → box_side →
 * box_top 的顺序保证牌盒正面先出、其余盒面以它作成套参考）：
 * - 生图模型取 templateConfig.assetImageModelId；评审模型取评审团
 *   reviewerModelIds[0]（回退结构/创意总监模型），走对话三层槽位；
 * - 及格线与打回上限沿用创建时用户质量设定（run.input.quality，
 *   缺省 content 75 / maxRetries 2）；
 * - 每次尝试落一行 agent_assets：meta.status = reviewing →（评审后）
 *   uploaded（过线或兜底选中，带 reviewScore）/ rejected（未过线，保留分数）；
 * - 重试耗尽选本次任务历史最高分行兜底置 uploaded（meta.fallback = true）；
 * - 与生图队列共享企业/模型/权限组三层并发槽位；单项整体失败不阻塞其余项。
 */
import { and, desc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  agentAssets,
  agentDirectionConfigs,
  agentEvents,
  agentRuns,
  enterprises,
  models,
  permissionGroups,
  users,
} from "@/db/schema"
import { callImageApi, summarizeImageErrors } from "@/lib/ai"
import { signUploadToken } from "@/lib/storage/upload-token"
import { getStorage } from "@/lib/storage"
import {
  AGENT_ASSET_KINDS,
  type AgentAssetKind,
  type AgentPendingAction,
} from "@/lib/agent/graph"
import { assetGenerationOrder, assetRuleOfKind, extractStyleEssence, orientationOfCardSize } from "@/lib/agent/asset-prompts"
import { resolveCardImageSize } from "@/lib/agent/pipelines"
import { recordAgentImageTask } from "./image-gen-log"
import { loadFullDirectionConfig } from "./direction-config"
import { callLlmJson, loadChatModel, LlmValidationError, type AgentLlmContext } from "./llm"
import { withAgentLlmSlot } from "./llm-slots"
import { acquireImageSlot, releaseImageSlot } from "@/lib/queue/task-queue"

export const TAROT_ASSET_KIND_LABELS: Record<AgentAssetKind, string> = {
  border: "透明卡牌边框",
  back: "卡背",
  box_front: "牌盒正面",
  box_back: "牌盒背面",
  box_side: "牌盒侧面",
  box_top: "牌盒顶面",
}

/** 需要「牌盒正面」作成套参考的资产 */
const FRONT_REFERENCED: readonly AgentAssetKind[] = ["box_back", "box_side", "box_top"]

/** 质量参数缺省（管理员配置缺失时；与平台默认档一致） */
const FALLBACK_QUALITY = { contentThreshold: 75, maxRetries: 2 }

function metaOf(asset: { meta: unknown }): Record<string, unknown> {
  return asset.meta && typeof asset.meta === "object" && !Array.isArray(asset.meta)
    ? (asset.meta as Record<string, unknown>)
    : {}
}

export async function runTarotAssetGeneration(
  run: typeof agentRuns.$inferSelect,
  action: AgentPendingAction,
): Promise<void> {
  const tasks = (action.assetTasks ?? []).filter((task) =>
    (AGENT_ASSET_KINDS as readonly string[]).includes(task.kind),
  )
  if (tasks.length === 0) throw new Error("没有待生成的周边资产")
  // 按模板生成顺序执行：box_front 先出图，其余盒面即可拿到成套参考
  const order = assetGenerationOrder()
  const ordered = [...tasks].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))

  const [config] = await db.select().from(agentDirectionConfigs).where(eq(agentDirectionConfigs.direction, "tarot"))
  const templateConfig = config?.templateConfig as { assetImageModelId?: string | null } | null | undefined
  const imageModelId = templateConfig?.assetImageModelId
  if (!imageModelId) throw new Error("未配置周边资产生图模型，请联系管理员在「Agent 工坊配置」中补齐")
  const [imageModel] = await db.select().from(models).where(and(eq(models.id, imageModelId), eq(models.isActive, true)))
  if (!imageModel) throw new Error("周边资产生图模型不可用")
  // 企业归属校验（与 AI 融合同款）：企业私有模型仅归属企业可用
  if (imageModel.enterpriseId !== null && imageModel.enterpriseId !== run.enterpriseId) {
    throw new Error("周边资产生图模型不在本企业可用范围内，请联系管理员调整配置")
  }

  // 评审模型：评审团首选 → 结构策划 → 创意总监（与模板生产同源槽位）
  const fullConfig = await loadFullDirectionConfig("tarot")
  const reviewerModelId =
    fullConfig.templateConfig?.reviewerModelIds?.[0] ??
    fullConfig.models.structureChatModelId ??
    fullConfig.models.styleChatModelId
  if (!reviewerModelId) throw new Error("未配置周边资产评审模型（评审团/风格策划/创意总监均缺），请联系管理员补齐")
  const llmCtx: AgentLlmContext = { run, chatModelCache: new Map() }
  const reviewModel = await loadChatModel(llmCtx, reviewerModelId)
  // 套件资产延用卡面生图比例（优先 run 快照里 imagegen 节点固化的尺寸）
  const cardImageSize = resolveCardImageSize(run, fullConfig)

  // 用户创建时的质量设定（及格线 + 打回上限）
  const quality = run.input.quality ?? FALLBACK_QUALITY
  const threshold = Math.max(1, Math.min(100, quality.contentThreshold))
  const maxAttempts = Math.max(0, Math.min(3, quality.maxRetries)) + 1 // 尝试次数 = 重试上限 + 1

  const [entRow] = await db.select({ maxConcurrent: enterprises.maxConcurrent }).from(enterprises).where(eq(enterprises.id, run.enterpriseId))
  const [groupRow] = await db
    .select({ groupId: permissionGroups.id, maxConcurrent: permissionGroups.maxConcurrent })
    .from(users)
    .innerJoin(permissionGroups, eq(users.groupId, permissionGroups.id))
    .where(eq(users.id, run.userId))
  const groupId = groupRow?.groupId ?? null
  const groupMaxConcurrent = groupRow?.maxConcurrent ?? 0
  const storage = await getStorage()
  const endpointHost = (() => {
    try {
      return new URL(imageModel.apiEndpoint).hostname
    } catch {
      return null
    }
  })()
  const slotTtlSec = Math.max(30, imageModel.taskTimeout || 600) + 300
  const enterpriseMaxConcurrent = entRow?.maxConcurrent ?? 5

  for (const task of ordered) {
    const label = TAROT_ASSET_KIND_LABELS[task.kind]
    const rule = assetRuleOfKind(task.kind)
    // 本次任务的全部尝试行（兜底时选最高分）
    const attempts: { id: string; score: number | null }[] = []
    let passed = false

    await db.insert(agentEvents).values({
      runId: run.id,
      nodeKey: "compositor",
      nodeType: "agent",
      action: "start",
      status: "ok",
      detail: `${label}开始 AI 生成（及格线 ${threshold} 分，最多 ${maxAttempts} 次尝试）`,
    })

    for (let attempt = 1; attempt <= maxAttempts && !passed; attempt++) {
      // 心跳：逐尝试续期 run.updatedAt，防被另一 worker 的 stale 恢复重置重跑
      await db.update(agentRuns).set({ updatedAt: new Date() }).where(eq(agentRuns.id, run.id))
      // 盒面参考：优先已确认的牌盒正面；批量生成时回退最新一条（box_front 先出图）
      let referenceImages: string[] = []
      if (FRONT_REFERENCED.includes(task.kind)) {
        const fronts = await db
          .select()
          .from(agentAssets)
          .where(and(eq(agentAssets.runId, run.id), eq(agentAssets.kind, "box_front")))
          .orderBy(desc(agentAssets.createdAt))
        const front = fronts.find((asset) => metaOf(asset).status === "confirmed") ?? fronts[0] ?? null
        if (front) referenceImages = [signUploadToken(front.url)]
      }

      // ── 1. AI 生成 ──
      const attemptStartedAt = Date.now()
      let url: string | null = null
      let genError: string | null = null
      const gotSlot = await acquireImageSlot({
        enterpriseId: run.enterpriseId,
        modelId: imageModel.id,
        groupId,
        enterpriseMaxConcurrent,
        modelMaxConcurrent: imageModel.maxConcurrent,
        groupMaxConcurrent,
        ttlSec: slotTtlSec,
      })
      try {
        const result = await callImageApi({
          model: imageModel,
          prompt: task.prompt,
          // 套件资产延用卡面生图比例（与卡面生产同源；盒面等各资产不再各自取模型预设）
          imageSize: cardImageSize,
          imageCount: 1,
          referenceImages,
          downloadAndUpload: (u) =>
            storage.saveFromUrl(u, run.enterpriseId, "generate", endpointHost ? [endpointHost] : undefined),
        })
        const output = result.find((candidate) => candidate.url)?.url
        if (!output) throw new Error(summarizeImageErrors(result) ?? "生图未返回图片")
        url = output
      } catch (err) {
        // 单次生图失败不吞掉整批：按本次尝试失败计，进入下一次尝试
        genError = err instanceof Error ? err.message : String(err)
      } finally {
        if (gotSlot) {
          await releaseImageSlot({
            enterpriseId: run.enterpriseId,
            modelId: imageModel.id,
            groupId,
            modelMaxConcurrent: imageModel.maxConcurrent,
            groupMaxConcurrent,
          }).catch(() => {})
        }
      }

      // 补录生图任务（资产管理画廊 + 操作日志生图 Tab 可见；资产路径不计积分）
      await recordAgentImageTask({
        run,
        model: imageModel,
        prompt: task.prompt,
        imageSize: cardImageSize,
        kindLabel: `套件资产·${label}`,
        imageCount: 1,
        resultImages: url ? [url] : [],
        errorMessage: genError,
        creditsCharged: 0,
        durationMs: Date.now() - attemptStartedAt,
      })
      if (!url) {
        await db.insert(agentEvents).values({
          runId: run.id,
          nodeKey: "compositor",
          nodeType: "agent",
          action: "fail",
          status: "error",
          detail: `${label}第 ${attempt} 次生图失败：${genError ?? "未知原因"}`,
        })
        continue
      }

      // 落 reviewing 行（评审中状态对前端可见）
      const [assetRow] = await db
        .insert(agentAssets)
        .values({
          runId: run.id,
          kind: task.kind,
          name: label,
          url,
          meta: { status: "reviewing", source: "ai", prompt: task.prompt, attempt, confirmedAt: null },
        })
        .returning({ id: agentAssets.id })
      attempts.push({ id: assetRow!.id, score: null })

      // ── 2. AI 评审（视觉模型按资产规则打分） ──
      // 评审对照物与生成指令同源：风格要点取实际生成的 styleDoc/方向，
      // 构图措辞按卡面比例填充（与 buildTarotAssetPrompt 同一口径）
      const selected = run.directions.find((item) => item.id === run.selectedDirectionId)
      const reviewStyle = extractStyleEssence(run.styleDoc, selected?.visualLanguage ?? run.brief)
      const fillOrientation = (text: string): string =>
        text.replaceAll("{orientation}", orientationOfCardSize(cardImageSize))
      let score: number | null = null
      let reviewReason: string | null = null
      try {
        const parsed = await withAgentLlmSlot(llmCtx, reviewModel, () =>
          callLlmJson<{ score?: unknown; reason?: unknown }>(llmCtx, reviewModel, {
            systemPrompt: [
              `你是严格的塔罗套件资产审核员。对生成的${label}与下方规则的符合度打分（0-100，${threshold} 分为及格线，宁严勿宽）。`,
              "【资产规则】",
              fillOrientation(rule.promptTemplate.replace("{style}", reviewStyle)),
              ...rule.rules.map(fillOrientation),
              rule.negativePrompt,
              "【输出格式】只输出 JSON，不要输出其他文字：",
              '{ "score": 0-100 整数, "reason": "具体依据（指出问题所在）" }',
            ].join("\n"),
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: `请评审这张${label}：` },
                  { type: "image_url", image_url: { url: signUploadToken(url) } },
                ],
              },
            ],
            thinkingLevel: "medium",
            validate: (raw) => {
              if (typeof raw.score !== "number" || raw.score < 0 || raw.score > 100) {
                throw new LlmValidationError("score 必须是 0-100 整数")
              }
            },
          }),
        )
        score = Math.max(0, Math.min(100, Math.round(parsed.score as number)))
        reviewReason = typeof parsed.reason === "string" ? parsed.reason : null
      } catch (err) {
        // 评审调用失败不吞掉整项：按本次尝试失败计，进入下一次尝试
        await db.insert(agentEvents).values({
          runId: run.id,
          nodeKey: "review_panel",
          nodeType: "agent",
          action: "fail",
          status: "error",
          detail: `${label}第 ${attempt} 次评审调用失败：${err instanceof Error ? err.message : String(err)}`,
        })
      }

      if (score !== null && score >= threshold) {
        // ── 3a. 过线：待人工确认 ──
        passed = true
        attempts[attempts.length - 1]!.score = score
        await db
          .update(agentAssets)
          .set({
            meta: {
              status: "uploaded",
              source: "ai",
              prompt: task.prompt,
              attempt,
              reviewScore: score,
              reviewReason,
              confirmedAt: null,
            },
          })
          .where(eq(agentAssets.id, assetRow!.id))
        await db.insert(agentEvents).values({
          runId: run.id,
          nodeKey: "review_panel",
          nodeType: "agent",
          action: "done",
          status: "ok",
          detail: `${label}第 ${attempt} 次生成评审通过（${score} 分 ≥ ${threshold}），待人工确认`,
        })
      } else {
        // ── 3b. 未过线：该行标 rejected（保留分数），进入下一次尝试 ──
        if (attempts[attempts.length - 1]) attempts[attempts.length - 1]!.score = score
        await db
          .update(agentAssets)
          .set({
            meta: {
              status: "rejected",
              source: "ai",
              prompt: task.prompt,
              attempt,
              reviewScore: score,
              reviewReason,
              confirmedAt: null,
            },
          })
          .where(eq(agentAssets.id, assetRow!.id))
        if (score !== null) {
          await db.insert(agentEvents).values({
            runId: run.id,
            nodeKey: "review_panel",
            nodeType: "agent",
            action: "retry",
            status: "warn",
            detail: `${label}第 ${attempt} 次生成评审未过（${score} 分 < ${threshold}）${reviewReason ? `：${reviewReason}` : ""}`,
          })
        }
      }
    }

    // ── 4. 兜底：尝试耗尽未过线，选本次任务历史最高分行待人工确认 ──
    if (!passed) {
      const best = [...attempts]
        .filter((a) => a.score !== null)
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0]
      if (best) {
        const [bestRow] = await db.select().from(agentAssets).where(eq(agentAssets.id, best.id))
        await db
          .update(agentAssets)
          .set({
            meta: {
              ...metaOf(bestRow ?? { meta: null }),
              status: "uploaded",
              fallback: true,
              confirmedAt: null,
            },
          })
          .where(eq(agentAssets.id, best.id))
        await db.insert(agentEvents).values({
          runId: run.id,
          nodeKey: "supervisor",
          nodeType: "agent",
          action: "done",
          status: "warn",
          detail: `${label}评审未达及格线（最高 ${best.score} 分 < ${threshold}），按历史最优兜底待人工确认`,
        })
      } else {
        await db.insert(agentEvents).values({
          runId: run.id,
          nodeKey: "compositor",
          nodeType: "agent",
          action: "fail",
          status: "error",
          detail: `${label}共 ${maxAttempts} 次尝试全部失败（生成或评审异常），可稍后重试`,
        })
      }
    }
  }
}
