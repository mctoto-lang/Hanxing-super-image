import { describe, it, expect, vi, beforeAll } from "vitest"

/**
 * 滑动窗口消费循环单测（processQueueContinuous）
 *
 * 验证相对 processQueueOnce 的核心改进：批内慢任务（大图生成可达分钟级）
 * 不再阻塞同企业后续任务的补位——任务完成即在下一个 tick 出队新任务，
 * 同时进程内 in-flight 不超过 WORKER_TASK_CONCURRENCY。
 *
 * 全依赖 mock（db / task-queue / ai / storage / actions），不触 PG/Redis。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface MockTask {
  taskId: string
  prompt: string
}

/** 测试运行时状态（vi.hoisted 供 mock 工厂引用） */
const state = vi.hoisted(() => ({
  /** 待出队任务（FIFO） */
  queue: [] as MockTask[],
  /** 事件流：start:<prompt> / end:<prompt> */
  events: [] as string[],
  concurrent: 0,
  peak: 0,
}))

vi.mock("@/lib/env", () => ({
  env: { WORKER_TASK_CONCURRENCY: 3, QUEUE_POLL_INTERVAL_MS: 2000 },
}))

vi.mock("@/lib/queue/task-queue", () => ({
  listEnterprisesWithPendingTasks: vi.fn(async () => ["ent-1"]),
  dequeueNext: vi.fn(async () => {
    const t = state.queue.shift()
    if (!t) return null
    return {
      taskId: t.taskId,
      enterpriseId: "ent-1",
      modelId: "model-1",
      prompt: t.prompt,
      imageSize: "1024x1024",
      imageCount: 1,
      referenceImages: [],
      priority: 0,
      costPerImage: 1,
      apiTimeout: 30,
      taskTimeout: 300_000,
      maxRetries: 0,
      conversationId: null,
    }
  }),
  acquireImageSlot: vi.fn(async () => true),
  releaseImageSlot: vi.fn(async () => undefined),
  completeTask: vi.fn(async () => undefined),
  failTask: vi.fn(async () => undefined),
  setTaskPendingIndexes: vi.fn(async () => undefined),
  isTaskInQueue: vi.fn(async () => false),
  getTaskStatus: vi.fn(async () => null),
  enqueue: vi.fn(async () => undefined),
}))

vi.mock("@/lib/ai", () => ({
  callImageApi: vi.fn(
    async (opts: { prompt: string; imageCount: number; indexes?: number[] }) => {
      const slow = opts.prompt === "slow"
      const indexes =
        opts.indexes && opts.indexes.length > 0
          ? opts.indexes
          : Array.from({ length: opts.imageCount }, (_, i) => i)
      state.concurrent++
      state.peak = Math.max(state.peak, state.concurrent)
      state.events.push(`start:${opts.prompt}`)
      try {
        await new Promise((r) => setTimeout(r, slow ? 400 : 30))
        state.events.push(`end:${opts.prompt}`)
        return indexes.map((i) => ({ index: i, url: `https://cos/${opts.prompt}/${i}` }))
      } finally {
        state.concurrent--
      }
    },
  ),
}))

vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(async () => ({})),
}))

vi.mock("@/server/actions/create", () => ({
  refundFailedTask: vi.fn(async () => undefined),
}))

vi.mock("@/db/client", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema")
  /** 按表引用返回行数据（where 条件忽略，测试数据全库唯一） */
  const rowsFor = (table: unknown): unknown[] => {
    if (table === (schema.enterprises as unknown))
      return [{ id: "ent-1", status: "active", maxConcurrent: 100 }]
    if (table === (schema.models as unknown))
      return [{ id: "model-1", apiEndpoint: "https://api.example.com", maxConcurrent: 0 }]
    if (table === (schema.generationTasks as unknown))
      return [{ id: "task-x", status: "queued", imageCount: 1, succeededIndexes: null, resultImages: null, retryCount: 0 }]
    if (table === (schema.cardImages as unknown)) return []
    return []
  }
  /** 可 await 也可 .limit() 的查询结果（兼容 syncCardImagesOnTerminal 无 limit 的用法） */
  const queryResult = (rows: unknown[]) => {
    const promise = Promise.resolve(rows)
    return {
      limit: async () => rows,
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
    }
  }
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => queryResult(rowsFor(table)),
        // processor 的权限组并发上限查询走 innerJoin（测试无组数据 → 空结果）
        innerJoin: () => ({
          where: () => queryResult([]),
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: () => ({ where: async () => undefined }),
    }),
    insert: (_table: unknown) => ({
      values: async () => undefined,
    }),
  }
  return { db }
})

describe("processQueueContinuous 滑动窗口补位", () => {
  let processQueueContinuous: (opts: {
    isRunning: () => boolean
    tickMs?: number
  }) => Promise<void>

  beforeAll(async () => {
    ;({ processQueueContinuous } = await import("@/lib/queue/processor"))
  })

  it("慢任务不阻塞补位：快任务完成后立即出队新任务，无需等批内最慢者", async () => {
    state.queue.push(
      { taskId: "t-slow", prompt: "slow" }, // 400ms
      { taskId: "t-1", prompt: "f1" }, // 30ms
      { taskId: "t-2", prompt: "f2" }, // 30ms
      { taskId: "t-3", prompt: "f3" }, // 30ms（等空位）
    )
    state.events = []
    state.peak = 0

    let running = true
    const loop = processQueueContinuous({ isRunning: () => running, tickMs: 25 })

    await sleep(550)
    running = false
    await loop

    const events = state.events
    // 首个 tick：3 个任务（上限 3）同时启动
    expect(events.slice(0, 3)).toEqual(["start:slow", "start:f1", "start:f2"])
    // 核心断言：f3 在 slow 结束前就已补位启动（旧 processQueueOnce 会等整批）
    const f3Start = events.indexOf("start:f3")
    const slowEnd = events.indexOf("end:slow")
    expect(f3Start).toBeGreaterThan(-1)
    expect(slowEnd).toBeGreaterThan(f3Start)
    // 全部完成
    expect(events.filter((e) => e.startsWith("end:"))).toHaveLength(4)
    // 进程内 in-flight 峰值不超过 WORKER_TASK_CONCURRENCY=3
    expect(state.peak).toBe(3)
  })

  it("in-flight 上限持续生效：6 个快任务分批补位，全部完成且峰值不超上限", async () => {
    state.queue.push(
      { taskId: "u-1", prompt: "u1" },
      { taskId: "u-2", prompt: "u2" },
      { taskId: "u-3", prompt: "u3" },
      { taskId: "u-4", prompt: "u4" },
      { taskId: "u-5", prompt: "u5" },
      { taskId: "u-6", prompt: "u6" },
    )
    state.events = []
    state.peak = 0

    let running = true
    const loop = processQueueContinuous({ isRunning: () => running, tickMs: 25 })

    await sleep(400)
    running = false
    await loop

    expect(state.events.filter((e) => e.startsWith("end:"))).toHaveLength(6)
    expect(state.peak).toBeLessThanOrEqual(3)
  })
})
