import { describe, it, expect, afterEach, vi } from "vitest"
import { GET } from "@/app/api/image/proxy/route"
import type { StorageConfig } from "@/lib/storage/config"

/**
 * 图片代理租户绑定单测（extractTenantSegment 前缀清单）：
 * COS 模式下租户内容前缀（ref/、gen/、temu/、inventory/，key 第二段为
 * 企业 ID）只允许本企业用户/超管经代理取图。inventory/ 曾漏在前缀清单外，
 * 导致任意已登录用户可跨企业读取库存档案图。
 *
 * session / 存储配置均 mock（不打真库 system_setting）；同企业放行用例的
 * 上游 fetch 也 mock（本套测试从不发起真实网络请求）。
 */
const mockSession = vi.hoisted(() => ({
  user: null as { enterpriseId: string; isSuperAdmin?: boolean } | null,
}))
vi.mock("@/lib/auth/config", () => ({
  auth: async () => (mockSession.user ? { user: mockSession.user } : null),
}))

/** 与集成测试夹具同款的假 COS 配置（本套测试从不发起 COS 请求） */
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

const ENT_A = "ent-a"
const ENT_B = "ent-b"

function proxyRequest(pathname: string): Request {
  const target = `https://${storageCfg.cosBucket}.cos.${storageCfg.cosRegion}.myqcloud.com${pathname}`
  return new Request(
    `http://localhost:3000/api/image/proxy?url=${encodeURIComponent(target)}`,
  )
}

describe("图片代理租户绑定（inventory 前缀）", () => {
  afterEach(() => {
    mockSession.user = null
    vi.unstubAllGlobals()
  })

  it("企业 A 用户请求他企业 inventory/<entIdB>/ 图 → 403，不回源", async () => {
    mockSession.user = { enterpriseId: ENT_A, isSuperAdmin: false }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const resp = await GET(proxyRequest(`/inventory/${ENT_B}/2026/11/x.png`))
    expect(resp.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("本企业 inventory 图 → 放行并透传上游（防止修复后误伤）", async () => {
    mockSession.user = { enterpriseId: ENT_A, isSuperAdmin: false }
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const resp = await GET(proxyRequest(`/inventory/${ENT_A}/2026/11/x.png`))
    expect(resp.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("图片代理租户绑定（gen/thumb 缩略图前缀）", () => {
  afterEach(() => {
    mockSession.user = null
    vi.unstubAllGlobals()
  })

  it("本企业 gen/thumb/<entId>/ 缩略图 → 放行（修复 thumb 误判租户段）", async () => {
    mockSession.user = { enterpriseId: ENT_A, isSuperAdmin: false }
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const resp = await GET(proxyRequest(`/gen/thumb/${ENT_A}/2026/11/x.png`))
    expect(resp.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("企业 A 用户请求他企业 gen/thumb/<entIdB>/ → 403，不回源", async () => {
    mockSession.user = { enterpriseId: ENT_A, isSuperAdmin: false }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const resp = await GET(proxyRequest(`/gen/thumb/${ENT_B}/2026/11/x.png`))
    expect(resp.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
