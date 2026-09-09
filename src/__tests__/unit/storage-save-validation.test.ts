import { describe, it, expect } from "vitest"
import {
  maskStorageSecret,
  normalizeStorageSubmission,
  type StorageConfig,
} from "@/lib/storage/config"

/**
 * 存储设置保存出口校验单测（normalizeStorageSubmission）：
 * - 全字段 trim（粘贴空白曾是生产签名失效根因之一）；
 * - 「换 SecretId 必须同时换 SecretKey」硬拦截（掩码保留旧密钥 + 新 Id 的
 *   组合签名必然全部失败且无提示，生产已踩）；
 * - 掩码保留旧值 / 全新密钥 / local 切换回退语义不变。
 */

const current: StorageConfig = {
  provider: "cos",
  cosSecretId: "AKIDold",
  cosSecretKey: "old-secret-key",
  cosRegion: "ap-guangzhou",
  cosBucket: "old-1250000000",
  cosBaseUrl: "",
  refPrefix: "ref/",
  configPrefix: "config/",
  generatePrefix: "gen/",
  cosForceInternalEndpoint: false,
  localImagePrefix: "image/",
  allowedDownloadHosts: [],
}

describe("normalizeStorageSubmission 字段规范化", () => {
  it("凭证 / 域名 / 前缀字段一律 trim", () => {
    const r = normalizeStorageSubmission(
      {
        ...current,
        cosSecretId: "  AKIDnew  ",
        cosSecretKey: "\nnew-key\t",
        cosRegion: " ap-shanghai ",
        cosBucket: " hanxing-1250000000 ",
        cosBaseUrl: " https://img.example.com ",
        refPrefix: " ref/ ",
      },
      current,
    )
    expect(r).toMatchObject({
      ok: true,
      value: {
        cosSecretId: "AKIDnew",
        cosRegion: "ap-shanghai",
        cosBucket: "hanxing-1250000000",
        cosBaseUrl: "https://img.example.com",
        refPrefix: "ref/",
      },
      effectiveSecretKey: "new-key",
    })
  })

  it("provider 脏值归一为 local；布尔与白名单列表防御脏数据", () => {
    const r = normalizeStorageSubmission(
      {
        ...current,
        provider: "oss" as StorageConfig["provider"],
        cosForceInternalEndpoint: "yes" as unknown as boolean,
        allowedDownloadHosts: [
          "img.example.com",
          "",
          42 as unknown as string,
          " .cdn.example.com ",
        ],
      },
      current,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.provider).toBe("local")
    expect(r.value.cosForceInternalEndpoint).toBe(false)
    expect(r.value.allowedDownloadHosts).toEqual([
      "img.example.com",
      ".cdn.example.com",
    ])
  })

  it("前缀缺省时回退默认值（Partial 输入）", () => {
    const r = normalizeStorageSubmission({ provider: "local" }, current)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.refPrefix).toBe("ref/")
    expect(r.value.configPrefix).toBe("config/")
    expect(r.value.generatePrefix).toBe("gen/")
    expect(r.value.localImagePrefix).toBe("image/")
  })
})

describe("normalizeStorageSubmission 密钥对成对更换拦截", () => {
  it("换了 SecretId 但 SecretKey 仍是掩码 → 硬拦截", () => {
    const r = normalizeStorageSubmission(
      {
        ...current,
        cosSecretId: "AKIDnew",
        cosSecretKey: maskStorageSecret(current.cosSecretKey),
      },
      current,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("SecretKey")
    expect(r.error).toContain("同时")
  })

  it("SecretId 未变 + 掩码 → 保留旧密钥（含历史值带空白的比较）", () => {
    const r = normalizeStorageSubmission(
      {
        ...current,
        cosSecretId: "AKIDold", // 与 current 一致
        cosSecretKey: maskStorageSecret(current.cosSecretKey),
      },
      current,
    )
    expect(r).toMatchObject({ ok: true, effectiveSecretKey: "old-secret-key" })

    // 历史落库的 SecretId 带尾随空白，提交 trim 后值相同 → 同样视为未变更
    const r2 = normalizeStorageSubmission(
      {
        ...current,
        cosSecretId: "AKIDold",
        cosSecretKey: maskStorageSecret(current.cosSecretKey),
      },
      { ...current, cosSecretId: "AKIDold " },
    )
    expect(r2).toMatchObject({ ok: true, effectiveSecretKey: "old-secret-key" })
  })

  it("SecretId 与 SecretKey 成对更换 → 放行", () => {
    const r = normalizeStorageSubmission(
      {
        ...current,
        cosSecretId: "AKIDnew",
        cosSecretKey: "brand-new-key",
      },
      current,
    )
    expect(r).toMatchObject({ ok: true, effectiveSecretKey: "brand-new-key" })
  })

  it("provider=local 时密钥字段与 COS 无关，不拦截", () => {
    const r = normalizeStorageSubmission(
      {
        ...current,
        provider: "local",
        cosSecretId: "AKIDchanged",
        cosSecretKey: maskStorageSecret(current.cosSecretKey),
      },
      current,
    )
    expect(r.ok).toBe(true)
  })

  it("清空 SecretKey（空串，切回 local 场景）→ 不视为掩码，照常清空", () => {
    const r = normalizeStorageSubmission(
      { ...current, cosSecretKey: "  " },
      current,
    )
    expect(r).toMatchObject({ ok: true, effectiveSecretKey: "" })
  })
})
