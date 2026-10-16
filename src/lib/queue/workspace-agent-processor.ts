/**
 * 工作台 Agent 任务队列消费核心（workspace_agent_job 表）
 *
 * 与触发方式解耦：被独立 worker 进程（scripts/worker.ts）周期调用。每轮：
 *   1. 崩溃恢复：processing 且认领时间（started_at）超过 STALE_JOB_MS 的任务，
 *      条件更新原子认领后按退避重排（不与执行中的 worker 重复消费）；
 *   2. 原子认领：先选候选 id，再以 status='queued' 条件更新为 processing，
 *      多 worker 并发时只有一方能认领同一行（杜绝重复领取）；
 *   3. 执行：按 jobType 分发（gen_directions / write_prompts）；LLM 经
 *      dispatchStreamChat，真实 usage 写 workspace_agent_usage 账本并按
 *      厘累计→满 1 积分原子扣企业池（见 services/workspace-agent/llm）；
 *   4. 收口：成功 → job completed，workflow 回 waiting_human（等用户下一
 *      步），绝不虚标 completed；失败 → 指数退避重排（≤ MAX_JOB_RETRIES），
 *      重试耗尽才 failed 并落 error + fail 事件。
 *
 * 计费安全：LLM 计费按「实际发生的调用」逐次入账（usage 账本），重试产生的
 * 新调用如实计费；原子认领保证同一 job 不会被两个 worker 同时执行。
 *
 * 另含终态行清理（cleanupTerminalWorkspaceAgentJobs）：completed/failed 行
 * 按保留期删除，防表无限膨胀拖慢扫描；由 worker 恢复循环低频调用。
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  workspaceAgentJobs,
  workspaceAgentWorkflows,
  type WorkspaceAgentJobRow,
} from "@/db/schema"
import type { ProcessResult } from "@/lib/queue/processor"
import { stageOfJobType } from "@/lib/workspace/agent-templates"
import {
  logWaEvent,
  markReferenceStyleAnalysisFailed,
  runAnalyzeReferenceStyleJob,
  runGenDirectionsJob,
  runWritePromptsJob,
} from "@/server/services/workspace-agent/run"
import { runReviewImageJob, runRevisePromptJob } from "@/server/services/workspace-agent/production"
import { runWriteOracleCopyJob } from "@/server/services/workspace-agent/oracle"

/**
 * 认领心跳超时阈值（ms）：超过视为 worker 崩溃遗留。长任务执行期间按批/按
 * 评审员续期 job.startedAt（run.ts 的 heartbeat 与 production.ts 评审循环），
 * 本阈值即按 job.startedAt 判定；批内单次 LLM 受 taskTimeout 预算约束
 * （默认 300s）——15 分钟覆盖默认值 3 倍。
 */
const STALE_JOB_MS = 15 * 60 * 1000

/** 每轮最多认领的任务数 */
const MAX_JOBS_PER_POLL = 5

/** 单任务最大尝试次数（含首次） */
const MAX_JOB_RETRIES = 3

/** 重试退避基数：第 n 次失败后等待 BASE * 2^(n-1) 秒 */
const RETRY_BACKOFF_BASE_SEC = 30

/**
 * 终态任务行保留时长（ms）：completed/failed 行到期定期清理，防止队列
 * 扫描随表膨胀退化为全表顺序扫描。30 天为队列留痕行业常规保留期，
 * 兼顾排障回溯（job.result/errorMessage）与表规模可控。
 */
const TERMINAL_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// 崩溃恢复
// ---------------------------------------------------------------------------

/**
 * 崩溃恢复：processing 且 startedAt 超时的任务重排/判死。
 * 条件更新（WHERE status='processing' AND started_at < cutoff）保证恢复方与
 * 仍在执行的 worker 之间只有一方能改状态；改动后原执行方在收口时也会被
 * status 守卫拦住，不会覆盖恢复结果。
 */
export async function recoverStaleWorkspaceAgentJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_JOB_MS)
  const staleRows = await db
    .select({
      id: workspaceAgentJobs.id,
      workflowId: workspaceAgentJobs.workflowId,
      enterpriseId: workspaceAgentJobs.enterpriseId,
      retryCount: workspaceAgentJobs.retryCount,
      jobType: workspaceAgentJobs.jobType,
      payload: workspaceAgentJobs.payload,
    })
    .from(workspaceAgentJobs)
    .where(
      and(
        eq(workspaceAgentJobs.status, "processing"),
        lte(workspaceAgentJobs.startedAt, cutoff),
      ),
    )
  for (const row of staleRows) {
    const willRetry = row.retryCount + 1 < MAX_JOB_RETRIES
    const claimed = await db
      .update(workspaceAgentJobs)
      .set(
        willRetry
          ? {
              status: "queued",
              retryCount: row.retryCount + 1,
              nextRetryAt: new Date(
                Date.now() + RETRY_BACKOFF_BASE_SEC * 2 ** row.retryCount * 1000,
              ),
              startedAt: null,
            }
          : {
              status: "failed",
              errorMessage: "任务心跳超时（worker 崩溃或中断），重试次数已用尽",
              completedAt: new Date(),
            },
      )
      .where(
        and(
          eq(workspaceAgentJobs.id, row.id),
          eq(workspaceAgentJobs.status, "processing"),
          lte(workspaceAgentJobs.startedAt, cutoff),
        ),
      )
      .returning({ id: workspaceAgentJobs.id })
    if (claimed.length === 0) continue // 已被执行方收口或并发恢复方处理
    if (willRetry) {
      await logWaEvent({
        workflowId: row.workflowId,
        enterpriseId: row.enterpriseId,
        nodeKey: "supervisor",
        action: "retry",
        status: "warn",
        stage: stageOfJobType(row.jobType, typeof row.payload?.round === "string" ? row.payload.round : null),
        detail: `任务 ${row.jobType} 心跳超时（worker 重启或中断），已重新排队重试（第 ${row.retryCount + 1} 次）`,
      })
    } else {
      await db
        .update(workspaceAgentWorkflows)
        .set({
          status: "waiting_human",
          error: `任务 ${row.jobType} 多次执行失败（心跳超时），可重新发起`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workspaceAgentWorkflows.id, row.workflowId),
            inArray(workspaceAgentWorkflows.status, ["queued", "running"]),
          ),
        )
      await logWaEvent({
        workflowId: row.workflowId,
        enterpriseId: row.enterpriseId,
        nodeKey: "supervisor",
        action: "fail",
        status: "error",
        stage: stageOfJobType(row.jobType, typeof row.payload?.round === "string" ? row.payload.round : null),
        detail: `任务 ${row.jobType} 心跳超时且重试次数已用尽，已标记失败（可重新发起）`,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

/**
 * 终态行清理：删除 completed/failed 且创建时间早于保留期的任务行。
 * 任务从创建到终态在分钟级（重试上限 + 有界退避），按 createdAt 保留与按
 * completedAt 保留等价，且可直接复用 waj_status_created(status, created_at)
 * 索引做有界范围删除，不引入额外索引。由 worker 恢复循环低频调用。
 */
export async function cleanupTerminalWorkspaceAgentJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - TERMINAL_JOB_RETENTION_MS)
  await db
    .delete(workspaceAgentJobs)
    .where(
      and(
        inArray(workspaceAgentJobs.status, ["completed", "failed"]),
        lte(workspaceAgentJobs.createdAt, cutoff),
      ),
    )
}

export async function processWorkspaceAgentQueueOnce(): Promise<ProcessResult[]> {
  // ── 1. 崩溃恢复（认领前先扫；worker 另有独立定时通道） ──
  await recoverStaleWorkspaceAgentJobs()

  const now = new Date()
  // 「可处理」= nextRetryAt 为空或已到期（指数退避过滤，同 chat-queue 口径）
  const due = () => or(isNull(workspaceAgentJobs.nextRetryAt), lte(workspaceAgentJobs.nextRetryAt, now))

  // ── 2. 原子认领（UPDATE 不支持 LIMIT：先选候选 id 再条件更新） ──
  const candidates = await db
    .select({ id: workspaceAgentJobs.id, enterpriseId: workspaceAgentJobs.enterpriseId })
    .from(workspaceAgentJobs)
    .where(and(eq(workspaceAgentJobs.status, "queued"), due()))
    .orderBy(asc(workspaceAgentJobs.createdAt))
    .limit(MAX_JOBS_PER_POLL)
  const claims = candidates.length
    ? await db
        .update(workspaceAgentJobs)
        .set({ status: "processing", startedAt: now, nextRetryAt: null })
        .where(
          and(
            inArray(
              workspaceAgentJobs.id,
              candidates.map((c) => c.id),
            ),
            eq(workspaceAgentJobs.status, "queued"),
          ),
        )
        .returning()
    : []

  const results = new Map<string, { enterpriseId: string; processed: number; failed: number }>()
  const tally = (enterpriseId: string, ok: boolean) => {
    const entry = results.get(enterpriseId) ?? { enterpriseId, processed: 0, failed: 0 }
    if (ok) entry.processed += 1
    else entry.failed += 1
    results.set(enterpriseId, entry)
  }

  // ── 3. 串行执行（同进程不并发，简化计费与状态竞争面） ──
  for (const job of claims) {
    const ok = await runClaimedJob(job)
    tally(job.enterpriseId, ok)
  }

  return [...results.values()]
}

// ---------------------------------------------------------------------------
// 单任务执行与收口
// ---------------------------------------------------------------------------

async function runClaimedJob(job: WorkspaceAgentJobRow): Promise<boolean> {
  const [workflow] = await db
    .select()
    .from(workspaceAgentWorkflows)
    .where(eq(workspaceAgentWorkflows.id, job.workflowId))
  if (!workflow) {
    await failJobTerminal(job, "工作流不存在")
    return false
  }
  // 用户已取消：任务作废，不回写 waiting_human（保持 cancelled）
  if (workflow.status === "cancelled") {
    await db
      .update(workspaceAgentJobs)
      .set({ status: "failed", errorMessage: "工作流已取消", completedAt: new Date() })
      .where(and(eq(workspaceAgentJobs.id, job.id), eq(workspaceAgentJobs.status, "processing")))
    return false
  }

  // 置 running（终态守卫：completed/failed/cancelled 不复活）
  await db
    .update(workspaceAgentWorkflows)
    .set({
      status: "running",
      startedAt: workflow.startedAt ?? new Date(),
      error: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceAgentWorkflows.id, workflow.id),
        inArray(workspaceAgentWorkflows.status, ["queued", "running", "waiting_human"]),
      ),
    )

  try {
    const result = await dispatchJob(workflow, job)
    // job completed（status 守卫防覆盖恢复/取消结果）
    await db
      .update(workspaceAgentJobs)
      .set({ status: "completed", result, completedAt: new Date(), errorMessage: null })
      .where(and(eq(workspaceAgentJobs.id, job.id), eq(workspaceAgentJobs.status, "processing")))
    // workflow 回 waiting_human：等用户下一步（生图/评审未接入，不标 completed）
    await db
      .update(workspaceAgentWorkflows)
      .set({ status: "waiting_human", error: null, updatedAt: new Date() })
      .where(and(eq(workspaceAgentWorkflows.id, workflow.id), eq(workspaceAgentWorkflows.status, "running")))
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 参考图分析仅在重试耗尽（终态失败）时落 failed；中途重试保持 pending，
    // 避免向导在任务仍会自动重试时误报“分析失败”
    if (job.jobType === "analyze_reference_style" && job.retryCount + 1 >= MAX_JOB_RETRIES) {
      await markReferenceStyleAnalysisFailed(workflow.id, message).catch((persistError) => {
        console.error("[workspace-agent] 保存参考图风格分析失败状态失败:", persistError)
      })
    }
    await logWaEvent({
      workflowId: workflow.id,
      enterpriseId: workflow.enterpriseId,
      nodeKey: "supervisor",
      action: "fail",
      status: "error",
      stage: stageOfJobType(job.jobType, typeof job.payload?.round === "string" ? job.payload.round : null),
      detail: `任务 ${job.jobType} 执行失败：${message}`,
    })
    // 指数退避重排；耗尽则终态 failed
    if (job.retryCount + 1 < MAX_JOB_RETRIES) {
      await db
        .update(workspaceAgentJobs)
        .set({
          status: "queued",
          retryCount: job.retryCount + 1,
          nextRetryAt: new Date(
            Date.now() + RETRY_BACKOFF_BASE_SEC * 2 ** job.retryCount * 1000,
          ),
          startedAt: null,
          errorMessage: message.slice(0, 500),
          retryErrors: sql`${workspaceAgentJobs.retryErrors} || ${JSON.stringify([
            message.slice(0, 200),
          ])}::jsonb`,
        })
        .where(and(eq(workspaceAgentJobs.id, job.id), eq(workspaceAgentJobs.status, "processing")))
    } else {
      await failJobTerminal(job, message)
    }
    // 工作流回 waiting_human（保留 error 供进度弹窗展示与一键重试）
    await db
      .update(workspaceAgentWorkflows)
      .set({ status: "waiting_human", error: message.slice(0, 500), updatedAt: new Date() })
      .where(
        and(
          eq(workspaceAgentWorkflows.id, workflow.id),
          inArray(workspaceAgentWorkflows.status, ["queued", "running"]),
        ),
      )
    console.error(`[workspace-agent-queue] 任务 ${job.id}（${job.jobType}）失败:`, message)
    return false
  }
}

async function failJobTerminal(job: WorkspaceAgentJobRow, message: string): Promise<void> {
  await db
    .update(workspaceAgentJobs)
    .set({ status: "failed", errorMessage: message.slice(0, 500), completedAt: new Date() })
    .where(and(eq(workspaceAgentJobs.id, job.id), eq(workspaceAgentJobs.status, "processing")))
}

async function dispatchJob(
  workflow: typeof workspaceAgentWorkflows.$inferSelect,
  job: WorkspaceAgentJobRow,
): Promise<Record<string, unknown>> {
  switch (job.jobType) {
    case "analyze_reference_style": {
      const result = await runAnalyzeReferenceStyleJob(workflow)
      return { styleDescription: result.styleDescription }
    }
    case "gen_directions": {
      const r = await runGenDirectionsJob(workflow, job)
      return { directionIds: r.directionIds, names: r.names }
    }
    case "write_prompts": {
      const r = await runWritePromptsJob(workflow, job)
      return { written: r.written, failed: r.failed, total: r.total }
    }
    case "write_oracle_copy": {
      const r = await runWriteOracleCopyJob(workflow, job)
      return { written: r.written, skipped: r.skipped, total: r.total }
    }
    case "review_image": {
      // 生图终态触发的自动评审（打回循环）：outcome 含 approved / retry /
      // fallback / generation_failed / skipped 等，评分与 Token 已在
      // workspace_agent_usage 真实入账
      return runReviewImageJob(workflow, job)
    }
    case "revise_prompt": {
      // 「重新 Agent 生成（带修改意见）」：按用户意见改写提示词后自动生图，
      // 终态同样自动进评审循环
      return runRevisePromptJob(workflow, job)
    }
    default:
      // 开放集合的未知类型：显式失败（不静默标完成）
      throw new Error(`暂未支持的任务类型：${job.jobType}（等待后续阶段接入）`)
  }
}
