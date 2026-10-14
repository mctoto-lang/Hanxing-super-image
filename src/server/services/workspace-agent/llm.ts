/**
 * 工作台 Agent LLM 调用与计费（worker 侧）
 *
 * 语义与 services/agent/llm.ts 一致（对齐 chat SSE / Agent 工坊结算口径）：
 * - 聚合 dispatchStreamChat 为完整文本 + 真实 usage（缺失时按字符启发式
 *   估算兜底，宁可略高不漏账）；
 * - 每次调用写一条 workspace_agent_usage 账本行（LLM 厘 = 0.01 积分）；
 * - 厘累计到 workflow（costCenticredits/unbilledCenticredits/llmCallCount），
 *   满 100 厘（1 积分）行锁原子认领后扣企业池（deductCredits，taskId 记
 *   workflowId 便于对账），零头保留自愈；余额不足挂账待补扣；
 * - 实际发起流式调用前经 withAgentLlmSlot 三层并发槽位（模型 / 权限组 /
 *   企业对话，hanxing:agentllm:* 键），与 Agent 工坊、生图队列同款队列
 *   控制口径：多 worker 副本共享同一并发预算，超限排队等待。
 */
import { eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  workspaceAgentEvents,
  workspaceAgentUsage,
  workspaceAgentWorkflows,
  type WorkspaceAgentWorkflowRow,
} from "@/db/schema"
import { dispatchStreamChat } from "@/lib/ai/chat"
import type {
  ChatContentPart,
  ChatStreamEvent,
  ChatUpstreamMessage,
  ThinkingLevel,
} from "@/lib/ai/chat/chat-model-config"
import {
  calcMessageCostCenticredits,
  estimateMessageTokens,
} from "@/lib/ai/chat/chat-model-config"
import {
  deductCredits,
  CreditsInsufficientError,
} from "@/server/services/credits-service"
import { signUploadToken } from "@/lib/storage/upload-token"
import { parseJsonLoose, LlmJsonParseError } from "@/server/services/agent/llm-json"
import { LlmValidationError } from "@/server/services/agent/llm-errors"
import {
  withAgentLlmSlot,
  type AgentLlmSlotContext,
} from "@/server/services/agent/llm-slots"

export type WorkspaceAgentChatModelRow = typeof chatApiConfigs.$inferSelect

/** 单次调用时长预算：取模型 taskTimeout，至少 120 秒（防 worker 被挂死流拖死） */
function llmBudgetSec(model: WorkspaceAgentChatModelRow): number {
  return Math.max(120, model.taskTimeout || 300)
}

/** 加载对话模型（isActive + 企业归属校验；发起时已过候选池，执行期复验） */
export async function loadWorkspaceAgentChatModel(
  modelId: string,
  enterpriseId: string,
): Promise<WorkspaceAgentChatModelRow> {
  const [row] = await db
    .select()
    .from(chatApiConfigs)
    .where(eq(chatApiConfigs.id, modelId))
  if (!row || !row.isActive) throw new Error("对话模型不存在或已停用")
  if (row.enterpriseId !== null && row.enterpriseId !== enterpriseId) {
    throw new Error("对话模型不在本企业可用范围内")
  }
  return row
}

/**
 * 聚合流式调用为完整文本 + usage。流中任意位置出现 error 事件即抛错；
 * usage 缺失时按估算兜底（计费口径同 chat SSE / Agent 工坊）。
 * 传入 slot 时在三层并发槽位（模型/权限组/企业对话）内发起：槽等待为排队
 * 语义，不占用单次调用时长预算（deadline 在真正发起流之后才启动）。
 */
export async function callWorkspaceAgentLlmText(
  model: WorkspaceAgentChatModelRow,
  opts: {
    systemPrompt: string
    messages: ChatUpstreamMessage[]
    thinkingLevel?: ThinkingLevel
  },
  slot?: AgentLlmSlotContext,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const budgetSec = llmBudgetSec(model)
  let text = ""
  let inputTokens = 0
  let outputTokens = 0
  let sawError: string | null = null
  const consume = async (): Promise<void> => {
    for await (const ev of dispatchStreamChat(model, {
      messages: opts.messages,
      systemPrompt: opts.systemPrompt,
      thinkingLevel: opts.thinkingLevel ?? "medium",
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
  }
  const runWithBudget = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`模型调用超时（上限 ${budgetSec} 秒），已中止本次调用`)),
        budgetSec * 1000,
      )
    })
    const consuming = consume()
    try {
      await Promise.race([consuming, deadline])
    } finally {
      clearTimeout(timer)
      consuming.catch(() => {}) // 超时后吞掉后台流后续异常，防 unhandledRejection
    }
  }
  if (slot) {
    await withAgentLlmSlot(slot, model, runWithBudget)
  } else {
    await runWithBudget()
  }
  if (sawError) throw new Error(`模型调用失败：${sawError}`)
  if (!text.trim()) {
    throw new Error("模型返回空内容（推理型模型可能把正文放进了思考通道，请检查模型配置或更换模型）")
  }
  if (inputTokens === 0 && outputTokens === 0) {
    inputTokens =
      opts.messages.reduce((s, m) => s + estimateMessageTokens(m), 0) +
      estimateMessageTokens({ content: opts.systemPrompt })
    outputTokens = estimateMessageTokens({ content: text })
  }
  return { text, inputTokens, outputTokens }
}

/**
 * 记账 + 结算一次成功调用：usage 账本行 + workflow 计数器累计 + 满 100 厘
 * 原子认领扣企业池。余额不足不中断流程：零头挂账 + warn 事件，下次再扣。
 */
export async function settleWorkspaceAgentLlmCall(input: {
  workflow: WorkspaceAgentWorkflowRow
  model: WorkspaceAgentChatModelRow
  nodeKey: string
  inputTokens: number
  outputTokens: number
  durationMs: number
}): Promise<void> {
  const { workflow, model } = input
  const cost = calcMessageCostCenticredits({
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    inputPriceCenticredits: model.inputPriceCenticredits,
    outputPriceCenticredits: model.outputPriceCenticredits,
  })
  await db.insert(workspaceAgentUsage).values({
    workflowId: workflow.id,
    enterpriseId: workflow.enterpriseId,
    userId: workflow.userId,
    kind: "llm",
    nodeKey: input.nodeKey,
    chatApiId: model.id,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costCenticredits: cost,
    status: "success",
    durationMs: input.durationMs,
  })
  const [row] = await db
    .update(workspaceAgentWorkflows)
    .set({
      costCenticredits: sql`${workspaceAgentWorkflows.costCenticredits} + ${cost}`,
      unbilledCenticredits: sql`${workspaceAgentWorkflows.unbilledCenticredits} + ${cost}`,
      llmCallCount: sql`${workspaceAgentWorkflows.llmCallCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(workspaceAgentWorkflows.id, workflow.id))
    .returning({ unbilled: workspaceAgentWorkflows.unbilledCenticredits })
  const unbilled = row?.unbilled ?? 0
  if (unbilled < 100) return
  const claimedCredits = await claimUnbilledCredits(workflow.id)
  if (claimedCredits <= 0) return
  try {
    await deductCredits({
      enterpriseId: workflow.enterpriseId,
      userId: workflow.userId,
      amount: claimedCredits,
      taskId: workflow.id,
      remark: `工作台 Agent 模型调用 · ${model.displayName}`,
    })
  } catch (err) {
    if (err instanceof CreditsInsufficientError) {
      // 余额不足：认领的厘退回零头池，下一笔调用再试扣（同 Agent 工坊策略）
      await db
        .update(workspaceAgentWorkflows)
        .set({
          unbilledCenticredits: sql`${workspaceAgentWorkflows.unbilledCenticredits} + ${claimedCredits * 100}`,
        })
        .where(eq(workspaceAgentWorkflows.id, workflow.id))
      await db.insert(workspaceAgentEvents).values({
        workflowId: workflow.id,
        enterpriseId: workflow.enterpriseId,
        nodeKey: input.nodeKey,
        action: "fail",
        status: "warn",
        detail: `模型费用结算时企业积分不足（待扣 ${claimedCredits} 积分），已挂账待余额恢复后补扣`,
      })
      return
    }
    throw err
  }
}

/** 记一次失败调用（不计费或按 0 计；留痕账本 + 心跳） */
export async function recordWorkspaceAgentLlmFailure(input: {
  workflow: WorkspaceAgentWorkflowRow
  model: WorkspaceAgentChatModelRow | null
  nodeKey: string
  errorMessage: string
  durationMs: number
}): Promise<void> {
  await db.insert(workspaceAgentUsage).values({
    workflowId: input.workflow.id,
    enterpriseId: input.workflow.enterpriseId,
    userId: input.workflow.userId,
    kind: "llm",
    nodeKey: input.nodeKey,
    chatApiId: input.model?.id ?? null,
    status: "failure",
    errorMessage: input.errorMessage.slice(0, 500),
    durationMs: input.durationMs,
  })
}

/** 行锁下原子认领整百厘（并发调用互不重复；扣费额 = 认领额，同 Agent 工坊） */
async function claimUnbilledCredits(workflowId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ unbilled: workspaceAgentWorkflows.unbilledCenticredits })
      .from(workspaceAgentWorkflows)
      .where(eq(workspaceAgentWorkflows.id, workflowId))
      .for("update")
    const amount = row?.unbilled ?? 0
    if (amount < 100) return 0
    const credits = Math.floor(amount / 100)
    await tx
      .update(workspaceAgentWorkflows)
      .set({ unbilledCenticredits: amount - credits * 100, updatedAt: new Date() })
      .where(eq(workspaceAgentWorkflows.id, workflowId))
    return credits
  })
}

// ---------------------------------------------------------------------------
// JSON 输出调用（解析失败自动纠错重试；每次尝试都计费）
// ---------------------------------------------------------------------------

const WA_LLM_JSON_MAX_ATTEMPTS = 3

/**
 * 调用 LLM 并解析 JSON 输出；解析/字段校验失败时追加纠错提示重试
 * （复用 Agent 工坊的宽松解析与 nudge 策略），最多 3 次，仍失败抛可诊断错误。
 */
export async function callWorkspaceAgentLlmJson<T = Record<string, unknown>>(
  input: {
    workflow: WorkspaceAgentWorkflowRow
    model: WorkspaceAgentChatModelRow
    nodeKey: string
    systemPrompt: string
    messages: ChatUpstreamMessage[]
    thinkingLevel?: ThinkingLevel
    /** 解析成功后的字段校验；抛 LlmValidationError 走纠错重试 */
    validate?: (parsed: T) => void
  },
): Promise<T> {
  const slotCtx: AgentLlmSlotContext = {
    run: {
      userId: input.workflow.userId,
      enterpriseId: input.workflow.enterpriseId,
    },
  }
  const attempt = async (nudge?: string): Promise<string> => {
    const systemPrompt = nudge
      ? `${input.systemPrompt}\n\n上一次输出不符合要求（${nudge.slice(0, 240)}）。请严格只输出一个合法的 JSON 对象，包含全部必需字段，不要包含任何其他文字或代码块标记。`
      : input.systemPrompt
    const startedAt = Date.now()
    const { text, inputTokens, outputTokens } = await callWorkspaceAgentLlmText(
      input.model,
      { systemPrompt, messages: input.messages, thinkingLevel: input.thinkingLevel },
      // 三层并发槽位（模型/权限组/企业对话，与 Agent 工坊共享预算）；
      // 限额在 ctx 上惰性加载并缓存，纠错重试的各次尝试共用
      slotCtx,
    )
    await settleWorkspaceAgentLlmCall({
      workflow: input.workflow,
      model: input.model,
      nodeKey: input.nodeKey,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - startedAt,
    })
    return text
  }

  let lastError: Error | null = null
  for (let i = 0; i < WA_LLM_JSON_MAX_ATTEMPTS; i++) {
    // 网络等硬错误在 attempt 内直接上抛（已发生的调用逐次计费），不重试
    const text = await attempt(
      i === 0
        ? undefined
        : lastError instanceof LlmJsonParseError
          ? `输出无法解析为 JSON（${lastError.reason}）`
          : (lastError?.message ?? "").slice(0, 240),
    )
    try {
      const parsed = parseJsonLoose<T>(text)
      if (input.validate) input.validate(parsed)
      return parsed
    } catch (err) {
      if (err instanceof LlmValidationError || err instanceof LlmJsonParseError) {
        lastError = err
        continue
      }
      throw err
    }
  }
  throw new Error(
    `LLM 输出不符合要求（${lastError?.message ?? "未知原因"}），已连续尝试 ${WA_LLM_JSON_MAX_ATTEMPTS} 次`,
  )
}

// ---------------------------------------------------------------------------
// 视觉输入（ChatUpstreamMessage 多模态 parts）
// ---------------------------------------------------------------------------

/**
 * 组装带参考图的用户消息：模型支持视觉时以 ChatContentPart 数组附图
 * （signUploadToken 签名，同 Agent 工坊读图口径）；不支持时退纯文本并
 * 由调用方决定是否告警。工作台 Agent 主模型在发起时已强制 supportsVision，
 * 此处的降级只是执行期兜底。
 */
export function buildVisionUserMessage(input: {
  text: string
  referenceImages: string[]
  supportsVision: boolean
}): { message: ChatUpstreamMessage; skippedImageCount: number } {
  const images = input.referenceImages.filter(Boolean)
  if (images.length === 0 || !input.supportsVision) {
    return {
      message: { role: "user", content: input.text },
      skippedImageCount: images.length > 0 && !input.supportsVision ? images.length : 0,
    }
  }
  const parts: ChatContentPart[] = [
    { type: "text", text: input.text },
    ...images.map((url) => ({
      type: "image_url" as const,
      image_url: { url: signUploadToken(url) },
    })),
  ]
  return { message: { role: "user", content: parts }, skippedImageCount: 0 }
}
