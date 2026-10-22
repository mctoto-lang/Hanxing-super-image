import { afterEach, describe, expect, it, vi } from "vitest"
import {
  callTemuApi,
  forEachTemuPage,
  gatewayForType,
  gatewayUrl,
  isTemuNetworkError,
  isTemuPermissionError,
  isTemuTokenExpired,
  resetTemuRateGateForTest,
  TemuApiError,
} from "@/lib/temu-api/client"
import { signTemuRequest } from "@/lib/temu-api/sign"

/**
 * TEMU API 客户端单测（mock fetchImpl，不发真实请求）：
 * 网关路由（PA 迁移表）、公共参数与签名、响应 envelope、错误码映射、翻页字段、
 * 跨进程限速闸门（mock ../../lib/redis，默认 eval 恒放行不影响其余用例）。
 */

const gate = vi.hoisted(() => ({
  /** 可替换的 eval 行为：返回需等待毫秒（>0 等待重试），0=放行，抛错=Redis 故障 */
  evalImpl: async (..._args: unknown[]): Promise<number> => 0,
  calls: [] as Array<{ key: string; arg: number }>,
}))

vi.mock("../../lib/redis", () => ({
  redis: {
    eval: (_script: string, _numKeys: number, key: string, arg: number) => {
      gate.calls.push({ key, arg })
      return gate.evalImpl(_script, _numKeys, key, arg)
    },
  },
}))

const CTX = {
  appKey: "47bb4bb7769e12d9f7aa93cf029fe529",
  appSecret: "ac0a3e952eaaa5b19c0e615c2ef497f50afa6e49",
  accessToken: "test-access-token",
  fetchImpl: undefined,
}

function okEnvelope(result: unknown) {
  return {
    json: async () => ({ result, success: true, errorCode: 1000000, errorMsg: "" }),
    ok: true,
    status: 200,
  } as unknown as Response
}

function errEnvelope(errorCode: number, errorMsg: string) {
  return {
    json: async () => ({ result: null, success: false, errorCode, errorMsg, requestId: "req-1" }),
    ok: true,
    status: 200,
  } as unknown as Response
}

describe("gatewayForType", () => {
  it("已迁移接口走 PA 网关", () => {
    expect(gatewayForType("bg.glo.goods.list.get")).toBe("PA")
    expect(gatewayForType("bg.glo.product.search")).toBe("PA")
    expect(gatewayForType("bg.goods.salesv2.get")).toBe("CN")
    expect(gatewayForType("bg.mall.info.get")).toBe("CN")
    expect(gatewayForType("bg.glo.searchrec.ad.reports.mall.query")).toBe("PA")
    expect(gatewayForType("bg.semi.price.review.confirm.order")).toBe("PA")
  })

  it("网关地址常量", () => {
    expect(gatewayUrl("CN")).toBe("https://openapi.kuajingmaihuo.com/openapi/router")
    expect(gatewayUrl("PA")).toBe("https://openapi-b-partner.temu.com/openapi/router")
  })
})

describe("callTemuApi", () => {
  it("组装公共参数并附带与签名函数一致的 sign", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.type).toBe("bg.mall.info.get")
      expect(body.app_key).toBe(CTX.appKey)
      expect(body.access_token).toBe(CTX.accessToken)
      expect(body.data_type).toBe("JSON")
      expect(typeof body.timestamp).toBe("number")
      const { sign, ...rest } = body
      expect(sign).toBe(signTemuRequest(rest, CTX.appSecret))
      return okEnvelope({ semiManagedMall: false })
    })
    const envelope = await callTemuApi("bg.mall.info.get", {}, { ...CTX, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(envelope.success).toBe(true)
    expect(envelope.result).toEqual({ semiManagedMall: false })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("bg.glo.* 打到 PA 网关地址", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://openapi-b-partner.temu.com/openapi/router")
      return okEnvelope({ data: [] })
    })
    await callTemuApi("bg.glo.goods.list.get", {}, { ...CTX, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("业务失败抛 TemuApiError 且带错误码", async () => {
    const fetchImpl = vi.fn(async () => errEnvelope(1000003, "参数错误"))
    await expect(
      callTemuApi("bg.goods.salesv2.get", {}, { ...CTX, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "TemuApiError", errorCode: 1000003 })
  })

  it("7000007 映射为 token 过期错误（isTemuTokenExpired 命中）", async () => {
    const fetchImpl = vi.fn(async () => errEnvelope(7000007, "access_token is expired"))
    const err = await callTemuApi("bg.mall.info.get", {}, {
      ...CTX,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e: unknown) => e)
    expect(isTemuTokenExpired(err)).toBe(true)
    expect(err).toBeInstanceOf(TemuApiError)
  })

  it("权限类错误码命中 isTemuPermissionError", () => {
    const err = new TemuApiError("x", { errorCode: 7000022, apiType: "t", gateway: "PA" })
    expect(isTemuPermissionError(err)).toBe(true)
    const other = new TemuApiError("x", { errorCode: 1000003, apiType: "t", gateway: "CN" })
    expect(isTemuPermissionError(other)).toBe(false)
  })

  it("HTTP 非 200 抛 TemuApiError", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 502 }) as unknown as Response,
    )
    await expect(
      callTemuApi("bg.mall.info.get", {}, { ...CTX, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "TemuApiError" })
  })

  it("瞬时错误码（100000000/4000000 等）延迟重试一次后成功", async () => {
    for (const code of [100000000, 4000000]) {
      const fetchImpl = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(errEnvelope(code, "transient"))
        .mockResolvedValueOnce(okEnvelope({ data: [] }))
      const envelope = await callTemuApi("bg.goods.salesv2.get", {}, {
        ...CTX,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        rateKey: `retry-${code}`,
      })
      expect(envelope.success).toBe(true)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    }
  })

  it("牛皮癣「处理中」（5000000）延迟重试一次后成功", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(errEnvelope(5000000, "Image processing in progress"))
      .mockResolvedValueOnce(okEnvelope({ list: [{ imageUrl: "https://x/1.jpg", hasSpot: "false" }] }))
    const envelope = await callTemuApi("bg.compliancepicture.get.global", {}, {
      ...CTX,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateKey: "retry-5000000",
    })
    expect(envelope.success).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("网络层失败（fetch failed）延迟重试一次后成功", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okEnvelope({ data: [] }))
    const envelope = await callTemuApi("bg.glo.goods.list.get", {}, {
      ...CTX,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateKey: "retry-network-ok",
    })
    expect(envelope.success).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("网络层失败重试仍失败→抛 TemuNetworkError 且信息含底层 cause", async () => {
    const cause = Object.assign(new Error("connect ECONNRESET 1.2.3.4:443"), {
      code: "ECONNRESET",
    })
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValue(new TypeError("fetch failed", { cause }))
    await expect(
      callTemuApi("bg.glo.goods.list.get", {}, {
        ...CTX,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        rateKey: "retry-network-fail",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!isTemuNetworkError(err)) return false
      return err.message.includes("fetch failed") && err.message.includes("ECONNRESET")
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("瞬时错误码重试仍失败则抛出最后一次错误", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(errEnvelope(100000000, "query warehouse sales info error"))
    await expect(
      callTemuApi("bg.goods.salesv2.get", {}, { ...CTX, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ errorCode: 100000000 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("非瞬时错误码不重试", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(errEnvelope(1000003, "参数错误"))
    await expect(
      callTemuApi("bg.goods.salesv2.get", {}, { ...CTX, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ errorCode: 1000003 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe("forEachTemuPage", () => {
  it("默认 pageNo 字段，支持 pageField 覆盖（goods-list 用 page）", async () => {
    const seenPages: Array<[string, number]> = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const page = body.page ?? body.pageNo ?? body.pageNum
      const field = body.page !== undefined ? "page" : body.pageNo !== undefined ? "pageNo" : "pageNum"
      seenPages.push([field, Number(page)])
      // 第 1 页满页，第 2 页半页 → 停
      return okEnvelope({ data: Number(page) === 1 ? new Array(2).fill({}) : [{}] })
    })
    const handle = vi.fn(async (result: { data: unknown[] }) => result.data.length >= 2)
    await forEachTemuPage("bg.glo.goods.list.get", {}, {
      ...CTX,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }, handle, { pageSize: 2, pageField: "page" })
    expect(seenPages).toEqual([["page", 1], ["page", 2]])
    expect(handle).toHaveBeenCalledTimes(2)
  })
})

describe("跨进程限速闸门", () => {
  afterEach(() => {
    resetTemuRateGateForTest()
    gate.evalImpl = async () => 0
    gate.calls.length = 0
    vi.restoreAllMocks()
  })

  it("闸门要求等待时按指示延迟后重试放行，最小间隔按 qps 换算", async () => {
    gate.calls.length = 0
    let evalN = 0
    const seq = [120, 0]
    gate.evalImpl = async () => seq[Math.min(evalN++, seq.length - 1)]
    const fetchImpl = vi.fn(async () => okEnvelope({}))
    const t0 = Date.now()
    const envelope = await callTemuApi("bg.mall.info.get", {}, {
      ...CTX,
      rateKey: "gate-wait",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(envelope.success).toBe(true)
    // 第一次 eval 返回等待 120ms → 睡 120ms 后第二次放行
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110)
    expect(gate.calls.length).toBe(2)
    // qps=3 → 最小间隔 334ms
    expect(gate.calls.every((c) => c.arg === 334)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("Redis eval 失败时一次性降级放行且只 warn 一次", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    gate.evalImpl = async () => {
      throw new Error("redis down")
    }
    const fetchImpl = vi.fn(async () => okEnvelope({}))
    const t0 = Date.now()
    await callTemuApi("bg.mall.info.get", {}, {
      ...CTX,
      rateKey: "gate-down-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await callTemuApi("bg.mall.info.get", {}, {
      ...CTX,
      rateKey: "gate-down-2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    // 降级后不阻塞、后续调用不再触达 Redis
    expect(Date.now() - t0).toBeLessThan(500)
    expect(gate.calls.length).toBe(1)
    expect(warn).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
