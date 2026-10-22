import { describe, it, expect } from "vitest"
import { temuImageSrc } from "@/lib/temu/image"
import { resolveCosTarget, DEFAULT_STORAGE, type StorageConfig } from "@/lib/storage/config"

/** 与集成测试夹具同款的假 COS 配置（本套测试从不发起 COS 请求） */
const cfg: StorageConfig = {
  provider: "cos",
  cosSecretId: "id",
  cosSecretKey: "key",
  cosRegion: "ap-guangzhou",
  cosBucket: "bucket-1250000000",
  cosBaseUrl: "",
  refPrefix: "ref/",
  configPrefix: "config/",
  generatePrefix: "gen/",
  temuPrefix: "temu/",
  cosForceInternalEndpoint: false,
  localImagePrefix: "image/",
  allowedDownloadHosts: [],
}

describe("temuImageSrc（TEMU 商品图展示口径）", () => {
  it("转存 URL 优先：COS 直连不加代理", () => {
    const cos = "https://bucket-1250000000.cos.ap-guangzhou.myqcloud.com/temu/ent/2026/10/a.jpg"
    expect(temuImageSrc(cos, "https://img.kwcdn.com/x.jpg")).toBe(cos)
  })

  it("转存 URL 为本地 /uploads 路径时原样返回（local 存储回退）", () => {
    expect(temuImageSrc("/uploads/ent/image/2026/10/a.jpg", "https://img.kwcdn.com/x.jpg")).toBe(
      "/uploads/ent/image/2026/10/a.jpg",
    )
  })

  it("未转存时回落 kwcdn 外链直连：不走 /api/image/proxy（kwcdn 不在代理白名单）", () => {
    const kwcdn = "https://img.kwcdn.com/product/x.jpg"
    const src = temuImageSrc(null, kwcdn)
    expect(src).toBe(kwcdn)
    expect(src.startsWith("/api/image/proxy")).toBe(false)
  })

  it("两者皆空返回空串", () => {
    expect(temuImageSrc(null, null)).toBe("")
    expect(temuImageSrc(undefined, undefined)).toBe("")
  })
})

describe("存储 temu 类别（主图转存前缀）", () => {
  it("resolveCosTarget 按 temuPrefix 路由", () => {
    expect(resolveCosTarget(cfg, "temu")).toEqual({
      bucket: cfg.cosBucket,
      baseUrl: cfg.cosBaseUrl,
      prefix: "temu/",
    })
  })

  it("存量配置缺 temuPrefix 时默认 temu/（loadStorageConfig 以 DEFAULT_STORAGE 合并）", () => {
    expect(DEFAULT_STORAGE.temuPrefix).toBe("temu/")
  })
})
