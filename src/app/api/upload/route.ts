import { NextResponse } from "next/server"
import { auth } from "@/lib/auth/config"
import { requireUserContext, getCurrentEnterpriseScope } from "@/lib/auth/session"
import { apiError, withRouteHandler } from "@/lib/api/route-helpers"
import { getStorage } from "@/lib/storage"
import { safeImageExt } from "@/lib/storage/ext"
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_MESSAGE,
} from "@/lib/upload/limits"

/**
 * 文件上传端点（参考图，手册 §3）
 *
 * 限制：仅登录用户、仅图片、单文件 ≤ 20MB。
 * 路径遵循 §10.5 多租户规范：uploads/<enterpriseId>/image/...
 */
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

  const formData = await request.formData()
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return apiError("no file", 400)
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type as (typeof ALLOWED_IMAGE_TYPES)[number])) {
    return apiError("only images allowed", 415)
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return apiError(MAX_IMAGE_UPLOAD_MESSAGE, 413)
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const ext = safeImageExt(file.name)
  const storage = await getStorage()
  const url = await storage.saveFromBuffer(buffer, enterpriseId, ext, "reference")

  return NextResponse.json({ url })
})
