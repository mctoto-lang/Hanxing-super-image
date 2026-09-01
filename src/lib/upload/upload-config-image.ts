/**
 * 配置图上传统一工具（客户端，手册 §3）
 *
 * 用于模型图标 / logo 等不过期的配置图：
 * POST /api/upload/config（服务器转存，category=config，不进 COS 预签名直传）。
 *
 * 与 uploadImage（参考图）分离：参考图会过期、按企业隔离；配置图不过期。
 * 返回最终可访问的图片 URL。
 */

/**
 * 上传单张配置图，返回可访问 URL。
 * @throws 上传失败时抛错，调用方负责 toast 提示。
 */
export async function uploadConfigImage(file: File): Promise<string> {
  const formData = new FormData()
  formData.append("file", file)
  const resp = await fetch("/api/upload/config", {
    method: "POST",
    body: formData,
  })
  if (!resp.ok) {
    throw new Error(`config upload failed: ${resp.status}`)
  }
  const data = (await resp.json()) as { url: string }
  return data.url
}
