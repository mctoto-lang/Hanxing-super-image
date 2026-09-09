import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { verifyCosConfig } from "@/lib/storage/cos"

/**
 * 保存设置时 COS 连通性自检单测（verifyCosConfig）：
 * - 成功路径与 headBucket 传参（Bucket/Region/内网 Domain）；
 * - SDK restful 错误（XML body）→ 可操作中文提示（签名不匹配 / 桶不存在 /
 *   无权限），网络错误与超时的兜底文案；
 * - 内网开关开启时自检走 tencentcos.cn，开关误开能在保存当场暴露。
 */

const { headBucket } = vi.hoisted(() => ({ headBucket: vi.fn() }))

// 普通函数才能被 new 调用（verifyCosConfig 内部 new COS(...)）
vi.mock("cos-nodejs-sdk-v5", () => ({
  default: vi.fn(function () {
    return { headBucket }
  }),
}))

const input = {
  cosSecretId: "AKIDtest",
  cosSecretKey: "test-key",
  cosRegion: "ap-guangzhou",
  cosBucket: "hanxing-test-1250000000",
}

/** SDK restful 错误体：statusCode + XML 字符串 */
const sdkError = (statusCode: number, code: string, message: string) => ({
  statusCode,
  error: `<Error><Code>${code}</Code><Message>${message}</Message></Error>`,
})

beforeEach(() => {
  headBucket.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("verifyCosConfig 成功与传参", () => {
  it("headBucket 通过 → ok，公网模式不带 Domain", async () => {
    headBucket.mockImplementation(
      (_p: unknown, cb: (e: unknown) => void) => cb(null),
    )
    await expect(verifyCosConfig(input)).resolves.toEqual({ ok: true })
    const params = headBucket.mock.calls[0]![0] as Record<string, unknown>
    expect(params).toMatchObject({
      Bucket: "hanxing-test-1250000000",
      Region: "ap-guangzhou",
    })
    expect(params.Domain).toBeUndefined()
  })

  it("内网开关开启 → Domain 改写为 tencentcos.cn 内网域名", async () => {
    headBucket.mockImplementation(
      (_p: unknown, cb: (e: unknown) => void) => cb(null),
    )
    await expect(
      verifyCosConfig({ ...input, cosForceInternalEndpoint: true }),
    ).resolves.toEqual({ ok: true })
    const params = headBucket.mock.calls[0]![0] as Record<string, unknown>
    expect(params.Domain).toBe(
      "hanxing-test-1250000000.cos.ap-guangzhou.tencentcos.cn",
    )
  })
})

describe("verifyCosConfig 错误映射", () => {
  it.each([
    {
      err: sdkError(
        403,
        "SignatureDoesNotMatch",
        "The Signature you specified is invalid.",
      ),
      expect: "SecretId/SecretKey",
    },
    {
      err: sdkError(404, "NoSuchBucket", "The specified bucket does not exist."),
      expect: "桶不存在",
    },
    {
      err: sdkError(403, "AccessDenied", "Access Denied."),
      expect: "权限",
    },
  ])("SDK 错误 → 可操作提示（$expect）", async ({ err, expect: kw }) => {
    headBucket.mockImplementation(
      (_p: unknown, cb: (e: unknown) => void) => cb(err),
    )
    const r = await verifyCosConfig(input)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain(kw)
  })

  it("网络错误（无 statusCode）→ 无法连接提示", async () => {
    headBucket.mockImplementation(
      (_p: unknown, cb: (e: unknown) => void) =>
        cb({ error: "getaddrinfo ENOENT cos.ap-guangzhou.myqcloud.com" }),
    )
    const r = await verifyCosConfig(input)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("无法连接")
    expect(r.error).not.toContain("内网")
  })

  it("网络错误 + 内网开关 → 提示检查内网域名开关", async () => {
    headBucket.mockImplementation(
      (_p: unknown, cb: (e: unknown) => void) =>
        cb({ error: "connect ETIMEDOUT 10.0.0.1:443" }),
    )
    const r = await verifyCosConfig({ ...input, cosForceInternalEndpoint: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("内网域名开关")
  })

  it("headBucket 挂起不返回 → 10s 超时兜底，不无限等待", async () => {
    vi.useFakeTimers()
    headBucket.mockImplementation(() => {
      /* 模拟永不回调 */
    })
    const pending = verifyCosConfig(input)
    const assertion = expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("超时") as string,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })
})
