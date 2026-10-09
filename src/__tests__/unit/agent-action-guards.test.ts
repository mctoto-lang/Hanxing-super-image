import { beforeEach, describe, expect, it, vi } from "vitest"

import { switchTemplateStageAction } from "@/server/actions/agent-template"
import { regenFailedItemsAction, regenSampleItemsAction, updateItemPromptAction } from "@/server/actions/agent"
import { updateTarotCardPlanItemAction } from "@/server/actions/agent-cards"

/**
 * Server Action 守卫单测（action 当函数测，全 mock，不触 PG/Redis）：
 *
 * - db：仿 sliding-window.test.ts 的 vi.mock("@/db/client") 按表返回内存行，
 *   但 where 条件不忽略——内置一个仅覆盖 and/eq/inArray/notInArray 的
 *   drizzle 条件求值器（按真实 queryChunks 结构解析），让「条件更新」
 *   守卫被真实验证（如 notInArray(status,[running,queued]) 命中与否），
 *   而非 mock 侧复刻守卫造成的自证；
 * - auth：仿 refine-guards.test.ts 先例 mock 会话层，requireEnterpriseContext
 *   返回带 user/enterprise 的 ctx（checkModuleAccess 放行 agent 模块）；
 * - 其余副作用依赖（next/cache、storage、orchestrator）mock 为空操作。
 */

interface MockRow {
  [key: string]: unknown
}

const state = vi.hoisted(() => ({
  rows: {
    agentRuns: [] as MockRow[],
    agentItems: [] as MockRow[],
    agentEvents: [] as MockRow[],
  },
  /** SELECT 视图覆盖（部分字段旧快照）：模拟 SELECT→UPDATE 间隙被并发改变 */
  viewOverrides: new Map<object, MockRow>(),
}))

vi.mock("@/db/client", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema")

  /** Column 对象 → 行内 TS 键（身份映射；schema 为真实模块，与 action 侧同一实例） */
  const colKey = new Map<unknown, string>()
  for (const table of [
    schema.agentRuns,
    schema.agentRunItems,
    schema.agentRounds,
    schema.agentEvents,
    schema.agentMessages,
    schema.agentAssets,
  ]) {
    for (const [key, value] of Object.entries(table)) {
      if (
        value &&
        typeof value === "object" &&
        "name" in value &&
        "table" in value &&
        !("queryChunks" in value)
      ) {
        colKey.set(value, key)
      }
    }
  }

  const rowsOf = (table: unknown): MockRow[] => {
    if (table === (schema.agentRuns as unknown)) return state.rows.agentRuns
    if (table === (schema.agentRunItems as unknown)) return state.rows.agentItems
    if (table === (schema.agentEvents as unknown)) return state.rows.agentEvents
    return []
  }

  /** drizzle 条件求值（仅覆盖被测 action 用到的 and/eq/inArray/notInArray） */
  const matches = (cond: unknown, row: MockRow): boolean => {
    const chunks = (cond as { queryChunks?: unknown[] } | null)?.queryChunks
    if (!chunks) throw new Error("mock db: 不支持的条件形态")
    const subs = chunks.filter(
      (c) => c && typeof c === "object" && Array.isArray((c as { queryChunks?: unknown[] }).queryChunks),
    )
    if (subs.length > 0) return subs.every((sub) => matches(sub, row)) // and(...)
    let found = 0
    for (let i = 0; i < chunks.length; i++) {
      const key = colKey.get(chunks[i])
      if (!key) continue
      found++
      const opText = (chunks[i + 1] as { value?: string[] } | undefined)?.value?.join("") ?? ""
      const op = opText.trim()
      // 值块两种形态：eq → Param{value}；in/notIn → Param[]（数组本身无 .value）
      const valueOf = (c: unknown) => (c as { value?: unknown }).value
      const raw = chunks[i + 2]
      const cell = row[key]
      if (op === "=") {
        if (cell !== valueOf(raw)) return false
      } else if (op === "in" || op === "not in") {
        const list = (Array.isArray(raw) ? raw : [raw]).map(valueOf)
        const hit = list.includes(cell)
        if (op === "in" ? !hit : hit) return false
      } else {
        throw new Error(`mock db: 未支持的操作符「${op}」`)
      }
    }
    if (found === 0) throw new Error("mock db: 条件列未能识别（列身份映射失效）")
    return true
  }

  const selectRows = (table: unknown) =>
    rowsOf(table).map((row) => (state.viewOverrides.has(row) ? { ...row, ...state.viewOverrides.get(row) } : row))

  const queryable = (rows: MockRow[]) => {
    const promise = Promise.resolve(rows)
    return Object.assign(promise, {
      orderBy: () => queryable(rows),
      limit: async () => rows,
    })
  }

  const db = {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => queryable(selectRows(table).filter((row) => matches(cond, row))),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: MockRow) => ({
        where: (cond: unknown) => {
          // UPDATE 按当前存储行求值/覆盖（SELECT 旧快照不影响条件更新语义）
          const matched = rowsOf(table).filter((row) => matches(cond, row))
          for (const row of matched) Object.assign(row, values)
          const snapshot = matched.map((row) => ({ ...row }))
          return Object.assign(Promise.resolve(snapshot), {
            returning: (fields: Record<string, unknown> | undefined) =>
              Promise.resolve(
                snapshot.map((row) => {
                  if (!fields) return row
                  const out: MockRow = {}
                  for (const [key, col] of Object.entries(fields)) out[key] = row[colKey.get(col)!]
                  return out
                }),
              ),
          })
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: async () => undefined,
      returning: async () => [],
    }),
  }
  return { db }
})

vi.mock("@/lib/auth/session", () => {
  const ctx = {
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      username: "guard-user",
      name: "守卫用户",
      email: null,
      image: null,
      isSuperAdmin: false,
      enterpriseId: "22222222-2222-4222-8222-222222222222",
      enterpriseRole: "member",
      groupId: null,
      creditsBalance: 0,
    },
    enterprise: { id: "22222222-2222-4222-8222-222222222222", status: "active" },
    group: null,
    accessibleModules: ["agent"],
    canAccess: () => true,
  }
  return {
    requireEnterpriseContext: async () => ctx,
    requireUserContext: async () => ctx,
    requireEnterpriseAdmin: async () => ctx,
    requireSuperAdmin: async () => ctx,
    getCurrentUserContext: async () => ctx,
  }
})

vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/storage", () => ({
  getStorage: async () => ({}),
  saveFromUrl: async () => "",
  saveFromBuffer: async () => "",
  deleteObjects: async () => {},
}))
vi.mock("@/server/services/agent-orchestrator", () => ({
  checkRunCompletion: async () => undefined,
}))

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const RUN_ID = "31000000-0000-4000-8000-000000000001"
const ITEM_ID = "33000000-0000-4000-8000-000000000001"
const USER_ID = "11111111-1111-4111-8111-111111111111"
const ENT_ID = "22222222-2222-4222-8222-222222222222"

function runRow(partial: Partial<MockRow>): MockRow {
  return {
    id: RUN_ID,
    direction: "tarot",
    enterpriseId: ENT_ID,
    userId: USER_ID,
    status: "waiting_human",
    phase: "full",
    input: { prompt: "p", cardCount: 78 },
    graphSnapshot: {},
    template: "tarot",
    stage: "art",
    title: "守卫测试 run",
    brief: null,
    directions: [],
    selectedDirection: null,
    selectedDirectionId: "dir-1",
    pendingAction: null,
    error: null,
    ...partial,
  }
}

function itemRow(partial: Partial<MockRow>): MockRow {
  return {
    id: ITEM_ID,
    runId: RUN_ID,
    enterpriseId: ENT_ID,
    userId: USER_ID,
    index: 0,
    name: "愚者",
    meaning: "起始",
    currentPrompt: "[1] 画面风格\ns\n\n[2] 画面内容\nc",
    promptSource: "final",
    status: "confirmed",
    isSample: true,
    roundsUsed: 1,
    finalRoundId: "34000000-0000-4000-8000-000000000001",
    fallbackContentWarning: false,
    manualRegenCount: 0,
    errorMessage: null,
    visualBrief: "画面",
    framedImageUrl: null,
    frameStatus: null,
    ...partial,
  }
}

/** 78 张齐备清单（全部带 finalRoundId，art→compose 放行口径） */
function fullItems78(): MockRow[] {
  return Array.from({ length: 78 }, (_, index) =>
    itemRow({
      id: `33000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      index,
      isSample: index < 6,
    }),
  )
}

beforeEach(() => {
  state.rows.agentRuns = []
  state.rows.agentItems = []
  state.rows.agentEvents = []
  state.viewOverrides = new Map()
})

// ---------------------------------------------------------------------------
// 1) switchTemplateStageAction：来源阶段守卫（art ↔ compose 双向）
// ---------------------------------------------------------------------------

describe("switchTemplateStageAction 阶段切换守卫", () => {
  it("draft 阶段直跳 art：拒绝（需先完成终稿确认），run 阶段未被改动", async () => {
    const run = runRow({ stage: "draft", phase: "sample" })
    state.rows.agentRuns = [run]

    await expect(
      switchTemplateStageAction({ runId: RUN_ID, stage: "art" }),
    ).rejects.toThrow("当前阶段不支持切换，请先完成终稿确认，进入「卡面生产」阶段")

    expect(run.stage).toBe("draft")
  })

  it("art → compose（78 张卡面齐备）：放行并落库 compose", async () => {
    const run = runRow({ stage: "art", phase: "full", status: "waiting_human" })
    state.rows.agentRuns = [run]
    state.rows.agentItems = fullItems78()

    const result = await switchTemplateStageAction({ runId: RUN_ID, stage: "compose" })
    expect(result).toEqual({ ok: true })
    expect(run.stage).toBe("compose")
  })

  it("art → compose 但卡面不足 78 张：拒绝（走到 78 张齐备检查）", async () => {
    const run = runRow({ stage: "art", phase: "full" })
    state.rows.agentRuns = [run]
    state.rows.agentItems = fullItems78().slice(0, 77)

    await expect(
      switchTemplateStageAction({ runId: RUN_ID, stage: "compose" }),
    ).rejects.toThrow("请先完成 78 张卡面生产，再进入融合与交付")
    expect(run.stage).toBe("art")
  })
})

// ---------------------------------------------------------------------------
// 2) regenFailedItemsAction：SELECT→UPDATE 间隙状态被并发改变
// ---------------------------------------------------------------------------

describe("regenFailedItemsAction 条件更新守卫", () => {
  it("run 已被并发置 running：条件更新不生效、报「AI 团队正在处理中」且 run 行未被覆盖", async () => {
    // 存储行已被 worker 认领（status=running、无 pendingAction）；
    // action 的 SELECT 读到的是并发改变前的旧快照（waiting_human）
    const run = runRow({ stage: "art", phase: "full", status: "running", pendingAction: null })
    const failedItem = itemRow({ status: "failed", errorMessage: "生图失败" })
    state.rows.agentRuns = [run]
    state.rows.agentItems = [failedItem]
    state.viewOverrides.set(run, { status: "waiting_human" })

    // 业务失败以返回值传达（生产环境 Server Action 抛错会被抹为 #441）
    const result = await regenFailedItemsAction(RUN_ID)
    expect(result).toEqual({ ok: false, error: "AI 团队正在处理中，请稍候" })

    // 条件更新（notInArray status running/queued）未命中：run 行保持 worker 认领态
    expect(run.status).toBe("running")
    expect(run.pendingAction).toBeNull()
    // 失败卡重置发生在 run 条件更新之前（当前实现顺序）：item 已被重置为 pending
    expect(failedItem.status).toBe("pending")
    expect(failedItem.errorMessage).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2b) regenSampleItemsAction：一键重跑风格小样守卫
// ---------------------------------------------------------------------------

describe("regenSampleItemsAction 小样重生成守卫", () => {
  it("phase=full（小样已确认、锁定为一致性基准）：拒绝整批重跑且 item 未被改动", async () => {
    const run = runRow({ stage: "art", phase: "full" })
    const sample = itemRow({ status: "confirmed", isSample: true })
    state.rows.agentRuns = [run]
    state.rows.agentItems = [sample]

    const result = await regenSampleItemsAction(RUN_ID)
    expect(result).toEqual({
      ok: false,
      error: "风格小样确认后已作为成套一致性基准，无法整批重新生成（可在卡面弹窗中单张重开）",
    })
    expect(sample.status).toBe("confirmed")
    expect(run.status).toBe("waiting_human")
  })

  it("sample 相位：全部小样（无论成败）重置 pending 并重新排队小样生产，非小样卡不动", async () => {
    const run = runRow({ stage: "art", phase: "sample" })
    const okSample = itemRow({
      id: "33000000-0000-4000-8000-000000000002",
      index: 1,
      status: "confirmed",
      isSample: true,
    })
    const failedSample = itemRow({
      id: "33000000-0000-4000-8000-000000000003",
      index: 2,
      status: "failed",
      errorMessage: "生图失败",
      finalRoundId: null,
      isSample: true,
    })
    const normalCard = itemRow({
      id: "33000000-0000-4000-8000-000000000004",
      index: 6,
      status: "confirmed",
      isSample: false,
    })
    state.rows.agentRuns = [run]
    state.rows.agentItems = [okSample, failedSample, normalCard]

    const result = await regenSampleItemsAction(RUN_ID)
    expect(result).toEqual({ ok: true, count: 2 })

    expect(okSample.status).toBe("pending")
    expect(okSample.roundsUsed).toBe(0)
    expect(okSample.finalRoundId).toBeNull()
    expect(failedSample.status).toBe("pending")
    expect(failedSample.errorMessage).toBeNull()
    // 非小样卡不在重置范围
    expect(normalCard.status).toBe("confirmed")
    expect(run.status).toBe("queued")
    expect(run.pendingAction).toMatchObject({ kind: "produce_cards", phase: "sample" })
  })

  it("run 已被并发置 running：条件更新未命中，返回「AI 团队正在处理中」", async () => {
    const run = runRow({ stage: "art", phase: "sample", status: "running", pendingAction: null })
    const sample = itemRow({ status: "confirmed", isSample: true })
    state.rows.agentRuns = [run]
    state.rows.agentItems = [sample]
    // action 的 SELECT 读到并发改变前的旧快照（waiting_human）
    state.viewOverrides.set(run, { status: "waiting_human" })

    const result = await regenSampleItemsAction(RUN_ID)
    expect(result).toEqual({ ok: false, error: "AI 团队正在处理中，请稍候" })
    expect(run.status).toBe("running")
  })
})

// ---------------------------------------------------------------------------
// 3) updateItemPromptAction：item 在途守卫
// ---------------------------------------------------------------------------

describe("updateItemPromptAction 在途守卫", () => {
  it.each(["drafting", "generating", "reviewing"])("item.status=%s：拒绝编辑提示词且不落库", async (status) => {
    const item = itemRow({ status, currentPrompt: "旧提示词" })
    state.rows.agentItems = [item]

    await expect(
      updateItemPromptAction({ itemId: ITEM_ID, prompt: "新提示词内容超过十个字" }),
    ).rejects.toThrow("该卡牌正在生成或评审中，请等待本轮完成后再编辑提示词")

    expect(item.currentPrompt).toBe("旧提示词")
  })
})

// ---------------------------------------------------------------------------
// 4) updateTarotCardPlanItemAction：run 运行态守卫
// ---------------------------------------------------------------------------

describe("updateTarotCardPlanItemAction 运行态守卫", () => {
  it("run.status=queued（阶段 draft 放行口径下）：拒绝「AI 团队正在处理中」，item 未被改动", async () => {
    const run = runRow({ stage: "draft", phase: "sample", status: "queued" })
    const item = itemRow({ status: "pending", meaning: "原义", visualBrief: "原画面", currentPrompt: "原提示词" })
    state.rows.agentRuns = [run]
    state.rows.agentItems = [item]

    // 业务失败以返回值传达（生产环境 Server Action 抛错会被抹为 #441 占位文案）
    const result = await updateTarotCardPlanItemAction({ runId: RUN_ID, itemId: ITEM_ID, meaning: "新义", visualBrief: "新画面" })
    expect(result).toEqual({ ok: false, error: "AI 团队正在处理中，请稍候" })

    expect(item.meaning).toBe("原义")
    expect(item.visualBrief).toBe("原画面")
    expect(item.currentPrompt).toBe("原提示词")
  })
})
