import { NextResponse } from "next/server"
import { getCurrentUserContext } from "@/lib/auth/session"
import { fetchTemplateThumbnail } from "@/lib/mockup/client"
import { loadMockupConfig } from "@/lib/mockup/settings"

/**
 * 模板缩略图代理
 *
 * 外部渲染服务的模板缩略图需要 API Key 才能访问，浏览器 <img> 无法直连；
 * 此处按当前企业的渲染服务配置代理拉取。外部无该模板/无缩略图时 404，
 * 前端降级为占位图标。
 */
export async function GET(request: Request) {
  const ctx = await getCurrentUserContext()
  if (!ctx?.user.enterpriseId) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const templateId = new URL(request.url).searchParams.get("templateId")
  // 外部模板 ID 实际为 cuid（文档写 tpl_ 前缀，实测无前缀），宽松放行字母数字
  if (!templateId || !/^[a-zA-Z0-9_-]{1,64}$/.test(templateId)) {
    return new NextResponse("bad request", { status: 400 })
  }

  const cfg = await loadMockupConfig(ctx.user.enterpriseId)
  if (!cfg) {
    return new NextResponse("not found", { status: 404 })
  }
  // 非公开模板仅归属人/企业管理员可看缩略图（X-User-Id/X-User-Admin 透传）
  const user = {
    id: ctx.user.id,
    admin:
      ctx.user.enterpriseRole === "owner" ||
      ctx.user.enterpriseRole === "admin",
  }

  try {
    const upstream = await fetchTemplateThumbnail(cfg, templateId, user)
    if (!upstream.ok || !upstream.body) {
      return new NextResponse("not found", { status: 404 })
    }
    return new NextResponse(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/png",
        "Cache-Control": "private, max-age=600",
      },
    })
  } catch {
    return new NextResponse("upstream error", { status: 502 })
  }
}
