import { promises as fs } from "node:fs"
import { auth } from "@/lib/auth/config"
import { env } from "@/lib/env"
import { getLocalPath } from "@/lib/storage/local"
import { verifyUploadToken } from "@/lib/storage/upload-token"

/**
 * 本地存储模式的 /uploads 静态托管（COS 模式不经此路由，图片直连 COS）。
 *
 * 此前本地模式返回的图片 URL 没有任何 serving 机制（Next standalone 只托管
 * public/），图片一律 404。本路由补齐托管，并保持存储层的安全约束：
 *   - 路径经 getLocalPath 困在 uploads 根内（防穿越，越界 404）；
 *   - 仅放行白名单图片扩展名并按扩展名设置 Content-Type（拒绝 html/svg 等，
 *     从根本上杜绝把用户上传内容当同源脚本执行的存储型 XSS）；
 *   - 文件名为 UUID 不可变，长缓存 + immutable。
 *
 * 鉴权（登录会话 或 短时效 HMAC 令牌，二选一）：
 *   - 浏览器 <img> 同源请求自带会话 cookie，走会话校验（不再「URL 泄露
 *     即永久可访问」）；
 *   - 无法带 cookie 的机器消费方（上游 AI 拉参考图 / 导出打包 / 样机设计稿
 *     中转 / 图片代理回源）由调用方在 fetch 前用 signUploadToken 追加
 *     ?e&s 令牌（默认 15 分钟）；
 *   - 宽限期：UPLOADS_UNSIGNED_GRACE_END（ISO 日期）之前无签名访问仍放行
 *     （低频告警计数），到期后强制 401。未配置视为宽限中——上线收紧由
 *     运维显式设置日期驱动。
 */

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
}

export const dynamic = "force-dynamic"

/** 宽限期无签名访问的低频告警计数（每 200 次打一条，避免日志刷屏） */
let unsignedHits = 0

function unsignedGraceEndMs(): number | null {
  const raw = env.UPLOADS_UNSIGNED_GRACE_END
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : null
}

async function authorized(
  req: Request,
  pathname: string,
): Promise<{ ok: true } | { ok: false; status: 401 }> {
  // 1) 短时效令牌（机器消费方）
  const { searchParams } = new URL(req.url)
  if (verifyUploadToken(pathname, searchParams)) return { ok: true }
  // 2) 登录会话（浏览器同源 <img> 自带 cookie）
  const session = await auth()
  if (session?.user) return { ok: true }
  // 3) 宽限期放行无签名访问（到期后 fail-closed）
  const graceEnd = unsignedGraceEndMs()
  if (graceEnd === null || Date.now() < graceEnd) {
    unsignedHits++
    if (unsignedHits === 1 || unsignedHits % 200 === 0) {
      console.warn(
        `[uploads] 无签名访问仍在宽限期内放行（第 ${unsignedHits} 次；` +
          `设置 UPLOADS_UNSIGNED_GRACE_END 为已过去日期可立即收紧）path=${pathname}`,
      )
    }
    return { ok: true }
  }
  return { ok: false, status: 401 }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await ctx.params

  const filename = segments[segments.length - 1] ?? ""
  const ext = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : ""
  const contentType = CONTENT_TYPES[ext]
  if (!contentType) return new Response("not found", { status: 404 })

  const pathname = `/uploads/${segments.join("/")}`

  const authz = await authorized(req, pathname)
  if (!authz.ok) return new Response("unauthorized", { status: authz.status })

  // getLocalPath 内部 resolve 并困在 UPLOAD_ROOT 内，越界（含 .. 段）→ 404
  const abs = getLocalPath(pathname)
  if (!abs) return new Response("not found", { status: 404 })

  try {
    const data = await fs.readFile(abs)
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch {
    return new Response("not found", { status: 404 })
  }
}
