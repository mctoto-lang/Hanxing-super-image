import { NextResponse } from "next/server"
import {
  getCurrentEnterpriseScope,
  requireEnterpriseContext,
} from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import { MockupApiError, uploadFont } from "@/lib/mockup/client"
import { loadMockupConfig } from "@/lib/mockup/settings"
import { MAX_FONT_UPLOAD_BYTES } from "@/lib/mockup/limits"

export const dynamic = "force-dynamic"

/**
 * 字体上传（全局共享字体库），转发 PS-API POST /v1/fonts/upload。
 *
 * 走 Route Handler 而非 Server Action 的原因与 psd-upload 相同：大文件
 * multipart 在 Server Action 链路会被截断（proxy 层 10MB 缓冲上限），
 * 本路由已从 proxy matcher 排除，50MB 直通。
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireEnterpriseContext()
  } catch (err) {
    const msg = err instanceof Error ? err.message : ""
    return NextResponse.json({ ok: false, error: msg || "未登录" }, {
      status: msg.startsWith("UNAUTHORIZED") ? 401 : 403,
    })
  }
  if (checkModuleAccess(ctx, "mockup")) {
    return NextResponse.json({ ok: false, error: "无权访问样机模块" }, { status: 403 })
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) {
    return NextResponse.json({ ok: false, error: "样机渲染服务未配置" }, { status: 503 })
  }

  const formData = await request.formData()
  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ ok: false, error: "请选择字体文件" }, { status: 400 })
  }
  if (!/\.(ttf|otf|ttc)$/i.test(file.name)) {
    return NextResponse.json(
      { ok: false, error: "仅支持 .ttf / .otf / .ttc 字体文件" },
      { status: 400 },
    )
  }
  if (file.size > MAX_FONT_UPLOAD_BYTES) {
    return NextResponse.json(
      { ok: false, error: "字体文件过大，上限 50MB" },
      { status: 413 },
    )
  }

  try {
    const result = await uploadFont(cfg, {
      fileName: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
    })
    if (!result.installed) {
      // 已注册但本机安装失败：字体仍可通过 Worker 同步安装，提示不阻断
      console.warn("[font-upload] 本机安装失败:", result.installMessage)
    }
    return NextResponse.json({ ok: true, error: null, font: result })
  } catch (err) {
    const error =
      err instanceof MockupApiError
        ? err.message
        : err instanceof Error && err.message
          ? err.message
          : "字体上传失败"
    return NextResponse.json({ ok: false, error }, { status: 502 })
  }
}
