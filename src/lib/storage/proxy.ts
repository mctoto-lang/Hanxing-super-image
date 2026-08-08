/**
 * 图片代理 URL 构造（手册 §10.7 防 SSRF）
 *
 * 所有外部图片 URL 通过 /api/image/proxy 代理，后端校验 host 白名单
 * （COS 域名 + 本应用域名），防止 SSRF。
 */
export function getStorageProxyUrl(
  imageUrl: string,
  opts?: { width?: number },
): string {
  // 本应用自有 URL（/uploads/... 或同源）直接返回
  if (
    imageUrl.startsWith("/uploads/") ||
    imageUrl.startsWith("/api/")
  ) {
    return imageUrl
  }
  // 外部 URL → 代理
  const params = new URLSearchParams({ url: imageUrl })
  if (opts?.width) params.set("w", String(opts.width))
  return `/api/image/proxy?${params.toString()}`
}
