import { NextResponse } from "next/server"
import {
  getCurrentEnterpriseScope,
  requireEnterpriseContext,
} from "@/lib/auth/session"
import { checkModuleAccess, isEnterpriseAdmin } from "@/lib/auth/permissions"
import {
  MockupApiError,
  createTemplateUploadUrl,
  parsePsdTemplate,
  putUploadBytes,
  type ExternalLayerNode,
  type MockupUserContext,
} from "@/lib/mockup/client"
import { loadMockupConfig } from "@/lib/mockup/settings"
import { MAX_PSD_UPLOAD_BYTES } from "@/lib/mockup/limits"
import { invalidateTemplateListCache } from "@/server/services/mockup-template-cache"

export const dynamic = "force-dynamic"

/**
 * PSD 小模板上传（预签名票据 → PUT 文件字节 → 触发解析），原为 Server Action。
 *
 * 改走 Route Handler 的原因：PSD 文件大（上限 300MB，对齐 PS-API
 * /v1/templates/upload-url 的 sizeBytes 上限），Server Action 即便调大
 * experimental.serverActions.bodySizeLimit，dev 下 multipart 流仍会被
 * 截断报 "Unexpected end of form"；路由侧 request.formData() 走 Web Streams，
 * 与 /api/upload（≤20MB 图片）同一链路，无此限制。
 *
 * 返回结构与原 uploadPsdTemplateAction 保持一致，前端仅换调用入口。
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
    return NextResponse.json(
      {
        ok: false,
        error: "无权访问样机模块",
        templateId: null,
        templateVersionId: null,
        canvasWidth: null,
        canvasHeight: null,
        layerTree: [],
      },
      { status: 403 },
    )
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) {
    return NextResponse.json(
      {
        ok: false,
        error: "样机渲染服务未配置",
        templateId: null,
        templateVersionId: null,
        canvasWidth: null,
        canvasHeight: null,
        layerTree: [],
      },
      { status: 503 },
    )
  }

  const formData = await request.formData()
  const file = formData.get("file")
  const name = formData.get("name")
  const visibilityRaw = formData.get("visibility")
  const visibility: "public" | "private" =
    visibilityRaw === "private" ? "private" : "public"
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "请选择 PSD 文件",
        templateId: null,
        templateVersionId: null,
        canvasWidth: null,
        canvasHeight: null,
        layerTree: [],
      },
      { status: 400 },
    )
  }
  if (file.size > MAX_PSD_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: "PSD 文件过大，上限 300MB",
        templateId: null,
        templateVersionId: null,
        canvasWidth: null,
        canvasHeight: null,
        layerTree: [],
      },
      { status: 413 },
    )
  }
  const templateName =
    typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : file.name.replace(/\.psd$/i, "")

  const mockupUserCtx: MockupUserContext = {
    id: ctx.user.id,
    admin: isEnterpriseAdmin(ctx),
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer())
    const ticket = await createTemplateUploadUrl(cfg, {
      fileName: `template-${Date.now()}.psd`,
      sizeBytes: bytes.length,
    })
    await putUploadBytes(cfg, ticket, bytes)
    const parsed = await parsePsdTemplate(
      cfg,
      {
        objectKey: ticket.objectKey,
        name: templateName,
        visibility,
      },
      mockupUserCtx,
    )
    invalidateTemplateListCache(scope.enterpriseId)
    return NextResponse.json({
      ok: true,
      error: null,
      templateId: parsed.templateId,
      templateVersionId: parsed.templateVersionId,
      canvasWidth: parsed.canvas?.width ?? null,
      canvasHeight: parsed.canvas?.height ?? null,
      layerTree: (parsed.layerTree ?? []) as ExternalLayerNode[],
    })
  } catch (err) {
    const error =
      err instanceof MockupApiError
        ? err.message
        : err instanceof Error && err.message
          ? err.message
          : "PSD 上传解析失败"
    return NextResponse.json(
      {
        ok: false,
        error,
        templateId: null,
        templateVersionId: null,
        canvasWidth: null,
        canvasHeight: null,
        layerTree: [],
      },
      { status: 502 },
    )
  }
}
