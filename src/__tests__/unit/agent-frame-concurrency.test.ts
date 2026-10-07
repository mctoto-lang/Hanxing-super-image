import { describe, expect, it, vi } from "vitest"
import { computeFrameConcurrency, FRAME_MAX_CONCURRENCY } from "@/server/services/agent/frame-steps"
import { resolvePromptBatchConcurrency } from "@/server/services/agent/template-steps"
import type { AgentLlmContext, ChatModelRow } from "@/server/services/agent/llm"

// 批并发断言以 AGENT_PROMPT_BATCH_CONCURRENCY 默认值 8 为基准；该变量可由
// .env 外置（合法范围 1-16），且 env 模块在 import 时一次性求值——运行时
// stubEnv 已无法影响。故在导入被测模块前（vi.hoisted 提升到所有 import
// 之前）钉死。forks 池按文件隔离进程，无需还原。
vi.hoisted(() => {
  process.env.AGENT_PROMPT_BATCH_CONCURRENCY = "8"
})

/** 预填 llmLimits 缓存的 ctx（loadLlmLimits 命中缓存即不触 DB） */
function mockCtx(limits: { groupMax: number; entChatMax: number }): AgentLlmContext {
  return {
    run: { userId: "u1", enterpriseId: "e1" } as AgentLlmContext["run"],
    chatModelCache: new Map(),
    llmLimits: {
      groupId: "g1",
      groupMaxConcurrent: limits.groupMax,
      entChatMaxConcurrent: limits.entChatMax,
    },
  } as AgentLlmContext
}

function mockModel(maxConcurrent: number | null): ChatModelRow {
  return { maxConcurrent } as ChatModelRow
}

describe("AI 融合并发池并发数计算", () => {
  it("取企业与权限组上限的最小值", () => {
    expect(computeFrameConcurrency({ enterpriseMax: 5, groupMax: 2, pending: 78 })).toBe(2)
    expect(computeFrameConcurrency({ enterpriseMax: 2, groupMax: 5, pending: 78 })).toBe(2)
  })

  it("权限组 ≤0（不限）时回退企业上限", () => {
    expect(computeFrameConcurrency({ enterpriseMax: 5, groupMax: 0, pending: 78 })).toBe(5)
    expect(computeFrameConcurrency({ enterpriseMax: 5, groupMax: -1, pending: 78 })).toBe(5)
  })

  it("不超过保护上限 8，且恒 ≥1", () => {
    expect(computeFrameConcurrency({ enterpriseMax: 50, groupMax: 0, pending: 78 })).toBe(FRAME_MAX_CONCURRENCY)
    // 两个维度都不限（≤0 全部剔除）→ 回退保护上限 cap（默认 8）
    expect(computeFrameConcurrency({ enterpriseMax: 0, groupMax: 0, pending: 78 })).toBe(FRAME_MAX_CONCURRENCY)
  })

  it("企业不限（≤0 剔除）而组限 5 → 5（不塌缩为 1）", () => {
    expect(computeFrameConcurrency({ enterpriseMax: 0, groupMax: 5, pending: 78 })).toBe(5)
    expect(computeFrameConcurrency({ enterpriseMax: -1, groupMax: 5, pending: 78 })).toBe(5)
  })

  it("不超过待处理张数（小批量预览不空转 worker）", () => {
    expect(computeFrameConcurrency({ enterpriseMax: 8, groupMax: 8, pending: 3 })).toBe(3)
    expect(computeFrameConcurrency({ enterpriseMax: 8, groupMax: 8, pending: 1 })).toBe(1)
  })
})

describe("初稿/终稿批并发动态拉满对话槽位", () => {
  it("三层槽位取最小值（≤0 维度视为不限）", async () => {
    // 模型 6 / 组 2 / 企业 5 → 2
    expect(
      await resolvePromptBatchConcurrency(mockCtx({ groupMax: 2, entChatMax: 5 }), mockModel(6), 10),
    ).toBe(2)
    // 组不限（0）→ min(模型 6, 企业 5) = 5
    expect(
      await resolvePromptBatchConcurrency(mockCtx({ groupMax: 0, entChatMax: 5 }), mockModel(6), 10),
    ).toBe(5)
  })

  it("槽位超环境变量上限时以环境变量为绝对上限", async () => {
    expect(
      await resolvePromptBatchConcurrency(mockCtx({ groupMax: 32, entChatMax: 32 }), mockModel(32), 10),
    ).toBe(8)
  })

  it("三层全不限时回退环境变量默认（8）", async () => {
    expect(
      await resolvePromptBatchConcurrency(mockCtx({ groupMax: 0, entChatMax: 0 }), mockModel(0), 10),
    ).toBe(8)
    expect(
      await resolvePromptBatchConcurrency(mockCtx({ groupMax: 0, entChatMax: 0 }), mockModel(null), 10),
    ).toBe(8)
  })

  it("不超过批数，且恒 ≥1", async () => {
    expect(
      await resolvePromptBatchConcurrency(mockCtx({ groupMax: 8, entChatMax: 8 }), mockModel(8), 3),
    ).toBe(3)
    expect(
      await resolvePromptBatchConcurrency(mockCtx({ groupMax: 8, entChatMax: 8 }), mockModel(8), 0),
    ).toBe(1)
  })
})

