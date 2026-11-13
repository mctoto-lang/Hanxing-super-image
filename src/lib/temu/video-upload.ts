/**
 * TEMU 视频上传客户端纯函数（换视频功能，2026-11-12）。
 * 官方口径（文档站「视频上传流程」149198083286「关于视频质量说明」）：
 * ≤500MB、建议 ≤60s、宽高比 1:1 / 3:4 / 16:9 优先；≤20MB 单请求直传、
 * >20MB 分片（5MB ≤ 块 ≤ 20MB 且为 5MB 整数倍，最后一块不限）。
 */

export const VIDEO_MAX_BYTES = 500 * 1024 * 1024
export const VIDEO_MAX_DURATION_S = 60
/** 单请求直传上限（超过走分片） */
export const SINGLE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024

/** 格式白名单：官方格式明细在文档图片里不可读，按常见视频容器放行，
 *  转码失败时官方会以错误码反馈 */
export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const

/** 文件预检（type/大小/时长）；通过返回 null，否则返回中文错误消息 */
export function validateVideoFile(
  file: { size: number; type: string },
  durationS: number | null,
): string | null {
  if (!(ALLOWED_VIDEO_TYPES as readonly string[]).includes(file.type)) {
    return "仅支持 MP4 / MOV / WebM 格式视频"
  }
  if (file.size <= 0) return "视频文件为空"
  if (file.size > VIDEO_MAX_BYTES) return "视频超过官方 500MB 上限"
  // 元数据读不到（durationS=null）不拦截，时长异常由官方转码/审核兜底
  if (durationS != null && durationS > VIDEO_MAX_DURATION_S + 1) {
    return "视频时长超过 60 秒（官方建议上限，前 10 秒应突出核心卖点）"
  }
  return null
}

/** 分片区间：非末块恒 20MB（=5MB×4，满足「5MB 整数倍且 ≤20MB」），末块为余数（不限） */
export function videoChunkRanges(total: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let start = 0
  while (start < total) {
    const end = Math.min(start + SINGLE_UPLOAD_MAX_BYTES, total)
    ranges.push({ start, end })
    start = end
  }
  return ranges
}

/** 上传进度展示（0~100） */
export function uploadProgress(uploaded: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((uploaded / total) * 100))
}
