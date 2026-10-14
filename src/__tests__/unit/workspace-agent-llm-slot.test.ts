import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  callWorkspaceAgentLlmJson,
  callWorkspaceAgentLlmText,
  type WorkspaceAgentChatModelRow,
} from "@/server/services/workspace-agent/llm"
import type { WorkspaceAgentWorkflowRow } from "@/db/schema"

/**
 * 工作台 Agent LLM 调用三层并发槽位接线单测：
 * - callWorkspaceAgentLlmJson 的每次真实流式调用都必须经 withAgentLlmSlot
 *   （模型 / 权限组 / 企业对话，与 Agent 工坊共享 hanxing:agentllm:* 预算）；
 * - 槽位上下文从 workflow 构造（userId / enterpriseId）；
 * - 纠错重试的每次尝试都重新占槽；
 * - callWorkspaceAgentLlmText 未传 slot 时直通（不占槽）。
 */

const slotState = vi.hoisted(() => ({
  /** 每次 withAgentLlmSlot 收到的 ctx */
  contexts: [] as Array<{ run: { userId: string; enterpriseId: string } }>,
  /** 每次 withAgentLlmSlot 收到的 model */
  models: [] as unknown[],
  /** dispatchStreamChat 依次吐出的文本（每次消费 shift 一个） */
  streamTexts: [] as string[],
}))

vi.mock("@/server/services/agent/llm-slots", () => ({
  withAgentLlmSlot: vi.fn(
    async (
      ctx: { run: { userId: string; enterpriseId: string } },
      model: unknown,
      fn: () => Promise<unknown>,
    ) => {
      slotState.contexts.push(ctx)
      slotState.models.push(model)
      return await fn()
    },
  ),
}))

vi.mock("@/lib/ai/chat", () => ({
  dispatchStreamChat: vi.fn(async function* () {
    const text = slotState.streamTexts.shift() ?? '{"ok":true}'
    yield { type: "text_delta", text }
    yield { type: "usage", inputTokens: 10, outputTokens: 5 }
  }),
}))

vi.mock("@/db/client", () => {
  // callWorkspaceAgentLlmJson 成功路径只走 usage 账本 insert + workflow 计数
  // update（unbilled < 100 直接返回，不触发扣费）
  const returning = async () => [{ unbilled: 0 }]
  const chain = {
    values: async () => {},
    set: () => ({ where: () => ({ returning }) }),
    where: () => ({ returning }),
  }
  return {
    db: {
      insert: () => chain,
      update: () => chain,
    },
  }
})

vi.mock("@/server/services/credits-service", () => ({
  deductCredits: async () => {},
  CreditsInsufficientError: class CreditsInsufficientError extends Error {},
}))

vi.mock("@/lib/storage/upload-token", () => ({
  signUploadToken: (url: string) => url,
}))

const model = {
  id: "chat-1",
  displayName: "Test Chat",
  taskTimeout: 300,
  maxConcurrent: 2,
} as unknown as WorkspaceAgentChatModelRow

const workflow = {
  id: "wf-1",
  userId: "user-1",
  enterpriseId: "ent-1",
} as unknown as WorkspaceAgentWorkflowRow

beforeEach(() => {
  slotState.contexts = []
  slotState.models = []
  slotState.streamTexts = []
})

describe("callWorkspaceAgentLlmJson 槽位接线", () => {
  it("真实流式调用经 withAgentLlmSlot，ctx 由 workflow 构造", async () => {
    const parsed = await callWorkspaceAgentLlmJson({
      workflow,
      model,
      nodeKey: "write_prompts",
      systemPrompt: "只输出 JSON",
      messages: [{ role: "user", content: "写提示词" }],
    })
    expect(parsed).toEqual({ ok: true })
    expect(slotState.contexts).toHaveLength(1)
    expect(slotState.contexts[0]).toEqual({
      run: { userId: "user-1", enterpriseId: "ent-1" },
    })
    expect(slotState.models[0]).toBe(model)
  })

  it("JSON 纠错重试的每次尝试都重新占槽", async () => {
    slotState.streamTexts = ["这不是 JSON", '{"ok":true}']
    const parsed = await callWorkspaceAgentLlmJson({
      workflow,
      model,
      nodeKey: "gen_directions",
      systemPrompt: "只输出 JSON",
      messages: [{ role: "user", content: "出方向" }],
    })
    expect(parsed).toEqual({ ok: true })
    expect(slotState.contexts).toHaveLength(2)
    expect(slotState.contexts[1]).toEqual({
      run: { userId: "user-1", enterpriseId: "ent-1" },
    })
  })
})

describe("callWorkspaceAgentLlmText 槽位直通", () => {
  it("未传 slot 时不经 withAgentLlmSlot（兼容纯文本调用方）", async () => {
    const result = await callWorkspaceAgentLlmText(model, {
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(result.text).toBe('{"ok":true}')
    expect(slotState.contexts).toHaveLength(0)
  })
})
