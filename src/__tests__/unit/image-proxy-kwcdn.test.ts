import { describe, it, expect, afterEach, vi } from "vitest"
import { GET } from "@/app/api/image/proxy/route"
import type { StorageConfig } from "@/lib/storage/config"

/**
 * 图片代理 kwcdn 静态放行单测（isAllowedHost 的 TEMU 官方 CDN 分支）：
 * 商品主图未转存时表格 <img> 直连 kwcdn 外链，点击放大（ZoomableImage →
 * ImageViewer）经 toImageSrc 送 /api/image/proxy，代理对 kwcdn.com /
 * *.kwcdn.com 静态放行（固定公共 CDN，无 SSRF 面）。该分支此前无测试覆盖：
 * endsWith 被改成 includes、精确匹配被改成前缀匹配等回归不会被捕获。
 *
 * session / 存储配置均 mock（不打真库 system_setting；allowedDownloadHosts
 * 置空，确保只命中静态分支而非配置白名单）；放行用例的上游 fetch 也 mock
 * （本套测试从不发起真实网络请求）。
 */
const mockSession = vi.hoisted(() => ({
  user: null as { enterpriseId: string; isSuperAdmin?: boolean } | null,
}))
vi.mock("@/lib/auth/config", () => ({
  auth: async () => (mockSession.user ? { user: mockSession.user } : null),
}))

/** 与 image-proxy-tenant.test.ts 同款的假 COS 配置（本套测试从不发起 COS 请求） */
const storageCfg = vi.hoisted((): StorageConfig => ({
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
  inventoryPrefix: "inventory/",
  cosForceInternalEndpoint: false,
  localImagePrefix: "image/",
  allowedDownloadHosts: [],
}))

// 只替换 loadStorageConfig（避免打真库），host 白名单/内网改写保持真实实现
vi.mock("@/lib/storage/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/config")>()
  return { ...actual, loadStorageConfig: async () => storageCfg }
})

function proxyRequest(target: string): Request {
  return new Request(
    `http://localhost:3000/api/image/proxy?url=${encodeURIComponent(target)}`,
  )
}

describe("图片代理 kwcdn 静态放行", () => {
  afterEach(() => {
    mockSession.user = null
    vi.unstubAllGlobals()
  })

  it("https://img.kwcdn.com 子域 → 放行回源原 URL（ImageViewer 放大链路），缓存 24h", async () => {
    mockSession.user = { enterpriseId: "ent-a", isSuperAdmin: false }
    // _url 注解使 mock.calls 元组带参（与 temu-fulfillment.test.ts 同款），否则 calls[0][0] 类型为空元组
    const fetchMock = vi.fn(async (_url: string) => new Response("ok", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const target = "https://img.kwcdn.com/afi/x.webp"
    const resp = await GET(proxyRequest(target))
    expect(resp.status).toBe(200)
    // 外域不附上传令牌、不改写内网域名，回源 URL 即目标原样
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(target)
    // 非自有存储：24h 缓存，不吃 1 年 immutable
    expect(resp.headers.get("Cache-Control")).toBe("public, max-age=86400")
  })

  it("https://kwcdn.com 裸域 → 放行", async () => {
    mockSession.user = { enterpriseId: "ent-a", isSuperAdmin: false }
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const resp = await GET(proxyRequest("https://kwcdn.com/x.webp"))
    expect(resp.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("https://x.kwcdn.com.evil.com（后缀后接内容）→ 403，不回源", async () => {
    mockSession.user = { enterpriseId: "ent-a", isSuperAdmin: false }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const resp = await GET(proxyRequest("https://x.kwcdn.com.evil.com/x.webp"))
    expect(resp.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("https://kwcdn.com.evil.com（裸域前缀伪装）→ 403，不回源", async () => {
    mockSession.user = { enterpriseId: "ent-a", isSuperAdmin: false }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const resp = await GET(proxyRequest("https://kwcdn.com.evil.com/x.webp"))
    expect(resp.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("https://evil-kwcdn.com（连字符伪子域）→ 403，不回源", async () => {
    mockSession.user = { enterpriseId: "ent-a", isSuperAdmin: false }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const resp = await GET(proxyRequest("https://evil-kwcdn.com/x.webp"))
    expect(resp.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("http://img.kwcdn.com → 403（kwcdn 不豁免 https 强制），不回源", async () => {
    mockSession.user = { enterpriseId: "ent-a", isSuperAdmin: false }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const resp = await GET(proxyRequest("http://img.kwcdn.com/x.webp"))
    expect(resp.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
