import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  callGrsaiImageApi,
  extractGrsaiImage,
  resolveGrsaiGenerateEndpoint,
} from "@/lib/ai/grsai-image"
import {
  buildGrsaiRequestBody,
  grsaiAspectRatio,
  grsaiImageSizeTier,
  validateImageModelConfig,
} from "@/lib/ai/image-model-config"

/**
 * Grsai（Gemini (Grsai)）格式单测
 *
 * 覆盖：请求体组装（aspectRatio 必传 / gcd 归约与就近吸附 / 清晰度档位
 * 推导与覆盖 / 参考图 images 字段 / replyType=json）、配置校验
 * （grsai_image_size 白名单）、端点解析、响应解析与适配器端到端
 * （状态分支 + 比例进入实际 fetch 请求体）。
 */

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("grsaiAspectRatio 比例换算", () => {
  it("gcd 归约：1024x1536 → 2:3、1024x1024 → 1:1", () => {
    expect(grsaiAspectRatio("1024x1536")).toBe("2:3")
    expect(grsaiAspectRatio("1024x1024")).toBe("1:1")
  })

  it("auto 原样返回", () => {
    expect(grsaiAspectRatio("auto")).toBe("auto")
  })

  it("不支持的比例就近吸附（1024x1025 → 1:1；1000x1111 → 9:10 附近 → 4:5 或 1:1 之外最近者）", () => {
    expect(grsaiAspectRatio("1024x1025")).toBe("1:1")
    // 1000:1111 ≈ 0.9，最近支持比例为 4:5 (0.8) 与 1:1 (1.0)——log 距离上 1:1 更近
    const snapped = grsaiAspectRatio("1000x1111")
    expect(["4:5", "1:1"]).toContain(snapped)
  })

  it("极端竖长比例吸附到最近支持比例（1000x4000 ≈ 1:4 → 9:16 最近）", () => {
    // log(9/16)≈-0.575 距 log(1/4)≈-1.386 约 0.81，比 1:1（1.39）与 21:9（2.23）都近
    expect(grsaiAspectRatio("1000x4000")).toBe("9:16")
  })

  it("非法尺寸串兜底 1:1", () => {
    expect(grsaiAspectRatio("whatever")).toBe("1:1")
  })
})

describe("grsaiImageSizeTier 档位推导", () => {
  it("按总像素推导：≈≤160 万 → 1K、≤600 万 → 2K、更大 → 4K", () => {
    expect(grsaiImageSizeTier("1024x1536")).toBe("1K") // ≈157 万像素
    expect(grsaiImageSizeTier("1024x1024")).toBe("1K")
    expect(grsaiImageSizeTier("1664x2496")).toBe("2K") // ≈415 万像素
    expect(grsaiImageSizeTier("2048x3072")).toBe("4K") // ≈629 万像素
  })

  it("手动覆盖优先", () => {
    expect(grsaiImageSizeTier("1024x1024", "4K")).toBe("4K")
  })

  it("非法覆盖值忽略，回落自动推导", () => {
    expect(grsaiImageSizeTier("1024x1024", "8K")).toBe("1K")
  })
})

describe("buildGrsaiRequestBody 请求体", () => {
  const base = {
    model: "nano-banana-2",
    prompt: "p",
    referenceImages: [] as string[],
  }

  it("比例必传 + 档位自动 + replyType=json，不带 size", () => {
    const body = buildGrsaiRequestBody({ ...base, imageSize: "1024x1536" })
    expect(body.aspectRatio).toBe("2:3")
    expect(body.imageSize).toBe("1K")
    expect(body.replyType).toBe("json")
    expect("size" in body).toBe(false)
  })

  it("参考图进入 images 字段", () => {
    const body = buildGrsaiRequestBody({
      ...base,
      imageSize: "1024x1024",
      referenceImages: ["https://a/1.png", "https://a/2.png"],
    })
    expect(body.images).toEqual(["https://a/1.png", "https://a/2.png"])
  })

  it("档位覆盖生效", () => {
    const body = buildGrsaiRequestBody({
      ...base,
      imageSize: "1024x1024",
      imageSizeOverride: "2K",
    })
    expect(body.imageSize).toBe("2K")
  })
})

describe("validateImageModelConfig grsai 格式", () => {
  it("grsai 无 extraConfig 通过（档位自动推导）", () => {
    expect(() =>
      validateImageModelConfig({ apiFormat: "grsai", extraConfig: {} }),
    ).not.toThrow()
  })

  it("grsai + grsai_image_size 合法值通过", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "grsai",
        extraConfig: { grsai_image_size: "2K" },
      }),
    ).not.toThrow()
  })

  it("grsai + 非法档位 / 未知字段拒绝", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "grsai",
        extraConfig: { grsai_image_size: "8K" },
      }),
    ).toThrow(/grsai_image_size/)
    expect(() =>
      validateImageModelConfig({
        apiFormat: "grsai",
        extraConfig: { quality: "high" },
      }),
    ).toThrow(/不支持/)
  })
})

describe("resolveGrsaiGenerateEndpoint 端点解析", () => {
  it("裸域名 / /v1 结尾 / 已含 api/generate 三种形态", () => {
    expect(resolveGrsaiGenerateEndpoint("https://grsaiapi.com")).toBe(
      "https://grsaiapi.com/v1/api/generate",
    )
    expect(resolveGrsaiGenerateEndpoint("https://grsaiapi.com/v1/")).toBe(
      "https://grsaiapi.com/v1/api/generate",
    )
    expect(
      resolveGrsaiGenerateEndpoint("https://grsaiapi.com/v1/api/generate"),
    ).toBe("https://grsaiapi.com/v1/api/generate")
  })
})

describe("extractGrsaiImage 响应解析", () => {
  it("标准形态 results[0].url", () => {
    expect(
      extractGrsaiImage({ status: "succeeded", results: [{ url: "https://i/1" }] }),
    ).toBe("https://i/1")
  })

  it("容错形态 url 字符串 / data[0].url", () => {
    expect(extractGrsaiImage({ url: "https://i/2" })).toBe("https://i/2")
    expect(extractGrsaiImage({ data: [{ url: "https://i/3" }] })).toBe("https://i/3")
  })

  it("无可识别字段返回 null", () => {
    expect(extractGrsaiImage({ status: "succeeded", results: [] })).toBeNull()
    expect(extractGrsaiImage(null)).toBeNull()
  })
})

describe("callGrsaiImageApi 端到端", () => {
  const MODEL = {
    name: "nano-banana-2",
    apiEndpoint: "https://grsaiapi.com",
    apiTimeout: 30,
  }

  it("成功：比例进入请求体，结果经 downloadAndUpload 转存", async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(
          JSON.stringify({
            status: "succeeded",
            results: [{ url: "https://img/1" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }),
    )

    const results = await callGrsaiImageApi({
      model: MODEL,
      task: { prompt: "p", imageSize: "1024x1536", imageCount: 1 },
      apiKey: "k",
      downloadAndUpload: async (url) => `stored:${url}`,
    })

    expect(results).toEqual([{ index: 0, url: "stored:https://img/1" }])
    expect(bodies[0]).toMatchObject({
      model: "nano-banana-2",
      aspectRatio: "2:3",
      imageSize: "1K",
      replyType: "json",
    })
    expect(bodies[0]).not.toHaveProperty("size")
  })

  it("失败：status 非 succeeded → error 携带上游状态与报错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ status: "failed", error: "上游限流" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    )

    const results = await callGrsaiImageApi({
      model: MODEL,
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 1 },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
    })

    expect(results).toHaveLength(1)
    expect(results[0]!.error).toMatch(/Grsai 生图状态 failed：上游限流/)
  })

  it("HTTP 非 200 → error 携带状态码与响应体摘要", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad key", { status: 401 })),
    )

    const results = await callGrsaiImageApi({
      model: MODEL,
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 1 },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
    })

    expect(results[0]!.error).toMatch(/Grsai 生图 API 错误 401/)
  })
})
