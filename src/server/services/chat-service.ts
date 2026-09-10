import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  chatConversations,
  chatMessages,
  creditTransactions,
  users,
  type chatApiConfigs as ChatApiConfigTable,
} from "@/db/schema"
import { estimateTokens } from "@/lib/ai/chat/chat-model-config"
import { calcMessageCostCenticredits } from "@/lib/ai/chat/chat-model-config"
import {
  estimateMessageTokens,
  type ChatContentPart,
  type ChatUpstreamMessage,
  type ThinkingLevel,
} from "@/lib/ai/chat/chat-model-config"
import type { UserContext } from "@/lib/auth/session"
import { callChatApi } from "@/server/services/workspace-ai"
import { resolveProductChatConfig } from "@/server/services/product-ai-config"

/**
 * AI 对话服务层（/chat）
 *
 * - 会话/消息 CRUD 与上下文构建（供 actions 与流式路由共用）；
 * - 厘级计费结算 settleChatUsage：余额保持整数，0.01 精度账单记在
 *   chat_message.cost_centicredits，零头累计在
 *   users.chat_unbilled_centicredits，满 100 厘（1 积分）才原子扣减并写流水。
 */

type ChatModelRow = typeof ChatApiConfigTable.$inferSelect

/** 上下文预留（系统提示/格式化开销的保守余量，tokens） */
const CONTEXT_SAFETY_MARGIN = 512

// ═══════════════ 模型可见性 ═══════════════

/**
 * 当前用户可用的对话模型（平台预置 ∩ 企业白名单 + 企业私有，
 * 再经权限组 allowedChatModels 白名单过滤；组白名单空 = 放行全部）。
 * 与 listAvailableModelsAction（生图）同构。
 */
export async function listAccessibleChatModels(
  ctx: UserContext,
): Promise<ChatModelRow[]> {
  if (!ctx.enterprise || !ctx.user.enterpriseId) return []

  const rows = await db
    .select()
    .from(chatApiConfigs)
    .where(eq(chatApiConfigs.isActive, true))
    .orderBy(asc(chatApiConfigs.sortOrder), asc(chatApiConfigs.createdAt))

  const enterpriseId = ctx.user.enterpriseId
  const scoped = rows.filter(
    (m) =>
      m.enterpriseId === null || m.enterpriseId === enterpriseId,
  )

  const whitelist =
    (ctx.enterprise.visiblePresetChatModels as string[] | null) ?? []
  const visible =
    whitelist.length === 0
      ? scoped
      : scoped.filter(
          (m) => m.enterpriseId !== null || whitelist.includes(m.id),
        )

  const groupAllowed = ctx.group?.allowedChatModels ?? []
  if (groupAllowed.length === 0) return visible
  return visible.filter((m) => groupAllowed.includes(m.id))
}

/** 校验模型可访问（流式路由用）；返回 null 或拒绝原因 */
export function checkChatModelAccess(
  ctx: UserContext,
  model: ChatModelRow,
): string | null {
  if (!model.isActive) return "模型已停用"
  const enterpriseId = ctx.user.enterpriseId
  if (model.enterpriseId !== null && model.enterpriseId !== enterpriseId) {
    return "该模型未在企业可用范围内"
  }
  if (model.enterpriseId === null && enterpriseId) {
    const whitelist =
      (ctx.enterprise?.visiblePresetChatModels as string[] | null) ?? []
    if (whitelist.length > 0 && !whitelist.includes(model.id)) {
      return "该平台预置对话模型未对企业开放"
    }
  }
  const groupAllowed = ctx.group?.allowedChatModels ?? []
  if (groupAllowed.length > 0 && !groupAllowed.includes(model.id)) {
    return "当前权限组未开放该对话模型"
  }
  return null
}

// ═══════════════ 会话 ═══════════════

/** 创建会话（流式路由首条消息时调用） */
export async function createChatConversation(input: {
  ctx: UserContext
  title: string
  modelId: string
  thinkingLevel: ThinkingLevel
}): Promise<{ id: string; title: string }> {
  const { ctx, title, modelId, thinkingLevel } = input
  const enterpriseId = ctx.user.enterpriseId!
  const [row] = await db
    .insert(chatConversations)
    .values({
      enterpriseId,
      userId: ctx.user.id,
      title: title || "新对话",
      modelId,
      thinkingLevel,
    })
    .returning({ id: chatConversations.id, title: chatConversations.title })
  return { id: row!.id, title: row!.title }
}

/** 按归属读取会话（enterpriseId + userId 双过滤；软删会话视为不存在） */
export async function getOwnedChatConversation(
  ctx: UserContext,
  conversationId: string,
) {
  const [row] = await db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.enterpriseId, ctx.user.enterpriseId!),
        eq(chatConversations.userId, ctx.user.id),
        isNull(chatConversations.deletedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

/** 会话内最近 N 条消息（正序；上限防长会话无界加载） */
export async function listChatMessages(
  conversationId: string,
  limit = 50,
): Promise<Array<typeof chatMessages.$inferSelect>> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit)
  return rows.reverse()
}

/**
 * 清扫遗留的 streaming 消息（缺陷修复：流式进程在收尾前死亡，
 * assistant 行会永久停在 status="streaming"，前端表现为无限转圈）。
 * 无独立 sweeper 进程，挂载在消息发送路径上顺带执行：
 * 超过 10 分钟仍 streaming 的行 → stopped + 中断说明。
 */
const STALE_STREAMING_MS = 10 * 60 * 1000

export async function sweepStaleStreamingMessages(): Promise<number> {
  const rows = await db
    .update(chatMessages)
    .set({
      status: "stopped",
      errorMessage: "生成中断（流式进程退出）",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatMessages.status, "streaming"),
        lt(chatMessages.createdAt, new Date(Date.now() - STALE_STREAMING_MS)),
      ),
    )
    .returning({ id: chatMessages.id })
  if (rows.length > 0) {
    console.warn(`[chat] 清扫 ${rows.length} 条遗留 streaming 消息（置为 stopped）`)
  }
  return rows.length
}

// ═══════════════ 上下文窗口 ═══════════════

/** 上下文构建输入的历史消息（user 消息可带图片 URL） */
export interface ChatHistoryMessage {
  role: string
  content: string
  images?: string[] | null
}

/** 单条消息 → 上游消息形态（多模态模型 + 带图 user 消息 → part 数组） */
function toUpstreamMessage(
  msg: ChatHistoryMessage,
  supportsVision: boolean,
): ChatUpstreamMessage {
  const role = msg.role === "assistant" ? "assistant" : "user"
  const images = supportsVision ? (msg.images ?? []) : []
  if (images.length === 0) return { role, content: msg.content }
  const parts: ChatContentPart[] = []
  if (msg.content) parts.push({ type: "text", text: msg.content })
  for (const url of images) {
    parts.push({ type: "image_url", image_url: { url } })
  }
  return { role, content: parts }
}

/**
 * 构建发往上游的上下文窗口（纯函数，单测覆盖）。
 *
 * 预算 = maxContext − maxOutput − 新消息 − 安全余量；
 * 从新到旧回填，超出预算的最旧消息被截断（UI 仍显示全量历史）。
 * 新消息始终保留（由上游按超长报错兜底）。
 * 图片仅在目标模型 supportsVision 时携带，否则降级为纯文本。
 */
export function buildContextWindow(input: {
  history: ChatHistoryMessage[]
  maxContextTokens: number
  maxOutputTokens: number
  newMessage?: { content: string; images?: string[] }
  /** 目标模型是否多模态（false 时历史图片剔除） */
  supportsVision?: boolean
}): ChatUpstreamMessage[] {
  const {
    history,
    maxContextTokens,
    maxOutputTokens,
    newMessage,
    supportsVision = false,
  } = input

  const newTokens = newMessage
    ? estimateMessageTokens(toUpstreamMessage({ role: "user", ...newMessage }, supportsVision))
    : 0
  const budget =
    maxContextTokens - maxOutputTokens - newTokens - CONTEXT_SAFETY_MARGIN

  const selected: ChatUpstreamMessage[] = []
  let acc = newTokens
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!
    const tokens = estimateMessageTokens(toUpstreamMessage(msg, supportsVision))
    if (acc + tokens > budget) break
    acc += tokens
    selected.unshift(toUpstreamMessage(msg, supportsVision))
  }
  if (
    newMessage &&
    (newMessage.content || (newMessage.images?.length ?? 0) > 0)
  ) {
    selected.push(toUpstreamMessage({ role: "user", ...newMessage }, supportsVision))
  }
  return selected
}

// ═══════════════ 厘级计费结算 ═══════════════

/**
 * 对话用量结算（核心计费路径，手册计费红线的对话版）。
 *
 * 1. cost = ceil((输入×输入价 + 输出×输出价) / 1e6) 厘，最小 1 厘；
 * 2. 单事务锁 user 行：累计器 += cost；
 * 3. 累计 ≥ 100 厘时扣 floor(累计/100) 积分（个人配额，写 allocation_deduct
 *    流水，remark 标注模型），余数留待下次累计；
 * 4. 扣款瞬间余额不足：不透支、不回滚累计器——零头挂账，待余额恢复后
 *    下条消息结算时自动补扣（自愈）。
 *
 * 韧性：内容已交付后结算不允许静默丢账——事务失败自动重试一次，
 * 仍失败则降级为单语句原子累加零头（扣款下次结算自愈），只有连
 * 降级也失败（DB 完全不可用）才向上抛错。
 *
 * 返回账单与实际扣减（供 SSE done 事件回显）。
 */
export async function settleChatUsage(input: {
  enterpriseId: string
  userId: string
  model: {
    displayName: string
    inputPriceCenticredits: number
    outputPriceCenticredits: number
  }
  inputTokens: number
  outputTokens: number
  /** 关联的 assistant 消息 id（写流水 taskId 字段，便于对账） */
  messageId?: string | null
}): Promise<{
  costCenticredits: number
  chargedCredits: number
  unbilledCenticredits: number
}> {
  const {
    enterpriseId,
    userId,
    model,
    inputTokens,
    outputTokens,
    messageId,
  } = input
  const costCenticredits = calcMessageCostCenticredits({
    inputTokens,
    outputTokens,
    inputPriceCenticredits: model.inputPriceCenticredits,
    outputPriceCenticredits: model.outputPriceCenticredits,
  })
  if (costCenticredits <= 0) {
    return { costCenticredits: 0, chargedCredits: 0, unbilledCenticredits: 0 }
  }

  try {
    return await settleChatUsageOnce({
      enterpriseId,
      userId,
      model,
      costCenticredits,
      messageId,
    })
  } catch (firstErr) {
    console.error(
      "[chat] 结算事务失败，重试一次:",
      firstErr instanceof Error ? firstErr.message : String(firstErr),
    )
    try {
      return await settleChatUsageOnce({
        enterpriseId,
        userId,
        model,
        costCenticredits,
        messageId,
      })
    } catch (retryErr) {
      console.error(
        "[chat] 结算重试仍失败，降级为仅累计零头（扣款下次结算自愈）:",
        retryErr instanceof Error ? retryErr.message : String(retryErr),
      )
      await db
        .update(users)
        .set({
          chatUnbilledCenticredits: sql`${users.chatUnbilledCenticredits} + ${costCenticredits}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
      // 降级路径：账单已入累计器，扣减待自愈（charged 0、余额未知）
      return { costCenticredits, chargedCredits: 0, unbilledCenticredits: 0 }
    }
  }
}

async function settleChatUsageOnce(input: {
  enterpriseId: string
  userId: string
  model: { displayName: string }
  costCenticredits: number
  messageId?: string | null
}): Promise<{
  costCenticredits: number
  chargedCredits: number
  unbilledCenticredits: number
}> {
  const { enterpriseId, userId, model, costCenticredits, messageId } = input

  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        balance: users.creditsBalance,
        unbilled: users.chatUnbilledCenticredits,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for("update")

    if (!row) throw new Error("用户不存在")

    const unbilled = row.unbilled + costCenticredits
    let chargedCredits = 0
    let settled = unbilled

    if (unbilled >= 100 && row.balance >= Math.floor(unbilled / 100)) {
      chargedCredits = Math.floor(unbilled / 100)
      settled = unbilled - chargedCredits * 100
      const [updated] = await tx
        .update(users)
        .set({
          creditsBalance: sql`${users.creditsBalance} - ${chargedCredits}`,
          chatUnbilledCenticredits: settled,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning({ balance: users.creditsBalance })

      await tx.insert(creditTransactions).values({
        enterpriseId,
        userId,
        type: "allocation_deduct",
        amount: -chargedCredits,
        balanceAfter: updated!.balance,
        taskId: messageId ?? null,
        remark: `AI 对话消耗 · ${model.displayName}`,
      })
    } else {
      // 不足 1 积分 或 余额暂缺：仅累计零头
      await tx
        .update(users)
        .set({
          chatUnbilledCenticredits: unbilled,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
    }

    return { costCenticredits, chargedCredits, unbilledCenticredits: settled }
  })
}

// ═══════════════ 流式收尾持久化 ═══════════════

/**
 * 流结束后落库 assistant 消息 + 回写会话。
 * 用户停止/断流也走此路径：已生成的部分内容按实际用量计费（status=stopped）。
 */
export async function finalizeChatMessage(input: {
  messageId: string
  conversationId: string
  content: string
  thinkingContent: string
  status: "completed" | "stopped" | "failed"
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number
  errorMessage: string | null
}): Promise<void> {
  const {
    messageId,
    conversationId,
    content,
    thinkingContent,
    status,
    inputTokens,
    outputTokens,
    durationMs,
    errorMessage,
  } = input

  await db
    .update(chatMessages)
    .set({
      content,
      thinkingContent: thinkingContent || null,
      status,
      inputTokens,
      outputTokens,
      durationMs,
      errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(chatMessages.id, messageId))

  // 流进行中会话被软删：内容/用量先照常落库（管理端与计费依赖），
  // 再把会话下未置位消息对齐 deletedAt（保持「随会话整批软删」
  // 不变量——否则流中新建的 user/assistant 消息以未删态挂在已删
  // 会话下），且不再回写会话级字段（lastMessageAt 等冻结）
  const [deletedConv] = await db
    .select({ deletedAt: chatConversations.deletedAt })
    .from(chatConversations)
    .where(eq(chatConversations.id, conversationId))
    .limit(1)
  if (deletedConv?.deletedAt) {
    await db
      .update(chatMessages)
      .set({ deletedAt: deletedConv.deletedAt })
      .where(
        and(
          eq(chatMessages.conversationId, conversationId),
          isNull(chatMessages.deletedAt),
        ),
      )
    return
  }

  // contextTokens：上游 usage 的 input+output 即当前窗口真实占用；
  // 无 usage 时退化为字符估算，保证圆环始终有值
  const contextTokens =
    inputTokens != null || outputTokens != null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : estimateTokens(content)

  await db
    .update(chatConversations)
    .set({
      contextTokens,
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(chatConversations.id, conversationId))
}

/** 取会话消息与最后一条 user 消息下标（regenerate 场景截断上下文用） */
export async function getMessagesWithLastUserIndex(conversationId: string): Promise<{
  messages: Array<typeof chatMessages.$inferSelect>
  lastUserIndex: number
}> {
  const messages = await listChatMessages(conversationId, 200)
  let lastUserIndex = -1
  messages.forEach((m, i) => {
    if (m.role === "user") lastUserIndex = i
  })
  return { messages, lastUserIndex }
}

/** 消息列表（带模型展示信息，供前端渲染） */
export async function listChatMessagesWithModel(conversationId: string, limit = 50) {
  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      images: chatMessages.images,
      thinkingContent: chatMessages.thinkingContent,
      status: chatMessages.status,
      inputTokens: chatMessages.inputTokens,
      outputTokens: chatMessages.outputTokens,
      costCenticredits: chatMessages.costCenticredits,
      durationMs: chatMessages.durationMs,
      errorMessage: chatMessages.errorMessage,
      createdAt: chatMessages.createdAt,
      modelId: chatMessages.modelId,
      modelDisplayName: chatApiConfigs.displayName,
      modelIconUrl: chatApiConfigs.iconUrl,
    })
    .from(chatMessages)
    .leftJoin(chatApiConfigs, eq(chatMessages.modelId, chatApiConfigs.id))
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit)
  return rows.reverse()
}

/** 更新会话成本字段（结算后回写消息账单） */
export async function updateChatMessageCost(
  messageId: string,
  costCenticredits: number,
): Promise<void> {
  await db
    .update(chatMessages)
    .set({ costCenticredits })
    .where(eq(chatMessages.id, messageId))
}

/** 会话首条消息时同步标题（从 user 消息截断） */
export async function ensureConversationTitle(
  conversationId: string,
  title: string,
): Promise<void> {
  if (!title.trim()) return
  await db
    .update(chatConversations)
    .set({ title: title.trim().slice(0, 20), updatedAt: new Date() })
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.title, "新对话"),
        isNull(chatConversations.deletedAt),
      ),
    )
}

// ═══════════════ AI 标题生成 ═══════════════

/**
 * AI 生成会话标题（新会话首条消息完成后调用，覆盖截断式兜底标题）。
 *
 * - 复用工作台内部 AI（resolveProductChatConfig + callChatApi，openai 格式），
 *   成本由平台承担、不走用户对话计费；
 * - 任何失败（未配置内部 AI / 调用超时 / 输出异常）静默保留截断标题，
 *   不影响消息流收尾。
 */
export async function generateConversationTitle(input: {
  enterpriseId: string
  conversationId: string
  firstUserText: string
}): Promise<void> {
  const text = input.firstUserText.trim()
  if (!text) return
  try {
    const config = await resolveProductChatConfig(input.enterpriseId)
    if (!config) return

    const raw = await callChatApi({
      config: {
        ...config,
        // 标题只要十几个字，压低输出上限避免异常长回复
        extraConfig: { ...config.extraConfig, maxTokens: 64 },
      },
      messages: [
        {
          role: "system",
          content:
            "你是对话标题生成器。根据用户消息生成一个简短的中文对话标题，不超过 16 个字，概括用户意图。直接输出标题文本：不要引号、不要句号、不要换行、不要任何解释。",
        },
        { role: "user", content: text.slice(0, 2000) },
      ],
      temperature: 0.3,
      timeoutMs: 15_000,
    })

    const title = raw
      .split("\n")[0]!
      .replace(/["'“”‘’「」]/g, "")
      .trim()
      .slice(0, 20)
    if (!title) return

    await db
      .update(chatConversations)
      .set({ title, updatedAt: new Date() })
      .where(
        and(
          eq(chatConversations.id, input.conversationId),
          isNull(chatConversations.deletedAt),
        ),
      )
  } catch (err) {
    console.warn(
      "[chat] AI 标题生成失败（保留截断标题）:",
      err instanceof Error ? err.message : String(err),
    )
  }
}
