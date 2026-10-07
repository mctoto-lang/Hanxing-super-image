/**
 * Agent 生图统一入库（generation_task + api_call_log）
 *
 * Agent 工坊三路生图（卡面 / 套件资产 / AI 融合）都不走通用生图队列，
 * 此前完全不落 generation_task / api_call_log——资产管理画廊（/assets）与
 * 操作日志生图 Tab（/admin/logs）因此看不到任何 Agent 生图。本模块把三路
 * 生图统一补录为 source='agent' 的任务行：画廊与日志按现有查询自动可见。
 *
 * 纯日志性质：入库失败只 console.error，不打断生产流程。
 */
import { db } from "@/db/client"
import { apiCallLogs, generationTasks } from "@/db/schema"

/** Agent 生图任务的最小 run 上下文（agentRuns.$inferSelect 的结构子集） */
export interface AgentImageTaskRunInfo {
  id: string
  enterpriseId: string
  userId: string
  title: string | null
}

export interface AgentImageTaskInput {
  run: AgentImageTaskRunInfo
  model: { id: string; displayName: string }
  prompt: string
  imageSize: string
  /** 生图类别标签（卡面 / 透明卡牌边框 / 卡背 / 牌盒正面 / AI 融合 等） */
  kindLabel: string
  /** 具体条目标识（卡名等；卡面/融合逐张记录时使用） */
  itemLabel?: string | null
  /** 本次请求的图片张数（重试补张语义下为本次实际请求数） */
  imageCount: number
  /** 成功产出并已转存到平台存储的图片 URL（空数组 = 全部失败） */
  resultImages: string[]
  errorMessage?: string | null
  /** 本次计费积分（资产/融合不扣积分时传 0） */
  creditsCharged: number
  durationMs?: number | null
}

/**
 * 补录一次 Agent 生图为 generation_task（成功 completed / 失败 failed）
 * + api_call_log（成功/失败各一行，taskId 关联）。
 */
export async function recordAgentImageTask(input: AgentImageTaskInput): Promise<void> {
  const ok = input.resultImages.length > 0
  const durationMs =
    typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? Math.round(input.durationMs)
      : null
  try {
    const now = new Date()
    const [task] = await db
      .insert(generationTasks)
      .values({
        enterpriseId: input.run.enterpriseId,
        userId: input.run.userId,
        modelId: input.model.id,
        prompt: input.prompt,
        imageSize: input.imageSize,
        imageCount: Math.max(1, input.imageCount),
        status: ok ? "completed" : "failed",
        source: "agent",
        creditsCharged: Math.max(0, Math.round(input.creditsCharged)),
        resultImages: ok ? input.resultImages : null,
        errorMessage: input.errorMessage ?? null,
        templateInfo: {
          runId: input.run.id,
          runTitle: input.run.title ?? undefined,
          kind: input.kindLabel,
          item: input.itemLabel ?? undefined,
        },
        startedAt: durationMs !== null ? new Date(now.getTime() - durationMs) : now,
        completedAt: now,
      })
      .returning({ id: generationTasks.id })

    await db.insert(apiCallLogs).values({
      enterpriseId: input.run.enterpriseId,
      taskId: task?.id ?? null,
      modelId: input.model.id,
      requestSummary: `agent kind=${input.kindLabel}${input.itemLabel ? ` item=${input.itemLabel}` : ""} model=${input.model.displayName} size=${input.imageSize} count=${Math.max(1, input.imageCount)}`,
      responseSummary: ok
        ? `images=${input.resultImages.length}`
        : `error: ${(input.errorMessage ?? "unknown").slice(0, 200)}`,
      errorMessage: input.errorMessage ?? null,
      durationMs,
    })
  } catch (error) {
    console.error("[agent-image-gen-log] 生图任务补录失败（不影响生产流程）:", error)
  }
}
