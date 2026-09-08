import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "@/lib/env"

/**
 * /uploads 机器取图令牌（HMAC-SHA256，密钥复用 ENCRYPTION_KEY）。
 *
 * 背景：本地存储模式的 /uploads 路由已从「能力 URL（永久公开）」收紧为
 * 「登录会话 或 有效令牌」二选一。浏览器 <img> 同源自带会话 cookie；无法
 * 带 cookie 的机器消费方（上游 AI 拉参考图、导出 ZIP 打包、样机设计稿
 * 中转、图片代理服务端回源）由调用方在发起 fetch 前用 signUploadToken
 * 给本站 /uploads URL 追加短时效令牌。
 *
 * 令牌形如 ?e=<unix秒>&s=<hex(pathname:e)>，默认 15 分钟——机器链路均为
 * 分钟级完成，远短于令牌寿命；COS / 外域 URL 原样返回（桶仍为公有读，
 * 私有化在桶策略专项中处理）。
 */

/** 机器取图令牌默认有效期（秒） */
export const UPLOAD_TOKEN_TTL_SEC = 15 * 60

function mac(pathname: string, expiresAt: number): string {
  return createHmac("sha256", env.ENCRYPTION_KEY)
    .update(`${pathname}:${expiresAt}`)
    .digest("hex")
}

/** URL 是否指向本应用托管的 /uploads 对象 */
function isOwnUploadsUrl(url: URL): boolean {
  let app: URL | null = null
  try {
    app = new URL(env.NEXT_PUBLIC_APP_URL)
  } catch {
    return false
  }
  return url.host === app.host && url.pathname.startsWith("/uploads/")
}

/**
 * 给本站 /uploads URL 追加短时效令牌；其它 URL（COS、外域、data:）原样返回。
 * 接受绝对或相对（以 NEXT_PUBLIC_APP_URL 为基）URL；解析失败原样返回。
 */
export function signUploadToken(
  rawUrl: string,
  ttlSec: number = UPLOAD_TOKEN_TTL_SEC,
): string {
  let base: string
  try {
    base = env.NEXT_PUBLIC_APP_URL
  } catch {
    return rawUrl
  }
  try {
    const url = new URL(rawUrl, base)
    if (!isOwnUploadsUrl(url)) return rawUrl
    const e = Math.floor(Date.now() / 1000) + Math.max(60, ttlSec)
    url.searchParams.set("e", String(e))
    url.searchParams.set("s", mac(url.pathname, e))
    return url.toString()
  } catch {
    return rawUrl
  }
}

/** 校验请求令牌：未过期且 HMAC 匹配（恒定时间比较） */
export function verifyUploadToken(
  pathname: string,
  searchParams: URLSearchParams,
): boolean {
  const e = Number(searchParams.get("e"))
  const s = searchParams.get("s") ?? ""
  if (!Number.isInteger(e) || e < Math.floor(Date.now() / 1000)) return false
  const expected = mac(pathname, e)
  if (expected.length !== s.length) return false
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(s, "utf8"))
}
