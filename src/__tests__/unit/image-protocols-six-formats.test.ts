import { describe, expect, it } from "vitest"
import {
  buildChatImageRequestBody,
  buildGeminiImageRequestBody,
  buildMidjourneyPrompt,
  buildOpenAiRequestBody,
  extractChatImages,
  extractGeminiImages,
  extractMidjourneyTaskState,
  geminiAspectRatio,
  parseMidjourneySubmitResponse,
  resolveMidjourneyFetchEndpoint,
  resolveMidjourneySubmitEndpoint,
  validateImageModelConfig,
} from "@/lib/ai/image-model-config"
import {
  buildOpenAiEditsFormData,
  resolveOpenAiEditsEndpoint,
  resolveOpenAiGenerateEndpoint,
} from "@/lib/ai/openai-image"
import { buildExtraConfig } from "@/server/services/model-form-helpers"
import { gcdRatio, resolveSizePresets } from "@/lib/image-sizes"

/* ═══════════ Images 协议（openai）：generations/edits 分流 + tier 固定档 ═══════════ */

describe("Images 协议端点分流", () => {
  it("generations 端点归一（域名/ /v1 / 全路径）", () => {
    expect(resolveOpenAiGenerateEndpoint("https://api.xx.com")).toBe(
      "https://api.xx.com/v1/images/generations",
    )
    expect(resolveOpenAiGenerateEndpoint("https://api.xx.com/v1/")).toBe(
      "https://api.xx.com/v1/images/generations",
    )
  })

  it("edits 端点归一：无参考图走 generations、有参考图走 edits", () => {
    expect(resolveOpenAiEditsEndpoint("https://api.xx.com/v1")).toBe(
      "https://api.xx.com/v1/images/edits",
    )
    expect(resolveOpenAiEditsEndpoint("https://api.xx.com")).toBe(
      "https://api.xx.com/v1/images/edits",
    )
    // 已配 generations/edits 全路径时原样/互转
    expect(
      resolveOpenAiEditsEndpoint("https://api.xx.com/v1/images/generations"),
    ).toBe("https://api.xx.com/v1/images/edits")
    expect(
      resolveOpenAiEditsEndpoint("https://api.xx.com/v1/images/edits"),
    ).toBe("https://api.xx.com/v1/images/edits")
  })

  it("edits multipart：字段平铺 + 单图 image / 多图 image[]", () => {
    const form = buildOpenAiEditsFormData(
      { model: "gpt-image-1", prompt: "p", size: "1024x1024", skipped: undefined },
      [{ blob: new Blob(["a"]), filename: "ref.png" }],
    )
    expect(form.get("model")).toBe("gpt-image-1")
    expect(form.get("size")).toBe("1024x1024")
    expect(form.get("skipped")).toBeNull()
    expect(form.get("image")).toBeInstanceOf(File)

    const multi = buildOpenAiEditsFormData(
      { model: "m", prompt: "p" },
      [
        { blob: new Blob(["a"]), filename: "a.png" },
        { blob: new Blob(["b"]), filename: "b.png" },
      ],
    )
    expect(multi.getAll("image[]")).toHaveLength(2)
  })
})

describe("Images 协议 tier 固定档位", () => {
  const base = {
    model: "m",
    prompt: "p",
    imageSize: "1024x1024",
    referenceImages: [],
  }
  it("tierValue 固定档位优先于像素推导", () => {
    expect(buildOpenAiRequestBody({ ...base, sizeMode: "tier" }).size).toBe("1K")
    expect(
      buildOpenAiRequestBody({ ...base, sizeMode: "tier", tierValue: "4K" }).size,
    ).toBe("4K")
    // 2000x2000=400 万像素自动推导为 2K，但固定 1K 优先
    expect(
      buildOpenAiRequestBody({
        ...base,
        imageSize: "2000x2000",
        sizeMode: "tier",
        tierValue: "1K",
      }).size,
    ).toBe("1K")
  })
})

/* ═══════════ Chat 协议：请求体 + 回复解析 ═══════════ */

describe("Chat 协议", () => {
  it("无参考图 content 为纯文本字符串", () => {
    const body = buildChatImageRequestBody({
      model: "gpt-4o",
      prompt: "画一只猫",
      referenceImages: [],
    })
    expect(body.model).toBe("gpt-4o")
    expect(body.messages).toEqual([
      { role: "user", content: "画一只猫" },
    ])
  })

  it("带参考图 content 为多模态分段（text + image_url）", () => {
    const body = buildChatImageRequestBody({
      model: "gpt-4o",
      prompt: "画一只猫",
      referenceImages: ["https://a.com/1.png", "https://a.com/2.png"],
    })
    const content = (body.messages as Array<{ content: unknown }>)[0]!
      .content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: "text", text: "画一只猫" })
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://a.com/1.png" },
    })
  })

  it("回复解析：markdown 链接 / image_url 分段 / 裸 data URI / 图片扩展名 URL", () => {
    expect(extractChatImages("生成如下：![img](https://a.com/x.png) 完成")).toEqual([
      "https://a.com/x.png",
    ])
    expect(
      extractChatImages([
        { type: "text", text: "好的" },
        { type: "image_url", image_url: { url: "https://b.com/y.webp" } },
      ]),
    ).toEqual(["https://b.com/y.webp"])
    expect(
      extractChatImages("data:image/png;base64,AAAA=="),
    ).toEqual(["data:image/png;base64,AAAA=="])
    expect(extractChatImages("结果 https://c.com/z.jpg 请查收")).toEqual([
      "https://c.com/z.jpg",
    ])
    expect(extractChatImages("没有图片")).toEqual([])
  })

  it("validateImageModelConfig：chat 拒绝任何透传键", () => {
    expect(() =>
      validateImageModelConfig({ apiFormat: "chat", extraConfig: {} }),
    ).not.toThrow()
    expect(() =>
      validateImageModelConfig({ apiFormat: "chat", extraConfig: { quality: "high" } }),
    ).toThrow(/不支持/)
  })
})

/* ═══════════ Gemini 官方原生：比例换算 + 请求体 + 响应解析 ═══════════ */

describe("Gemini 官方原生协议", () => {
  it("aspectRatio：gcd 归约 + 不在十档时就近吸附 + 超限钳制 + auto 省略", () => {
    expect(geminiAspectRatio("1024x1024")).toBe("1:1")
    expect(geminiAspectRatio("1280x720")).toBe("16:9")
    // 1000x1100 → 10:11 不在支持集，就近吸附 9:10？实际最近为 9:10 不在集 → 1:1 或 4:5
    const snapped = geminiAspectRatio("1000x1100")!
    expect(["4:5", "1:1"]).toContain(snapped)
    // 普通模式画幅上限 14:1：200:1 钳到边界后就近吸附 21:9（14:1 不在官方十档）
    expect(geminiAspectRatio("1400x100")).toBe("21:9")
    expect(geminiAspectRatio("2800x100")).toBe("21:9")
    expect(geminiAspectRatio("auto")).toBeNull()
  })

  it("请求体：responseModalities 含 IMAGE + imageConfig.aspectRatio；auto 省略 imageConfig", () => {
    const body = buildGeminiImageRequestBody({
      prompt: "p",
      imageSize: "1280x720",
      inlineImages: [{ mimeType: "image/png", data: "AAA" }],
    }) as { contents: Array<{ parts: Array<Record<string, unknown>> }>; generationConfig: Record<string, unknown> }
    expect(body.contents[0]!.parts[0]).toEqual({ text: "p" })
    expect(body.contents[0]!.parts[1]).toEqual({
      inline_data: { mime_type: "image/png", data: "AAA" },
    })
    expect(body.generationConfig.responseModalities).toContain("IMAGE")
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "16:9" })

    const auto = buildGeminiImageRequestBody({
      prompt: "p",
      imageSize: "auto",
      inlineImages: [],
    }) as { generationConfig: Record<string, unknown> }
    expect("imageConfig" in auto.generationConfig).toBe(false)
  })

  it("响应解析：inlineData / inline_data，裸 base64 补 data 前缀", () => {
    expect(
      extractGeminiImages({
        candidates: [
          {
            content: {
              parts: [
                { text: "ok" },
                { inlineData: { mimeType: "image/png", data: "AAAA" } },
                { inline_data: { mime_type: "image/webp", data: "data:image/webp;base64,BBBB" } },
              ],
            },
          },
        ],
      }),
    ).toEqual(["data:image/png;base64,AAAA", "data:image/webp;base64,BBBB"])
    expect(extractGeminiImages({ candidates: [] })).toEqual([])
  })

  it("validateImageModelConfig：gemini 拒绝透传键（原生协议无额外配置）", () => {
    expect(() =>
      validateImageModelConfig({ apiFormat: "gemini", extraConfig: {} }),
    ).not.toThrow()
    expect(() =>
      validateImageModelConfig({ apiFormat: "gemini", extraConfig: { sizeMode: "ratio" } }),
    ).toThrow(/不支持/)
  })
})

/* ═══════════ Midjourney（MJ Proxy）：端点/prompt/提交解析/任务态 ═══════════ */

describe("Midjourney 协议纯函数", () => {
  it("端点归一：域名 / /mj / 完整 submit 路径", () => {
    expect(resolveMidjourneySubmitEndpoint("https://aipaiai.cn")).toBe(
      "https://aipaiai.cn/mj/submit/imagine",
    )
    expect(resolveMidjourneySubmitEndpoint("https://aipaiai.cn/mj/")).toBe(
      "https://aipaiai.cn/mj/submit/imagine",
    )
    expect(resolveMidjourneyFetchEndpoint("https://aipaiai.cn/mj", "T1")).toBe(
      "https://aipaiai.cn/mj/task/T1/fetch",
    )
  })

  it("prompt 构造：参考图拼头 + --ar 自动 + mjFlags 追加并剔重", () => {
    expect(
      buildMidjourneyPrompt({
        prompt: "a cat",
        imageSize: "1280x720",
        referenceImages: ["https://r/1.png", "https://r/2.png"],
        flags: "--v 8.2 --fast",
      }),
    ).toBe("https://r/1.png https://r/2.png a cat --ar 16:9 --v 8.2 --fast")
    // auto 省略 --ar；flags 中的 --ar 被剔除防冲突
    expect(
      buildMidjourneyPrompt({
        prompt: "a cat",
        imageSize: "auto",
        referenceImages: [],
        flags: "--ar 3:2 --v 8.2",
      }),
    ).toBe("a cat --v 8.2")
    // 画幅上限 14:1
    expect(
      buildMidjourneyPrompt({ prompt: "p", imageSize: "2000x100", referenceImages: [], flags: null }),
    ).toBe("p --ar 21:9")
  })

  it("提交响应解析：code 1/21/22 且有 result 才算成功", () => {
    expect(parseMidjourneySubmitResponse({ code: 1, description: "提交成功", result: "TASK1" })).toEqual({
      ok: true,
      taskId: "TASK1",
    })
    expect(parseMidjourneySubmitResponse({ code: 22, result: "TASK2" })).toEqual({
      ok: true,
      taskId: "TASK2",
    })
    const bad = parseMidjourneySubmitResponse({ code: 4, description: "排队已满", result: null })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/排队已满/)
  })

  it("任务态解析：status/splitStatus/images 宽高", () => {
    const state = extractMidjourneyTaskState({
      status: "SUCCESS",
      splitStatus: "succeeded",
      images: [
        { index: 1, url: "https://cdn/1.png", width: 1024, height: 1024 },
        { index: 2, url: "https://cdn/2.png" },
      ],
      progress: "100%",
    })
    expect(state.status).toBe("SUCCESS")
    expect(state.splitStatus).toBe("succeeded")
    expect(state.images).toEqual([
      { url: "https://cdn/1.png", width: 1024, height: 1024 },
      { url: "https://cdn/2.png", width: null, height: null },
    ])
  })

  it("validateImageModelConfig：midjourney 仅放行 mjFlags", () => {
    expect(() =>
      validateImageModelConfig({ apiFormat: "midjourney", extraConfig: { mjFlags: "--v 8.2" } }),
    ).not.toThrow()
    expect(() =>
      validateImageModelConfig({ apiFormat: "midjourney", extraConfig: { quality: "high" } }),
    ).toThrow(/不支持/)
  })
})

/* ═══════════ buildExtraConfig 六格式组装 ═══════════ */

describe("buildExtraConfig 六格式", () => {
  it("openai：tierValue 仅 tier 模式写入；pixels 不写 sizeMode", () => {
    expect(
      buildExtraConfig({ apiFormat: "openai", sizeMode: "tier", tierValue: "2K" }),
    ).toEqual({ sizeMode: "tier", tierValue: "2K" })
    expect(
      buildExtraConfig({ apiFormat: "openai", sizeMode: "tier", tierValue: undefined }),
    ).toEqual({ sizeMode: "tier" })
    expect(
      buildExtraConfig({ apiFormat: "openai", sizeMode: "pixels", tierValue: "2K" }),
    ).toEqual({})
    expect(
      buildExtraConfig({ apiFormat: "openai", sizeMode: "ratio", responseFormat: "url" }),
    ).toEqual({ sizeMode: "ratio", responseFormat: "url" })
  })

  it("chat/gemini 空配置；midjourney 写 mjFlags；jimeng/grsai 维持原状", () => {
    expect(buildExtraConfig({ apiFormat: "chat", quality: "high" })).toEqual({})
    expect(buildExtraConfig({ apiFormat: "gemini", sizeMode: "ratio" })).toEqual({})
    expect(buildExtraConfig({ apiFormat: "midjourney", mjFlags: "--fast" })).toEqual({
      mjFlags: "--fast",
    })
    expect(
      buildExtraConfig({ apiFormat: "midjourney", mjFlags: "  " }),
    ).toEqual({})
    expect(
      buildExtraConfig({ apiFormat: "grsai", grsaiImageSize: "4K" }),
    ).toEqual({ grsaiImageSize: "4K" })
    expect(
      buildExtraConfig({ apiFormat: "jimeng", jimengResolution: "2k", jimengN: 4 }),
    ).toEqual({ jimengResolution: "2k", jimengN: 4 })
  })
})

/* ═══════════ 尺寸预设新结构（ratio/icon）归一化 ═══════════ */

describe("尺寸预设新结构归一化", () => {
  it("gcdRatio 归约", () => {
    expect(gcdRatio(1024, 768)).toBe("4:3")
    expect(gcdRatio(720, 1280)).toBe("9:16")
    expect(gcdRatio(0, 100)).toBe("")
  })

  it("ratio 缺省由宽高推导、label 回退 ratio、icon 缺省 outline；旧结构兼容", () => {
    const [preset] = resolveSizePresets([
      { label: "方形", width: 1024, height: 1024, enabled: true },
    ])
    expect(preset).toMatchObject({
      value: "1024x1024",
      label: "方形",
      ratio: "1:1",
      icon: "outline",
      enabled: true,
    })
    const [fresh] = resolveSizePresets([
      { ratio: "16:9", width: 1280, height: 720, icon: "solid" },
    ])
    expect(fresh).toMatchObject({
      label: "16:9",
      ratio: "16:9",
      icon: "solid",
    })
  })

  it("默认预设携带 ratio（无 label 字段）", () => {
    const presets = resolveSizePresets(null)
    expect(presets[0]).toMatchObject({ ratio: "1:1", label: "1:1" })
    expect(presets[1]).toMatchObject({ ratio: "21:9", label: "21:9" })
  })
})
