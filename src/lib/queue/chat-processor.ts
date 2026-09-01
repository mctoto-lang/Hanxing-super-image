import { and, eq, or, isNull, lte } from "drizzle-orm"
import { db } from "@/db/client"
import { chatTasks } from "@/db/schema"
import { processChatTask } from "@/server/services/workspace-ai"
import type { ProcessResult } from "@/lib/queue/processor"

/**
 * 对话任务队列消费核心逻辑（手册 §5.6、M5）
 *
 * 与触发方式解耦：既被 `/api/cron/process-chat-queue` 路由调用（手动 curl /
 * 外部 cron 兜底），又被独立 worker 进程（scripts/worker.ts）调用。
 *
 * 每次调用：扫描有「可处理」queued chatTasks 的企业 → 各取一批 → 调
 * processChatTask。
 *
 * 指数退避：仅选取 nextRetryAt 为空（立即可处理）或已到期（<= now）的任务，
 * 跳过尚未到退避时间的重试任务。重试上限逻辑由 processChatTask 内部处理
 * （retryCount < maxRetries）。
 */

/** 每企业每轮处理的最大对话任务数 */
const BATCH_SIZE_PER_ENTERPRISE = 20

/** 执行一轮对话队列消费。 */
export async function processChatQueueOnce(): Promise<ProcessResult[]> {
  const now = new Date()
  // 「可处理」= nextRetryAt 为空 或 已到期（指数退避过滤）。
  // 用工厂函数每次生成新表达式，避免 Drizzle builder 在多次复用时被污染。
  const due = () => or(isNull(chatTasks.nextRetryAt), lte(chatTasks.nextRetryAt, now))

  // 查询所有有「可处理」queued chatTasks 的企业（租户隔离分组扫描）
  const enterpriseRows = await db
    .selectDistinct({ enterpriseId: chatTasks.enterpriseId })
    .from(chatTasks)
    .where(and(eq(chatTasks.status, "queued"), due()))

  const results: ProcessResult[] = []

  for (const { enterpriseId } of enterpriseRows) {
    let processed = 0
    let failed = 0

    // 该企业一批「可处理」queued chatTasks（限制批量大小，应用退避过滤）
    const queuedTasks = await db
      .select({ id: chatTasks.id })
      .from(chatTasks)
      .where(
        and(
          eq(chatTasks.enterpriseId, enterpriseId),
          eq(chatTasks.status, "queued"),
          due(),
        ),
      )
      .limit(BATCH_SIZE_PER_ENTERPRISE)

    for (const { id: chatTaskId } of queuedTasks) {
      try {
        await processChatTask({ chatTaskId, enterpriseId })
        processed++
      } catch (err) {
        failed++
        console.error(
          `[chat-queue] 任务 ${chatTaskId} 失败:`,
          err instanceof Error ? err.message : err,
        )
        // 不中断整个流程，继续处理下一个
      }
    }

    results.push({ enterpriseId, processed, failed })
  }

  return results
}
