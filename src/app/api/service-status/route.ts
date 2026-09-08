import { NextResponse } from "next/server"
import { getCurrentUserContext } from "@/lib/auth/session"
import { getServiceStatusView } from "@/server/services/status-service"

/**
 * 服务可用性视图（侧边栏「服务可用性」弹窗）
 *
 * 返回当前企业的 PS-API（样机渲染服务）+ 平台自身（PostgreSQL/Redis）
 * 实时状态与最近 30 天历史。实时探测服务端缓存 60s（PS-API 按分钟限流），
 * 状态是数据而非错误——探测失败也返回 200 + status=down。
 */
export async function GET(request: Request) {
  const ctx = await getCurrentUserContext()
  if (!ctx?.user.enterpriseId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  // ?fresh=1：手动刷新时跳过 5 分钟实时缓存直接回源
  const force = new URL(request.url).searchParams.get("fresh") === "1"
  try {
    const view = await getServiceStatusView(ctx.user.enterpriseId, { force })
    return NextResponse.json(view, {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (err) {
    console.error("[service-status] 聚合视图获取失败:", err)
    return NextResponse.json({ error: "internal" }, { status: 500 })
  }
}
