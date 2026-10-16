import { beforeEach, describe, expect, it, vi } from "vitest"

import { rollbackWorkspaceAgentStageAction } from "@/server/actions/workspace/agent"

/**
 * 工作台 Agent 阶段回退（rollbackWorkspaceAgentStageAction）单测
 * （action 当函数测，全 mock 不触 PG，仿 agent-action-guards.test.ts）：
 *
 * - db：内存行 + 仅覆盖 and/eq/inArray/notInArray 的 drizzle 条件求值器
 *   （列身份映射取自真实 schema，与 action 侧同一实例），insert 落行、
 *   update 原地覆盖、delete 按 where 剔除、transaction 直通；
 * - 断言口径：目标步之后的决策复位（原选中恢复候选 + 「上次选择」留
 *   档）、卡片五类下游产出清空（评审/轮次/卡片图/Oracle 文案/提示词卡
 *   重写为锁定骨架）、workflow 游标清空与 rollbackCount 递增、日志事件
 *   落库；以及各前置守卫（在途 job / 在途卡片 / 非法目标 / 终态）。
 */

interface MockRow {
  [key: string]: unknown
}

const state = vi.hoisted(() => ({
  rows: {
    workflows: [] as MockRow[],
    directions: [] as MockRow[],
    cards: [] as MockRow[],
    promptCards: [] as MockRow[],
    cardImages: [] as MockRow[],
    rounds: [] as MockRow[],
    reviews: [] as MockRow[],
    oracleCopies: [] as MockRow[],
    events: [] as MockRow[],
    jobs: [] as MockRow[],
  },
}))

vi.mock("@/db/client", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema")

  /** Column 对象 → 行内 TS 键（schema 为真实模块，与 action 侧同一实例） */
  const colKey = new Map<unknown, string>()
  for (const table of [
    schema.workspaceAgentWorkflows,
    schema.workspaceAgentDirections,
    schema.workspaceAgentCards,
    schema.workspaceAgentEvents,
    schema.workspaceAgentJobs,
    schema.workspaceAgentRounds,
    schema.workspaceAgentReviews,
    schema.workspaceAgentOracleCopies,
    schema.promptCards,
    schema.cardImages,
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

  const rowsOf = (table: unknown): MockRow[] | null => {
    if (table === (schema.workspaceAgentWorkflows as unknown)) return state.rows.workflows
    if (table === (schema.workspaceAgentDirections as unknown)) return state.rows.directions
    if (table === (schema.workspaceAgentCards as unknown)) return state.rows.cards
    if (table === (schema.workspaceAgentEvents as unknown)) return state.rows.events
    if (table === (schema.workspaceAgentJobs as unknown)) return state.rows.jobs
    if (table === (schema.workspaceAgentRounds as unknown)) return state.rows.rounds
    if (table === (schema.workspaceAgentReviews as unknown)) return state.rows.reviews
    if (table === (schema.workspaceAgentOracleCopies as unknown)) return state.rows.oracleCopies
    if (table === (schema.promptCards as unknown)) return state.rows.promptCards
    if (table === (schema.cardImages as unknown)) return state.rows.cardImages
    return null
  }

  /** drizzle 条件求值（仅覆盖被测 action 用到的 and/eq/inArray/notInArray） */
  const matches = (cond: unknown, row: MockRow): boolean => {
    const chunks = (cond as { queryChunks?: unknown[] } | null)?.queryChunks
    if (!chunks) throw new Error("mock db: 不支持的条件形态")
    const subs = chunks.filter(
      (c) => c && typeof c === "object" && Array.isArray((c as { queryChunks?: unknown[] }).queryChunks),
    )
    if (subs.length > 0) return subs.every((sub) => matches(sub, row))
    let found = 0
    for (let i = 0; i < chunks.length; i++) {
      const key = colKey.get(chunks[i])
      if (!key) continue
      found++
      const opText = (chunks[i + 1] as { value?: string[] } | undefined)?.value?.join("") ?? ""
      const op = opText.trim()
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

  const db = {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => {
          const rows = rowsOf(table)
          if (!rows) throw new Error("mock db: 未登记的表")
          const hit = rows.filter((row) => matches(cond, row))
          const projected = hit.map((row) => {
            if (!fields) return row
            const out: MockRow = {}
            for (const [key, col] of Object.entries(fields)) out[key] = row[colKey.get(col)!]
            return out
          })
          return Object.assign(Promise.resolve(projected), {
            limit: async () => projected,
          })
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: MockRow) => ({
        where: (cond: unknown) => {
          const rows = rowsOf(table)
          if (!rows) throw new Error("mock db: 未登记的表")
          const matched = rows.filter((row) => matches(cond, row))
          for (const row of matched) Object.assign(row, values)
          return Promise.resolve(matched.map((row) => ({ ...row })))
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (cond: unknown) => {
        const rows = rowsOf(table)
        if (!rows) throw new Error("mock db: 未登记的表")
        const keep = rows.filter((row) => !matches(cond, row))
        rows.length = 0
        rows.push(...keep)
        return Promise.resolve(keep.length)
      },
    }),
    insert: (table: unknown) => ({
      values: async (vals: MockRow | MockRow[]) => {
        const rows = rowsOf(table)
        if (!rows) throw new Error("mock db: 未登记的表")
        const list = Array.isArray(vals) ? vals : [vals]
        for (const v of list) rows.push({ ...v })
        return [{ ...list[0] }]
      },
    }),
    // 事务直通：action 内 tx 与 db 同构，直接复用同一 mock（注解不用
    // typeof db 以避免自引用类型环 TS7022）
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  }
  return { db }
})

vi.mock("@/lib/auth/session", () => {
  const ENT_ID = "22222222-2222-4222-8222-222222222222"
  const ctx = {
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      username: "rollback-user",
      name: "回退用户",
      email: null,
      image: null,
      isSuperAdmin: false,
      enterpriseId: ENT_ID,
      enterpriseRole: "member",
      groupId: null,
      creditsBalance: 0,
    },
    enterprise: { id: ENT_ID, status: "active" },
    group: null,
    accessibleModules: ["workspace"],
    canAccess: () => true,
  }
  return {
    requireUserContext: async () => ctx,
    getCurrentEnterpriseScope: () => ({ enterpriseId: ENT_ID }),
  }
})

vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/queue/task-queue", () => ({ enqueue: async () => {} }))
vi.mock("@/server/services/credits-service", () => ({
  deductUserCredits: async () => true,
  refundUserCredits: async () => true,
}))
vi.mock("@/lib/storage/upload-token", () => ({ signUploadToken: () => "token" }))

// ---------------------------------------------------------------------------
// 夹具：方向已定稿（styleDoc + selectedDirectionId 就绪）的工作流
// ---------------------------------------------------------------------------

const USER_ID = "11111111-1111-4111-8111-111111111111"
const ENT_ID = "22222222-2222-4222-8222-222222222222"
const WF_ID = "40000000-0000-4000-8000-000000000001"
const THEME_SEL = "41000000-0000-4000-8000-000000000001"
const THEME_REJ_A = "41000000-0000-4000-8000-000000000002"
const THEME_REJ_B = "41000000-0000-4000-8000-000000000003"
const DIR_REJ_A = "42000000-0000-4000-8000-000000000001"
const DIR_SEL = "42000000-0000-4000-8000-000000000002"
const DIR_REJ_B = "42000000-0000-4000-8000-000000000003"
const CARD_1 = "43000000-0000-4000-8000-000000000001"
const CARD_2 = "43000000-0000-4000-8000-000000000002"
const PC_1 = "44000000-0000-4000-8000-000000000001"
const PC_2 = "44000000-0000-4000-8000-000000000002"
const CI_1 = "45000000-0000-4000-8000-000000000001"
const ROUND_1 = "46000000-0000-4000-8000-000000000001"
const REVIEW_1 = "47000000-0000-4000-8000-000000000001"
const ORACLE_1 = "48000000-0000-4000-8000-000000000001"
const OLD_DIR_REJ = "42000000-0000-4000-8000-000000000099"

function workflowRow(partial: Partial<MockRow> = {}): MockRow {
  return {
    id: WF_ID,
    enterpriseId: ENT_ID,
    userId: USER_ID,
    status: "waiting_human",
    title: "回退测试工作流",
    workspaceTaskId: "49000000-0000-4000-8000-000000000001",
    styleDoc: "风格规范书（定稿）",
    selectedDirectionId: DIR_SEL,
    error: null,
    input: {
      prompt: "需求",
      stylePrompt: null,
      cardCount: 2,
      referenceImages: [],
      frozenConfig: { templateKey: "tarot81", cardCount: 2 },
      themeDirectionIds: [THEME_SEL, THEME_REJ_A, THEME_REJ_B],
      directionBatchIds: [DIR_REJ_A, DIR_SEL, DIR_REJ_B],
      imaginationLevel: "balanced",
      styleConfirmedAt: "2026-10-01T00:00:00.000Z",
    },
    ...partial,
  }
}

function directionRow(id: string, status: string, partial: Partial<MockRow> = {}): MockRow {
  return {
    id,
    workflowId: WF_ID,
    enterpriseId: ENT_ID,
    name: `方向 ${id.slice(-2)}`,
    description: "说明",
    concept: "概念",
    worldview: "世界观",
    palette: "色板",
    visualLanguage: "固定风格提示词",
    stylePhrase: null,
    sampleCards: [],
    status,
    sortOrder: 0,
    ...partial,
  }
}

/** 两张已完成提示词/生图/评审的卡片（含互链 prompt_card / card_image / 轮次） */
function producedCards(): MockRow[] {
  return [
    {
      id: CARD_1,
      workflowId: WF_ID,
      enterpriseId: ENT_ID,
      userId: USER_ID,
      cardIndex: 0,
      kind: "face",
      name: "愚者",
      meaning: "AI 撰写的牌义",
      visualBrief: "画面简报",
      currentPrompt: "AI 撰写的提示词",
      promptSource: "initial",
      status: "approved_by_ai",
      isSample: false,
      roundsUsed: 1,
      finalRoundId: ROUND_1,
      fallbackContentWarning: false,
      manualRegenCount: 0,
      isLocked: false,
      promptCardId: PC_1,
      directionId: DIR_SEL,
      errorMessage: null,
    },
    {
      id: CARD_2,
      workflowId: WF_ID,
      enterpriseId: ENT_ID,
      userId: USER_ID,
      cardIndex: 1,
      kind: "face",
      name: "魔术师",
      meaning: "AI 撰写的牌义",
      visualBrief: "画面简报",
      currentPrompt: "AI 撰写的提示词",
      promptSource: "initial",
      status: "confirmed",
      isSample: false,
      roundsUsed: 2,
      finalRoundId: null,
      fallbackContentWarning: true,
      manualRegenCount: 1,
      isLocked: true,
      promptCardId: PC_2,
      directionId: DIR_SEL,
      errorMessage: "旧错误",
    },
  ]
}

function promptCardRow(id: string): MockRow {
  return {
    id,
    enterpriseId: ENT_ID,
    taskId: "49000000-0000-4000-8000-000000000001",
    cardIndex: 0,
    prompt: "真实提示词",
    selectedImageId: CI_1,
    translatedPrompt: "english prompt",
    translationSourcePrompt: "真实提示词",
    translationStatus: "synced",
    displayLanguage: "zh",
    isLocked: false,
    agentKind: "face",
    referenceImages: [],
  }
}

/** 全量基础夹具（方向定稿态） */
function seedBase() {
  state.rows.workflows.push(workflowRow())
  state.rows.directions.push(
    directionRow(THEME_SEL, "selected"),
    directionRow(THEME_REJ_A, "rejected"),
    directionRow(THEME_REJ_B, "rejected"),
    directionRow(DIR_REJ_A, "rejected"),
    directionRow(DIR_SEL, "selected"),
    directionRow(DIR_REJ_B, "rejected"),
    // 重新生成方向时淘汰的旧批次 rejected 行：回退不得把它复活
    directionRow(OLD_DIR_REJ, "rejected"),
  )
  state.rows.cards.push(...producedCards())
  state.rows.promptCards.push(promptCardRow(PC_1), promptCardRow(PC_2))
  state.rows.cardImages.push({
    id: CI_1,
    enterpriseId: ENT_ID,
    cardId: PC_1,
    imageUrl: "/uploads/img.png",
    status: "completed",
    isSelected: true,
    generationTaskId: "4a000000-0000-4000-8000-000000000001",
  })
  state.rows.rounds.push({
    id: ROUND_1,
    workflowId: WF_ID,
    enterpriseId: ENT_ID,
    cardId: CARD_1,
    roundNumber: 1,
    prompt: "轮次提示词",
    promptSource: "initial",
    imageUrl: "/uploads/img.png",
    selectedCardImageId: CI_1,
    candidates: [],
    costCredits: 10,
  })
  state.rows.reviews.push({
    id: REVIEW_1,
    workflowId: WF_ID,
    enterpriseId: ENT_ID,
    cardId: CARD_1,
    roundId: ROUND_1,
    nodeKey: "review_panel:x",
    kind: "review",
    result: {},
  })
  state.rows.oracleCopies.push({
    id: ORACLE_1,
    workflowId: WF_ID,
    enterpriseId: ENT_ID,
    cardId: CARD_1,
    locale: "en",
    status: "draft",
    fields: {},
  })
}

const workflowOf = () => state.rows.workflows.find((w) => w.id === WF_ID)!
const directionStatusOf = (id: string) =>
  state.rows.directions.find((d) => d.id === id)?.status

beforeEach(() => {
  for (const key of Object.keys(state.rows) as Array<keyof typeof state.rows>) {
    state.rows[key] = []
  }
})

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------

describe("rollbackWorkspaceAgentStageAction 守卫", () => {
  it("非法目标直接拒绝", async () => {
    seedBase()
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "style")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("theme / imagination / direction")
  })

  it("cancelled 工作流拒绝回退", async () => {
    seedBase()
    state.rows.workflows[0]!.status = "cancelled"
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "direction")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("已取消")
  })

  it("排队中任务拒绝回退", async () => {
    seedBase()
    state.rows.jobs.push({
      id: "4b000000-0000-4000-8000-000000000001",
      workflowId: WF_ID,
      status: "queued",
      jobType: "gen_directions",
      payload: {},
    })
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "direction")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("排队中或执行中")
  })

  it("卡片生图/评审中拒绝回退", async () => {
    seedBase()
    state.rows.cards[0]!.status = "reviewing"
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "theme")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("生图或评审中")
  })

  it("方向未定稿时 direction 回退无意义", async () => {
    seedBase()
    state.rows.workflows[0]!.selectedDirectionId = null
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "direction")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("落地方向尚未定稿")
  })

  it("主题未选时 theme 回退无意义", async () => {
    seedBase()
    state.rows.directions.find((d) => d.id === THEME_SEL)!.status = "candidate"
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "theme")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("主题尚未选定")
  })

  it("想象力未选时 imagination 回退无意义", async () => {
    seedBase()
    delete (state.rows.workflows[0]!.input as MockRow).imaginationLevel
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "imagination")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("想象力档位尚未选定")
  })
})

// ---------------------------------------------------------------------------
// 效果
// ---------------------------------------------------------------------------

describe("rollbackWorkspaceAgentStageAction 效果", () => {
  it("回退到主题选择：原主题恢复候选 + 留档，想象力/方向全部作废，卡片回初始态", async () => {
    seedBase()
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "theme")
    expect(res.ok).toBe(true)

    // 决策复位：主题恢复候选；方向轮（含当前批次与旧批次）全部 rejected
    expect(directionStatusOf(THEME_SEL)).toBe("candidate")
    expect(directionStatusOf(THEME_REJ_A)).toBe("rejected")
    expect(directionStatusOf(DIR_SEL)).toBe("rejected")
    expect(directionStatusOf(DIR_REJ_A)).toBe("rejected")
    expect(directionStatusOf(OLD_DIR_REJ)).toBe("rejected")

    // workflow 游标清空 + input 留档
    const wf = workflowOf()
    expect(wf.styleDoc).toBeNull()
    expect(wf.selectedDirectionId).toBeNull()
    expect(wf.status).toBe("waiting_human")
    const input = wf.input as MockRow
    expect(input.imaginationLevel).toBeUndefined()
    expect(input.lastSelectedThemeId).toBe(THEME_SEL)
    expect(input.lastSelectedDirectionId).toBeUndefined()
    expect(input.rollbackCount).toBe(1)

    // 卡片回「刚创建」初始态
    for (const card of state.rows.cards) {
      expect(card.status).toBe("pending")
      expect(card.currentPrompt).toBeNull()
      expect(card.visualBrief).toBeNull()
      expect(card.promptSource).toBeNull()
      expect(card.directionId).toBeNull()
      expect(card.finalRoundId).toBeNull()
      expect(card.roundsUsed).toBe(0)
      expect(card.fallbackContentWarning).toBe(false)
      expect(card.errorMessage).toBeNull()
      expect(card.isLocked).toBe(false)
      expect(typeof card.meaning).toBe("string")
      expect(card.meaning).not.toBe("AI 撰写的牌义")
    }

    // 提示词卡重写为锁定骨架、清翻译与选中图引用
    for (const pc of state.rows.promptCards) {
      expect(String(pc.prompt)).toMatch(/^【骨架】/)
      expect(pc.isLocked).toBe(true)
      expect(pc.selectedImageId).toBeNull()
      expect(pc.translatedPrompt).toBeNull()
      expect(pc.translationStatus).toBe("none")
    }

    // 五类下游产出清空
    expect(state.rows.cardImages).toHaveLength(0)
    expect(state.rows.rounds).toHaveLength(0)
    expect(state.rows.reviews).toHaveLength(0)
    expect(state.rows.oracleCopies).toHaveLength(0)

    // 日志：warn 级 rollback 事件落在 theme 模块
    const ev = state.rows.events.find((e) => e.action === "rollback")
    expect(ev).toBeTruthy()
    expect(ev!.status).toBe("warn")
    expect(ev!.stage).toBe("theme")
  })

  it("回退到想象力程度：主题保留、想象力清空、方向作废", async () => {
    seedBase()
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "imagination")
    expect(res.ok).toBe(true)

    expect(directionStatusOf(THEME_SEL)).toBe("selected")
    expect(directionStatusOf(DIR_SEL)).toBe("rejected")
    const wf = workflowOf()
    expect(wf.styleDoc).toBeNull()
    expect(wf.selectedDirectionId).toBeNull()
    const input = wf.input as MockRow
    expect(input.imaginationLevel).toBeUndefined()
    expect(input.lastSelectedThemeId).toBeUndefined()
    expect(input.rollbackCount).toBe(1)
    // 卡片同样清空（提示词依赖方向，随方向作废）
    expect(state.rows.cards.every((c) => c.status === "pending")).toBe(true)
    expect(state.rows.rounds).toHaveLength(0)
    const ev = state.rows.events.find((e) => e.action === "rollback")
    expect(ev!.stage).toBe("imagination")
  })

  it("回退到落地方向：整批方向恢复候选 + 上次选择留档，主题/想象力保留", async () => {
    seedBase()
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "direction")
    expect(res.ok).toBe(true)

    expect(directionStatusOf(THEME_SEL)).toBe("selected")
    expect(directionStatusOf(DIR_REJ_A)).toBe("candidate")
    expect(directionStatusOf(DIR_SEL)).toBe("candidate")
    expect(directionStatusOf(DIR_REJ_B)).toBe("candidate")
    // 旧批次 rejected 行不复活
    expect(directionStatusOf(OLD_DIR_REJ)).toBe("rejected")

    const wf = workflowOf()
    expect(wf.styleDoc).toBeNull()
    expect(wf.selectedDirectionId).toBeNull()
    const input = wf.input as MockRow
    expect(input.imaginationLevel).toBe("balanced")
    expect(input.lastSelectedDirectionId).toBe(DIR_SEL)
    // 卡片产出同样清空（新方向 → 新提示词/生图）
    expect(state.rows.cards.every((c) => c.status === "pending")).toBe(true)
    expect(state.rows.cardImages).toHaveLength(0)
    const ev = state.rows.events.find((e) => e.action === "rollback")
    expect(ev!.stage).toBe("direction")
  })

  it("旧数据缺 directionBatchIds：回退方向仅恢复原选中行", async () => {
    seedBase()
    delete (state.rows.workflows[0]!.input as MockRow).directionBatchIds
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "direction")
    expect(res.ok).toBe(true)
    expect(directionStatusOf(DIR_SEL)).toBe("candidate")
    expect(directionStatusOf(DIR_REJ_A)).toBe("rejected")
    expect(directionStatusOf(DIR_REJ_B)).toBe("rejected")
  })

  it("回退后再次回退：rollbackCount 单调递增", async () => {
    seedBase()
    await rollbackWorkspaceAgentStageAction(WF_ID, "direction")
    // 方向已回退但主题/想象力仍在 → 可继续回退到想象力
    const res = await rollbackWorkspaceAgentStageAction(WF_ID, "imagination")
    expect(res.ok).toBe(true)
    expect((workflowOf().input as MockRow).rollbackCount).toBe(2)
  })
})
