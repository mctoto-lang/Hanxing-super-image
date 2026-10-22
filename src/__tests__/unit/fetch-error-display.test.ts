import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { describeFetchError } from "@/lib/fetch-error"
import { callOpenAiImageApi } from "@/lib/ai/openai-image"
import { createCosAdapter } from "@/lib/storage/cos"
import type { StorageConfig } from "@/lib/storage/config"

/**
 * fetch failed 错误显示单测：
 * - describeFetchError：展开 undici err.cause（错误码/消息/AggregateError 多地址）；
 * - ai 适配器：端点网络失败报「生图请求网络失败（端点）: 原因」，
 *   与下载转存失败（storage 层包装）形态可区分；
 * - cos 适配器：下载网络失败报「下载失败: 无法连接 host（原因，url=…）」。
 * 背景：codex789 中转返回内网图片 URL，裸 "fetch failed" 无 cause/目标时无法定位。
 */

function networkError(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause })
}

const ECONNREFUSED = Object.assign(
  new Error("connect ECONNREFUSED 127.0.0.1:8000"),
  { code: "ECONNREFUSED" },
)

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("describeFetchError cause 展开", () => {
  it("cause 为带 code 的 Error → 返回消息（含地址与错误码）", () => {
    expect(describeFetchError(networkError(ECONNREFUSED))).toBe(
      "connect ECONNREFUSED 127.0.0.1:8000",
    )
  })

  it("cause 为 AggregateError（多地址尝试）→ 取首个子错误", () => {
    const agg = new AggregateError(
      [Object.assign(new Error("connect ETIMEDOUT 107.172.214.36:443"), { code: "ETIMEDOUT" })],
      "connect failed",
    )
    expect(describeFetchError(networkError(agg))).toContain("ETIMEDOUT")
    expect(describeFetchError(networkError(agg))).toContain("107.172.214.36:443")
  })

  it("cause 无消息无 code → 未知连接错误", () => {
    expect(describeFetchError(networkError(new Error()))).toBe("未知连接错误")
    expect(describeFetchError(networkError(undefined))).toBe("未知连接错误")
  })

  it("非 fetch 网络错误（普通 Error/AbortError）→ null", () => {
    expect(describeFetchError(new Error("下载失败: 404"))).toBeNull()
    const abort = new Error("This operation was aborted")
    abort.name = "AbortError"
    expect(describeFetchError(abort)).toBeNull()
  })
})

describe("openai 适配器端点网络失败", () => {
  it("fetch reject（ECONNREFUSED）→ per-image error 带端点与原因，非裸 fetch failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(networkError(ECONNREFUSED)),
    )
    const results = await callOpenAiImageApi({
      model: {
        name: "m",
        apiEndpoint: "https://www.example-relay.com/v1",
        apiTimeout: 30,
      },
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 1 },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
    })
    expect(results[0]!.error).toContain("生图请求网络失败")
    expect(results[0]!.error).toContain("https://www.example-relay.com/v1/images/generations")
    expect(results[0]!.error).toContain("ECONNREFUSED 127.0.0.1:8000")
    expect(results[0]!.error).not.toBe("fetch failed")
  })

  it("下载转存失败的既有文案原样透传（不双包装）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ url: "https://img.example.com/a.png" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )
    const results = await callOpenAiImageApi({
      model: { name: "m", apiEndpoint: "https://api.example.com/v1", apiTimeout: 30 },
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 1 },
      apiKey: "k",
      downloadAndUpload: async () => {
        throw new Error("下载失败: 无法连接 127.0.0.1:8000（connect ECONNREFUSED 127.0.0.1:8000，url=http://127.0.0.1:8000/a.png）")
      },
    })
    expect(results[0]!.error).toBe(
      "下载失败: 无法连接 127.0.0.1:8000（connect ECONNREFUSED 127.0.0.1:8000，url=http://127.0.0.1:8000/a.png）",
    )
  })
})

describe("cos 适配器下载网络失败", () => {
  const cfg = {
    provider: "cos",
    cosSecretId: "dummy-id",
    cosSecretKey: "dummy-token",
    cosRegion: "ap-guangzhou",
    cosBucket: "hanxing-test",
    cosBaseUrl: "",
    refPrefix: "ref/",
    configPrefix: "config/",
    generatePrefix: "gen/",
    temuPrefix: "temu/",
    cosForceInternalEndpoint: false,
    localImagePrefix: "image/",
    allowedDownloadHosts: [],
  } satisfies StorageConfig

  it("默认后缀放行后 fetch reject → 错误带 host、原因与 URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(networkError(ECONNREFUSED)),
    )
    const adapter = createCosAdapter(cfg)
    const sourceUrl = "https://p3-dreamina-sign.byteimg.com/a.png?sig=x"
    await expect(
      adapter.saveFromUrl(sourceUrl, "ent-1", "generate"),
    ).rejects.toThrow(
      /下载失败: 无法连接 p3-dreamina-sign\.byteimg\.com（connect ECONNREFUSED 127\.0\.0\.1:8000，url=https:\/\/p3-dreamina-sign\.byteimg\.com\/a\.png\?sig=x）/,
    )
  })

  it("上游非 2xx → 错误带 HTTP 状态与 host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    )
    const adapter = createCosAdapter(cfg)
    await expect(
      adapter.saveFromUrl(
        "https://p3-dreamina-sign.byteimg.com/a.png",
        "ent-1",
        "generate",
      ),
    ).rejects.toThrow("下载失败: HTTP 404（p3-dreamina-sign.byteimg.com）")
  })
})
