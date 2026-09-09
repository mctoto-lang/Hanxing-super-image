import { describe, it, expect, vi } from "vitest"
import path from "node:path"
import { safeImageExt } from "@/lib/storage/ext"
import { getLocalPath, UPLOAD_ROOT } from "@/lib/storage/local"

/**
 * 存储路径安全单测（审查 H1/H2 修复）：
 * - safeImageExt：上传文件名扩展名白名单，防任意扩展名（html）落盘；
 *   svg 已对配置图开放（上传前 sanitizeSvg 清洗 + 托管强制 attachment
 *   下载，见 svg-sanitize.test.ts），其余端点在上游按 MIME 拒绝；
 * - getLocalPath：本地删除路径困在 uploads 根内，防 query/fragment 携带
 *   ".." 段绕过 URL 规范化造成任意文件删除；
 * - validateReferenceImageUrls：引用图 URL 租户校验 + 穿越段拒绝。
 */

vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" },
}))
vi.mock("@/lib/storage/config", () => ({
  loadStorageConfig: async () => ({}),
}))

describe("safeImageExt 扩展名白名单", () => {
  it("接受白名单扩展名并归一化大小写", () => {
    expect(safeImageExt("photo.jpg")).toBe("jpg")
    expect(safeImageExt("photo.jpeg")).toBe("jpg")
    expect(safeImageExt("photo.PNG")).toBe("png")
    expect(safeImageExt("a.b.webp")).toBe("webp")
    expect(safeImageExt("动图.gif")).toBe("gif")
  })

  it("非图片扩展名一律回落 png（含恶意构造）", () => {
    expect(safeImageExt("x.html")).toBe("png")
    expect(safeImageExt("x.htaccess")).toBe("png")
    // 末段带斜杠的伪造文件名（子路径段），同样不在白名单
    expect(safeImageExt("x./etc/passwd")).toBe("png")
    expect(safeImageExt("noext")).toBe("png")
    expect(safeImageExt("")).toBe("png")
    expect(safeImageExt(undefined)).toBe("png")
    expect(safeImageExt(null)).toBe("png")
  })
})

describe("getLocalPath 删除路径困住", () => {
  const entId = "e7f3"
  it("正常 URL 映射到 uploads 根内", () => {
    expect(getLocalPath(`https://app.example.com/uploads/${entId}/image/2026/08/u.png`)).toBe(
      path.join(UPLOAD_ROOT, entId, "image", "2026", "08", "u.png"),
    )
  })

  it("query 中的 .. 段（URL 规范化不覆盖）返回 null", () => {
    expect(
      getLocalPath(`https://app.example.com/uploads/${entId}/x?a=/../../../../evil`),
    ).toBeNull()
  })

  it("fragment 中的 .. 段返回 null", () => {
    expect(
      getLocalPath(`https://app.example.com/uploads/${entId}/x#/../../../evil`),
    ).toBeNull()
  })

  it("路径中的 .. 越出 uploads 根返回 null（纵深防御）", () => {
    expect(getLocalPath(`https://app.example.com/uploads/${entId}/../../evil`)).toBeNull()
  })
})

describe("validateReferenceImageUrls 引用图校验", () => {
  it("本企业 URL 与 data: URL 放行", async () => {
    const { validateReferenceImageUrls } = await import("@/lib/storage/reference-url")
    const entId = "e7f3"
    expect(
      await validateReferenceImageUrls(
        [`https://app.example.com/uploads/${entId}/image/2026/08/u.png`],
        entId,
      ),
    ).toBeNull()
    expect(
      await validateReferenceImageUrls(["data:image/png;base64,AAAA"], entId),
    ).toBeNull()
  })

  it("跨企业 / 外部域名拒绝", async () => {
    const { validateReferenceImageUrls } = await import("@/lib/storage/reference-url")
    const entId = "e7f3"
    expect(
      await validateReferenceImageUrls(
        ["https://app.example.com/uploads/other-ent/image/2026/08/u.png"],
        entId,
      ),
    ).toContain("本企业")
    expect(
      await validateReferenceImageUrls(
        ["https://evil.example.com/uploads/e7f3/image/u.png"],
        entId,
      ),
    ).toContain("本企业")
  })

  it("query / fragment 携带 .. 段直接拒绝（防 cleanup 任意删除）", async () => {
    const { validateReferenceImageUrls } = await import("@/lib/storage/reference-url")
    const entId = "e7f3"
    expect(
      await validateReferenceImageUrls(
        [`https://app.example.com/uploads/${entId}/x?/../../../../evil`],
        entId,
      ),
    ).toContain("非法")
    expect(
      await validateReferenceImageUrls(
        [`https://app.example.com/uploads/${entId}/x#/../../evil`],
        entId,
      ),
    ).toContain("非法")
  })
})
