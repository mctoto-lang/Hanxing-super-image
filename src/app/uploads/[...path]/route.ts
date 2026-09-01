import { promises as fs } from "node:fs"
import { getLocalPath } from "@/lib/storage/local"

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
 * 鉴权遵循既有设计：proxy.ts 对 /uploads 放行（UUID 即能力令牌），
 * 租户隔离在上传/引用环节已保证（对象 key 强制含企业 ID 段）。
 */

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
}

export const dynamic = "force-dynamic"

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await ctx.params

  const filename = segments[segments.length - 1] ?? ""
  const ext = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : ""
  const contentType = CONTENT_TYPES[ext]
  if (!contentType) return new Response("not found", { status: 404 })

  // getLocalPath 内部 resolve 并困在 UPLOAD_ROOT 内，越界（含 .. 段）→ 404
  const abs = getLocalPath(`/uploads/${segments.join("/")}`)
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
