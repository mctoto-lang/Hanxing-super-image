import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * enqueueMany 单测：批量提交时 100 个任务打包成一次 Redis pipeline 往返，
 * 且同优先级批量保持提交顺序（FIFO：先提交的 score 更高，出队端取最高分）。
 */

type PipelineCommand = { cmd: string; args: unknown[] }

const pipelineCommands: PipelineCommand[][] = []
const execMock = vi.fn(async () => [])

function makePipeline() {
  const commands: PipelineCommand[] = []
  pipelineCommands.push(commands)
  const pipeline = {
    hset: (...args: unknown[]) => {
      commands.push({ cmd: "hset", args })
      return pipeline
    },
    zadd: (...args: unknown[]) => {
      commands.push({ cmd: "zadd", args })
      return pipeline
    },
    exec: execMock,
  }
  return pipeline
}

vi.mock("@/lib/redis", () => ({
  redis: {
    pipeline: vi.fn(makePipeline),
    eval: vi.fn(),
    get: vi.fn(),
    zrange: vi.fn(),
    zrem: vi.fn(),
    hset: vi.fn(),
    hgetall: vi.fn(),
  },
}))

vi.mock("@/lib/env", () => ({
  env: { REDIS_URL: "redis://localhost:6379" },
}))

import { enqueue, enqueueMany, type QueueTaskInput } from "@/lib/queue/task-queue"

function makeTask(overrides: Partial<QueueTaskInput> = {}): QueueTaskInput {
  return {
    taskId: "t-1",
    enterpriseId: "ent-1",
    modelId: "model-1",
    prompt: "a cat",
    imageSize: "1024x1024",
    imageCount: 1,
    referenceImages: [],
    priority: 0,
    costPerImage: 1,
    apiTimeout: 120,
    taskTimeout: 300,
    maxRetries: 2,
    conversationId: null,
    ...overrides,
  }
}

beforeEach(() => {
  pipelineCommands.length = 0
  execMock.mockClear()
  vi.spyOn(Date, "now").mockReturnValue(1_000_000)
})

describe("enqueueMany", () => {
  it("空数组不创建 pipeline", async () => {
    const { redis } = await import("@/lib/redis")
    await enqueueMany([])
    expect(redis.pipeline).not.toHaveBeenCalled()
    expect(execMock).not.toHaveBeenCalled()
  })

  it("每任务恰好 3 条命令（HSET + 2×ZADD），一次 exec 往返", async () => {
    const tasks = Array.from({ length: 100 }, (_, i) =>
      makeTask({ taskId: `t-${i}` }),
    )
    await enqueueMany(tasks)
    expect(pipelineCommands).toHaveLength(1)
    const commands = pipelineCommands[0]!
    expect(commands).toHaveLength(300)
    expect(commands.filter((c) => c.cmd === "hset")).toHaveLength(100)
    expect(commands.filter((c) => c.cmd === "zadd")).toHaveLength(200)
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it("同优先级批量 score 严格递减（同毫秒 FIFO 保序）", async () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ taskId: `t-${i}` }),
    )
    await enqueueMany(tasks)
    const zaddScores = pipelineCommands[0]!
      .filter((c) => c.cmd === "zadd")
      .map((c) => Number(c.args[1]))
    // 企业队列 + 全局队列交替，各 5 个；同一队列内严格递减
    // （时间分量取反：先提交分数更高，出队端 zrange(-1,-1) 取最高分 → FIFO）
    const entScores = zaddScores.filter((_, i) => i % 2 === 0)
    const globalScores = zaddScores.filter((_, i) => i % 2 === 1)
    expect(entScores).toEqual([
      1e13 - 1_000_000,
      1e13 - 1_000_001,
      1e13 - 1_000_002,
      1e13 - 1_000_003,
      1e13 - 1_000_004,
    ])
    expect(globalScores).toEqual(entScores)
  })

  it("优先级参与 score 组成（priority * 1e13 + 取反时间戳）", async () => {
    await enqueueMany([makeTask({ priority: 5 })])
    const score = Number(pipelineCommands[0]!.find((c) => c.cmd === "zadd")!.args[1])
    expect(score).toBe(5 * 1e13 + (1e13 - 1_000_000))
  })

  it("HSET 元数据字段完整（含 status/enqueuedAt）", async () => {
    await enqueueMany([makeTask({ conversationId: "c-1", pendingIndexes: [0] })])
    const hsetArgs = pipelineCommands[0]!.find((c) => c.cmd === "hset")!.args
    const hash = hsetArgs[1] as Record<string, string>
    expect(hash.taskId).toBe("t-1")
    expect(hash.status).toBe("queued")
    expect(hash.enqueuedAt).toBe("1000000")
    expect(hash.conversationId).toBe("c-1")
    expect(hash.pendingIndexes).toBe("[0]")
  })

  it("enqueue 单任务包装为单元素批量", async () => {
    await enqueue(makeTask())
    expect(pipelineCommands).toHaveLength(1)
    expect(pipelineCommands[0]).toHaveLength(3)
    expect(execMock).toHaveBeenCalledTimes(1)
  })
})
