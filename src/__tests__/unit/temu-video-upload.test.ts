import { describe, expect, it } from "vitest"
import {
  ALLOWED_VIDEO_TYPES,
  SINGLE_UPLOAD_MAX_BYTES,
  uploadProgress,
  validateVideoFile,
  videoChunkRanges,
  VIDEO_MAX_BYTES,
} from "@/lib/temu/video-upload"

/**
 * 换视频纯函数单测（2026-11-12 批次）：文件预检（格式/大小/时长）与
 * 分片区间计算（官方规则：非末块 5MB 整数倍且 ≤20MB，末块不限）。
 */

const MB = 1024 * 1024

describe("validateVideoFile 预检", () => {
  it("放行 MP4 + 合法大小/时长", () => {
    expect(validateVideoFile({ size: 10 * MB, type: "video/mp4" }, 30)).toBeNull()
    expect(validateVideoFile({ size: 10 * MB, type: "video/quicktime" }, null)).toBeNull()
    expect(validateVideoFile({ size: 10 * MB, type: "video/webm" }, 0.5)).toBeNull()
  })

  it("拒绝非白名单格式", () => {
    expect(validateVideoFile({ size: MB, type: "video/x-msvideo" }, 10)).toContain("仅支持")
    expect(validateVideoFile({ size: MB, type: "application/octet-stream" }, 10)).toContain("仅支持")
  })

  it("拒绝空文件与超限大小", () => {
    expect(validateVideoFile({ size: 0, type: "video/mp4" }, 10)).toContain("为空")
    expect(validateVideoFile({ size: VIDEO_MAX_BYTES + 1, type: "video/mp4" }, 10)).toContain("500MB")
  })

  it("拒绝超 60 秒时长（±1 秒容差；读不到时长不拦截）", () => {
    expect(validateVideoFile({ size: MB, type: "video/mp4" }, 61.5)).toContain("60 秒")
    expect(validateVideoFile({ size: MB, type: "video/mp4" }, 60.5)).toBeNull()
    expect(validateVideoFile({ size: MB, type: "video/mp4" }, null)).toBeNull()
  })
})

describe("videoChunkRanges 分片区间（非末块 20MB=5MB×4，末块余量不限）", () => {
  it("≤20MB 不分片", () => {
    expect(videoChunkRanges(SINGLE_UPLOAD_MAX_BYTES)).toEqual([
      { start: 0, end: SINGLE_UPLOAD_MAX_BYTES },
    ])
    expect(videoChunkRanges(1)).toEqual([{ start: 0, end: 1 }])
  })

  it(">20MB 按块切，非末块恒 20MB（5MB 整数倍）", () => {
    const total = 53 * MB
    const ranges = videoChunkRanges(total)
    expect(ranges).toHaveLength(3)
    expect(ranges[0]).toEqual({ start: 0, end: 20 * MB })
    expect(ranges[1]).toEqual({ start: 20 * MB, end: 40 * MB })
    // 末块 13MB：非 5MB 整数倍也合法（官方「最后一块不限」）
    expect(ranges[2]).toEqual({ start: 40 * MB, end: 53 * MB })
    for (const r of ranges.slice(0, -1)) {
      expect(r.end - r.start).toBe(SINGLE_UPLOAD_MAX_BYTES)
      expect((r.end - r.start) % (5 * MB)).toBe(0)
    }
  })

  it("500MB 上限按 25 块切完", () => {
    const ranges = videoChunkRanges(VIDEO_MAX_BYTES)
    expect(ranges).toHaveLength(25)
    expect(ranges.at(-1)).toEqual({ start: 480 * MB, end: 500 * MB })
  })
})

describe("uploadProgress", () => {
  it("常规/边界/非法输入", () => {
    expect(uploadProgress(0, 100)).toBe(0)
    expect(uploadProgress(50, 100)).toBe(50)
    expect(uploadProgress(100, 100)).toBe(100)
    expect(uploadProgress(120, 100)).toBe(100)
    expect(uploadProgress(10, 0)).toBe(0)
  })
})

describe("ALLOWED_VIDEO_TYPES 快照", () => {
  it("白名单与前端 input accept 一致", () => {
    expect([...ALLOWED_VIDEO_TYPES]).toEqual(["video/mp4", "video/quicktime", "video/webm"])
  })
})
