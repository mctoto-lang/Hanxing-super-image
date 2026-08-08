import { NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  apiCallLogs,
  enterprises,
  generationTasks,
  models,
} from "@/db/schema"
import { env } from "@/lib/env"
import {
  listEnterprisesWithPendingTasks,
  dequeueNext,
  completeTask,
  failTask,
} from "@/lib/queue/task-queue"
import { callImageApi } from "@/lib/ai"
import { saveFromUrl } from "@/lib/storage/local"
import { refundFailedTask } from "@/server/actions/create"

/**
 * 队列消费者（手册 §5.4）
 *
 * 由宿主机 cron / supercronic 定时触发（每 QUEUE_POLL_INTERVAL_MS）。
 * 安全：CRON_SECRET Bearer token 守卫。
 *
 * 每次触发：扫描有待处理任务的企业 → 各 dequeue 一批 → 调 AI → 写结果。
 */
export async function POST(request: Request) {
  // Bearer token 校验
  const auth = request.headers.get("authorization")
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const enterprisesWithTasks = await listEnterprisesWithPendingTasks()
  const results: { enterpriseId: string; processed: number; failed: number }[] = []

  for (const enterpriseId of enterprisesWithTasks) {
    const [ent] = await db
      .select()
      .from(enterprises)
      .where(eq(enterprises.id, enterpriseId))
      .limit(1)
    if (!ent || ent.status !== "active") continue

    let processed = 0
    let failed = 0

    // 每个企业最多消费 maxConcurrent 个（一次 cron 触发）
    for (let i = 0; i < ent.maxConcurrent; i++) {
      const task = await dequeueNext({
        enterpriseId,
        enterpriseMaxConcurrent: ent.maxConcurrent,
      })
      if (!task) break

      try {
        await processOneTask(task)
        processed++
      } catch (err) {
        failed++
        console.error(
          `[queue] 任务 ${task.taskId} 失败:`,
          err instanceof Error ? err.message : err,
        )
        // 失败处理（含重试判断）
        await handleTaskFailure(task, err)
      }
    }

    results.push({ enterpriseId, processed, failed })
  }

  return NextResponse.json({ ok: true, results })
}

async function processOneTask(task: Awaited<ReturnType<typeof dequeueNext>>): Promise<void> {
  if (!task) return

  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, task.modelId))
    .limit(1)
  if (!model) throw new Error("模型不存在")

  const startedAt = Date.now()

  try {
    const imageUrls = await callImageApi({
      model,
      prompt: task.prompt,
      imageSize: task.imageSize,
      imageCount: task.imageCount,
      referenceImages: task.referenceImages,
      downloadAndUpload: async (url, _idx) =>
        saveFromUrl(url, task.enterpriseId, "image"),
    })

    await db
      .update(generationTasks)
      .set({
        status: "completed",
        resultImages: imageUrls,
        completedAt: new Date(),
      })
      .where(eq(generationTasks.id, task.taskId))

    await apiCallLog(model.id, task, startedAt, null, imageUrls.length)

    await completeTask(task.enterpriseId, task.taskId)
  } catch (err) {
    // 写错误日志
    const msg = err instanceof Error ? err.message : String(err)
    await apiCallLog(model.id, task, startedAt, msg, 0)
    throw err
  }
}

async function handleTaskFailure(
  task: NonNullable<Awaited<ReturnType<typeof dequeueNext>>>,
  err: unknown,
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err)
  // 是否还能重试
  const [current] = await db
    .select()
    .from(generationTasks)
    .where(eq(generationTasks.id, task.taskId))
    .limit(1)
  const retryCount = current?.retryCount ?? 0
  const shouldRetry = retryCount < task.maxRetries

  await db
    .update(generationTasks)
    .set({
      status: shouldRetry ? "queued" : "failed",
      retryCount: retryCount + 1,
      errorMessage: shouldRetry ? msg : `最终失败（重试 ${retryCount} 次）: ${msg}`,
      retryErrors: [...(current?.retryErrors ?? []), msg],
    })
    .where(eq(generationTasks.id, task.taskId))

  if (!shouldRetry) {
    // 重试用尽：退还积分
    await refundFailedTask(task.taskId)
  }

  await failTask(task.enterpriseId, task.taskId, shouldRetry)
}

async function apiCallLog(
  modelId: string,
  task: NonNullable<Awaited<ReturnType<typeof dequeueNext>>>,
  startedAt: number,
  errorMsg: string | null,
  imageCount: number,
): Promise<void> {
  await db.insert(apiCallLogs).values({
    enterpriseId: task.enterpriseId,
    taskId: task.taskId,
    modelId,
    requestSummary: `model=${task.modelId} size=${task.imageSize} count=${task.imageCount}`,
    responseSummary: errorMsg
      ? `error: ${errorMsg.slice(0, 200)}`
      : `images=${imageCount}`,
    errorMessage: errorMsg,
    durationMs: Date.now() - startedAt,
  })
}
