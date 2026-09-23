/**
 * 参考图客户端统一校验 + 批量上传
 *
 * 单一事实来源：格式白名单与大小上限取自 limits.ts（与 /api/upload、
 * /api/upload/presign 的服务端校验完全一致），避免各上传入口规则漂移
 * （历史上曾出现前端 10MB / 服务端 20MB、白名单有无 GIF 不一致）。
 */
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
} from "@/lib/upload/limits"
import { uploadImage } from "@/lib/upload/upload-image"

/** 单边像素上限（与外部渲染/模型服务素材限制对齐） */
export const MAX_REFERENCE_IMAGE_DIMENSION = 8192

/** 仅凭扩展名兜底判断（个别系统截图 MIME 为空） */
function hasAllowedExtension(file: File): boolean {
  const name = file.name.toLowerCase()
  return (
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".webp") ||
    name.endsWith(".gif")
  )
}

export function isAllowedImageType(file: File): boolean {
  return (
    (ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type) ||
    hasAllowedExtension(file)
  )
}

/** 读取图片真实尺寸做预校验（防伪造 MIME / 压缩炸弹） */
export function readImageSize(
  file: File,
): Promise<{ width: number; height: number }> {
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

/**
 * 校验单张参考图，通过返回 null，否则返回用户可读的错误原因
 * （含文件名前缀由调用方按需拼接）。
 */
export async function validateReferenceImage(
  file: File,
): Promise<string | null> {
  if (!isAllowedImageType(file)) {
    return "格式不支持，仅支持 PNG / JPEG / WEBP / GIF"
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return `大小超过 ${Math.floor(MAX_IMAGE_UPLOAD_BYTES / 1024 / 1024)}MB`
  }
  try {
    const { width, height } = await readImageSize(file)
    if (
      width > MAX_REFERENCE_IMAGE_DIMENSION ||
      height > MAX_REFERENCE_IMAGE_DIMENSION
    ) {
      return `图片尺寸过大（最长边上限 ${MAX_REFERENCE_IMAGE_DIMENSION}px）`
    }
  } catch {
    return "无法读取图片，文件可能已损坏"
  }
  return null
}

export interface UploadResult {
  url: string
  filename: string
}

/**
 * 批量上传参考图（并行），返回成功上传的结果（保持传入顺序）。
 * 校验失败或上传失败的文件会被跳过；调用方按 needs 自行 toast 提示。
 */
export async function uploadReferenceImages(
  files: File[],
  opts?: {
    /** 单文件上传进度回调（0-100，presign 完成即 ≥10） */
    onFileProgress?: (file: File, percent: number) => void
  },
): Promise<UploadResult[]> {
  const settled = await Promise.allSettled(
    files.map(async (file) => {
      const error = await validateReferenceImage(file)
      if (error) throw new Error(`${file.name}：${error}`)
      const url = await uploadImage(file, {
        onProgress: (percent) => opts?.onFileProgress?.(file, percent),
      })
      return { url, filename: file.name }
    }),
  )
  return settled.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  )
}
