import { NextResponse } from "next/server"
import { env } from "@/lib/env"
import { safeEqual } from "@/lib/crypto"
import { processChatQueueOnce } from "@/lib/queue/chat-processor"

/**
 * 对话任务队列消费者入口（手册 §5.6、M5）
 *
 * 消费逻辑抽取在 `src/lib/queue/chat-processor.ts` 的 `processChatQueueOnce()`，
 * 供本路由与独立 worker 进程（`scripts/worker.ts`）共用。本路由保留为：
 *   - 手动触发（开发期 curl 验证）
 *   - 外部 cron / supercronic 兜底触发（无独立 worker 时）
 *
 * 安全：CRON_SECRET Bearer token 守卫（常量时间比较，防时序攻击）。
 */
export async function POST(request: Request) {
  // Bearer token 校验（常量时间比较，防时序攻击）
  const auth = request.headers.get("authorization")
  if (!env.CRON_SECRET || !auth || !safeEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const results = await processChatQueueOnce()
  return NextResponse.json({ ok: true, results })
}
