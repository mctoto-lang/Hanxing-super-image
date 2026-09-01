/**
 * 图片上传统一工具（客户端，手册 §3）
 *
 * 自适应存储后端：
 * - COS 模式：先 POST /api/upload/presign 拿预签名 PUT URL → 直接 PUT 到 COS
 *   （参考图进上传桶 ref/ 前缀，不经应用服务器转发，省带宽）。
 * - local 模式（或 COS 未配齐）：回退 POST /api/upload 服务器转存。
 *
 * 返回最终可访问的图片 URL。
 */

interface PresignResponse {
  mode: "cos" | "local"
  presignedUrl?: string
  finalUrl?: string
  contentType?: string
}

/**
 * 上传单张图片，返回可访问 URL。
 * @throws 上传失败时抛错，调用方负责 toast 提示。
 */
export async function uploadImage(file: File): Promise<string> {
  // 1. 请求预签名（含服务端格式/大小校验）
  const presignResp = await fetch("/api/upload/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type,
      size: file.size,
    }),
  })
  if (!presignResp.ok) throw new Error(`presign failed: ${presignResp.status}`)
  const presign = (await presignResp.json()) as PresignResponse

  // 2. COS 直传
  if (presign.mode === "cos" && presign.presignedUrl && presign.finalUrl) {
    const putResp = await fetch(presign.presignedUrl, {
      method: "PUT",
      body: file,
      headers: {
        "Content-Type": presign.contentType ?? file.type,
      },
    })
    if (!putResp.ok) {
      throw new Error(`cos upload failed: ${putResp.status}`)
    }
    return presign.finalUrl
  }

  // 3. 本地回退：服务器转存
  const formData = new FormData()
  formData.append("file", file)
  const uploadResp = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  })
  if (!uploadResp.ok) throw new Error(`upload failed: ${uploadResp.status}`)
  const data = (await uploadResp.json()) as { url: string }
  return data.url
}
