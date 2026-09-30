import { describe, expect, it } from "vitest"

import {
  CLASSIC_NODE_KEYS,
  NODE_TO_TEMPLATE_ROLE,
  deriveClassicNodeBoard,
  type NodeCardInfo,
} from "@/lib/agent/node-board"
import { buildMockTarotWorkspace, type PreviewStage, type PreviewStatus } from "@/lib/agent/mocks/tarot-workspace"

/**
 * 经典 8 节点看板推导单测（纯函数）：以 mock 工作台快照为输入，
 * 校验五阶段 × 三状态下的节点状态/进度/警示推导。
 */

const STAGES: PreviewStage[] = ["clarify", "world", "prompt", "art", "compose"]
const STATUSES: PreviewStatus[] = ["waiting_human", "running", "error"]

function boardOf(stage: PreviewStage, status: PreviewStatus): NodeCardInfo[] {
  const data = buildMockTarotWorkspace(stage, status)
  return deriveClassicNodeBoard({ run: data.run, items: data.items })
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

  it("style/structure 随阶段推进完成（方向定稿 / 78 张清单）", () => {
    const world = boardOf("world", "waiting_human")
    expect(cardOf(world, "structure").status).toBe("waiting")
    expect(cardOf(world, "structure").total).toBe(78)

    const prompt = boardOf("prompt", "waiting_human")
    expect(cardOf(prompt, "style").status).toBe("done")
    expect(cardOf(prompt, "structure").status).toBe("done")
    expect(cardOf(prompt, "structure").processed).toBe(78)
    expect(cardOf(prompt, "copywriter").status).toBe("done")
  })

  it("art 等待（小样收口）：小样口径进度，生产节点完成", () => {
    const cards = boardOf("art", "waiting_human")
    const samples = buildMockTarotWorkspace("art", "waiting_human").items.filter((item) => item.isSample)
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
    expect(cardOf(cards, "imagegen").total).toBe(78)
    expect(cardOf(cards, "review_content").status).toBe("running")
  })

  it("compose 交付：全部完成，裁决 78/78", () => {
    const cards = boardOf("compose", "waiting_human")
    expect(cardOf(cards, "imagegen").status).toBe("done")
    expect(cardOf(cards, "imagegen").processed).toBe(78)
    expect(cardOf(cards, "supervisor").status).toBe("done")
    expect(cardOf(cards, "supervisor").processed).toBe(78)
  })

  it("error 状态：错误归属对应节点（produce_cards → imagegen）", () => {
    const cards = boardOf("art", "error")
    expect(cardOf(cards, "imagegen").status).toBe("failed")
    expect(cardOf(cards, "imagegen").lastError).toBeTruthy()

    const clarifyError = boardOf("clarify", "error")
    expect(cardOf(clarifyError, "style").status).toBe("failed")
  })

  it("警示行：打回次数 = Σ(roundsUsed - 1)", () => {
    const cards = boardOf("compose", "waiting_human")
    const items = buildMockTarotWorkspace("compose", "waiting_human").items
    const expectedRetries = items.reduce((sum, item) => sum + Math.max(0, item.roundsUsed - 1), 0)
    expect(cardOf(cards, "supervisor").retryCount).toBe(expectedRetries)
  })
})

describe("NODE_TO_TEMPLATE_ROLE", () => {
  it("8 个经典节点全部映射到模板角色编制", () => {
    const templateRoleIds = [
      "creative_director",
      "world_planner",
      "prompt_designer",
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
