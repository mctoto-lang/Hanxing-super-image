import { NextResponse } from "next/server"
import { sql } from "drizzle-orm"
import { db } from "@/db/client"
import { redis } from "@/lib/redis"

/**
 * 健康检查端点（手册 §8.3）
 *
 * 检查 PostgreSQL 连接 + Redis 连接。
 * docker-compose healthcheck 依赖此端点。
 */
export async function GET() {
  const checks: Record<string, "ok" | "fail"> = {
    postgres: "fail",
    redis: "fail",
  }

  try {
    await db.execute(sql`SELECT 1`)
    checks.postgres = "ok"
  } catch {
    // ignore
  }

  try {
    const pong = await redis.ping()
    if (pong === "PONG") checks.redis = "ok"
  } catch {
    // ignore
  }

  const ok = checks.postgres === "ok" && checks.redis === "ok"
  return NextResponse.json(
    { status: ok ? "healthy" : "degraded", checks },
    { status: ok ? 200 : 503 },
  )
}
