import { describe, it, expect, afterEach, vi } from "vitest"
import { GET } from "@/app/uploads/[...path]/route"

/**
 * 本地 /uploads 直连路由租户校验单测。
 *
 * 本地存储 key 规范 uploads/<enterpriseId>/...（首段=租户段），此前仅做
 * 「登录即可读」校验，任何企业的已登录用户都能读他企业文件（知道 URL
 * 即可）。本批补齐口径对齐 /api/image/proxy 的 extractTenantSegment：
 * 非本企业且非超管 → 403；_platform 段（头像等平台资产）放行。
 *
 * session / getLocalPath / fs.readFile 均 mock（不读真实文件系统）。
 */
const mockSession = vi.hoisted(() => ({
  user: null as
    | { enterpriseId: string | null; isSuperAdmin?: boolean }
    | null,
}))
vi.mock("@/lib/auth/config", () => ({
  auth: async () => (mockSession.user ? { user: mockSession.user } : null),
}))
vi.mock("@/lib/storage/local", () => ({
  // 鉴权通过后才走到路径解析；返回假绝对路径配合 fs mock
  getLocalPath: () => "/fake/abs/path.png",
}))
// vi.fn 包装以记录调用：403 用例需守护「不读文件」（不触碰他企业内容）
const mockReadFile = vi.hoisted(() =>
  vi.fn(async () => new Uint8Array([1, 2, 3])),
)
vi.mock("node:fs", () => ({
  promises: { readFile: mockReadFile },
}))

const ENT_A = "11111111-1111-1111-1111-111111111111"
const ENT_B = "22222222-2222-2222-2222-222222222222"

function uploadsRequest(...segments: string[]): Promise<{
  req: Request
  ctx: { params: Promise<{ path: string[] }> }
}> {
  return Promise.resolve({
    req: new Request(`http://localhost:3000/uploads/${segments.join("/")}`),
    ctx: { params: Promise.resolve({ path: segments }) },
  })
}

describe("/uploads 直连路由租户校验", () => {
  afterEach(() => {
    mockSession.user = null
    mockReadFile.mockClear()
  })

  it("企业 A 用户读他企业 uploads/<entB>/image/ → 403（不读文件）", async () => {
    mockSession.user = { enterpriseId: ENT_A, isSuperAdmin: false }
    const { req, ctx } = await uploadsRequest(
      ENT_B,
      "image",
      "2026",
      "11",
      "x.png",
    )
    const resp = await GET(req, ctx)
    expect(resp.status).toBe(403)
    // 403 直接返回，不得读取他企业文件内容（防回归为鉴权前读文件）
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it("本企业 uploads/<entA>/image/ → 放行（200）", async () => {
    mockSession.user = { enterpriseId: ENT_A, isSuperAdmin: false }
    const { req, ctx } = await uploadsRequest(
      ENT_A,
      "image",
      "2026",
      "11",
      "x.png",
    )
    const resp = await GET(req, ctx)
    expect(resp.status).toBe(200)
  })

  it("本企业缩略图 uploads/<entA>/thumb/ → 放行", async () => {
    mockSession.user = { enterpriseId: ENT_A, isSuperAdmin: false }
    const { req, ctx } = await uploadsRequest(
      ENT_A,
      "thumb",
      "2026",
      "11",
      "x.png",
    )
    const resp = await GET(req, ctx)
    expect(resp.status).toBe(200)
  })

  it("超管读他企业 → 放行（平台运维视角）", async () => {
    mockSession.user = { enterpriseId: ENT_A, isSuperAdmin: true }
    const { req, ctx } = await uploadsRequest(
      ENT_B,
      "image",
      "2026",
      "11",
      "x.png",
    )
    const resp = await GET(req, ctx)
    expect(resp.status).toBe(200)
  })

  it("_platform 平台资产（头像）→ 任意登录用户放行", async () => {
    mockSession.user = { enterpriseId: ENT_B, isSuperAdmin: false }
    const { req, ctx } = await uploadsRequest(
      "_platform",
      "image",
      "2026",
      "11",
      "x.png",
    )
    const resp = await GET(req, ctx)
    expect(resp.status).toBe(200)
  })
})
