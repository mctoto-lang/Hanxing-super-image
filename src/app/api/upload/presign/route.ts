import { NextResponse } from "next/server"
import { auth } from "@/lib/auth/config"
import { requireUserContext, getCurrentEnterpriseScope } from "@/lib/auth/session"
import { apiError, withRouteHandler } from "@/lib/api/route-helpers"
import { loadStorageConfig } from "@/lib/storage/config"
import { createCosAdapter } from "@/lib/storage/cos"
import { safeImageExt } from "@/lib/storage/ext"
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_MESSAGE,
} from "@/lib/upload/limits"

/**
 * 参考图上传预签名端点（客户端直传 COS，手册 §3）
 *
 * 流程：浏览器先请求本端点拿到预签名 PUT URL → 直接 PUT 到 COS 上传桶 ref/ 前缀。
 * 仅当 COS 配齐（凭证 + 上传桶）时返回预签名；否则返回 mode:local，
 * 由前端回退到 POST /api/upload（服务器转存，local 模式）。
 *
 * 鉴权 / 校验与 /api/upload 一致：仅登录用户、仅图片、单文件 ≤ 20MB。
 */
interface PresignBody {
  filename?: string
  contentType?: string
  size?: number
}

export const POST = withRouteHandler(async (request: Request) => {
  const session = await auth()
  if (!session?.user?.id) {
    return apiError("unauthorized", 401)
  }
  const ctx = await requireUserContext()
  if (!ctx.enterprise) {
    return apiError("no enterprise", 403)
  }
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  const body = (await request.json().catch(() => ({}))) as PresignBody
  const contentType = body.contentType ?? ""
  const size = Number(body.size ?? 0)

  if (!ALLOWED_IMAGE_TYPES.includes(contentType as (typeof ALLOWED_IMAGE_TYPES)[number])) {
    return apiError("only images allowed", 415)
  }
  if (size <= 0) {
    return apiError("invalid size", 400)
  }
  if (size > MAX_IMAGE_UPLOAD_BYTES) {
    return apiError(MAX_IMAGE_UPLOAD_MESSAGE, 413)
  }

  const ext = safeImageExt(body.filename)
  const cfg = await loadStorageConfig()

  // 仅当 COS 配齐（凭证 + 桶名）时启用客户端直传；否则前端回退服务器上传
  const cosReady = Boolean(
    cfg.provider === "cos" &&
      cfg.cosSecretId &&
      cfg.cosSecretKey &&
      cfg.cosRegion &&
      cfg.cosBucket,
  )

  if (cosReady) {
    const adapter = createCosAdapter(cfg)
    const { presignedUrl, finalUrl, key } = await adapter.presignPut(
      enterpriseId,
      ext,
      "reference",
      contentType,
      size,
    )
    return NextResponse.json({
      mode: "cos" as const,
      presignedUrl,
      finalUrl,
      key,
      contentType,
    })
  }

  // provider=local 或 COS 未配齐 → 前端走 POST /api/upload
  return NextResponse.json({ mode: "local" as const })
})
