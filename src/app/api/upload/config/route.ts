import { NextResponse } from "next/server"
import { requireUserContext } from "@/lib/auth/session"
import { getStorage } from "@/lib/storage"
import { safeImageExt } from "@/lib/storage/ext"
import { sanitizeSvg } from "@/lib/storage/svg"

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
 *
 * SVG 图标（模型图标常为矢量）三层防护下放行：
 * 1. 上传清洗：sanitizeSvg 剥离 script/事件属性/脚本 URL/foreignObject；
 * 2. 托管强制下载：存储层对 .svg 一律 Content-Disposition: attachment
 *    （直接导航变下载而非执行，<img> 渲染不受影响）——见 cos.ts
 *    saveFromBuffer 与 /uploads 路由 / 图片代理；
 * 3. 渲染层图标一律 <img> 标签（img 中的 SVG 不执行脚本）。
 */
const MAX_SIZE = 2 * 1024 * 1024 // 2MB
const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]

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

  let buffer = Buffer.from(await file.arrayBuffer())
  const ext = safeImageExt(file.name)

  // SVG：文本解码 → 剥离脚本类内容（清洗后必须有剩余 <svg 标记，否则拒绝）。
  // 触发条件取 MIME 与扩展名的并集：filename 声明 .svg 而 MIME 谎报为
  // png 的构造同样要清洗（扩展名决定落盘后的托管行为）
  if (file.type === "image/svg+xml" || ext === "svg") {
    const text = buffer.toString("utf8")
    const sanitized = sanitizeSvg(text)
    if (!/<svg[\s>]/i.test(sanitized)) {
      return new NextResponse("invalid svg", { status: 415 })
    }
    buffer = Buffer.from(sanitized, "utf8")
  }

  const storage = await getStorage()
  const url = await storage.saveFromBuffer(buffer, enterpriseId, ext, "config")

  return NextResponse.json({ url })
}
