import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { callJimengApi } from "@/lib/ai/jimeng"
import { validateImageModelConfig } from "@/lib/ai/image-model-config"

/**
 * 即梦适配器拆分请求单测：
 * 单次上游上限 4 张——>4 张自动按 4 张/请求拆分（并发窗口 4，块序稳定），
 * 任一块失败整体抛错；jimengN 不再在适配器覆盖请求张数（相乘已上移到
 * 提交端 submitTaskAction），超量返回原样上抛由上层裁剪。
 */

const MODEL = {
  name: "jimeng-3",
  apiEndpoint: "https://api.example.com/gen",
  apiTimeout: 5,
}
const dl = vi.fn(async (url: string) => url)

function okResponse(images: string[]) {
  return { ok: true, json: async () => ({ images }) }
}

/** 读取第 i 次请求体里的 n */
function requestN(calls: unknown[][], i: number): number {
  return JSON.parse(String((calls[i]![1] as RequestInit).body)).n
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function callWith(imageCount: number, extraConfig: Record<string, unknown> = {}) {
  return callJimengApi({
    model: MODEL,
    task: { prompt: "p", imageSize: "1024x1024", imageCount, referenceImages: [] },
    extraConfig,
    apiKey: "k",
    downloadAndUpload: dl,
  })
}

describe("callJimengApi 请求拆分", () => {
  it("≤4 张单次请求：6→[4,2]、8→[4,4]、3→[3]", async () => {
    fetchMock.mockImplementation(async (_u: unknown, init?: RequestInit) => {
      const n = JSON.parse(String(init!.body)).n as number
      return okResponse(Array.from({ length: n }, (_, i) => `u${i}`))
    })
    await callWith(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestN(fetchMock.mock.calls, 0)).toBe(3)

    fetchMock.mockClear()
    await callWith(6)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestN(fetchMock.mock.calls, 0)).toBe(4)
    expect(requestN(fetchMock.mock.calls, 1)).toBe(2)

    fetchMock.mockClear()
    await callWith(8)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestN(fetchMock.mock.calls, 0)).toBe(4)
    expect(requestN(fetchMock.mock.calls, 1)).toBe(4)
  })

  it("jimengN 不再覆盖请求张数（相乘已在提交端完成）", async () => {
    fetchMock.mockImplementation(async (_u: unknown, init?: RequestInit) => {
      const n = JSON.parse(String(init!.body)).n as number
      return okResponse(Array.from({ length: n }, (_, i) => `u${i}`))
    })
    // 旧版语义：jimengN=4 会把 2 张覆盖成 4；现在按传入的 2 张请求
    await callWith(2, { jimengN: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestN(fetchMock.mock.calls, 0)).toBe(2)
  })

  it("上游超量返回（如固定出 4 张）原样上抛，由上层按需裁剪", async () => {
    fetchMock.mockResolvedValue(okResponse(["a", "b", "c", "d"]))
    const urls = await callWith(2)
    expect(urls).toEqual(["a", "b", "c", "d"])
  })

  it("任一块失败 → 整体抛错（全或无契约）", async () => {
    let call = 0
    fetchMock.mockImplementation(async () => {
      const idx = call++
      if (idx === 1) return { ok: false, status: 502, text: async () => "bad" }
      return okResponse(["a", "b", "c", "d"])
    })
    await expect(callWith(6)).rejects.toThrow("即梦 API 错误 502")
  })

  it("并发窗口 ≤4：32 张 = 8 块，同时在飞最多 4 个请求", async () => {
    let inFlight = 0
    let maxInFlight = 0
    fetchMock.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return okResponse(["u"])
    })
    await callWith(32)
    expect(fetchMock).toHaveBeenCalledTimes(8)
    expect(maxInFlight).toBeLessThanOrEqual(4)
  })

  it("块序稳定：后发的块先返回，结果仍按块序拼接", async () => {
    let call = 0
    fetchMock.mockImplementation(async () => {
      const idx = call++
      if (idx === 0) await new Promise((r) => setTimeout(r, 30)) // 块 0 故意慢
      return okResponse([`c${idx}-a`, `c${idx}-b`])
    })
    const urls = await callWith(6) // [4,2]
    expect(urls.slice(0, 2)).toEqual(["c0-a", "c0-b"])
    expect(urls.slice(2, 4)).toEqual(["c1-a", "c1-b"])
  })
})

describe("validateImageModelConfig jimengN 范围 1-8", () => {
  it("8 通过；9 拒绝（文案 1 到 8）", () => {
    expect(() =>
      validateImageModelConfig({ apiFormat: "jimeng", extraConfig: { jimengN: 8 } }),
    ).not.toThrow()
    expect(() =>
      validateImageModelConfig({ apiFormat: "jimeng", extraConfig: { jimengN: 9 } }),
    ).toThrow("1 到 8")
    expect(() =>
      validateImageModelConfig({ apiFormat: "jimeng", extraConfig: { jimengN: 0 } }),
    ).toThrow("1 到 8")
  })
})
