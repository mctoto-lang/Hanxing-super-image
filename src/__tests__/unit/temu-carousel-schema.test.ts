import { describe, expect, it } from "vitest"

import { temuProductCarouselSchema } from "@/server/schemas/temu"

/**
 * 轮播图源字符上限口径（server-schema 回归）：官方 2M 上限按解码后字节
 * （temu-publish uploadImageToStore base64 解码后校验 buf.length），base64 后
 * 2MiB ≈ 2_796_227 字符——data: 项须放宽到 2_800_000 字符，否则 1.43MiB~2MiB
 * 的官方合规图片会被 schema 先拒；普通 http(s) URL 维持 2_000_000 字符。
 */

const STORE_ID = "11111111-1111-4111-8111-111111111111"
const kwcdn = (n: number) => `https://img.kwcdn.com/test/a${n}.jpg`

const carousel = (imageUrls: string[]) =>
  temuProductCarouselSchema.safeParse({ storeId: STORE_ID, productId: "P1", imageUrls })

describe("temuProductCarouselSchema 图源字符上限", () => {
  it("恰好 2MiB 的 data: URL（≈2_796_226 字符）放行", () => {
    const b64Len = Math.ceil((2 * 1024 * 1024) / 3) * 4 // 2_796_204
    const url = `data:image/png;base64,${"A".repeat(b64Len)}`
    expect(url.length).toBe(2_796_226) // 2_796_204 + 前缀 22 字符
    const res = carousel([kwcdn(1), kwcdn(2), kwcdn(3), kwcdn(4), url])
    expect(res.success).toBe(true)
  })

  it("超过 2_800_000 字符的 data: URL 拒绝并提示官方 2M 口径", () => {
    const res = carousel([
      kwcdn(1),
      kwcdn(2),
      kwcdn(3),
      kwcdn(4),
      `data:image/png;base64,${"A".repeat(2_800_000)}`,
    ])
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues[0]?.message).toBe("图片超过 2M 上限（官方 2000021）")
    }
  })

  it("普通 http(s) URL 超过 2_000_000 字符仍拒绝", () => {
    const res = carousel([
      kwcdn(1),
      kwcdn(2),
      kwcdn(3),
      kwcdn(4),
      `https://img.kwcdn.com/a/${"a".repeat(2_000_001)}`,
    ])
    expect(res.success).toBe(false)
  })
})
