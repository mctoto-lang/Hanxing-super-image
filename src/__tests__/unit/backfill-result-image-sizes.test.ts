/**
 * 回归：backfill-result-image-sizes 探测错误分类（review backfill#1）。
 *
 * 口径：仅 404/403/非 myqcloud/无有效宽高 记 miss（永久 null 落库）；
 * 超时/网络异常/5xx 为瞬时失败 —— 退避重试后仍失败返回 transient，
 * 调用方须跳过该任务不落库（否则一次网络抖动就把尺寸永久写成 null）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { probeImageUrl } from "../../../scripts/backfill-result-image-sizes"

const COS_URL = "https://bucket.cos.ap-guangzhou.myqcloud.com/a.jpg"

/** imageInfo 元数据接口的典型应答（width/height 为字符串） */
const okBody = JSON.stringify({ width: "1254", height: "819", format: "png" })

const resp = (status: number, body?: string) =>
  new Response(body ?? "", { status })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("probeImageUrl 错误分类", () => {
  it("200 且宽高有效 → hit", async () => {
    const fetchMock = vi.fn(async () => resp(200, okBody))
    vi.stubGlobal("fetch", fetchMock)
    const r = await probeImageUrl(COS_URL, 0)
    expect(r).toEqual({ kind: "hit", size: { width: 1254, height: 819 } })
  })

  it("404/403 → miss（永久 null 落库口径），且不重试", async () => {
    for (const status of [404, 403]) {
      const fetchMock = vi.fn(async () => resp(status))
      vi.stubGlobal("fetch", fetchMock)
      const r = await probeImageUrl(COS_URL, 0)
      expect(r).toEqual({ kind: "miss" })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it("非 myqcloud URL / 非法 URL → miss 且不发请求", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect(await probeImageUrl("/uploads/local.png", 0)).toEqual({ kind: "miss" })
    expect(await probeImageUrl("not a url", 0)).toEqual({ kind: "miss" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("5xx 重试后成功 → hit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp(503))
      .mockResolvedValueOnce(resp(500))
      .mockResolvedValueOnce(resp(200, okBody))
    vi.stubGlobal("fetch", fetchMock)
    const r = await probeImageUrl(COS_URL, 0)
    expect(r).toEqual({ kind: "hit", size: { width: 1254, height: 819 } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("5xx 重试耗尽 → transient（不得落库）", async () => {
    const fetchMock = vi.fn(async () => resp(502))
    vi.stubGlobal("fetch", fetchMock)
    const r = await probeImageUrl(COS_URL, 0)
    expect(r.kind).toBe("transient")
    expect(fetchMock).toHaveBeenCalledTimes(3) // 首次 + 2 次退避重试
  })

  it("网络异常（fetch 抛错/超时中断）→ transient（不得落库）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error")
      }),
    )
    const r = await probeImageUrl(COS_URL, 0)
    expect(r.kind).toBe("transient")
  })

  it("200 但无有效宽高 → miss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resp(200, JSON.stringify({ format: "png" }))),
    )
    const r = await probeImageUrl(COS_URL, 0)
    expect(r).toEqual({ kind: "miss" })
  })
})
