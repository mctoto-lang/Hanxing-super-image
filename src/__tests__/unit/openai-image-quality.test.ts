import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { callOpenAiImageApi } from "@/lib/ai/openai-image"
import {
  buildOpenAiRequestBody,
  validateImageModelConfig,
} from "@/lib/ai/image-model-config"

/**
 * OpenAI 生图质量参数（quality）透传单测
 *
 * 覆盖：请求体组装（有值透传 / 空白不传）、配置校验（openai 白名单 + 类型、
 * jimeng 拒绝）、适配器端到端（quality 进入实际 fetch 请求体）。
 */

const MODEL = {
  name: "test-model",
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

describe("buildOpenAiRequestBody quality 透传", () => {
  it("有值 → trim 后原样透传", () => {
    const body = buildOpenAiRequestBody({
      model: "m",
      prompt: "p",
      imageSize: "1024x1024",
      referenceImages: [],
      quality: "  high ",
    })
    expect(body.quality).toBe("high")
  })

  it("未配置 / 空白 → 请求体不含 quality 字段", () => {
    const base = {
      model: "m",
      prompt: "p",
      imageSize: "1024x1024",
      referenceImages: [] as string[],
    }
    expect("quality" in buildOpenAiRequestBody(base)).toBe(false)
    expect(
      "quality" in buildOpenAiRequestBody({ ...base, quality: undefined }),
    ).toBe(false)
    expect(
      "quality" in buildOpenAiRequestBody({ ...base, quality: "   " }),
    ).toBe(false)
  })
})

describe("validateImageModelConfig quality 白名单", () => {
  it("openai + 字符串 quality 通过", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "openai",
        extraConfig: { quality: "high" },
      }),
    ).not.toThrow()
  })

  it("openai + 非字符串 quality 拒绝", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "openai",
        extraConfig: { quality: 3 },
      }),
    ).toThrow(/quality/)
  })

  it("openai + 其他未知字段仍拒绝（白名单只放行 quality）", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "openai",
        extraConfig: { style: "vivid" },
      }),
    ).toThrow(/不支持/)
  })

  it("jimeng + quality 拒绝（仅 openai 格式支持）", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "jimeng",
        extraConfig: { quality: "high" },
      }),
    ).toThrow(/不支持/)
  })
})

describe("callOpenAiImageApi quality 进入请求体", () => {
  it("模型配置了 quality → fetch 请求体携带；未配置 → 不携带", async () => {
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
      model: { ...MODEL, quality: "high" },
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
    expect(bodies[0]).toMatchObject({ quality: "high" })
    expect(bodies[1]).not.toHaveProperty("quality")
  })
})
