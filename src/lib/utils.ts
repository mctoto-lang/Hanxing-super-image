import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 将图片 URL 转为可访问的 src（防 SSRF + 加宽高参数）。
 *
 * - 本地 /uploads/、/api/、data: 直接返回
 * - 腾讯云 COS（*.myqcloud.com）直接返回 → 浏览器直连，绕过 /api/image/proxy 省带宽；
 *   指定 width 时追加数据万象 imageMogr2 缩放参数（缩略图不过服务器；
 *   桶未开通 CI 时由 SmartImage onError 自动降级回原图）
 * - 其它远程 URL 走 /api/image/proxy 代理
 */
export function toImageSrc(
  url: string | null | undefined,
  opts?: { width?: number; height?: number },
): string {
  if (!url) return ""
  // 本地上传路径（/uploads/...）直接返回
  if (url.startsWith("/uploads/") || url.startsWith("/api/")) return url
  // data: URL 直接返回
  if (url.startsWith("data:")) return url
  // 腾讯云 COS 双桶域名直连（参考图桶 / 生成图桶均为 *.myqcloud.com）
  if (url.includes(".myqcloud.com/")) {
    if (opts?.width && !url.includes("imageMogr2")) {
      const sep = url.includes("?") ? "&" : "?"
      // width 定宽等比缩放：thumbnail/400x → 宽 ≤400px，高按比例
      return `${url}${sep}imageMogr2/thumbnail/${opts.width}x`
    }
    return url
  }
  // 其它远程 URL 走代理
  const proxyBase = "/api/image/proxy"
  const params = new URLSearchParams({ url })
  if (opts?.width) params.set("width", String(opts.width))
  if (opts?.height) params.set("height", String(opts.height))
  return `${proxyBase}?${params.toString()}`
}

/**
 * 去掉 toImageSrc 追加的 COS 缩略参数（imageMogr2 段至末尾）。
 * 供图片加载失败时降级回原图（桶未开通数据万象等场景）。
 */
export function stripCosThumbnail(src: string): string {
  const idx = src.indexOf("imageMogr2")
  if (idx === -1) return src
  return src.slice(0, idx).replace(/[?&]\s*$/, "")
}
