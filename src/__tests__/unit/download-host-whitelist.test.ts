import { describe, it, expect } from "vitest"
import { checkTrustedDownloadHost } from "@/lib/storage/local"
import {
  checkAllowedDownloadHost,
  isAllowedDownloadHost,
} from "@/lib/storage/cos"
import {
  buildDownloadRefusalError,
  DOWNLOAD_REFUSAL_URL_MAX,
  type StorageConfig,
} from "@/lib/storage/config"

/**
 * 下载白名单口径单测（local / cos 适配器共用语义）：
 * - 显式白名单（allowedDownloadHosts）与模型端点同站提示（hostHints）放行 http
 *   ——本机反代/网关（如 jimeng-free-api 部署在 127.0.0.1）回传指向自身的
 *   图片地址无法挂 https 证书，这是「加了白名单仍下载失败」的根因修复；
 * - 其余路径（默认 CDN 后缀、COS、同源）仍强制 https，防内网探测被动触发；
 * - 拒绝报错携带完整 URL（截断保护）并区分「非 https」与「不在白名单」。
 */

const EMPTY_CFG: StorageConfig = {
  provider: "local",
  cosSecretId: "",
  cosSecretKey: "",
  cosRegion: "",
  cosBucket: "",
  cosBaseUrl: "",
  refPrefix: "ref/",
  configPrefix: "config/",
  generatePrefix: "gen/",
  cosForceInternalEndpoint: false,
  localImagePrefix: "image/",
  allowedDownloadHosts: [],
}

function cfgWith(hosts: string[]): StorageConfig {
  return { ...EMPTY_CFG, allowedDownloadHosts: hosts }
}

describe("显式白名单放行 http 源站", () => {
  it("http + 精确 IP host（127.0.0.1 本机反代）放行", () => {
    const url = new URL("http://127.0.0.1:8080/files/a.png?sig=x")
    expect(checkTrustedDownloadHost(url, ["127.0.0.1"], [])).toEqual({ ok: true })
    expect(
      checkAllowedDownloadHost(url, cfgWith(["127.0.0.1"]), []),
    ).toEqual({ ok: true })
  })

  it("http + \".\" 开头后缀放行", () => {
    const url = new URL("http://img.lan.example.com/a.png")
    expect(
      checkTrustedDownloadHost(url, [".lan.example.com"], []),
    ).toEqual({ ok: true })
    expect(
      checkAllowedDownloadHost(url, cfgWith([".lan.example.com"]), []),
    ).toEqual({ ok: true })
  })

  it("白名单后缀不匹配裸注册域（.lan.example.com 不放行 example.com）", () => {
    const url = new URL("http://example.com/a.png")
    expect(checkTrustedDownloadHost(url, [".lan.example.com"], [])).toEqual({
      ok: false,
      reason: "protocol",
      host: "example.com",
    })
  })
})

describe("模型端点同站提示（hostHints）放行 http", () => {
  it("http + 与端点同 host 放行（反代回传指向自身）", () => {
    const url = new URL("http://127.0.0.1:8080/files/a.png")
    expect(checkTrustedDownloadHost(url, [], ["127.0.0.1"])).toEqual({ ok: true })
    expect(checkAllowedDownloadHost(url, EMPTY_CFG, ["127.0.0.1"])).toEqual({
      ok: true,
    })
  })

  it("http + 端点同注册域的子域放行（api.foo.com 端点 → img.foo.com 图）", () => {
    const url = new URL("http://img.foo.com/a.png")
    expect(checkTrustedDownloadHost(url, [], ["api.foo.com"])).toEqual({ ok: true })
  })

  it("https + 端点同站放行（回归：原有行为）", () => {
    const url = new URL("https://img.foo.com/a.png")
    expect(checkTrustedDownloadHost(url, [], ["api.foo.com"])).toEqual({ ok: true })
    expect(checkAllowedDownloadHost(url, EMPTY_CFG, ["api.foo.com"])).toEqual({
      ok: true,
    })
  })
})

describe("其余路径仍强制 https", () => {
  it("http + 默认 CDN 后缀（byteimg.com）拒绝，reason=protocol", () => {
    const url = new URL("http://p3-dreamina-sign.byteimg.com/a.png")
    expect(checkTrustedDownloadHost(url, [], [])).toEqual({
      ok: false,
      reason: "protocol",
      host: "p3-dreamina-sign.byteimg.com",
    })
    expect(checkAllowedDownloadHost(url, EMPTY_CFG, [])).toEqual({
      ok: false,
      reason: "protocol",
      host: "p3-dreamina-sign.byteimg.com",
    })
  })

  it("https + 默认 CDN 后缀放行（回归）", () => {
    const url = new URL("https://p3-dreamina-sign.byteimg.com/a.png")
    expect(checkTrustedDownloadHost(url, [], [])).toEqual({ ok: true })
    expect(checkAllowedDownloadHost(url, EMPTY_CFG, [])).toEqual({ ok: true })
  })

  it("https + 陌生域名拒绝，reason=host", () => {
    const url = new URL("https://img.unknown.com/a.png")
    expect(checkTrustedDownloadHost(url, [], [])).toEqual({
      ok: false,
      reason: "host",
      host: "img.unknown.com",
    })
    expect(checkAllowedDownloadHost(url, EMPTY_CFG, [])).toEqual({
      ok: false,
      reason: "host",
      host: "img.unknown.com",
    })
  })

  it("http + 陌生域名且无白名单 → 先按 protocol 拒绝（非「不在白名单」误导）", () => {
    const url = new URL("http://169.254.169.254/latest/meta-data")
    const localCheck = checkTrustedDownloadHost(url, [], [])
    expect(localCheck.ok).toBe(false)
    expect(localCheck.ok || localCheck.reason).toBe("protocol")
    const cosCheck = checkAllowedDownloadHost(url, EMPTY_CFG, [])
    expect(cosCheck.ok).toBe(false)
    expect(cosCheck.ok || cosCheck.reason).toBe("protocol")
  })
})

describe("local 与 cos 判定口径一致", () => {
  const cases: Array<{ url: string; hosts: string[]; hints: string[] }> = [
    { url: "http://127.0.0.1:8080/a.png", hosts: ["127.0.0.1"], hints: [] },
    { url: "http://127.0.0.1:8080/a.png", hosts: [], hints: ["127.0.0.1"] },
    { url: "http://127.0.0.1:8080/a.png", hosts: [], hints: [] },
    { url: "https://img.foo.com/a.png", hosts: [], hints: ["api.foo.com"] },
    { url: "http://p9-douyinpic.com/a.png", hosts: [], hints: [] },
    { url: "https://img.unknown.com/a.png", hosts: [".other.com"], hints: [] },
    { url: "https://img.unknown.com/a.png", hosts: ["img.unknown.com"], hints: [] },
  ]
  for (const { url, hosts, hints } of cases) {
    it(`${url}（白名单 ${hosts.join(",") || "空"} / hint ${hints.join(",") || "空"}）`, () => {
      expect(checkTrustedDownloadHost(new URL(url), hosts, hints)).toEqual(
        checkAllowedDownloadHost(new URL(url), cfgWith(hosts), hints),
      )
    })
  }

  it("isAllowedDownloadHost 布尔包装与结构化判定一致", () => {
    const url = new URL("http://127.0.0.1:8080/a.png")
    expect(isAllowedDownloadHost(url, cfgWith(["127.0.0.1"]))).toBe(true)
    expect(isAllowedDownloadHost(url, EMPTY_CFG)).toBe(false)
  })
})

describe("拒绝报错携带完整 URL（截断保护）", () => {
  it("protocol 原因：含完整 URL、host 与放行指引", () => {
    const url = new URL("http://127.0.0.1:8080/files/a.png?sig=abc")
    const err = buildDownloadRefusalError(url, "protocol")
    expect(err.message).toContain("非 https")
    expect(err.message).toContain("http://127.0.0.1:8080/files/a.png?sig=abc")
    expect(err.message).toContain("127.0.0.1")
    expect(err.message).toContain("额外可信下载域名")
  })

  it("host 原因：含域名、完整 URL 与重试指引", () => {
    const url = new URL("https://img.unknown.com/a.png?sig=abc")
    const err = buildDownloadRefusalError(url, "host")
    expect(err.message).toContain("目标域名 img.unknown.com 不在可信白名单内")
    expect(err.message).toContain("https://img.unknown.com/a.png?sig=abc")
    expect(err.message).toContain("额外可信下载域名")
  })

  it("超长 URL 截断到 DOWNLOAD_REFUSAL_URL_MAX", () => {
    const longQuery = "sig=" + "x".repeat(500)
    const url = new URL(`https://img.unknown.com/a.png?${longQuery}`)
    const err = buildDownloadRefusalError(url, "host")
    // 去掉固定文案骨架后，URL 部分不应超过上限（+1 为截断省略号）
    const urlPart = err.message.match(/（([^）]*)）/)?.[1] ?? ""
    expect(urlPart.length).toBeLessThanOrEqual(DOWNLOAD_REFUSAL_URL_MAX + 1)
    expect(urlPart.endsWith("…")).toBe(true)
  })
})
