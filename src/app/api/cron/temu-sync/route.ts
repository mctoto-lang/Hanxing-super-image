import { NextResponse } from "next/server"
import { env } from "@/lib/env"
import { safeEqual } from "@/lib/crypto"
import { syncDueStores } from "@/server/services/temu-sync"

/**
 * TEMU 官方 API 数据同步入口（cron 兜底）
 *
 * 常规驱动是独立 worker（scripts/worker.ts 的 temu-sync 循环，默认 15 分钟）；
 * 本路由供外部 cron / supercronic 兜底触发（无独立 worker 的部署）。
 * 安全：CRON_SECRET Bearer token 守卫（常量时间比较）。
 */
export async function POST(request: Request) {
  const auth = request.headers.get("authorization")
  if (!env.CRON_SECRET || !auth || !safeEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const interval = Number(process.env.TEMU_SYNC_INTERVAL_MS) || 15 * 60 * 1000
  const outcomes = await syncDueStores(interval)
  return NextResponse.json({
    ok: true,
    synced: outcomes.length,
    outcomes: outcomes.map((o) => ({
      storeId: o.storeId,
      skipped: o.skipped ?? null,
      ok: o.status?.ok ?? null,
    })),
  })
}
