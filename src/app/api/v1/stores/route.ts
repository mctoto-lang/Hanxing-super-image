import { NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { temuStores } from "@/db/schema"
import { getCurrentUserContext } from "@/lib/auth/session"

export const dynamic = "force-dynamic"

/**
 * 插件登录态接口：返回当前登录用户、所属企业与该企业的 Temu 店铺列表（含 deviceToken）。
 *
 * 供 Temu Collector 扩展登录（Auth.js session cookie，扩展侧先
 * /api/auth/csrf → /api/auth/callback/credentials）后同步店铺使用。
 * 企业归属链：登录用户 → 企业 → temu_store → 上报数据（X-Device-Token → store → enterprise）。
 * 超管/无企业归属的用户返回空店铺列表。
 */
export async function GET() {
  const ctx = await getCurrentUserContext()
  if (!ctx) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const user = {
    id: ctx.user.id,
    username: ctx.user.username,
    name: ctx.user.name,
  }

  if (!ctx.user.enterpriseId || !ctx.enterprise) {
    return NextResponse.json({ user, enterprise: null, stores: [] })
  }

  const rows = await db
    .select({
      id: temuStores.id,
      name: temuStores.name,
      deviceToken: temuStores.deviceToken,
      mallId: temuStores.mallId,
      mallName: temuStores.mallName,
      enabled: temuStores.enabled,
    })
    .from(temuStores)
    .where(eq(temuStores.enterpriseId, ctx.user.enterpriseId))
    .orderBy(temuStores.createdAt)

  return NextResponse.json({
    user,
    enterprise: { id: ctx.enterprise.id, name: ctx.enterprise.name },
    stores: rows,
  })
}
