/**
 * 头像上传统一工具（客户端）
 *
 * POST /api/upload/avatar（服务器转存，category=config，不过期）。
 * 任何登录用户可上传；返回最终可访问的图片 URL。
 */

/**
 * 上传头像图片，返回可访问 URL。
 * @throws 上传失败时抛错，调用方负责 toast 提示。
 */
export async function uploadAvatarImage(file: File): Promise<string> {
  const formData = new FormData()
  formData.append("file", file)
  const resp = await fetch("/api/upload/avatar", {
    method: "POST",
    body: formData,
  })
  if (!resp.ok) {
    if (resp.status === 413) {
      throw new Error("头像图片不能超过 2MB")
    }
    throw new Error(`avatar upload failed: ${resp.status}`)
  }
  const data = (await resp.json()) as { url: string }
  return data.url
}
