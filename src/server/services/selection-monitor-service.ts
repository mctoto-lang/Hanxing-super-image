import { and, asc, eq, lte } from "drizzle-orm"
import { db } from "@/db/client"
import { selectionMonitors, selectionTasks } from "@/db/schema"
import {
  CreditsInsufficientError,
  deductUserCredits,
} from "@/server/services/credits-service"
import { buildActorInput } from "@/lib/selection/input-builders"
import {
  SELECTION_PLATFORM_CONFIGS,
  estimateCredits,
  isSelectionPlatform,
} from "@/lib/selection/platforms"
import { resolveSelectionToken } from "@/lib/selection/provider-config"

/**
 * 竞品监控调度核心（0106，worker 调度循环与手动「立即抓取」共用）
 *
 * 到期认领（原子推进 nextRunAt，多副本安全）→ 组装 monitor/review 任务
 * （与普通任务同口径：单事务入库 + 预扣发起人积分，结算退款走既有收割链路）。
 * 积分不足 → 自动暂停（用户拍板口径）；凭证缺失 → 暂停并给指引。
 */

/** 单轮最多处理的到期监控数（防大量监控同时到期拖长循环） */
const MONITOR_BATCH = 5
/** 调度循环间隔 */
export const MONITOR_POLL_INTERVAL_MS = 30_000

/** 监控目标重抓一次需要创建的任务规格（runInput 由启动循环按 searchParams 重建） */
interface RunSpec {
  taskType: "monitor" | "review"
  actorId: string
  maxResults: number
  estimatedCredits: number
}

/**
 * 认领并执行到期监控（调度循环单轮）：原子认领（status=active 且
 * nextRunAt<=now，推进 nextRunAt）→ 创建任务。手动「立即抓取」传 force=true
 * （忽略 nextRunAt，但仍要求 active）。
 */
export async function runDueMonitorsOnce(force = false): Promise<{
  ran: number
  paused: number
}> {
  const now = new Date()
  const candidates = await db
    .select()
    .from(selectionMonitors)
    .where(
      force
        ? eq(selectionMonitors.status, "active")
        : and(
            eq(selectionMonitors.status, "active"),
            lte(selectionMonitors.nextRunAt, now),
          ),
    )
    .orderBy(asc(selectionMonitors.nextRunAt))
    .limit(force ? 1 : MONITOR_BATCH)

  let ran = 0
  let paused = 0
  for (const monitor of candidates) {
    // 原子认领：条件更新（active 且仍到期/force），推进调度时钟；失败=并发已处理
    const claimed = await db
      .update(selectionMonitors)
      .set({
        lastRunAt: now,
        nextRunAt: new Date(now.getTime() + monitor.intervalHours * 3600_000),
        runCount: monitor.runCount + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(selectionMonitors.id, monitor.id),
          eq(selectionMonitors.status, "active"),
          ...(force
            ? []
            : [lte(selectionMonitors.nextRunAt, now), eq(selectionMonitors.runCount, monitor.runCount)]),
        ),
      )
      .returning({ id: selectionMonitors.id })
    if (claimed.length === 0) continue

    const outcome = await createMonitorRunTasks(monitor.id)
    if (outcome === "paused") paused += 1
    else if (outcome === "ran") ran += 1
  }
  return { ran, paused }
}

/** 创建监控目标的一次重抓任务（monitor 指标 + review 评论，reddit 合一） */
export async function createMonitorRunTasks(
  monitorId: string,
): Promise<"ran" | "paused" | "skipped"> {
  const [monitor] = await db
    .select()
    .from(selectionMonitors)
    .where(eq(selectionMonitors.id, monitorId))
    .limit(1)
  if (!monitor || monitor.status !== "active") return "skipped"
  if (!isSelectionPlatform(monitor.platform)) return "skipped"
  const cfg = SELECTION_PLATFORM_CONFIGS[monitor.platform]
  const mon = cfg.monitor
  if (!mon || (!mon.metricsActorId && !mon.reviewActorId)) return "skipped"

  const cred = await resolveSelectionToken({ enterpriseId: monitor.enterpriseId })
  if (!cred) {
    await pauseMonitor(
      monitor.id,
      "企业未配置选品抓取凭证（请联系超管配置后手动恢复监控）",
    )
    return "paused"
  }

  const reviewMax = Math.max(1, Math.min(monitor.reviewMax, mon.reviewMaxPerTask))
  const params: Record<string, unknown> = {
    targetUrl: monitor.targetUrl,
    externalId: monitor.externalId ?? "",
    targetTitle: monitor.title ?? "",
    keyword: monitor.title ?? monitor.targetUrl,
    country: monitor.country ?? "",
    // reddit monitor 任务自带评论抓取上限
    reviewMax,
  }

  const specs: RunSpec[] = []
  if (mon.metricsActorId) {
    const built = buildActorInput({
      platform: monitor.platform,
      taskType: "monitor",
      params,
      maxResults: 1,
    })
    specs.push({
      taskType: "monitor",
      actorId: built.actorId,
      maxResults: 1,
      estimatedCredits: estimateCredits(monitor.platform, "monitor", 1),
    })
  }
  // reddit：评论随 monitor 任务带回（urls+includeComments），不另开 review 任务
  const reviewInline = monitor.platform === "reddit"
  if (mon.reviewActorId && monitor.trackReviews && !reviewInline) {
    const built = buildActorInput({
      platform: monitor.platform,
      taskType: "review",
      params,
      maxResults: reviewMax,
    })
    specs.push({
      taskType: "review",
      actorId: built.actorId,
      maxResults: reviewMax,
      estimatedCredits: estimateCredits(monitor.platform, "review", reviewMax),
    })
  }
  if (specs.length === 0) return "skipped"

  const label = cfg.label
  try {
    await db.transaction(async (tx) => {
      for (const spec of specs) {
        const [t] = await tx
          .insert(selectionTasks)
          .values({
            enterpriseId: monitor.enterpriseId,
            userId: monitor.userId,
            taskType: spec.taskType,
            platform: monitor.platform,
            actorId: spec.actorId,
            searchParams: params,
            keyword: (monitor.title ?? monitor.targetUrl).slice(0, 255),
            country: monitor.country,
            providerId: cred.providerId,
            maxResults: spec.maxResults,
            estimatedCredits: spec.estimatedCredits,
            monitorId: monitor.id,
            status: "queued",
          })
          .returning({ id: selectionTasks.id })
        await deductUserCredits({
          enterpriseId: monitor.enterpriseId,
          userId: monitor.userId,
          amount: spec.estimatedCredits,
          taskId: t!.id,
          type: "selection_deduct",
          remark: `竞品监控${spec.taskType === "monitor" ? "重抓" : "评论"}：${label}「${(monitor.title ?? monitor.targetUrl).slice(0, 60)}」×${spec.maxResults}`,
          tx,
        })
      }
    })
    return "ran"
  } catch (err) {
    if (err instanceof CreditsInsufficientError) {
      await pauseMonitor(
        monitor.id,
        `发起人积分不足（重抓需 ${specs.reduce((s, x) => s + x.estimatedCredits, 0)} 分），已自动暂停`,
      )
      return "paused"
    }
    // 其他异常：不暂停（可能是瞬时故障），下一周期重试；认领已推进时钟
    console.error(
      `[worker:selection-monitor] 监控 ${monitor.id} 任务创建失败:`,
      err instanceof Error ? err.message : err,
    )
    return "skipped"
  }
}

/** 暂停监控（积分不足/凭证缺失/用户手动） */
export async function pauseMonitor(id: string, reason: string): Promise<void> {
  await db
    .update(selectionMonitors)
    .set({ status: "paused", pauseReason: reason.slice(0, 255), updatedAt: new Date() })
    .where(eq(selectionMonitors.id, id))
}

/**
 * worker 调度循环入口（30s 一轮）：到期监控 → 重抓任务。
 * 调用方保证 isRunning()=false 后结束本轮回退。
 */
export async function runSelectionMonitorLoop(
  isRunning: () => boolean,
  intervalMs = MONITOR_POLL_INTERVAL_MS,
): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  while (isRunning()) {
    try {
      const { ran, paused } = await runDueMonitorsOnce()
      if (ran > 0 || paused > 0) {
        console.log(`[worker:selection-monitor] 本轮: 重抓 ${ran}，自动暂停 ${paused}`)
      }
    } catch (err) {
      console.error(
        "[worker:selection-monitor] 循环异常:",
        err instanceof Error ? err.message : err,
      )
    }
    await sleep(intervalMs)
  }
}
