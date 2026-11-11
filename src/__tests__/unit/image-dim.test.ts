/**
 * probeImageSize 包装层单测：
 * - 合成主流格式头（PNG/GIF/PSD）验证宽高正确读出（image-size 只读头部，
 *   无需完整图片数据）；
 * - 乱字节/空 buffer/截断 → null（探测永不抛错、不阻断上传主链路）。
 */
import { describe, expect, it } from "vitest"
import { probeImageSize } from "@/lib/storage/image-dim"

/** 合成 PNG 头（签名 + IHDR 大端宽高；image-size 只读头不校验 CRC） */
function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.write("IHDR", 0, "ascii")
  ihdr.writeUInt32BE(width, 4)
  ihdr.writeUInt32BE(height, 8)
  ihdr[12] = 6 // color type
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    ihdr,
    Buffer.alloc(4), // CRC 占位
  ])
}

/** 合成 GIF 头（"GIF89a" + 小端 u16 宽高） */
function gifHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(10)
  b.write("GIF89a", 0, "ascii")
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

/** 合成 PSD 头（"8BPS" + version u16 + reserved 6B + channels u16 + height u32be + width u32be） */
function psdHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(26)
  b.write("8BPS", 0, "ascii")
  b.writeUInt16BE(1, 4)
  b.writeUInt16BE(4, 12) // 6-11 为保留段
  b.writeUInt32BE(height, 14)
  b.writeUInt32BE(width, 18)
  return b
}

describe("probeImageSize", () => {
  it("合成 PNG 头读出宽高（大尺寸 768x1344）", () => {
    expect(probeImageSize(pngHeader(768, 1344))).toEqual({
      width: 768,
      height: 1344,
    })
  })

  it("已知 1x1 PNG base64 常量", () => {
    const b = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    )
    expect(probeImageSize(b)).toEqual({ width: 1, height: 1 })
  })

  it("合成 GIF 头读出宽高", () => {
    expect(probeImageSize(gifHeader(800, 600))).toEqual({
      width: 800,
      height: 600,
    })
  })

  it("合成 PSD 头读出宽高（样机渲染源文件路径）", () => {
    expect(probeImageSize(psdHeader(800, 1080))).toEqual({
      width: 800,
      height: 1080,
    })
  })

  it("乱字节 → null（不抛错）", () => {
    expect(probeImageSize(Buffer.from("not an image at all"))).toBeNull()
  })

  it("空 buffer → null", () => {
    expect(probeImageSize(Buffer.alloc(0))).toBeNull()
  })

  it("截断的 PNG 头（不足 IHDR）→ null", () => {
    expect(probeImageSize(pngHeader(100, 100).subarray(0, 10))).toBeNull()
  })
})
