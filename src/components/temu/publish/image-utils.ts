"use client"

/**
 * 发品图片客户端工具：尺寸软校验 / 浏览器压缩 / 源图大小探测 / 转存自有存储
 * （>2MB 必须先过浏览器压缩才能上官方图床——官方上传闸门 2M，
 * 官方压缩接口只认已上图床的 URL，见 docs §8.14）。
 * 压缩产物一律直传存储 temu/ 前缀换 URL——绝不存 dataUrl：dataUrl 会把
 * 发品/建模板 server action 载荷顶到 MB 级，被反向代理 413 拒绝。
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
export async function compressToJpegBlob(blob: Blob): Promise<Blob> {
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
    if (out && out.size <= 2 * 1024 * 1024) return out
  }
  throw new Error("压缩后仍超过 2MB")
}

/** 图片 blob 直传自有存储 temu/ 前缀（不过期，模板长期引用），返回 URL */
export async function storeImageBlob(blob: Blob): Promise<string> {
  const { uploadTemuAsset } = await import("@/lib/upload/upload-image")
  const file = new File([blob], `material-${Date.now()}.jpeg`, { type: "image/jpeg" })
  return uploadTemuAsset(file)
}

/**
 * 图源物化：data: 项压缩（>2MB）后直传存储换成 URL，http(s) 项原样透传。
 * 发品弹窗/向导保存前对图源列表过一遍——兜住存量模板里的 dataUrl
 * （物化脚本迁移前的窗口期），并保证 server action 载荷恒为 KB 级。
 * @throws 任一张转存失败抛错（调用方 toast 并中止）
 */
export async function materializeImageSources(srcs: string[]): Promise<string[]> {
  const out: string[] = []
  for (const src of srcs) {
    if (!src.startsWith("data:")) {
      out.push(src)
      continue
    }
    let blob: Blob
    try {
      const [head, b64] = src.split(",")
      const bin = atob(b64 ?? "")
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      blob = new Blob([bytes], {
        type: head!.slice(5, head!.indexOf(";")) || "image/jpeg",
      })
    } catch {
      throw new Error("存量 dataUrl 解码失败，请重新选图")
    }
    if (blob.size > 2 * 1024 * 1024) blob = await compressToJpegBlob(blob)
    out.push(await storeImageBlob(blob))
  }
  return out
}
