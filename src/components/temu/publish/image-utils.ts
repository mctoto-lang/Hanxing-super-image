"use client"

/**
 * 发品图片客户端工具：尺寸软校验 / 浏览器压缩 / 源图大小探测
 * （>2MB 必须先过浏览器压缩才能上官方图床——官方上传闸门 2M，
 * 官方压缩接口只认已上图床的 URL，见 docs §8.14）
 */

/** 本地尺寸软校验（1:1 ≥800；仅提前提示，终校验在发品侧） */
export async function checkImageDims(src: string): Promise<boolean> {
  const { toImageSrc } = await import("@/lib/utils")
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error("load"))
      el.src = src.startsWith("data:") ? src : toImageSrc(src, { width: 800 })
    })
    if (img.naturalWidth < 800 || img.naturalHeight < 800 || img.naturalWidth !== img.naturalHeight) {
      return false
    }
    return true
  } catch {
    return true // 尺寸探测失败不拦截（发品侧还有终校验）
  }
}

/** 探测源图大小（同域代理取 blob；失败返回 undefined 按原样接收） */
export async function probeImageBlob(url: string): Promise<Blob | undefined> {
  try {
    const res = await fetch(`/api/image/proxy?url=${encodeURIComponent(url)}`)
    return res.ok ? await res.blob() : undefined
  } catch {
    return undefined
  }
}

/** 浏览器压缩：限宽 ≤1600、JPEG 质量阶梯，直到 ≤2MB（不改纵横比） */
export async function compressToDataUrl(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q))
    if (out && out.size <= 2 * 1024 * 1024) {
      return await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = () => reject(new Error("读取压缩结果失败"))
        fr.readAsDataURL(out)
      })
    }
  }
  throw new Error("压缩后仍超过 2MB")
}
