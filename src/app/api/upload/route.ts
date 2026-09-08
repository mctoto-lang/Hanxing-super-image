import { NextResponse } from "next/server"
import { auth } from "@/lib/auth/config"
import { requireUserContext, getCurrentEnterpriseScope } from "@/lib/auth/session"
import { getStorage } from "@/lib/storage"
import { safeImageExt } from "@/lib/storage/ext"
import { MAX_IMAGE_UPLOAD_BYTES, MAX_IMAGE_UPLOAD_MESSAGE } from "@/lib/upload/limits"

/**
 * 文件上传端点（参考图，手册 §3）
 *
 * 限制：仅登录用户、仅图片、单文件 ≤ 20MB。
 * 路径遵循 §10.5 多租户规范：uploads/<enterpriseId>/image/...
 */
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse("unauthorized", { status: 401 })
  }
  const ctx = await requireUserContext()
  if (!ctx.enterprise) {
    return new NextResponse("no enterprise", { status: 403 })
  }
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)

  const formData = await request.formData()
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return new NextResponse("no file", { status: 400 })
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return new NextResponse("only images allowed", { status: 415 })
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return new NextResponse(MAX_IMAGE_UPLOAD_MESSAGE, { status: 413 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const ext = safeImageExt(file.name)
  const storage = await getStorage()
  const url = await storage.saveFromBuffer(buffer, enterpriseId, ext, "reference")

  return NextResponse.json({ url })
}
