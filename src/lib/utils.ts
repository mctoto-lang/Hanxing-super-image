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
    // 数据万象处理不了 SVG（imageMogr2 必失败），矢量图标不追加缩略参数
    if (opts?.width && !url.includes("imageMogr2") && !/\.svg(?:\?|#|$)/.test(url)) {
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

/**
 * 客户端随机 id（UUID v4）。
 * crypto.randomUUID 仅在安全上下文（HTTPS / localhost）与较新浏览器可用，
 * HTTP 线上环境为 undefined——曾导致图片库上传后乐观行构造抛错、成功上传被
 * 误报为失败；getRandomValues 在非安全上下文仍可用，作为一级回退。
 */
export function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    // RFC 4122：byte6 高半字节 version=4，byte8 高两位 variant=10
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 是否为 PSD 文件 URL（样机渲染的 PSD 源文件结果）。浏览器无法渲染
 * PSD，展示层应显示文件占位而非 <img>（SmartImage 会裂图）。
 */
export function isPsdUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return /\.psd(?:$|[?#])/i.test(url)
}

/**
 * 生成耗时（毫秒）：completedAt − startedAt；历史任务 startedAt 为空时
 * 回退 completedAt − createdAt（含排队时间）。未完成 / 数据缺失 / 差值为负
 * 返回 null（调用方不显示耗时）。
 */
export function generationDurationMs(input: {
  createdAt: Date | string | null
  startedAt?: Date | string | null
  completedAt?: Date | string | null
}): number | null {
  if (!input.completedAt) return null
  const end = new Date(input.completedAt).getTime()
  const startTs = input.startedAt ?? input.createdAt
  if (!startTs) return null
  const ms = end - new Date(startTs).getTime()
  return ms >= 0 ? ms : null
}

/**
 * 复制文本到剪贴板（成功返回 true）。
 * navigator.clipboard 仅安全上下文（HTTPS / localhost）可用，HTTP 线上为
 * undefined——复制按钮曾因此静默失效甚至假报「已复制」；execCommand('copy')
 * 非安全上下文仍可用（需在用户点击等手势内调用），作为兜底。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限被拒 / 文档失焦等：落入 execCommand 兜底
    }
  }
  if (typeof document === "undefined") return false
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    // 离屏但保持可渲染：display:none 在部分浏览器会导致复制失败
    ta.style.position = "fixed"
    ta.style.top = "-9999px"
    document.body.appendChild(ta)
    // 保留用户原选区，复制后还原
    const selection = document.getSelection()
    const prevRange =
      selection && selection.rangeCount > 0
        ? selection.getRangeAt(0)
        : null
    ta.select()
    // iOS Safari 需要 setSelectionRange 才会真正选中
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    if (selection && prevRange) {
      selection.removeAllRanges()
      selection.addRange(prevRange)
    }
    return ok
  } catch {
    return false
  }
}
