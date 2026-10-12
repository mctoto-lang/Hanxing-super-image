/**
 * data:image/...;base64,... URL 解码（模型 b64_json 回传转存用）。
 *
 * openai 格式模型常以 b64_json 返回图片，适配器拼成 data: URL 后交给
 * saveFromUrl 转存；data: 不是 https，会被下载域名白名单拒绝（“目标域名
 * 不在可信白名单内”）。data: URL 内容自包含、解码不经网络请求，无 SSRF
 * 面，直接走 saveFromBuffer 落盘。
 */

/** data: 图片可接受的最大解码体积（与两个存储适配器的下载体积上限一致） */
const MAX_DATA_URL_BYTES = 50 * 1024 * 1024

const DATA_IMAGE_URL_RE =
  /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/

/**
 * 解析 data: 图片 URL。
 * 非 data: 开头返回 null（调用方继续走正常的 URL 下载白名单流程）；
 * 是 data: 但格式非法 / 为空 / 超限时抛错（与下载失败文案对齐）。
 */
export function parseDataImageUrl(
  sourceUrl: string,
): { buffer: Buffer; ext: string } | null {
  if (!sourceUrl.startsWith("data:")) return null
  const m = sourceUrl.trim().match(DATA_IMAGE_URL_RE)
  if (!m) throw new Error("下载失败: 无效的 data: 图片 URL")
  const buffer = Buffer.from(m[2]!.replace(/\s+/g, ""), "base64")
  if (buffer.length === 0) throw new Error("下载失败: data: 图片内容为空")
  if (buffer.length > MAX_DATA_URL_BYTES) {
    throw new Error("下载失败: 超过最大体积限制")
  }
  const ext =
    m[1] === "webp" ? "webp" : m[1] === "gif" ? "gif" : m[1] === "png" ? "png" : "jpg"
  return { buffer, ext }
}
