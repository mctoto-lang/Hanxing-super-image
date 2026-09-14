import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { callOpenAiImageApi } from "@/lib/ai/openai-image"
import {
  buildOpenAiRequestBody,
  validateImageModelConfig,
} from "@/lib/ai/image-model-config"

/**
 * Gemini 格式比例传参单测（useRatioParam / ratioParamField）
 *
 * 覆盖：请求体组装（比例模式换字段且不带 size / gcd 归约 / 自定义字段名 /
 * auto 原样 / 关闭时与现状一致）、配置校验（gemini 走 openai 同款白名单）、
 * 适配器端到端（比例参数进入实际 fetch 请求体）。
 */

const MODEL = {
  name: "gemini-relay-model",
  apiEndpoint: "https://api.example.com/v1",
  apiTimeout: 30,
  referenceImageField: undefined,
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("buildOpenAiRequestBody 比例传参", () => {
  const base = {
    model: "m",
    prompt: "p",
    referenceImages: [] as string[],
  }

  it("开启 useRatioParam → 默认字段 aspect_ratio，且不带 size", () => {
    const body = buildOpenAiRequestBody({
      ...base,
      imageSize: "1024x1024",
      useRatioParam: true,
    })
    expect(body.aspect_ratio).toBe("1:1")
    expect("size" in body).toBe(false)
  })

  it("比例值由宽高 gcd 归约（1536x1024 → 3:2）", () => {
    const body = buildOpenAiRequestBody({
      ...base,
      imageSize: "1536x1024",
      useRatioParam: true,
    })
    expect(body.aspect_ratio).toBe("3:2")
  })

  it("自定义字段名生效（如中转站要求 size_ratio）", () => {
    const body = buildOpenAiRequestBody({
      ...base,
      imageSize: "1920x1080",
      useRatioParam: true,
      ratioParamField: "size_ratio",
    })
    expect(body.size_ratio).toBe("16:9")
    expect("aspect_ratio" in body).toBe(false)
    expect("size" in body).toBe(false)
  })

  it("智能（auto）在比例模式下原样透传", () => {
    const body = buildOpenAiRequestBody({
      ...base,
      imageSize: "auto",
      useRatioParam: true,
    })
    expect(body.aspect_ratio).toBe("auto")
  })

  it("未开启 / 未传 → 维持现状：size 字段、无比例字段", () => {
    const on = buildOpenAiRequestBody({ ...base, imageSize: "1024x1024" })
    expect(on.size).toBe("1024x1024")
    expect("aspect_ratio" in on).toBe(false)

    const explicitOff = buildOpenAiRequestBody({
      ...base,
      imageSize: "1024x1024",
      useRatioParam: false,
    })
    expect(explicitOff.size).toBe("1024x1024")
    expect("aspect_ratio" in explicitOff).toBe(false)
  })

  it("比例模式与 quality 透传可同时生效", () => {
    const body = buildOpenAiRequestBody({
      ...base,
      imageSize: "1024x1024",
      useRatioParam: true,
      quality: "high",
    })
    expect(body.aspect_ratio).toBe("1:1")
    expect(body.quality).toBe("high")
    expect("size" in body).toBe(false)
  })
})

describe("validateImageModelConfig gemini 格式", () => {
  it("gemini + 字符串 quality 通过（同 openai 白名单）", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "gemini",
        extraConfig: { quality: "high" },
      }),
    ).not.toThrow()
  })

  it("gemini + 未知字段仍拒绝", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "gemini",
        extraConfig: { style: "vivid" },
      }),
    ).toThrow(/不支持/)
  })

  it("gemini + jimeng 专属字段拒绝", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "gemini",
        extraConfig: { jimengResolution: "2k" },
      }),
    ).toThrow(/不支持/)
  })
})

describe("callOpenAiImageApi 比例参数进入请求体", () => {
  it("useRatioParam → fetch 请求体携带 aspect_ratio 不携带 size；关闭则相反", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({ data: [{ url: "https://img/1" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", fn)

    await callOpenAiImageApi({
      model: { ...MODEL, useRatioParam: true, ratioParamField: null },
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 1 },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
    })
    await callOpenAiImageApi({
      model: MODEL,
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 1 },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
    })

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ aspect_ratio: "1:1" })
    expect(bodies[0]).not.toHaveProperty("size")
    expect(bodies[1]).toMatchObject({ size: "1024x1024" })
    expect(bodies[1]).not.toHaveProperty("aspect_ratio")
  })
})
