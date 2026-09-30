/**
 * Agent LLM 调用与计费共享层（经典流水线编排器 + 模板化步骤共用）
 *
 * 从 agent-orchestrator 抽出：调用方只依赖最小上下文接口 AgentLlmContext
 * （run 行 + 对话模型缓存），经典流水线传 RunEnv 超集，模板化步骤传
 * { run, chatModelCache } 即可复用同一套调用与计费语义。
 *
 * 计费语义（与 chat SSE 结算一致）：
 * - 每次调用按实际 usage × 模型厘价累计到 run（厘 = 0.01 积分）；
 * - usage 缺失时按字符启发式估算兜底（宁可略高不漏账）；
 * - 满 100 厘（1 积分）原子扣企业池写流水（deductCredits，taskId 记 runId
 *   便于对账），零头保留自愈。
 */
import { eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { agentEvents, agentRuns, chatApiConfigs, type AgentRunRow } from "@/db/schema"
import { dispatchStreamChat } from "@/lib/ai/chat"
import type { ChatStreamEvent, ChatUpstreamMessage, ThinkingLevel } from "@/lib/ai/chat/chat-model-config"
import { calcMessageCostCenticredits, estimateMessageTokens } from "@/lib/ai/chat/chat-model-config"
import { deductCredits, CreditsInsufficientError } from "@/server/services/credits-service"
import type { AgentThinkingLevel } from "@/lib/agent/graph"

export type ChatModelRow = typeof chatApiConfigs.$inferSelect

/** LLM 调用最小上下文（agent-orchestrator 的 RunEnv 是其超集） */
export interface AgentLlmContext {
  run: AgentRunRow
  chatModelCache: Map<string, ChatModelRow>
}

/** 运行计费/日志用展示名（固定流水线：方向名） */
export function runLabel(run: { direction: string | null }): string {
  switch (run.direction) {
    case "tarot":
      return "塔罗牌工坊"
    case "oracle":
      return "神谕卡工坊"
    case "poker":
      return "扑克牌工坊"
    default:
      return "AI Agent"
  }
}

/** 加载对话模型（平台预置或本企业私有；未配置/不可用抛错） */
export async function loadChatModel(ctx: AgentLlmContext, modelId: string | null): Promise<ChatModelRow> {
  if (!modelId) throw new Error("节点未配置对话模型")
  const cached = ctx.chatModelCache.get(modelId)
  if (cached) return cached
  const [row] = await db
    .select()
    .from(chatApiConfigs)
    .where(eq(chatApiConfigs.id, modelId))
  if (!row || !row.isActive) throw new Error("对话模型不存在或已停用")
  if (row.enterpriseId !== null && row.enterpriseId !== ctx.run.enterpriseId) {
    throw new Error("对话模型不在本企业可用范围内")
  }
  ctx.chatModelCache.set(modelId, row)
  return row
}

/**
 * 聚合流式调用为完整文本 + usage（usage 缺失时按估算兜底计费，同 chat SSE 策略）。
 * 流中任意位置出现 error 事件即抛错（不返回半截文本，避免残缺输出污染下游）。
 */
export async function callLlmText(
  model: ChatModelRow,
  opts: {
    systemPrompt: string
    messages: ChatUpstreamMessage[]
    thinkingLevel: AgentThinkingLevel
  },
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  let text = ""
  let inputTokens = 0
  let outputTokens = 0
  let sawError: string | null = null
  for await (const ev of dispatchStreamChat(model, {
    messages: opts.messages,
    systemPrompt: opts.systemPrompt,
    thinkingLevel: opts.thinkingLevel as ThinkingLevel,
  })) {
    const e = ev as ChatStreamEvent
    if (e.type === "text_delta") {
      text += e.text
    } else if (e.type === "usage") {
      inputTokens = Math.max(inputTokens, e.inputTokens ?? 0)
      outputTokens = Math.max(outputTokens, e.outputTokens ?? 0)
    } else if (e.type === "error") {
      sawError = e.message
    }
  }
  if (sawError) throw new Error(`模型调用失败：${sawError}`)
  if (inputTokens === 0 && outputTokens === 0) {
    // 计费兜底估算（宁可略高不漏账）
    inputTokens = opts.messages.reduce((s, m) => s + estimateMessageTokens(m), 0) +
      estimateMessageTokens({ content: opts.systemPrompt })
    outputTokens = estimateMessageTokens({ content: text })
  }
  return { text, inputTokens, outputTokens }
}

/** 字段校验失败（可触发一次纠错重试）——定义见 llm-errors.ts（零依赖小模块） */
export { LlmValidationError } from "./llm-errors"
import { LlmValidationError } from "./llm-errors"

export class LlmJsonParseError extends Error {
  constructor(public raw: string) {
    super("LLM 输出无法解析为 JSON")
    this.name = "LlmJsonParseError"
  }
}

/** 宽松 JSON 解析：剥离 ``` 代码块围栏、截取首尾大括号之间 */
export function parseJsonLoose<T>(text: string): T {
  const stripped = text.replace(/```(?:json)?/gi, "").trim()
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new LlmJsonParseError(text)
  }
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as T
  } catch {
    throw new LlmJsonParseError(text)
  }
}

/**
 * 调用 LLM 并解析 JSON 输出；解析失败或字段校验（validate）不通过时，
 * 自动追加纠错提示重试一次，仍失败抛错（调用方按失败处置）。两次调用都计费。
 */
export async function callLlmJson<T = Record<string, unknown>>(
  ctx: AgentLlmContext,
  model: ChatModelRow,
  opts: {
    systemPrompt: string
    messages: ChatUpstreamMessage[]
    thinkingLevel: AgentThinkingLevel
    /** 解析成功后的字段校验；抛错走纠错重试 */
    validate?: (parsed: T) => void
  },
): Promise<T> {
  const attempt = async (nudge?: string): Promise<T> => {
    const systemPrompt = nudge
      ? `${opts.systemPrompt}\n\n上一次输出不符合要求（${nudge.slice(0, 160)}）。请严格只输出一个合法的 JSON 对象，包含全部必需字段，不要包含任何其他文字或代码块标记。`
      : opts.systemPrompt
    const { text, inputTokens, outputTokens } = await callLlmText(model, {
      systemPrompt,
      messages: opts.messages,
      thinkingLevel: opts.thinkingLevel,
    })
    await settleLlmCost(ctx, model, inputTokens, outputTokens)
    const parsed = parseJsonLoose<T>(text)
    if (opts.validate) opts.validate(parsed)
    return parsed
  }
  try {
    return await attempt()
  } catch (err) {
    if (err instanceof LlmJsonParseError) {
      return await attempt(`输出无法解析为 JSON，原文片段：${err.raw.slice(0, 120)}`)
    }
    if (err instanceof LlmValidationError) {
      return await attempt(err.message)
    }
    throw err
  }
}

/** LLM 成本结算：厘累计到 run，满 100 厘原子扣企业池（零头保留自愈） */

/**
 * 行锁下原子认领整百厘（并发调用各自认领互不重复；扣费额 = 认领额）。
 * 之前的「读 returning → 算 credits → 覆盖写零头」是非原子读-改-写：
 * 并发 LLM 调用同时满 100 厘时会按各自的陈旧读数重复扣企业积分。
 */
async function claimUnbilledCredits(runId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ unbilled: agentRuns.unbilledCenticredits })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update")
    const amount = row?.unbilled ?? 0
    if (amount < 100) return 0
    const credits = Math.floor(amount / 100)
    await tx
      .update(agentRuns)
      .set({ unbilledCenticredits: amount - credits * 100, updatedAt: new Date() })
      .where(eq(agentRuns.id, runId))
    return credits
  })
}

export async function settleLlmCost(
  ctx: AgentLlmContext,
  model: ChatModelRow,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const cost = calcMessageCostCenticredits({
    inputTokens,
    outputTokens,
    inputPriceCenticredits: model.inputPriceCenticredits,
    outputPriceCenticredits: model.outputPriceCenticredits,
  })
  const [row] = await db
    .update(agentRuns)
    .set({
      costCenticredits: sql`${agentRuns.costCenticredits} + ${cost}`,
      unbilledCenticredits: sql`${agentRuns.unbilledCenticredits} + ${cost}`,
      llmCallCount: sql`${agentRuns.llmCallCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, ctx.run.id))
    .returning({ unbilled: agentRuns.unbilledCenticredits })
  const unbilled = row?.unbilled ?? 0
  if (unbilled < 100) return
  const claimedCredits = await claimUnbilledCredits(ctx.run.id)
  if (claimedCredits <= 0) return
  try {
    await deductCredits({
      enterpriseId: ctx.run.enterpriseId,
      userId: ctx.run.userId,
      amount: claimedCredits,
      taskId: ctx.run.id,
      remark: `AI Agent 模型调用 · ${model.displayName} · ${runLabel(ctx.run)}`,
    })
  } catch (err) {
    if (err instanceof CreditsInsufficientError) {
      // 余额不足：认领的厘退回零头池，下一笔调用/运行结束再试扣
      await db
        .update(agentRuns)
        .set({ unbilledCenticredits: sql`${agentRuns.unbilledCenticredits} + ${claimedCredits * 100}` })
        .where(eq(agentRuns.id, ctx.run.id))
      await db.insert(agentEvents).values({
        runId: ctx.run.id,
        action: "fail",
        status: "warn",
        detail: `模型费用结算时企业积分不足（待扣 ${claimedCredits} 积分），已挂账待余额恢复后补扣`,
      })
      return
    }
    throw err
  }
}
