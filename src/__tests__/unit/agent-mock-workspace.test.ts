import { describe, expect, it } from "vitest"

import {
  MOCK_CARDS,
  buildMockTarotWorkspace,
  mockCardImageUrl,
  mockDeckScores,
  mockDeliverables,
  mockItemDetail,
  type PreviewStage,
  type PreviewStatus,
} from "@/lib/agent/mocks/tarot-workspace"

/**
 * 塔罗工作台 Mock 构建器单测：保证 /agent/preview 的假数据与
 * getTemplateWorkspaceAction 返回同型（类型漂移会在编译期暴露），
 * 且五阶段 × 三状态都能产出可渲染的完整快照。
 */

const STAGES: PreviewStage[] = ["clarify", "world", "prompt", "art", "compose"]
const STATUSES: PreviewStatus[] = ["waiting_human", "running", "error"]

describe("MOCK_CARDS", () => {
  it("恰好 78 张（22 大阿卡纳 + 4 花色 × 14）且名称唯一", () => {
    expect(MOCK_CARDS).toHaveLength(78)
    expect(MOCK_CARDS.slice(0, 22).every((card) => card.suit === null)).toBe(true)
    expect(MOCK_CARDS.slice(22).every((card) => card.suit !== null)).toBe(true)
    expect(new Set(MOCK_CARDS.map((card) => card.name)).size).toBe(78)
  })

  it("占位图是内联 SVG data-URI（无网络请求）", () => {
    const url = mockCardImageUrl(0)
    expect(url.startsWith("data:image/svg+xml")).toBe(true)
    expect(mockCardImageUrl(0, true)).not.toBe(url)
  })
})

describe("buildMockTarotWorkspace", () => {
  it.each(STAGES.map((stage) => [stage] as const))("%s 阶段可构建完整快照", (stage) => {
    for (const status of STATUSES) {
      const data = buildMockTarotWorkspace(stage, status)
      expect(data.run.template).toBe("tarot")
      expect(data.run.stage).toBe(stage)
      expect(data.run.input.cardCount).toBe(78)
      // itemStats 与 items 的状态分布一致
      const total = data.itemStats.reduce((sum, entry) => sum + entry.count, 0)
      expect(total).toBe(data.items.length)
    }
  })

  it("clarify/world 阶段无卡牌清单；prompt 起为 78 张", () => {
    expect(buildMockTarotWorkspace("clarify", "waiting_human").items).toHaveLength(0)
    expect(buildMockTarotWorkspace("world", "waiting_human").items).toHaveLength(0)
    expect(buildMockTarotWorkspace("prompt", "waiting_human").items).toHaveLength(78)
  })

  it("clarify 等待中：有未答追问与简报，且无待执行动作", () => {
    const data = buildMockTarotWorkspace("clarify", "waiting_human")
    expect(data.run.pendingAction).toBeNull()
    expect(data.run.brief).toBeTruthy()
    const last = data.messages[data.messages.length - 1]!
    expect(last.role).toBe("assistant")
    expect(last.meta?.kind).toBe("clarify")
    if (last.meta?.kind === "clarify") {
      expect(last.meta.questions.length).toBeGreaterThan(0)
      expect(last.meta.round).toBe(2)
    }
  })

  it("running/error 状态带 pendingAction（可渲染重试/处理中横幅）", () => {
    for (const stage of STAGES) {
      expect(buildMockTarotWorkspace(stage, "running").run.pendingAction).not.toBeNull()
      const failed = buildMockTarotWorkspace(stage, "error").run
      expect(failed.status).toBe("failed")
      expect(failed.error).toBeTruthy()
      expect(failed.pendingAction).not.toBeNull()
    }
  })

  it("world 阶段恰有 3 个内容方向；选定后阶段带 selectedDirectionId", () => {
    const world = buildMockTarotWorkspace("world", "waiting_human")
    expect(world.run.directions).toHaveLength(3)
    expect(world.run.selectedDirectionId).toBeNull()
    expect(buildMockTarotWorkspace("prompt", "waiting_human").run.selectedDirectionId).toBeTruthy()
  })

  it("art 等待中小样全部终态（触发小样确认横幅）；compose 全部融合完成", () => {
    const art = buildMockTarotWorkspace("art", "waiting_human")
    const samples = art.items.filter((item) => item.isSample)
    expect(samples).toHaveLength(6)
    expect(samples.every((item) => !["pending", "drafting", "generating", "reviewing"].includes(item.status))).toBe(true)
    expect(samples.filter((item) => ["approved_by_ai", "fallback", "confirmed"].includes(item.status)).length).toBeGreaterThan(0)

    const compose = buildMockTarotWorkspace("compose", "waiting_human")
    expect(compose.items).toHaveLength(78)
    expect(compose.items.every((item) => item.frameStatus === "framed" && item.framedImageUrl)).toBe(true)
    expect(compose.assets).toHaveLength(6)
  })
})

describe("读操作 mock", () => {
  it("评分聚合：art+ 阶段有样本与阈值", () => {
    const scores = mockDeckScores("art")
    expect(scores.sampled).toBeGreaterThan(0)
    expect(scores.thresholds.aesthetic).toBeGreaterThan(0)
    expect(mockDeckScores("clarify").sampled).toBe(0)
  })

  it("交付物：compose 阶段 78 卡 + 6 资产全部就绪", () => {
    const data = buildMockTarotWorkspace("compose", "waiting_human")
    const deliverables = mockDeliverables(data)
    expect(deliverables.totalCount).toBe(84)
    expect(deliverables.readyCount).toBe(84)
    expect(deliverables.files.every((file) => !!file.url)).toBe(true)
  })

  it("单卡详情：2 轮回放 + 评审与裁决记录，第二轮为终版", () => {
    const data = buildMockTarotWorkspace("art", "waiting_human")
    const item = data.items.find((candidate) => candidate.isSample && candidate.finalRoundId) ?? data.items[0]!
    const detail = mockItemDetail(item.id, data)
    expect(detail.rounds).toHaveLength(2)
    expect(detail.reviews.some((review) => review.kind === "verdict")).toBe(true)
    expect(detail.item.finalRoundId).toBe(detail.rounds[1]!.id)
  })
})
