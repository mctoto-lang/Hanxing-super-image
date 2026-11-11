/**
 * 图片像素尺寸探测（worker 转存时顺带探测，零额外网络开销）。
 *
 * 基于 image-size（纯 JS，支持 png/jpg/webp/gif/psd 等主流格式），
 * 从 buffer 头部解析宽高。任何失败（未知格式/截断/异常）一律返回
 * null——探测是尽力而为的增强信息，绝不阻断上传主链路。
 */
import { imageSize } from "image-size"

export interface ImageDim {
  width: number
  height: number
}

/**
 * 存储保存结果：可访问 URL + 顺带探测到的像素尺寸。
 *
 * 尺寸在转存路径上从 buffer 头部解析（零额外网络开销）；未知格式或
 * 「本桶/本服务对象复用」早退（buffer 不经过应用）时为 null。调用方按需
 * 取用，null 时回退各自的兜底比例。
 */
export interface SavedImage {
  url: string
  width: number | null
  height: number | null
}

/** 从图片 buffer 探测像素尺寸；无法识别时返回 null */
export function probeImageSize(buffer: Uint8Array): ImageDim | null {
  try {
    const dim = imageSize(buffer)
    if (
      !dim.width ||
      !dim.height ||
      !Number.isFinite(dim.width) ||
      !Number.isFinite(dim.height) ||
      dim.width <= 0 ||
      dim.height <= 0
    ) {
      return null
    }
    return { width: dim.width, height: dim.height }
  } catch {
    return null
  }
}
