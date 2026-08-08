import { NextResponse } from "next/server"
import { env } from "@/lib/env"

/**
 * 图片代理（手册 §10.7 防 SSRF）
 *
 * 校验目标 host 白名单（本应用域名 + COS 域名），防止 SSRF。
 */

function isAllowedHost(url: URL): boolean {
  const appUrl = new URL(env.NEXT_PUBLIC_APP_URL)
  // 同源
  if (url.host === appUrl.host) return true
  // COS 域名
  if (env.COS_BASE_URL) {
    try {
      const cosUrl = new URL(env.COS_BASE_URL)
      if (url.host === cosUrl.host) return true
      // COS 桶域名通常含 bucket 名 + myqcloud.com
      if (
        url.hostname.endsWith(".myqcloud.com") &&
        env.COS_BUCKET &&
        url.hostname.startsWith(env.COS_BUCKET)
      ) {
        return true
      }
    } catch {
      // ignore
    }
  }
  return false
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const target = searchParams.get("url")
  if (!target) {
    return new NextResponse("missing url", { status: 400 })
  }

  let targetUrl: URL
  try {
    targetUrl = new URL(target)
  } catch {
    return new NextResponse("invalid url", { status: 400 })
  }

  // 仅允许 https（防内网探测）
  if (targetUrl.protocol !== "https:") {
    return new NextResponse("only https allowed", { status: 403 })
  }

  if (!isAllowedHost(targetUrl)) {
    return new NextResponse("host not allowed (SSRF protection)", {
      status: 403,
    })
  }

  try {
    const resp = await fetch(targetUrl, {
      // 防止后端服务挂起
      signal: AbortSignal.timeout(15_000),
    })
    if (!resp.ok) {
      return new NextResponse(`upstream ${resp.status}`, {
        status: resp.status,
      })
    }
    const buffer = Buffer.from(await resp.arrayBuffer())
    const contentType =
      resp.headers.get("content-type") ?? "image/png"
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    })
  } catch {
    return new NextResponse("fetch failed", { status: 502 })
  }
}
