import { NextResponse } from "next/server"
import { auth } from "@/lib/auth/config"
import { requireUserContext, getCurrentEnterpriseScope } from "@/lib/auth/session"
import { loadStorageConfig } from "@/lib/storage/config"
import { createCosAdapter } from "@/lib/storage/cos"
import { safeImageExt } from "@/lib/storage/ext"

/**
 * 参考图上传预签名端点（客户端直传 COS，手册 §3）
 *
 * 流程：浏览器先请求本端点拿到预签名 PUT URL → 直接 PUT 到 COS 上传桶 ref/ 前缀。
 * 仅当 COS 配齐（凭证 + 上传桶）时返回预签名；否则返回 mode:local，
 * 由前端回退到 POST /api/upload（服务器转存，local 模式）。
 *
 * 鉴权 / 校验与 /api/upload 一致：仅登录用户、仅图片、单文件 ≤ 10MB。
 */
const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]

interface PresignBody {
  filename?: string
  contentType?: string
  size?: number
}

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

  const body = (await request.json().catch(() => ({}))) as PresignBody
  const contentType = body.contentType ?? ""
  const size = Number(body.size ?? 0)

  if (!ALLOWED_TYPES.includes(contentType)) {
    return new NextResponse("only images allowed", { status: 415 })
  }
  if (size <= 0) {
    return new NextResponse("invalid size", { status: 400 })
  }
  if (size > MAX_SIZE) {
    return new NextResponse("file too large (max 10MB)", { status: 413 })
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
}
