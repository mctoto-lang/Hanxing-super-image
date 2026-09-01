/**
 * 上传文件扩展名安全提取（白名单）
 *
 * multipart 声明的 filename 不可信：直接取末段作为扩展名会产出 html/svg
 * 等任意扩展名（内容又是任意字节），落盘后经 /uploads 同源托管即成为
 * 存储型 XSS 载体。这里强制图片扩展名白名单，不匹配一律回落 png。
 */
const ALLOWED_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif"])

export type SafeImageExt = "jpg" | "png" | "webp" | "gif"

export function safeImageExt(
  filename: string | undefined | null,
): SafeImageExt {
  const last = filename?.split(".").pop()?.toLowerCase() ?? ""
  if (!ALLOWED_IMAGE_EXTS.has(last)) return "png"
  return last === "jpeg" ? "jpg" : (last as SafeImageExt)
}
