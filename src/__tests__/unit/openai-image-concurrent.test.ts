import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { callOpenAiImageApi } from "@/lib/ai/openai-image"
import { mergeImageResults } from "@/lib/ai/image-model-config"

/**
 * OpenAI 生图并发出图单测（纯函数级：mock fetch + 内存信号量模拟 Redis 槽位）
 *
 * 覆盖：槽位限流下的并发度、等待重试、部分失败聚合、index 保序、
 * 重试补张（indexes 子集）、release 幂等调用、结果合并。
 */

const MODEL = {
  name: "test-model",
  apiEndpoint: "https://api.example.com/v1",
  apiTimeout: 30,
  referenceImageField: undefined,
}

/** 内存信号量：模拟 Redis acquire/release 图片槽位 */
function makeSemaphore(max: number) {
  let inFlight = 0
  let peak = 0
  return {
    async acquire() {
      if (inFlight >= max) return false
      inFlight++
      peak = Math.max(peak, inFlight)
      return true
    },
    async release() {
      inFlight--
    },
    get inFlight() {
      return inFlight
    },
    get peak() {
      return peak
    },
  }
}

/** 计数 fetch mock：默认延迟后返回 succeeded + 带序号的 url；可指定部分调用失败 */
function mockFetch(opts?: {
  delayMs?: number
  failCallIndexes?: number[] // 第 N 次调用（从 1 起）返回 500
}) {
  const delay = opts?.delayMs ?? 80
  const failCalls = new Set(opts?.failCallIndexes ?? [])
  let callCount = 0
  let concurrent = 0
  let peak = 0
  const fn = vi.fn(async () => {
    const n = ++callCount // 固定本次调用序号（await 恢复后共享 callCount 已变）
    concurrent++
    peak = Math.max(peak, concurrent)
    try {
      await new Promise((r) => setTimeout(r, delay))
      if (failCalls.has(n)) {
        return new Response("upstream error", { status: 500 })
      }
      return new Response(
        JSON.stringify({ data: [{ url: `https://img/${n}` }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    } finally {
      concurrent--
    }
  })
  return {
    fn,
    stats: {
      get callCount() {
        return callCount
      },
      get peak() {
        return peak
      },
    },
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("callOpenAiImageApi 并发调度", () => {
  it("槽位限制并发：4 张图、max=2 时同时在途请求 ≤ 2，全部成功且 index 保序", async () => {
    const sem = makeSemaphore(2)
    const { fn, stats } = mockFetch()
    vi.stubGlobal("fetch", fn)

    const results = await callOpenAiImageApi({
      model: MODEL,
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 4 },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
      slots: { acquireSlot: sem.acquire, releaseSlot: sem.release },
    })

    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3])
    expect(results.every((r) => r.url && !r.error)).toBe(true)
    expect(stats.callCount).toBe(4)
    expect(stats.peak).toBeLessThanOrEqual(2)
    expect(sem.peak).toBeLessThanOrEqual(2)
    expect(sem.inFlight).toBe(0) // 全部释放
  })

  it("无槽位回调时不限并发（全部同时发出）", async () => {
    const { fn, stats } = mockFetch()
    vi.stubGlobal("fetch", fn)

    const results = await callOpenAiImageApi({
      model: MODEL,
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 4 },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
    })

    expect(results).toHaveLength(4)
    expect(results.every((r) => r.url)).toBe(true)
    expect(stats.peak).toBe(4)
  })

  it("槽位占满时等待：max=1 两张图串行完成，最终并发峰值 ≤ 1", async () => {
    const sem = makeSemaphore(1)
    const { fn, stats } = mockFetch({ delayMs: 60 })
    vi.stubGlobal("fetch", fn)

    const results = await callOpenAiImageApi({
      model: MODEL,
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 2 },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
      slots: { acquireSlot: sem.acquire, releaseSlot: sem.release },
    })

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.url)).toBe(true)
    expect(stats.peak).toBe(1) // 第二张必须等第一张释放槽位后才发出
    expect(sem.inFlight).toBe(0)
  })

  it("部分失败：单张 500 不影响其他张，失败张返回 error、成功张返回 url", async () => {
    const sem = makeSemaphore(4)
    const { fn } = mockFetch({ failCallIndexes: [2] }) // 第 2 次调用失败
    vi.stubGlobal("fetch", fn)

    const results = await callOpenAiImageApi({
      model: MODEL,
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 4 },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
      slots: { acquireSlot: sem.acquire, releaseSlot: sem.release },
    })

    expect(results).toHaveLength(4)
    const ok = results.filter((r) => r.url)
    const failed = results.filter((r) => r.error)
    expect(ok).toHaveLength(3)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.error).toContain("500")
    expect(sem.inFlight).toBe(0) // 失败张同样释放槽位
  })

  it("indexes 子集（重试补张）：只生成指定序号，结果按 indexes 顺序", async () => {
    const { fn, stats } = mockFetch()
    vi.stubGlobal("fetch", fn)

    const results = await callOpenAiImageApi({
      model: MODEL,
      task: {
        prompt: "p",
        imageSize: "1024x1024",
        imageCount: 4,
        indexes: [1, 3], // 仅补第 2、4 张
      },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
    })

    expect(stats.callCount).toBe(2)
    expect(results.map((r) => r.index)).toEqual([1, 3])
    expect(results.every((r) => r.url)).toBe(true)
  })

  it("外层 signal 中止时：等待槽位的张返回错误，不再发请求", async () => {
    const sem = makeSemaphore(1)
    // 预占唯一槽位 → 所有图都在等待
    await sem.acquire()
    const { fn, stats } = mockFetch({ delayMs: 40 })
    vi.stubGlobal("fetch", fn)

    const controller = new AbortController()
    const promise = callOpenAiImageApi({
      model: MODEL,
      task: { prompt: "p", imageSize: "1024x1024", imageCount: 2 },
      apiKey: "k",
      downloadAndUpload: async (url) => url,
      signal: controller.signal,
      slots: { acquireSlot: sem.acquire, releaseSlot: sem.release },
    })

    // 等待进入槽位等待循环后中止
    setTimeout(() => controller.abort(), 100)
    const results = await promise

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.error && !r.url)).toBe(true)
    expect(stats.callCount).toBe(0) // 从未发出请求
  })
})

describe("mergeImageResults 结果合并", () => {
  it("历史成功 + 本轮成功按序号升序合并，URL 一一对应", () => {
    const { succeededIndexes, resultImages } = mergeImageResults(
      [0],
      ["a"],
      [
        { index: 2, url: "c" },
        { index: 1, url: "b" },
      ],
    )
    expect(succeededIndexes).toEqual([0, 1, 2])
    expect(resultImages).toEqual(["a", "b", "c"])
  })

  it("本轮失败张（error）不覆盖历史成功", () => {
    const { succeededIndexes, resultImages } = mergeImageResults(
      [0, 1],
      ["a", "b"],
      [{ index: 1, error: "重试仍失败" }, { index: 2, url: "c" }],
    )
    expect(succeededIndexes).toEqual([0, 1, 2])
    expect(resultImages).toEqual(["a", "b", "c"])
  })

  it("全部失败时保持历史不变", () => {
    const { succeededIndexes, resultImages } = mergeImageResults(
      [0],
      ["a"],
      [{ index: 1, error: "x" }, { index: 2, error: "y" }],
    )
    expect(succeededIndexes).toEqual([0])
    expect(resultImages).toEqual(["a"])
  })
})
