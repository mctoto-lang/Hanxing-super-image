/**
 * 工作台参考图批量上传工具（1:1 对齐旧项目 product-reference-upload.tsx）
 *
 * 复用统一上传工具 uploadImage（自适应 COS 直传 / 本地服务器转存）逐个上传，返回 URL 数组。
 */
import { uploadImage } from "@/lib/upload/upload-image"

const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_DIMENSION = 8192
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"]

function readImageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new window.Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("无法读取图片"))
    }
    img.src = url
  })
}

export interface UploadResult {
  url: string
  filename: string
}

/**
 * 批量上传参考图到 /api/upload。
 * 返回成功上传的 URL 列表（按顺序）。失败的文件会跳过。
 */
export async function uploadReferenceImages(
  files: File[],
): Promise<UploadResult[]> {
  const results: UploadResult[] = []
  for (const file of files) {
    if (!ALLOWED_TYPES.includes(file.type)) continue
    if (file.size > MAX_SIZE) continue
    try {
      const { width, height } = await readImageSize(file)
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) continue
      const url = await uploadImage(file)
      results.push({ url, filename: file.name })
    } catch {
      // skip
    }
  }
  return results
}
