import { describe, it, expect, vi } from "vitest"
import { createCosAdapter, isOwnCosObjectUrl } from "@/lib/storage/cos"
import type { StorageConfig } from "@/lib/storage/config"

/**
 * 中转服务器预转存跳过单测：
 * - isOwnCosObjectUrl：本桶域名 + key 含本企业段才命中（host 精确匹配、
 *   企业段防跨租户/伪造、https 限定）；
 * - saveFromUrl：命中时原样返回 URL（零网络请求）；外域仍被白名单拒绝；
 * - 本地适配器：同源 /uploads/<entId>/ 对称跳过。
 */

vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" },
}))

const cfg = {
  provider: "cos",
  cosSecretId: "dummy-id",
  cosSecretKey: "dummy-key",
  cosRegion: "ap-guangzhou",
  cosBucket: "hanxing-test",
  cosBaseUrl: "",
  refPrefix: "ref/",
  configPrefix: "config/",
  generatePrefix: "gen/",
  cosForceInternalEndpoint: false,
  localImagePrefix: "image/",
  allowedDownloadHosts: [],
} satisfies StorageConfig

const ENT = "ent-123"
const BUCKET_HOST = "hanxing-test.cos.ap-guangzhou.myqcloud.com"

describe("isOwnCosObjectUrl 中转预转存识别", () => {
  it("本桶域名 + key 含本企业段 → 命中", () => {
    expect(
      isOwnCosObjectUrl(
        new URL(`https://${BUCKET_HOST}/gen/${ENT}/2026/09/u.png`),
        cfg,
        ENT,
      ),
    ).toBe(true)
  })

  it("cosBaseUrl 域名（如 CDN）同样识别", () => {
    expect(
      isOwnCosObjectUrl(
        new URL(`https://img.example.com/gen/${ENT}/2026/09/u.png`),
        { ...cfg, cosBaseUrl: "https://img.example.com" },
        ENT,
      ),
    ).toBe(true)
  })

  it("他企业段 / 无企业段 / http / 外域 → 不命中", () => {
    // 跨租户：桶内对象但 key 是别的企业段，不得复用
    expect(
      isOwnCosObjectUrl(
        new URL(`https://${BUCKET_HOST}/gen/other-ent/2026/09/u.png`),
        cfg,
        ENT,
      ),
    ).toBe(false)
    expect(
      isOwnCosObjectUrl(new URL(`https://${BUCKET_HOST}/gen/2026/09/u.png`), cfg, ENT),
    ).toBe(false)
    expect(
      isOwnCosObjectUrl(new URL(`http://${BUCKET_HOST}/gen/${ENT}/u.png`), cfg, ENT),
    ).toBe(false)
    expect(
      isOwnCosObjectUrl(new URL(`https://evil.com/gen/${ENT}/u.png`), cfg, ENT),
    ).toBe(false)
  })
})

describe("saveFromUrl 中转预转存跳过", () => {
  const adapter = createCosAdapter(cfg)

  it("本桶对象 URL 原样返回（零网络请求）", async () => {
    const url = `https://${BUCKET_HOST}/gen/${ENT}/2026/09/u.png`
    await expect(adapter.saveFromUrl(url, ENT, "generate")).resolves.toBe(url)
  })

  it("外域 URL 仍被下载白名单拒绝", async () => {
    await expect(
      adapter.saveFromUrl(`https://evil.com/gen/${ENT}/u.png`, ENT, "generate"),
    ).rejects.toThrow("白名单")
  })
})

describe("本地适配器同源跳过", () => {
  it("同源 /uploads/<entId>/ 原样返回", async () => {
    const { saveFromUrl } = await import("@/lib/storage/local")
    const url = `https://app.example.com/uploads/${ENT}/image/2026/09/u.png`
    await expect(saveFromUrl(url, ENT)).resolves.toBe(url)
  })
})
