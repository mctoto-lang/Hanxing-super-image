import { toImageSrc } from "@/lib/utils"

/**
 * TEMU 商品图展示 src：转存 URL（COS/本地，temu/ 前缀）优先；未转存或转存
 * 失败时回落 kwcdn 外链直连。
 *
 * - 转存 URL 走 toImageSrc：COS（*.myqcloud.com）浏览器直连，可按需加数据
 *   万象 imageMogr2 缩放参数（本处调用均为裸 <img>、无 SmartImage 降级，
 *   暂不传 width——桶未开通 CI 时带参会直接裂图；本地 /uploads 原样返回）
 * - kwcdn 外链**不走** /api/image/proxy（不在代理白名单），维持直连现状
 */
export function temuImageSrc(
  cosUrl: string | null | undefined,
  sourceUrl: string | null | undefined,
  opts?: { width?: number },
): string {
  if (cosUrl) return toImageSrc(cosUrl, opts)
  return sourceUrl ?? ""
}
