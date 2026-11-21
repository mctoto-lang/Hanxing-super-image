import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { selectionTasks } from "@/db/schema"
import { env } from "@/lib/env"
import {
  abortActorRun,
  ApifyError,
  forEachDatasetItem,
  getActorRun,
  getDatasetItemCount,
  startActorRun,
} from "@/lib/apify/client"
import { buildActorInput } from "@/lib/selection/input-builders"
import { isSelectionPlatform } from "@/lib/selection/platforms"
import { resolveSelectionToken } from "@/lib/selection/provider-config"
import {
  countTaskResults,
  countTaskReviews,
  ingestRedditPostComments,
  ingestSelectionResults,
  ingestSelectionReviews,
  refreshMonitorSnapshot,
  settleSelectionTask,
} from "@/server/services/selection-service"
import { triggerSelectionAiHooks } from "@/server/services/selection-ai"

/**
 * 选品抓取双循环（0104）
 *
 * ── 启动循环（默认 2s）──
 *   并发闸门（processing 总数 ≥ SELECTION_MAX_CONCURRENT_RUNS 停认领）→
 *   原子认领一条 queued（workspace-agent 同款「选候选 id + 条件更新」）→
 *   buildActorInput 重建 runInput → Apify startActorRun → 回写 runId/datasetId。
 *   启动失败直接结算 failed 全额退款（不重试：POST /runs 重试会双跑双扣）。
 *
 * ── 收割循环（默认 5s）──
 *   扫全部 processing/cancelled 任务（无属主、崩溃自愈——Apify 侧状态是
 *   唯一真相）：RUNNING 更新进度；SUCCEEDED 翻页入库+结算；终态失败取
 *   部分数据按实际结算；cancelled 先 abort 再收割；超时强制 abort。
 *
 * 结算幂等（settleSelectionTask：actualCredits 认领）+ 入库幂等
 * （unique(task_id, dedupe_key)）双保险，多副本安全。
 */

const POLL_BATCH = 20
/** 认领后迟迟未回填 runId 的回收阈值（start 循环可能崩溃在 API 调用中途） */
const RUN_ID_GRACE_MS = 10 * 60_000
/** 收割循环自己的间隔（启动循环复用 worker 全局 interval） */
const HARVEST_INTERVAL_MS = 5_000

type LoopResult = { processed: number; failed: number }[]

export async function processSelectionStartOnce(): Promise<LoopResult> {

  // 并发闸门（进程内全局口径；多副本各自再乘副本数）
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(selectionTasks)
    .where(eq(selectionTasks.status, "processing"))
  if (count >= env.SELECTION_MAX_CONCURRENT_RUNS) {
    return [{ processed: 0, failed: 0 }]
  }

  // 原子认领：先选候选 id 再条件更新（UPDATE 无 LIMIT，多副本安全）
  const candidates = await db
    .select({ id: selectionTasks.id })
    .from(selectionTasks)
    .where(eq(selectionTasks.status, "queued"))
    .orderBy(asc(selectionTasks.createdAt))
    .limit(1)
  const claims = candidates.length
    ? await db
        .update(selectionTasks)
        .set({ status: "processing", startedAt: new Date() })
        .where(
          and(
            inArray(selectionTasks.id, candidates.map((c) => c.id)),
            eq(selectionTasks.status, "queued"),
          ),
        )
        .returning()
    : []
  if (claims.length === 0) return [{ processed: 0, failed: 0 }]
  const task = claims[0]

  let run: Awaited<ReturnType<typeof startActorRun>> | null = null
  let runToken: string | null = null
  try {
    if (!isSelectionPlatform(task.platform)) {
      throw new Error(`未知平台 ${task.platform}`)
    }
    // 凭证按任务快照解析（企业 provider → 平台 APIFY_API_TOKEN 兜底）
    const cred = await resolveSelectionToken({
      providerId: task.providerId,
      enterpriseId: task.enterpriseId,
    })
    if (!cred) {
      throw new Error("企业未配置选品抓取凭证（请联系超管在平台管理配置 Apify Token）")
    }
    const built = buildActorInput({
      platform: task.platform,
      taskType: task.taskType,
      params: task.searchParams ?? {},
      maxResults: task.maxResults,
    })
    run = await startActorRun({
      actorId: built.actorId,
      runInput: built.runInput,
      maxResults: task.maxResults,
      token: cred.token,
    })
    runToken = cred.token
    // 回填加条件：仅当任务仍为 processing——期间被取消/已结算的跳过回填，
    // 并 best-effort abort 已创建的 run（否则 Apify 孤儿 run 持续计费）
    const updated = await db
      .update(selectionTasks)
      .set({ apifyRunId: run.runId, apifyDatasetId: run.datasetId })
      .where(
        and(eq(selectionTasks.id, task.id), eq(selectionTasks.status, "processing")),
      )
      .returning({ id: selectionTasks.id })
    if (updated.length === 0) {
      try {
        await abortActorRun(run.runId, runToken)
      } catch (abortErr) {
        console.error(
          `[worker:selection] 任务 ${task.id} 回填被跳过，abort 孤儿 run ${run.runId} 失败:`,
          abortErr instanceof Error ? abortErr.message : abortErr,
        )
      }
    }
    return [{ processed: 1, failed: 0 }]
  } catch (err) {
    // run 已创建但回填/后续步骤失败：best-effort abort 防 Apify 孤儿 run 持续计费
    if (run && runToken) {
      try {
        await abortActorRun(run.runId, runToken)
      } catch (abortErr) {
        console.error(
          `[worker:selection] 任务 ${task.id} 启动失败，abort run ${run.runId} 失败:`,
          abortErr instanceof Error ? abortErr.message : abortErr,
        )
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    await settleSelectionTask({
      taskId: task.id,
      finalStatus: "failed",
      fetchedCount: 0,
      errorMessage: `启动抓取失败：${msg.slice(0, 500)}`,
    })
    return [{ processed: 0, failed: 1 }]
  }
}

/** 收割单轮：扫描在途任务（覆盖全部并发在途 + 滞留 cancelled，防 orderBy+limit 饥饿） */
async function processSelectionHarvestOnce(): Promise<LoopResult> {

  const tasks = await db
    .select()
    .from(selectionTasks)
    .where(inArray(selectionTasks.status, ["processing", "cancelled"]))
    .orderBy(asc(selectionTasks.createdAt))
    .limit(Math.max(POLL_BATCH, env.SELECTION_MAX_CONCURRENT_RUNS + 50))

  let processed = 0
  let failed = 0
  for (const task of tasks) {
    try {
      const outcome = await harvestOne(task.id)
      if (outcome === "settled-completed") processed += 1
      else if (outcome === "settled-failed") failed += 1
    } catch (err) {
      // 单任务异常不中断整轮（对齐 temu-sync 源级隔离口径）；连续失败由
      // 超时分支兜底强制 abort 结算
      console.error(
        `[worker:selection] 任务 ${task.id} 收割异常:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return [{ processed, failed }]
}

type HarvestOutcome = "settled-completed" | "settled-failed" | "pending"

async function harvestOne(taskId: string): Promise<HarvestOutcome> {
  const [task] = await db
    .select()
    .from(selectionTasks)
    .where(eq(selectionTasks.id, taskId))
    .limit(1)
  if (!task || task.actualCredits != null) return "pending" // 已结算
  const isCancelled = task.status === "cancelled"

  // ── 无 runId：queued→cancelled 被 action 直接结算过；processing 卡认领区回收 ──
  if (!task.apifyRunId) {
    if (isCancelled) {
      await settleSelectionTask({
        taskId,
        finalStatus: "cancelled",
        fetchedCount: task.fetchedCount,
      })
      return "settled-failed"
    }
    // startedAt 缺失时回退 createdAt（历史行/竞态窗口不得按 epoch 0 误判超时）
    const startedAt = task.startedAt ?? task.createdAt
    if (Date.now() - startedAt.getTime() > RUN_ID_GRACE_MS) {
      await settleSelectionTask({
        taskId,
        finalStatus: "failed",
        fetchedCount: 0,
        errorMessage: "启动抓取超时（worker 认领后未回填 runId，已回收）",
      })
      return "settled-failed"
    }
    return "pending"
  }

  // run/dataset 归属启动账号：必须用与启动一致的凭证（按任务快照解析）
  const cred = await resolveSelectionToken({
    providerId: task.providerId,
    enterpriseId: task.enterpriseId,
  })
  if (!cred) {
    await settleSelectionTask({
      taskId,
      finalStatus: "failed",
      fetchedCount: task.fetchedCount,
      errorMessage: "抓取凭证已失效（企业凭证被删除且平台未配置兜底 Token），任务终止",
    })
    return "settled-failed"
  }

  let run: Awaited<ReturnType<typeof getActorRun>>
  try {
    run = await getActorRun(task.apifyRunId, cred.token)
  } catch (err) {
    // 404：run 不存在或跨账号不可见（凭证换账号后收割永远 404）——按失败
    // 结算，防止任务永久卡 processing 占满并发闸门；其他错误（网络/5xx）
    // 照旧抛给外层，下轮继续轮询
    if (err instanceof ApifyError && err.status === 404) {
      await settleSelectionTask({
        taskId,
        finalStatus: "failed",
        fetchedCount: task.fetchedCount,
        errorMessage: "运行记录不可见或不存在（Apify run 404，抓取凭证可能已更换账号）",
      })
      return "settled-failed"
    }
    throw err
  }
  const datasetId = run.defaultDatasetId ?? task.apifyDatasetId
  const terminal =
    run.status === "SUCCEEDED" ||
    run.status === "FAILED" ||
    run.status === "ABORTED" ||
    run.status === "TIMED-OUT" ||
    run.status === "DELETED"

  // ── 用户取消且 run 未终止：先 abort，下轮收割部分数据 ──
  if (isCancelled && !terminal) {
    await abortActorRun(task.apifyRunId, cred.token)
    return "pending"
  }

  // ── 仍在跑：更新进度；超时强制 abort ──
  if (!terminal) {
    // startedAt 缺失时回退 createdAt（与上方无 runId 分支同一兜底口径，避免恒超时误判）
    const startedAt = task.startedAt ?? task.createdAt
    const elapsed = Date.now() - startedAt.getTime()
    if (elapsed > env.SELECTION_TASK_TIMEOUT_MS) {
      await abortActorRun(task.apifyRunId, cred.token)
      return "pending" // 下轮看到 ABORTED 终态后按部分数据结算
    }
    if (datasetId) {
      try {
        const itemCount = await getDatasetItemCount(datasetId, cred.token)
        const progress = Math.min(
          99,
          Math.round((itemCount / Math.max(1, task.maxResults)) * 100),
        )
        await db
          .update(selectionTasks)
          .set({ fetchedCount: itemCount, progress })
          .where(
            and(eq(selectionTasks.id, taskId), eq(selectionTasks.status, task.status)),
          )
      } catch {
        // 进度查询失败不影响主流程
      }
    }
    return "pending"
  }

  // ── 终态：翻页入库（SUCCEEDED 全量 / 失败取部分）后结算 ──
  // 入库路由（0106）：review 型 → selection_review；monitor 型 → 结果表
  // （reddit 特例同时抽帖子内嵌评论）；discover/market → 结果表
  let harvested = 0
  if (datasetId) {
    const taskRef = {
      id: task.id,
      enterpriseId: task.enterpriseId,
      platform: task.platform,
      taskType: task.taskType,
      country: task.country,
      monitorId: task.monitorId,
      targetTitle: (task.searchParams?.targetTitle as string) ?? null,
      targetUrl: (task.searchParams?.targetUrl as string) ?? null,
    }
    await forEachDatasetItem(
      datasetId,
      async (batch) => {
        if (task.taskType === "review") {
          await ingestSelectionReviews(taskRef, batch)
        } else {
          await ingestSelectionResults(taskRef, batch)
          if (task.taskType === "monitor" && task.platform === "reddit") {
            await ingestRedditPostComments(taskRef, batch)
          }
        }
      },
      { token: cred.token },
    )
    harvested =
      task.taskType === "review"
        ? await countTaskReviews(task.id)
        : await countTaskResults(task.id)
  }

  if (run.status === "SUCCEEDED") {
    await settleSelectionTask({
      taskId,
      finalStatus: "completed",
      fetchedCount: harvested,
    })
    // 监控快照回写 + AI 汇总触发（失败不影响结算；AI 内部静默降级）
    if (task.monitorId && task.taskType === "monitor") {
      try {
        await refreshMonitorSnapshot(task.monitorId, task.id)
      } catch (err) {
        console.error(
          `[worker:selection] 监控 ${task.monitorId} 快照回写失败:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
    if (task.monitorId || task.taskType !== "monitor") {
      void triggerSelectionAiHooks({
        taskId: task.id,
        monitorId: task.monitorId,
        enterpriseId: task.enterpriseId,
        platform: task.platform,
        taskType: task.taskType,
      }).catch(() => {})
    }
    return "settled-completed"
  }

  await settleSelectionTask({
    taskId,
    finalStatus: isCancelled ? "cancelled" : "failed",
    fetchedCount: harvested,
    errorMessage: isCancelled
      ? "用户取消（已按实际抓取条数结算）"
      : `Apify run ${run.status}（已保留 ${harvested} 条部分数据并按实际结算）`,
  })
  return isCancelled ? "settled-completed" : "settled-failed"
}

/**
 * worker 注册入口：启动循环（复用调用方 interval）+ 收割循环（5s）并行。
 * 调用方保证 isRunning()=false 后两个循环各自结束本轮回退。
 */
export async function runSelectionLoops(
  isRunning: () => boolean,
  startIntervalMs = 2000,
): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const startLoop = async (): Promise<void> => {
    while (isRunning()) {
      try {
        const results = await processSelectionStartOnce()
        const total = results.reduce((s, r) => s + r.processed + r.failed, 0)
        if (total > 0) {
          console.log(`[worker:selection-start] 本轮: ${JSON.stringify(results)}`)
        }
      } catch (err) {
        console.error(
          "[worker:selection-start] 循环异常:",
          err instanceof Error ? err.message : err,
        )
      }
      await sleep(startIntervalMs)
    }
  }

  const harvestLoop = async (): Promise<void> => {
    while (isRunning()) {
      try {
        const results = await processSelectionHarvestOnce()
        const total = results.reduce((s, r) => s + r.processed + r.failed, 0)
        if (total > 0) {
          console.log(`[worker:selection-harvest] 本轮: ${JSON.stringify(results)}`)
        }
      } catch (err) {
        console.error(
          "[worker:selection-harvest] 循环异常:",
          err instanceof Error ? err.message : err,
        )
      }
      await sleep(HARVEST_INTERVAL_MS)
    }
  }

  await Promise.all([startLoop(), harvestLoop()])
}
