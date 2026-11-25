import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"

/**
 * 选品收割单任务 harvestOne 的错误分类单测（R-7-1 回归）
 *
 * 覆盖两处错误分类修复：
 * ① getActorRun 抛 ApifyError 404/401/403（run 不可见/凭证失效）→ 按 failed
 *    结算防任务永久卡 processing 占满并发闸门；其余错误（5xx/网络）原样上抛。
 * ② run 已终态后 forEachDatasetItem 抛 ApifyError 4xx（429 除外）→ 按已入库
 *    条数结算 failed；429/5xx/非 ApifyError 照旧上抛给外层下轮重试。
 *
 * 全 mock 单测（db / apify / selection-service / provider-config / selection-ai），
 * 不碰 PG/Redis：假 db 只实现 harvestOne 会走到的 select 链，遇到任何未预期的
 * 调用链直接抛错（查询形状变了测试会响而不是静默放过）。
 */

/** 测试运行时状态（vi.hoisted 供 mock 工厂与用例共享） */
const state = vi.hoisted(() => ({
  /** 假库中的唯一任务行（select 链原样返回） */
  task: null as Record<string, unknown> | null,
  /** countTaskResults / countTaskReviews 的确定返回值（用例断言钉死口径） */
  countResults: 7,
  countReviews: 5,
}))

vi.mock("@/lib/env", () => ({
  env: {
    SELECTION_MAX_CONCURRENT_RUNS: 3,
    SELECTION_TASK_TIMEOUT_MS: 30 * 60_000,
    APIFY_API_TOKEN: "platform-token",
  },
}))

vi.mock("@/db/client", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema")
  const fail = (chain: string): never => {
    throw new Error(`selection-processor 单测未预期的 db 调用链: ${chain}`)
  }
  const db = {
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table !== (schema.selectionTasks as unknown)) fail(`select().from(${String(table)})`)
        if (fields != null) fail("select(字段投影)——harvestOne 只用整行 select()")
        return {
          where: () => ({
            limit: async (n: number) => {
              if (n !== 1) fail("where().limit(n≠1)")
              return [state.task]
            },
            orderBy: () => fail("where().orderBy()"),
            // thenable：where() 直接 await（缺 limit）也要响
            then: () => fail("where() 直接 await"),
          }),
          orderBy: () => fail("select().from().orderBy()"),
          limit: () => fail("select().from().limit()（缺 where）"),
        }
      },
    }),
    update: () => fail("update()——harvestOne 不直接写库"),
    insert: () => fail("insert()"),
    delete: () => fail("delete()"),
  }
  return { db }
})

// 保留真实 ApifyError 类（instanceof 判定依赖同一构造器），只替换四个网络函数
vi.mock("@/lib/apify/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apify/client")>("@/lib/apify/client")
  return {
    ...actual,
    getActorRun: vi.fn(),
    forEachDatasetItem: vi.fn(),
    abortActorRun: vi.fn(),
    getDatasetItemCount: vi.fn(),
  }
})

vi.mock("@/server/services/selection-service", () => ({
  settleSelectionTask: vi.fn(async () => undefined),
  countTaskResults: vi.fn(async () => state.countResults),
  countTaskReviews: vi.fn(async () => state.countReviews),
  ingestSelectionResults: vi.fn(async () => undefined),
  ingestSelectionReviews: vi.fn(async () => undefined),
  ingestRedditPostComments: vi.fn(async () => undefined),
  refreshMonitorSnapshot: vi.fn(async () => undefined),
}))

// 真实返回形状 { token, source, providerId }（harvestOne 只消费 token）
vi.mock("@/lib/selection/provider-config", () => ({
  resolveSelectionToken: vi.fn(async () => ({
    token: "t",
    source: "platform" as const,
    providerId: null,
  })),
}))

vi.mock("@/server/services/selection-ai", () => ({
  triggerSelectionAiHooks: vi.fn(async () => undefined),
}))

import {
  ApifyError,
  forEachDatasetItem,
  getActorRun,
} from "@/lib/apify/client"
import {
  countTaskReviews,
  countTaskResults,
  ingestSelectionResults,
  settleSelectionTask,
} from "@/server/services/selection-service"

const TASK_ID = "11111111-1111-4111-8111-111111111111"

/** selection_task 整行（按真实列补齐；用例按需覆盖字段） */
function taskRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: TASK_ID,
    enterpriseId: "22222222-2222-4222-8222-222222222222",
    userId: "33333333-3333-4333-8333-333333333333",
    taskType: "market",
    platform: "amazon",
    actorId: "some-scraper/amazon-discover",
    searchParams: { keyword: "cup" },
    keyword: "cup",
    country: "US",
    providerId: null,
    maxResults: 100,
    estimatedCredits: 50,
    actualCredits: null, // 未结算（已结算行 harvestOne 直接跳过）
    status: "processing",
    progress: 10,
    fetchedCount: 12,
    apifyRunId: "run-1",
    apifyDatasetId: "ds-1",
    errorMessage: null,
    monitorId: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    cancelledAt: null,
    ...over,
  }
}

/** SUCCEEDED run（getActorRun 返回形状，ApifyRun 接口） */
const succeededRun = {
  id: "run-1",
  status: "SUCCEEDED",
  defaultDatasetId: "ds-1",
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
}

describe("harvestOne 错误分类（R-7-1）", () => {
  let harvestOne: (taskId: string) => Promise<string>

  beforeAll(async () => {
    ;({ harvestOne } = await import("@/lib/queue/selection-processor"))
  })

  beforeEach(() => {
    // vitest 4：resetAllMocks 清调用记录并还原 vi.fn(impl) 的原始实现（count 默认值等）
    vi.resetAllMocks()
    state.task = taskRow()
  })

  it.each([
    [401, "抓取凭证已失效"],
    [403, "抓取凭证已失效"],
    [404, "运行记录不可见"],
  ] as Array<[number, string]>)(
    "getActorRun 抛 ApifyError %d → 结算 failed（文案含「%s」），不再拉 dataset",
    async (status, text) => {
      vi.mocked(getActorRun).mockRejectedValueOnce(new ApifyError(`mock ${status}`, status, "run-1"))

      const outcome = await harvestOne(TASK_ID)

      expect(outcome).toBe("settled-failed")
      // run/dataset 归属启动账号：查询按任务快照凭证（provider-config mock 的 token）
      expect(getActorRun).toHaveBeenCalledWith("run-1", "t")
      expect(settleSelectionTask).toHaveBeenCalledTimes(1)
      expect(settleSelectionTask).toHaveBeenCalledWith({
        taskId: TASK_ID,
        finalStatus: "failed",
        fetchedCount: 12, // 结算口径 = 任务行已回写的 fetchedCount
        errorMessage: expect.stringContaining(text),
      })
      expect(forEachDatasetItem).not.toHaveBeenCalled()
    },
  )

  it("getActorRun 抛 5xx 与不带 status 的网络错误 → 不结算，错误原样上抛", async () => {
    vi.mocked(getActorRun).mockRejectedValueOnce(new ApifyError("apify internal", 500, "run-1"))
    await expect(harvestOne(TASK_ID)).rejects.toThrow("apify internal")
    expect(settleSelectionTask).not.toHaveBeenCalled()

    // 网络/解析类错误没有 status：同样照旧上抛，下轮继续轮询
    vi.mocked(getActorRun).mockRejectedValueOnce(new ApifyError("network down"))
    await expect(harvestOne(TASK_ID)).rejects.toThrow("network down")
    expect(settleSelectionTask).not.toHaveBeenCalled()
    expect(forEachDatasetItem).not.toHaveBeenCalled()
  })

  it("run SUCCEEDED 后 forEachDatasetItem 抛 403 → 按已入库条数结算 failed", async () => {
    vi.mocked(getActorRun).mockResolvedValueOnce(succeededRun)
    vi.mocked(forEachDatasetItem).mockRejectedValueOnce(new ApifyError("forbidden", 403, "run-1"))

    const outcome = await harvestOne(TASK_ID)

    expect(outcome).toBe("settled-failed")
    expect(forEachDatasetItem).toHaveBeenCalledTimes(1)
    // dataset 用 run 回参的 defaultDatasetId（缺省回退任务行的 apifyDatasetId）
    expect(vi.mocked(forEachDatasetItem).mock.calls[0]?.[0]).toBe("ds-1")
    // 非评论任务按结果表计数（countTaskResults mock=7）；countTaskReviews 不该被碰
    expect(countTaskResults).toHaveBeenCalledWith(TASK_ID)
    expect(countTaskReviews).not.toHaveBeenCalled()
    expect(ingestSelectionResults).not.toHaveBeenCalled() // 第一片就炸，零入库
    expect(settleSelectionTask).toHaveBeenCalledTimes(1)
    expect(settleSelectionTask).toHaveBeenCalledWith({
      taskId: TASK_ID,
      finalStatus: "failed",
      fetchedCount: state.countResults,
      errorMessage: expect.stringContaining("抓取结果拉取失败"),
    })
  })

  it.each([429, 500])(
    "run SUCCEEDED 后 forEachDatasetItem 抛 ApifyError %d → 不结算，错误上抛（下轮重试）",
    async (status) => {
      vi.mocked(getActorRun).mockResolvedValue(succeededRun)
      vi.mocked(forEachDatasetItem).mockRejectedValue(new ApifyError(`mock ${status}`, status, "run-1"))

      await expect(harvestOne(TASK_ID)).rejects.toThrow(`mock ${status}`)
      expect(settleSelectionTask).not.toHaveBeenCalled()
    },
  )
})
