import { eq, sql } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/db/client"
import { temuStores, temuIngestLogs } from "@/db/schema"

export const dynamic = "force-dynamic"

/**
 * Temu Collector 插件文件上报端点（导出 Excel/CSV 的 base64）
 *
 * v1 仅审计留痕（记录 filename/contentType/byteLength，dataB64 不落库——
 * 项目暂无 xlsx 解析依赖，CSV 已在插件侧解析走 /api/v1/ingest 的
 * export-file 通道；后续如需服务端解析 xlsx 再引入依赖迭代）。
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-Token",
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(request: Request) {
  const token = request.headers.get("x-device-token") ?? ""
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing token" }, { status: 401, headers: CORS_HEADERS })
  }
  const [store] = await db.select().from(temuStores).where(eq(temuStores.deviceToken, token)).limit(1)
  if (!store) {
    return NextResponse.json({ ok: false, error: "bad token" }, { status: 401, headers: CORS_HEADERS })
  }
  if (!store.enabled) {
    return NextResponse.json({ ok: false, error: "store disabled" }, { status: 403, headers: CORS_HEADERS })
  }

  let body: {
    deviceTime?: number
    storeId?: string | null
    page?: string
    capturedAt?: number
    meta?: { url?: string; contentType?: string; byteLength?: number; filename?: string }
    dataB64?: string
  }
  try {
    // 不解析 dataB64 内容，只读元信息；body 限制 16MB（base64 后最大文件 ~11MB）
    const raw = await request.text()
    if (raw.length > 16 * 1024 * 1024) {
      return NextResponse.json({ ok: false, error: "body too large" }, { status: 413, headers: CORS_HEADERS })
    }
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ ok: false, error: "bad payload" }, { status: 400, headers: CORS_HEADERS })
  }

  await Promise.all([
    db.update(temuStores).set({ lastSeenAt: sql`now()` }).where(eq(temuStores.id, store.id)),
    db.insert(temuIngestLogs).values({
      storeId: store.id,
      source: "export-file",
      itemCount: 1,
      acceptedCount: 0,
      detail: {
        filename: body.meta?.filename?.slice(0, 200) ?? null,
        contentType: body.meta?.contentType ?? null,
        byteLength: body.meta?.byteLength ?? null,
        page: body.page?.slice(0, 300) ?? null,
        note: "v1 audit-only",
      },
    }),
  ])

  return NextResponse.json({ ok: true, stored: false, parsed: false }, { headers: CORS_HEADERS })
}
