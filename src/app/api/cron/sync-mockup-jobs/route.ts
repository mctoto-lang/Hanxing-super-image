import { NextResponse } from "next/server"
import { env } from "@/lib/env"
import { safeEqual } from "@/lib/crypto"
import { syncMockupJobs } from "@/server/services/mockup-service"

/**
 * 样机渲染任务同步入口（cron 兜底）
 *
 * 常规驱动是独立 worker（scripts/worker.ts 的 mockup 循环，5s 间隔）；
 * 本路由供外部 cron / supercronic 兜底触发（无独立 worker 的部署）。
 * 安全：CRON_SECRET Bearer token 守卫（常量时间比较）。
 */
export async function POST(request: Request) {
  const auth = request.headers.get("authorization")
  if (!env.CRON_SECRET || !auth || !safeEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const result = await syncMockupJobs()
  return NextResponse.json({ ok: true, ...result })
}
