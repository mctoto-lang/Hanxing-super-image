import { NextResponse } from "next/server"
import { auth } from "@/lib/auth/config"
import { requireUserContext, getCurrentEnterpriseScope } from "@/lib/auth/session"
import { saveFromBuffer } from "@/lib/storage/local"

/**
 * 文件上传端点（参考图，手册 §3）
 *
 * 限制：仅登录用户、仅图片、单文件 ≤ 10MB。
 * 路径遵循 §10.5 多租户规范：uploads/<enterpriseId>/image/...
 */
const MAX_SIZE = 10 * 1024 * 1024 // 10MB
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
  if (file.size > MAX_SIZE) {
    return new NextResponse("file too large (max 10MB)", { status: 413 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "png"
  const url = await saveFromBuffer(buffer, enterpriseId, ext, "image")

  return NextResponse.json({ url })
}
