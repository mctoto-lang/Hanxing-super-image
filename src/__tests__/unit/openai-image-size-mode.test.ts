import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { callOpenAiImageApi } from "@/lib/ai/openai-image"
import {
  buildOpenAiRequestBody,
  resolveImageSizeMode,
  validateImageModelConfig,
} from "@/lib/ai/image-model-config"
import {
  extractModelIds,
  fetchUpstreamModelIds,
  resolveModelsListEndpoint,
} from "@/lib/ai/upstream-models"

/**
 * 尺寸传参模式（sizeMode）与 response_format 透传单测（openai/gemini 共用）
 *
 * 覆盖：三态请求体组装（pixels/ratio/tier、档位像素推导、自定义字段名、
 * 优先级与旧 useRatioParam 回退）、resolveImageSizeMode 解析、配置白名单
 * 校验、适配器端到端、/v1/models 拉取服务（端点归一 + 响应形状容错 +
 * 错误映射）。
 */

const BASE = {
  model: "m",
  prompt: "p",
  referenceImages: [] as string[],
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("buildOpenAiRequestBody 尺寸传参模式", () => {
  it("tier 模式：默认字段 size，档位按预设总像素推导（1024x1024 → 1K）", () => {
    const body = buildOpenAiRequestBody({
      ...BASE,
      imageSize: "1024x1024",
      sizeMode: "tier",
    })
    expect(body.size).toBe("1K")
    expect("aspect_ratio" in body).toBe(false)
  })

  it("tier 档位边界：2048x2048（约 419 万像素）→ 2K、3072x3072 → 4K", () => {
    expect(
      buildOpenAiRequestBody({ ...BASE, imageSize: "2048x2048", sizeMode: "tier" })
        .size,
    ).toBe("2K")
    expect(
      buildOpenAiRequestBody({ ...BASE, imageSize: "3072x3072", sizeMode: "tier" })
        .size,
    ).toBe("4K")
  })

  it("tier 模式自定义字段名（如中转站约定 image_size）", () => {
    const body = buildOpenAiRequestBody({
      ...BASE,
      imageSize: "1024x1536",
      sizeMode: "tier",
      ratioParamField: "image_size",
    })
    expect(body.image_size).toBe("1K")
    expect("size" in body).toBe(false)
  })

  it("ratio 模式：默认字段 aspect_ratio（1024x1536 → 2:3）", () => {
    const body = buildOpenAiRequestBody({
      ...BASE,
      imageSize: "1024x1536",
      sizeMode: "ratio",
    })
    expect(body.aspect_ratio).toBe("2:3")
    expect("size" in body).toBe(false)
  })

  it("sizeMode 优先于旧 useRatioParam（tier + useRatioParam=true → 走档位）", () => {
    const body = buildOpenAiRequestBody({
      ...BASE,
      imageSize: "1024x1024",
      sizeMode: "tier",
      useRatioParam: true,
    })
    expect(body.size).toBe("1K")
    expect("aspect_ratio" in body).toBe(false)
  })

  it("response_format 透传：设置时写入、缺省不带", () => {
    const withFmt = buildOpenAiRequestBody({
      ...BASE,
      imageSize: "1024x1024",
      responseFormat: "url",
    })
    expect(withFmt.response_format).toBe("url")

    const withoutFmt = buildOpenAiRequestBody({
      ...BASE,
      imageSize: "1024x1024",
    })
    expect("response_format" in withoutFmt).toBe(false)
  })

  it("三件套组合：tier + 自定义字段 + response_format + quality", () => {
    const body = buildOpenAiRequestBody({
      ...BASE,
      imageSize: "1920x1080",
      sizeMode: "tier",
      ratioParamField: "image_size",
      responseFormat: "b64_json",
      quality: "high",
    })
    expect(body.image_size).toBe("2K")
    expect(body.response_format).toBe("b64_json")
    expect(body.quality).toBe("high")
  })
})

describe("resolveImageSizeMode 旧配置回退", () => {
  it("extraConfig.sizeMode 优先", () => {
    expect(resolveImageSizeMode({ sizeMode: "tier" }, true)).toBe("tier")
    expect(resolveImageSizeMode({ sizeMode: "pixels" }, true)).toBe("pixels")
  })

  it("sizeMode 缺省时旧 useRatioParam=true → ratio；否则 pixels", () => {
    expect(resolveImageSizeMode({}, true)).toBe("ratio")
    expect(resolveImageSizeMode({}, false)).toBe("pixels")
    expect(resolveImageSizeMode(null, true)).toBe("ratio")
    // 非法值视为缺省
    expect(resolveImageSizeMode({ sizeMode: "huge" }, false)).toBe("pixels")
  })
})

describe("validateImageModelConfig 新增键", () => {
  it("openai + sizeMode/tierValue/responseFormat 合法值通过；gemini 拒绝（原生协议无透传配置）", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "openai",
        extraConfig: { sizeMode: "ratio", responseFormat: "url" },
      }),
    ).not.toThrow()
    expect(() =>
      validateImageModelConfig({
        apiFormat: "openai",
        extraConfig: { sizeMode: "tier", tierValue: "2K" },
      }),
    ).not.toThrow()
    expect(() =>
      validateImageModelConfig({
        apiFormat: "gemini",
        extraConfig: { sizeMode: "tier" },
      }),
    ).toThrow(/不支持/)
  })

  it("非法 sizeMode / tierValue / responseFormat 拒绝", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "openai",
        extraConfig: { sizeMode: "huge" },
      }),
    ).toThrow(/sizeMode/)
    expect(() =>
      validateImageModelConfig({
        apiFormat: "openai",
        extraConfig: { tierValue: "8K" },
      }),
    ).toThrow(/tierValue/)
    expect(() =>
      validateImageModelConfig({
        apiFormat: "openai",
        extraConfig: { responseFormat: "base64" },
      }),
    ).toThrow(/responseFormat/)
  })

  it("jimeng/grsai 仍拒绝 sizeMode（格式专属白名单）", () => {
    expect(() =>
      validateImageModelConfig({
        apiFormat: "jimeng",
        extraConfig: { sizeMode: "ratio" },
      }),
    ).toThrow(/不支持/)
  })
})

describe("callOpenAiImageApi sizeMode 进入请求体", () => {
  it("tier 模式 → fetch 请求体携带档位不携带 aspect_ratio", async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ data: [{ url: "https://img/1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }),
    )

    await callOpenAiImageApi({
      model: {
        name: "relay-model",
        apiEndpoint: "https://api.example.com/v1",
        apiTimeout: 30,
        sizeMode: "tier",
        responseFormat: "url",
      },
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 1 },
      apiKey: "k",
      downloadAndUpload: async (url) => ({ url, width: null, height: null }),
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ size: "1K", response_format: "url" })
    expect(bodies[0]).not.toHaveProperty("aspect_ratio")
  })
})

describe("upstream-models 拉取服务", () => {
  it("端点归一：裸域名 / /v1 结尾 / 全路径", () => {
    expect(resolveModelsListEndpoint("https://gw.example.com")).toBe(
      "https://gw.example.com/v1/models",
    )
    expect(resolveModelsListEndpoint("https://gw.example.com/v1/")).toBe(
      "https://gw.example.com/v1/models",
    )
    expect(resolveModelsListEndpoint("https://gw.example.com/v1/models")).toBe(
      "https://gw.example.com/v1/models",
    )
  })

  it("extractModelIds 容忍常见响应形状（对象数组/字符串数组/裸数组），去重截断", () => {
    expect(
      extractModelIds({ data: [{ id: "b" }, { id: "a" }, { id: "b" }] }),
    ).toEqual(["a", "b"])
    expect(extractModelIds({ data: ["x", "y"] })).toEqual(["x", "y"])
    expect(extractModelIds([{ id: "z" }])).toEqual(["z"])
    expect(extractModelIds({ object: "list" })).toEqual([])
    expect(extractModelIds(null)).toEqual([])
  })

  it("fetchUpstreamModelIds：成功返回 id 列表（Bearer 头 + 归一端点）", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
        calls.push({
          url: String(url),
          headers: init?.headers ?? {},
        })
        return new Response(
          JSON.stringify({ data: [{ id: "gemini-2.5-flash-image" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }),
    )

    const ids = await fetchUpstreamModelIds({
      endpoint: "https://gw.example.com/v1",
      apiKey: "sk-test",
    })
    expect(ids).toEqual(["gemini-2.5-flash-image"])
    expect(calls[0]?.url).toBe("https://gw.example.com/v1/models")
    expect(calls[0]?.headers.Authorization).toBe("Bearer sk-test")
  })

  it("fetchUpstreamModelIds：非 2xx 抛带状态码的中文错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "无效令牌" } }), {
            status: 401,
          }),
      ),
    )
    await expect(
      fetchUpstreamModelIds({
        endpoint: "https://gw.example.com",
        apiKey: "bad",
      }),
    ).rejects.toThrow(/401/)
  })

  it("fetchUpstreamModelIds：无可识别模型时报错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    )
    await expect(
      fetchUpstreamModelIds({ endpoint: "https://gw.example.com", apiKey: "k" }),
    ).rejects.toThrow(/未返回可识别/)
  })
})
