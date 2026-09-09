/**
 * 上传文件扩展名安全提取（白名单）
 *
 * multipart 声明的 filename 不可信：直接取末段作为扩展名会产出 html
 * 等任意扩展名（内容又是任意字节），落盘后经 /uploads 同源托管即成为
 * 存储型 XSS 载体。这里强制图片扩展名白名单，不匹配一律回落 png。
 *
 * svg 仅对配置图（/api/upload/config）开放：上传前经 sanitizeSvg 清洗、
 * 托管时强制 Content-Disposition: attachment（导航变下载不执行）；
 * 参考图 / 头像端点在上游按 MIME 拒绝 svg，不会走到这里的 "svg" 分支。
 */
const ALLOWED_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg"])

export type SafeImageExt = "jpg" | "png" | "webp" | "gif" | "svg"

export function safeImageExt(
  filename: string | undefined | null,
): SafeImageExt {
  const last = filename?.split(".").pop()?.toLowerCase() ?? ""
  if (!ALLOWED_IMAGE_EXTS.has(last)) return "png"
  return last === "jpeg" ? "jpg" : (last as SafeImageExt)
}
