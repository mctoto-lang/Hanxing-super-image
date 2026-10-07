/**
 * 独立队列消费者 worker（手册 §5.4 / §5.6）
 *
 * 周期性消费两个队列：生图任务（Redis 队列）+ 对话任务（DB 表）；
 * 另含低频服务可用性采样循环（5 分钟，见 statusLoop）与 Agent 崩溃恢复
 * 独立循环（60 秒，长任务阻塞主轮询时其他企业仍能被恢复）。
 * 解决「任务永久卡在 queued」——补齐队列消费者的触发器，与 Web 进程解耦，
 * 避免长耗时 AI 任务拖累用户请求响应。
 *
 * 运行：
 *   开发：pnpm worker（tsx watch 热重载）或 pnpm dev:all（web + worker 同启）
 *   生产：docker compose up（worker 服务：npx tsx scripts/worker.ts）
 *
 * 设计要点：
 *   - .env 加载必须早于 import processor（后者会触发 env.ts 校验），故用同步
 *     loadEnvFile + 动态 import（静态 import 会被提升到 loadEnvFile 之前）。
 *   - 生图队列用常驻滑动窗口循环（任务完成即补位，慢任务不阻塞后续任务，
 *     高并发下吞吐稳定）；对话队列保持 while+sleep 串行轮询。两个循环
 *     async IO 交错，互不阻塞。
 *   - 单轮异常不退出（catch 后继续下一轮），保证长期可用。
 *   - SIGINT/SIGTERM 优雅退出：置 running=false，生图循环等待在途任务结束后
 *     退出，对话循环当前轮结束后退出。
 */

// 先加载本地 .env（开发），生产靠容器注入 env；文件不存在时忽略。
// 必须在任何 import 之前执行，故放在文件顶部、processor 用动态 import。
try {
  process.loadEnvFile()
} catch {
  // .env 不存在时忽略（生产环境靠容器注入 env）
}

import os from "node:os"

// 韧性兜底：各消费循环自带 try/catch，但循环外偶发的未处理拒绝
// （如 Redis 重连、fire-and-forget 任务）会让 Node 直接 exit(1) 且不留
// 日志（worker 常驻进程静默消失）。这里统一记录后继续运行；
// uncaughtException 属不可恢复状态，记录后带码退出由容器/守护拉起。
process.on("unhandledRejection", (reason) => {
  console.error("[worker] 未处理的 Promise 拒绝（已忽略，继续运行）:", reason)
})
process.on("uncaughtException", (err) => {
  console.error("[worker] 未捕获异常，进程即将退出:", err)
  process.exit(1)
})

void (async () => {
  try {
    // 动态 import：确保上面 loadEnvFile 在 env.ts 校验之前完成
    const { processQueueContinuous } = await import("@/lib/queue/processor")
    const { processChatQueueOnce } = await import("@/lib/queue/chat-processor")
    const { processAgentQueueOnce, recoverStaleAgentRuns } = await import("@/lib/queue/agent-processor")
    const { syncMockupJobs } = await import("@/server/services/mockup-service")
    const { sampleAllServices } = await import("@/server/services/status-service")

    const interval = Number(process.env.QUEUE_POLL_INTERVAL_MS) || 2000

    let running = true
    const shutdown = (sig: string) => {
      if (!running) return
      console.log(`[worker] 收到 ${sig}，等待当前轮结束后退出...`)
      running = false
    }
    process.on("SIGINT", () => shutdown("SIGINT"))
    process.on("SIGTERM", () => shutdown("SIGTERM"))

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

    console.log(
      `[worker] 队列消费者启动（主机 ${os.hostname()}，间隔 ${interval}ms，消费生图 + 对话 + Agent 队列）`,
    )

    type LoopResult = { processed: number; failed: number }[]

    // 通用消费循环：单个队列独立 while+sleep 串行
    const runLoop = async (
      name: string,
      consume: () => Promise<LoopResult>,
    ): Promise<void> => {
      while (running) {
        try {
          const results = await consume()
          const total = results.reduce((s, r) => s + r.processed + r.failed, 0)
          if (total > 0) {
            console.log(`[worker:${name}] 本轮消费: ${JSON.stringify(results)}`)
          }
        } catch (err) {
          // 单轮异常不退出，下一轮继续
          console.error(
            `[worker:${name}] 消费循环异常:`,
            err instanceof Error ? err.message : err,
          )
        }
        await sleep(interval)
      }
    }

    // 生图：常驻滑动窗口（完成即补位） + 对话：轮询循环，双队列并行消费
    // 服务可用性采样：低频（5 分钟），平台 + 全部企业 PS-API/AI 端点 upsert 当日样本
    const statusSampleInterval = 5 * 60 * 1000
    const statusLoop = async (): Promise<void> => {
      while (running) {
        try {
          const r = await sampleAllServices()
          console.log(
            `[worker:status] 采样完成: system=${r.system}, storage=${r.storage.configured ? r.storage.status : "未配置"}, ps-api ${r.psApi.sampled}/${r.psApi.total}${r.psApi.errors ? `（失败 ${r.psApi.errors}）` : ""}, ai ${r.ai.sampled}/${r.ai.enterprises}, chat ${r.chat.sampled}/${r.chat.enterprises}`,
          )
        } catch (err) {
          console.error(
            "[worker:status] 采样循环异常:",
            err instanceof Error ? err.message : err,
          )
        }
        await sleep(statusSampleInterval)
      }
    }

    // Agent 崩溃恢复独立循环：produce_cards 长任务会阻塞 agent 主轮询，
    // 独立通道保证其他企业的 stale run 恢复与新任务认领不被卡死
    const agentRecoveryInterval = 60 * 1000
    const agentRecoveryLoop = async (): Promise<void> => {
      while (running) {
        try {
          await recoverStaleAgentRuns()
        } catch (err) {
          console.error(
            "[worker:agent-recovery] 恢复循环异常:",
            err instanceof Error ? err.message : err,
          )
        }
        await sleep(agentRecoveryInterval)
      }
    }

    // 订阅套餐周期发放：扫描到期未发放的订阅，把套餐积分发到企业池
    // （幂等由 plan_credit_grant 唯一索引保证；企业停用期间跳过，恢复后按锚点补发）
    const { grantAllDueSubscriptions } = await import(
      "@/server/services/subscription-service"
    )
    const subscriptionPollInterval =
      Number(process.env.SUBSCRIPTION_POLL_INTERVAL_MS) || 60_000
    const subscriptionLoop = async (): Promise<void> => {
      while (running) {
        try {
          const results = await grantAllDueSubscriptions()
          for (const r of results) {
            const credits = r.results.reduce((s, g) => s + g.creditsGranted, 0)
            if (credits > 0) {
              console.log(
                `[worker:subscription] 企业 ${r.enterpriseId} 周期发放 ${credits} 积分（${r.results.length} 期）`,
              )
            }
          }
        } catch (err) {
          console.error(
            "[worker:subscription] 发放循环异常:",
            err instanceof Error ? err.message : err,
          )
        }
        await sleep(subscriptionPollInterval)
      }
    }

    await Promise.all([
      processQueueContinuous({ isRunning: () => running }),
      runLoop("chat", processChatQueueOnce),
      runLoop("agent", processAgentQueueOnce),
      agentRecoveryLoop(),
      runLoop("mockup", async () => {
        const r = await syncMockupJobs()
        return [{ processed: r.finalized, failed: 0 }]
      }),
      statusLoop(),
      subscriptionLoop(),
    ])

    console.log("[worker] 已停止")
    process.exit(0)
  } catch (err) {
    // 启动阶段（动态 import / 循环外）异常：记录后退出，由容器/守护重启
    console.error("[worker] 启动失败:", err)
    process.exit(1)
  }
})()
