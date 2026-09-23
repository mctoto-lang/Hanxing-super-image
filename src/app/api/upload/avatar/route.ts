import { NextResponse } from "next/server"
import { requireUserContext } from "@/lib/auth/session"
import { apiError, withRouteHandler } from "@/lib/api/route-helpers"
import { getStorage } from "@/lib/storage"
import { safeImageExt } from "@/lib/storage/ext"
import { ALLOWED_IMAGE_TYPES } from "@/lib/upload/limits"

/**
 * 头像上传端点（用户头像，落 users.image）
 *
 * 与 /api/upload/config 的区别：
 * - 任何登录用户都可上传自己的头像（config 仅超管/企业管理员）；
 * - 同样使用 category=config（不过期，不被 cleanup 清理）；
 * - 超管无企业归属时目录回退 "_platform"。
 *
 * 限制：仅图片、单文件 ≤ 2MB。
 */
const MAX_SIZE = 2 * 1024 * 1024 // 2MB

export const POST = withRouteHandler(async (request: Request) => {
  let ctx
  try {
    ctx = await requireUserContext()
  } catch {
    return apiError("unauthorized", 401)
  }

  const enterpriseId = ctx.user.enterpriseId ?? "_platform"

  const formData = await request.formData()
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return apiError("no file", 400)
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type as (typeof ALLOWED_IMAGE_TYPES)[number])) {
    return apiError("only images allowed", 415)
  }
  if (file.size > MAX_SIZE) {
    return apiError("file too large (max 2MB)", 413)
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const ext = safeImageExt(file.name)
  const storage = await getStorage()
  const url = await storage.saveFromBuffer(buffer, enterpriseId, ext, "config")

  return NextResponse.json({ url })
})
