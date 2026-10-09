import { describe, expect, it } from "vitest"

import { TAROT_TEMPLATE } from "@/lib/agent/templates"
import {
  CLASSIC_NODE_KEYS,
  NODE_TO_TEMPLATE_ROLE,
  deriveClassicNodeBoard,
  type NodeBoardItemSnapshot,
  type NodeBoardRunSnapshot,
  type NodeCardInfo,
} from "@/lib/agent/node-board"

/**
 * 经典 8 节点看板推导单测（纯函数）：以本地构造的最小快照为输入，
 * 校验四阶段 × 三状态下的节点状态/进度/警示推导（final 为存量阶段值，
 * stagePos 归一化到 draft 后比对）。
 */

type Stage = "clarify" | "draft" | "final" | "art" | "compose"
type Status = "waiting_human" | "running" | "error"

const STAGES: Stage[] = ["clarify", "draft", "final", "art", "compose"]
const STATUSES: Status[] = ["waiting_human", "running", "error"]

const SAMPLE_INDEXES = TAROT_TEMPLATE.meta.sampleIndexes
const CARD_TOTAL = 78

const FINAL_PROMPT = "[1] 画面风格\n测试风格\n\n[2] 画面内容\n测试画面内容"

function item(partial: Partial<NodeBoardItemSnapshot> & { status: string }, index: number): NodeBoardItemSnapshot {
  return {
    currentPrompt: null,
    promptSource: null,
    latestRoundId: null,
    latestImageUrl: null,
    finalRoundId: null,
    roundsUsed: 0,
    errorMessage: null,
    isSample: SAMPLE_INDEXES.includes(index),
    ...partial,
  }
}

function itemsOf(count: number, make: (index: number) => Partial<NodeBoardItemSnapshot> & { status: string }) {
  return Array.from({ length: count }, (_, index) => item(make(index), index))
}

/** 按（阶段 × 状态）构造口径正确的最小快照 */
function makeFixture(stage: Stage, status: Status): { run: NodeBoardRunSnapshot; items: NodeBoardItemSnapshot[] } {
  const busy = status === "running"
  const failed = status === "error"
  const base: NodeBoardRunSnapshot = {
    stage,
    status: failed ? "failed" : busy ? "running" : "waiting_human",
    phase: stage === "art" || stage === "compose" ? (status === "running" ? "full" : "sample") : "sample",
    brief: stage === "clarify" && !busy ? "已拟简报" : null,
    directions: [],
    selectedDirectionId: stage === "draft" && busy ? "dir-1" : null,
    pendingAction: null,
    error: null,
  }

  if (stage === "clarify") {
    return {
      run: { ...base, pendingAction: busy || failed ? { kind: "clarify_turn" } : null, error: failed ? "澄清失败" : null },
      items: [],
    }
  }

  if (stage === "draft") {
    // waiting = 待选风格规范方向（清单未建）；running = 已选定方向、初稿撰写中（清单齐备）
    const items = busy
      ? itemsOf(CARD_TOTAL, () => ({ status: "pending" }))
      : []
    return {
      run: { ...base, pendingAction: busy ? { kind: "design_drafts" } : null, error: failed ? "初稿失败" : null },
      items,
    }
  }

  if (stage === "final") {
    // waiting = 78 张终稿齐备（结构化两段）
    return {
      run: { ...base, selectedDirectionId: "dir-1", pendingAction: failed ? { kind: "design_finals" } : null, error: failed ? "终稿失败" : null },
      items: itemsOf(CARD_TOTAL, () => ({ status: "pending", currentPrompt: FINAL_PROMPT })),
    }
  }

  if (stage === "art") {
    if (status === "running") {
      // 全套生产进行中：部分卡在途
      return {
        run: { ...base, selectedDirectionId: "dir-1", pendingAction: { kind: "produce_cards" } },
        items: itemsOf(CARD_TOTAL, (index) =>
          index < 8
            ? { status: "approved_by_ai", currentPrompt: FINAL_PROMPT, latestRoundId: `r${index}`, latestImageUrl: `u${index}`, finalRoundId: `r${index}` }
            : { status: "generating", currentPrompt: FINAL_PROMPT },
        ),
      }
    }
    // waiting = 小样收口：6 张小样全终态（1 张失败），非小样尚未生产
    // error = produce_cards 整体失败（同口径小样数据 + run.error）
    return {
      run: {
        ...base,
        selectedDirectionId: "dir-1",
        pendingAction: failed ? { kind: "produce_cards" } : null,
        error: failed ? "生产失败" : null,
      },
      items: itemsOf(CARD_TOTAL, (index) => {
        if (!SAMPLE_INDEXES.includes(index)) return { status: "pending", currentPrompt: FINAL_PROMPT }
        if (index === SAMPLE_INDEXES[2]) return { status: "failed", currentPrompt: FINAL_PROMPT, errorMessage: "生图失败" }
        return {
          status: "approved_by_ai",
          currentPrompt: FINAL_PROMPT,
          latestRoundId: `r${index}`,
          latestImageUrl: `u${index}`,
          finalRoundId: `r${index}`,
          roundsUsed: 1,
        }
      }),
    }
  }

  // compose：全套 78 张定稿交付（部分卡被打回过一轮）
  return {
    run: { ...base, selectedDirectionId: "dir-1", phase: "full", pendingAction: failed ? { kind: "compose_batch" } : null, error: failed ? "融合失败" : null },
    items: itemsOf(CARD_TOTAL, (index) => ({
      status: "confirmed",
      currentPrompt: FINAL_PROMPT,
      latestRoundId: `r${index}`,
      latestImageUrl: `u${index}`,
      finalRoundId: `r${index}`,
      roundsUsed: index % 3 === 0 ? 2 : 1,
    })),
  }
}

function boardOf(stage: Stage, status: Status): NodeCardInfo[] {
  const { run, items } = makeFixture(stage, status)
  return deriveClassicNodeBoard({ run, items, cardTotal: CARD_TOTAL })
}

function cardOf(cards: NodeCardInfo[], nodeKey: (typeof CLASSIC_NODE_KEYS)[number]): NodeCardInfo {
  const found = cards.find((card) => card.nodeKey === nodeKey)
  if (!found) throw new Error(`missing node card: ${nodeKey}`)
  return found
}

describe("deriveClassicNodeBoard", () => {
  it("恒定输出 8 张卡，顺序与经典节点一致", () => {
    for (const stage of STAGES) {
      for (const status of STATUSES) {
        const cards = boardOf(stage, status)
        expect(cards.map((card) => card.nodeKey)).toEqual([...CLASSIC_NODE_KEYS])
      }
    }
  })

  it("clarify 阶段：style 等待/运行，生产四节点待命且无进度", () => {
    const waiting = boardOf("clarify", "waiting_human")
    expect(cardOf(waiting, "style").status).toBe("waiting")
    expect(cardOf(waiting, "imagegen").status).toBe("idle")
    expect(cardOf(waiting, "supervisor").total).toBe(0)

    const running = boardOf("clarify", "running")
    expect(cardOf(running, "style").status).toBe("running")
  })

  it("style/structure 随阶段推进完成（简报确认 / 方向选定 + 78 张清单）", () => {
    // draft 等待用户 = 待选风格规范方向：简报已确认（style done），清单未建（structure waiting）
    const draftWaiting = boardOf("draft", "waiting_human")
    expect(cardOf(draftWaiting, "style").status).toBe("done")
    expect(cardOf(draftWaiting, "structure").status).toBe("waiting")
    expect(cardOf(draftWaiting, "structure").total).toBe(CARD_TOTAL)

    // draft 进行中 = 已选定方向、初稿撰写中：清单齐备（structure done），终稿未开始（copywriter running）
    const draftRunning = boardOf("draft", "running")
    expect(cardOf(draftRunning, "structure").status).toBe("done")
    expect(cardOf(draftRunning, "structure").processed).toBe(CARD_TOTAL)
    expect(cardOf(draftRunning, "copywriter").status).toBe("running")

    const final = boardOf("final", "waiting_human")
    // final 阶段 78 张终稿齐备（结构化两段）→ copywriter（终稿细化师）完成
    expect(cardOf(final, "copywriter").status).toBe("done")
    expect(cardOf(final, "copywriter").processed).toBe(CARD_TOTAL)
  })

  it("art 等待（小样收口）：小样口径进度，生产节点完成", () => {
    const cards = boardOf("art", "waiting_human")
    const samples = makeFixture("art", "waiting_human").items.filter((item) => item.isSample)
    const withImage = samples.filter((item) => item.latestImageUrl).length
    expect(cardOf(cards, "imagegen").status).toBe("done")
    expect(cardOf(cards, "imagegen").total).toBe(samples.length)
    expect(cardOf(cards, "imagegen").processed).toBe(withImage)
    // 失败小样进入警示行
    expect(cardOf(cards, "imagegen").failedCount).toBe(1)
  })

  it("art 进行中：生产节点 running，进度为全套口径", () => {
    const cards = boardOf("art", "running")
    expect(cardOf(cards, "imagegen").status).toBe("running")
    expect(cardOf(cards, "imagegen").total).toBe(CARD_TOTAL)
    expect(cardOf(cards, "review_content").status).toBe("running")
  })

  it("art 全套生产整体失败（error + phase=full）：错误归属 imagegen，全套口径而非小样", () => {
    // 全套生产中途失败：8 张已出图定稿、4 张失败、其余仍在途（中断瞬间的快照）
    const { run, items } = makeFixture("art", "error")
    const fullFailureItems = itemsOf(CARD_TOTAL, (index) => {
      if (index < 8) {
        return {
          status: "approved_by_ai",
          currentPrompt: FINAL_PROMPT,
          latestRoundId: `r${index}`,
          latestImageUrl: `u${index}`,
          finalRoundId: `r${index}`,
        }
      }
      if (index < 12) return { status: "failed", currentPrompt: FINAL_PROMPT, errorMessage: "生图失败" }
      return { status: "pending", currentPrompt: FINAL_PROMPT }
    })
    const fullFailureRun: NodeBoardRunSnapshot = {
      ...run,
      phase: "full",
      pendingAction: { kind: "produce_cards", phase: "full" },
      error: "全套生产失败",
    }
    const cards = deriveClassicNodeBoard({ run: fullFailureRun, items: fullFailureItems, cardTotal: CARD_TOTAL })

    // produce_cards 出错 → imagegen 节点 failed，lastError 取 run.error
    expect(cardOf(cards, "imagegen").status).toBe("failed")
    expect(cardOf(cards, "imagegen").lastError).toBe("全套生产失败")
    // 全套口径（scope 非 sample）：total = 78 而非小样 6；已出图 8 张
    expect(cardOf(cards, "imagegen").total).toBe(CARD_TOTAL)
    expect(cardOf(cards, "imagegen").processed).toBe(8)
    expect(cardOf(cards, "imagegen").failedCount).toBe(4)
    expect(cardOf(cards, "supervisor").total).toBe(CARD_TOTAL)
    expect(cardOf(cards, "supervisor").processed).toBe(8)
  })

  it("compose 交付：全部完成，裁决 78/78", () => {
    const cards = boardOf("compose", "waiting_human")
    expect(cardOf(cards, "imagegen").status).toBe("done")
    expect(cardOf(cards, "imagegen").processed).toBe(CARD_TOTAL)
    expect(cardOf(cards, "supervisor").status).toBe("done")
    expect(cardOf(cards, "supervisor").processed).toBe(CARD_TOTAL)
  })

  it("error 状态：错误归属对应节点（produce_cards → imagegen / clarify_turn → style）", () => {
    const cards = boardOf("art", "error")
    expect(cardOf(cards, "imagegen").status).toBe("failed")
    expect(cardOf(cards, "imagegen").lastError).toBeTruthy()

    const clarifyError = boardOf("clarify", "error")
    expect(cardOf(clarifyError, "style").status).toBe("failed")
  })

  it("警示行：打回次数 = Σ(roundsUsed - 1)", () => {
    const cards = boardOf("compose", "waiting_human")
    const items = makeFixture("compose", "waiting_human").items
    const expectedRetries = items.reduce((sum, item) => sum + Math.max(0, item.roundsUsed - 1), 0)
    expect(expectedRetries).toBeGreaterThan(0)
    expect(cardOf(cards, "supervisor").retryCount).toBe(expectedRetries)
  })
})

describe("NODE_TO_TEMPLATE_ROLE", () => {
  it("8 个经典节点全部映射到模板角色编制", () => {
    const templateRoleIds = [
      "creative_director",
      "style_director",
      "prompt_designer",
      "final_refiner",
      "artist",
      "review_panel",
      "compositor",
      "supervisor",
    ]
    for (const nodeKey of CLASSIC_NODE_KEYS) {
      expect(templateRoleIds).toContain(NODE_TO_TEMPLATE_ROLE[nodeKey])
    }
  })
})
