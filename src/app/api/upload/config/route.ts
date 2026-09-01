import { NextResponse } from "next/server"
import { requireUserContext } from "@/lib/auth/session"
import { getStorage } from "@/lib/storage"
import { safeImageExt } from "@/lib/storage/ext"

/**
 * 配置图上传端点（模型图标 / logo / 模板图，手册 §3、§10.5）
 *
 * 与 /api/upload（参考图，按企业隔离、会过期）的区别：
 * - category=config → COS 进 config/ 前缀（不过期，生命周期不清理）；
 *   本地模式落到 uploads/<eid>/image/（由反向代理托管）。
 * - 允许平台超管（无企业归属）上传：enterpriseId 回退 "_platform"。
 * - 仅限超管 / 企业管理员（模型表单才需要）。
 *
 * 限制：仅图片、单文件 ≤ 2MB（图标为小图）。
 */
const MAX_SIZE = 2 * 1024 * 1024 // 2MB
// 不允许 SVG：内联渲染时可携带脚本（存储型 XSS）；需要 SVG 图标可填外部 URL
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireUserContext()
  } catch {
    return new NextResponse("unauthorized", { status: 401 })
  }

  // 仅超管 / 企业管理员可上传配置图
  const isSuperAdmin = ctx.user.isSuperAdmin
  const isEntAdmin =
    !!ctx.enterprise &&
    (ctx.user.enterpriseRole === "owner" ||
      ctx.user.enterpriseRole === "admin")
  if (!isSuperAdmin && !isEntAdmin) {
    return new NextResponse("forbidden", { status: 403 })
  }

  // 超管无企业 → 用 "_platform" 占位前缀；企业管理员用本企业 id
  const enterpriseId = ctx.user.enterpriseId ?? "_platform"

  const formData = await request.formData()
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return new NextResponse("no file", { status: 400 })
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return new NextResponse("only images allowed", { status: 415 })
  }
  if (file.size > MAX_SIZE) {
    return new NextResponse("file too large (max 2MB)", { status: 413 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const ext = safeImageExt(file.name)
  const storage = await getStorage()
  const url = await storage.saveFromBuffer(buffer, enterpriseId, ext, "config")

  return NextResponse.json({ url })
}
