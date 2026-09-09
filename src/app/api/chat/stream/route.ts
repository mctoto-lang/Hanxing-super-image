import { NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { chatApiConfigs, chatConversations, chatMessages } from "@/db/schema"
import { getCurrentUserContext } from "@/lib/auth/session"
import { sendChatMessageSchema } from "@/server/schemas/chat"
import {
  buildContextWindow,
  checkChatModelAccess,
  createChatConversation,
  ensureConversationTitle,
  finalizeChatMessage,
  generateConversationTitle,
  getMessagesWithLastUserIndex,
  getOwnedChatConversation,
  settleChatUsage,
  sweepStaleStreamingMessages,
  updateChatMessageCost,
} from "@/server/services/chat-service"
import { dispatchStreamChat } from "@/lib/ai/chat"
import type { ThinkingLevel } from "@/lib/ai/chat"
import {
  calcMessageCostCenticredits,
  estimateMessageTokens,
  estimateTokens,
} from "@/lib/ai/chat/chat-model-config"
import { acquireChatSlot, releaseChatSlot } from "@/lib/queue/chat-concurrency"
import { chatRateLimiter } from "@/lib/rate-limit"
import { truncateConversationTitle } from "@/lib/conversation-title"

/**
 * AI 对话流式路由（全站首个 SSE 端点）
 *
 * POST /api/chat/stream
 *   { conversationId?, modelId, content, thinkingLevel?, regenerate? }
 *
 * 流前校验失败返回常规 JSON 错误（4xx）；进入流后错误经 SSE error 事件下发。
 * 事件序列：conversation（新会话）→ message → delta/thinking_delta/usage* →
 * done（含 costCenticredits 账单）| error。
 *
 * 收尾铁律：无论正常结束、用户停止（abort）、上游失败，都在收尾中
 * 落库已生成内容并按实际 usage 计费（无 usage 时字符估算兜底）。
 */

export const dynamic = "force-dynamic"
export const maxDuration = 300

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

/** 合并多个中止信号（任一触发即中止） */
function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  for (const s of signals) {
    if (s.aborted) {
      controller.abort()
      break
    }
    s.addEventListener("abort", onAbort, { once: true })
  }
  return controller.signal
}

export async function POST(req: Request) {
  const ctx = await getCurrentUserContext()
  if (!ctx) return jsonError("未登录", 401)
  if (!ctx.enterprise || !ctx.user.enterpriseId || !ctx.canAccess("chat")) {
    return jsonError("无权使用 AI 对话", 403)
  }
  const enterpriseId = ctx.user.enterpriseId
  // 企业对话并发上限：早退守卫的 narrowing 不进闭包（finally 释放槽位），
  // 守卫后先取局部量
  const enterpriseChatMax = ctx.enterprise.chatMaxConcurrent

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonError("请求体格式错误", 400)
  }
  const parsed = sendChatMessageSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "参数错误", 400)
  }
  const d = parsed.data

  // 用户级频率限制（每分钟 20 条）
  if (await chatRateLimiter.consume(enterpriseId, ctx.user.id)) {
    return jsonError("发送过于频繁，请稍后再试", 429)
  }

  // 模型校验：存在 + active + 租户可见
  const [model] = await db
    .select()
    .from(chatApiConfigs)
    .where(eq(chatApiConfigs.id, d.modelId))
    .limit(1)
  if (!model) return jsonError("对话模型不存在", 404)
  const accessError = checkChatModelAccess(ctx, model)
  if (accessError) return jsonError(accessError, 403)

  // 余额预检门槛：单条消息成本通常 < 1 积分，余额 ≥ 1 即放行
  //（精确计费在流结束后按 usage 结算）
  if (ctx.user.creditsBalance < 1) {
    return jsonError("积分余额不足，请向企业管理员申请配额", 402)
  }
  if (!model.supportsThinking && d.thinkingLevel !== "off") {
    d.thinkingLevel = "off"
  }

  // 会话：新建或校验归属
  let conversationId = d.conversationId ?? null
  let isNewConversation = false
  if (!conversationId) {
    const created = await createChatConversation({
      ctx,
      title:
        (d.content ? truncateConversationTitle(d.content) : "") ||
        (d.images.length > 0 ? "图片对话" : "新对话"),
      modelId: model.id,
      thinkingLevel: d.thinkingLevel,
    })
    conversationId = created.id
    isNewConversation = true
  } else {
    const conv = await getOwnedChatConversation(ctx, conversationId)
    if (!conv) return jsonError("会话不存在或无权操作", 404)
  }

  // 并发槽（用户 + 企业 + 模型）：获取失败不落任何消息
  const slotTtl = (model.taskTimeout || 300) + 60
  const acquired = await acquireChatSlot({
    userId: ctx.user.id,
    enterpriseId,
    modelId: model.id,
    enterpriseMaxConcurrent: enterpriseChatMax,
    modelMaxConcurrent: model.maxConcurrent,
    ttlSec: slotTtl,
  })
  if (!acquired) {
    return jsonError("当前对话请求已达并发上限，请稍候再试", 429)
  }

  // 插入 user 消息（regenerate 复用最后一条 user 消息，不新插入）
  // 顺带清扫遗留 streaming 消息（上次流式进程死亡未收尾的行）
  await sweepStaleStreamingMessages()
  let history: Array<{ role: string; content: string; images?: string[] | null }> = []
  let userMessageId: string | null = null
  try {
    const { messages, lastUserIndex } = await getMessagesWithLastUserIndex(
      conversationId,
    )
    if (d.regenerate) {
      if (lastUserIndex < 0) {
        await releaseChatSlot({
          userId: ctx.user.id,
          enterpriseId,
          modelId: model.id,
          enterpriseMaxConcurrent: enterpriseChatMax,
          modelMaxConcurrent: model.maxConcurrent,
        })
        return jsonError("会话内没有可重新生成的消息", 400)
      }
      // 重新生成：上下文截止到最后一条 user 消息（含，含其图片），其后的 assistant 响应不再携带
      history = messages
        .slice(0, lastUserIndex + 1)
        .map((m) => ({ role: m.role, content: m.content, images: m.images }))
    } else {
      const [userMsg] = await db
        .insert(chatMessages)
        .values({
          conversationId,
          enterpriseId,
          userId: ctx.user.id,
          role: "user",
          content: d.content,
          images: d.images,
        })
        .returning({ id: chatMessages.id })
      userMessageId = userMsg!.id
      history = messages.map((m) => ({
        role: m.role,
        content: m.content,
        images: m.images,
      }))
    }
  } catch (err) {
    await releaseChatSlot({
      userId: ctx.user.id,
      enterpriseId,
      modelId: model.id,
      enterpriseMaxConcurrent: enterpriseChatMax,
      modelMaxConcurrent: model.maxConcurrent,
    })
    return jsonError(
      `消息写入失败：${err instanceof Error ? err.message : String(err)}`,
      500,
    )
  }

  // 上下文裁剪 + 预插入 assistant 消息（streaming）
  const contextWindow = d.regenerate
    ? buildContextWindow({
        history: history.slice(0, -1),
        maxContextTokens: model.maxContextTokens,
        maxOutputTokens: model.maxOutputTokens,
        newMessage: {
          content: history[history.length - 1]?.content ?? "",
          images: history[history.length - 1]?.images ?? [],
        },
        supportsVision: model.supportsVision,
      })
    : buildContextWindow({
        history,
        maxContextTokens: model.maxContextTokens,
        maxOutputTokens: model.maxOutputTokens,
        newMessage: { content: d.content, images: d.images },
        supportsVision: model.supportsVision,
      })

  const [assistantMsg] = await db
    .insert(chatMessages)
    .values({
      conversationId,
      enterpriseId,
      userId: ctx.user.id,
      role: "assistant",
      content: "",
      modelId: model.id,
      thinkingLevel: d.thinkingLevel,
      status: "streaming",
    })
    .returning({ id: chatMessages.id })
  const assistantMessageId = assistantMsg!.id

  // 会话当前模型/思考档位随最新一次发送更新（圆环分母随之切换）
  await db
    .update(chatConversations)
    .set({
      modelId: model.id,
      thinkingLevel: d.thinkingLevel,
      updatedAt: new Date(),
    })
    .where(eq(chatConversations.id, conversationId))

  const startedAt = Date.now()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (data: Record<string, unknown>) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          closed = true
        }
      }

      if (isNewConversation) {
        send({ type: "conversation", id: conversationId })
      }
      send({ type: "message", id: assistantMessageId, userMessageId })

      let content = ""
      let thinking = ""
      let inputTokens: number | null = null
      let outputTokens: number | null = null
      let streamError: string | null = null

      // 流中预算防护：估算成本超过（余额 + 1 积分缓冲）即中止剩余生成，
      // 防止低余额用户在单条流内无限输出（收尾仍按实际用量计费）
      const budgetAbort = new AbortController()
      const budgetAllowanceCenticredits = ctx.user.creditsBalance * 100 + 100
      const estimatedInputTokens = contextWindow.reduce(
        (acc, m) => acc + estimateMessageTokens(m),
        0,
      )
      let lastBudgetCheckAt = 0

      try {
        for await (const evt of dispatchStreamChat(model, {
          messages: contextWindow,
          systemPrompt: null,
          thinkingLevel: d.thinkingLevel as ThinkingLevel,
          signal: combineAbortSignals([req.signal, budgetAbort.signal]),
        })) {
          switch (evt.type) {
            case "text_delta":
              content += evt.text
              send({ type: "delta", text: evt.text })
              if (Date.now() - lastBudgetCheckAt >= 1000) {
                lastBudgetCheckAt = Date.now()
                const est = calcMessageCostCenticredits({
                  inputTokens: estimatedInputTokens,
                  outputTokens: estimateTokens(content),
                  inputPriceCenticredits: model.inputPriceCenticredits,
                  outputPriceCenticredits: model.outputPriceCenticredits,
                })
                if (est > budgetAllowanceCenticredits) {
                  budgetAbort.abort()
                  streamError = "积分余额不足，已中止生成（本次按实际用量计费）"
                  send({ type: "error", message: streamError })
                  break
                }
              }
              break
            case "thinking_delta":
              thinking += evt.text
              send({ type: "thinking_delta", text: evt.text })
              break
            case "usage":
              if (evt.inputTokens != null) {
                inputTokens = Math.max(inputTokens ?? 0, evt.inputTokens)
              }
              if (evt.outputTokens != null) {
                outputTokens = Math.max(outputTokens ?? 0, evt.outputTokens)
              }
              send({
                type: "usage",
                inputTokens: evt.inputTokens ?? undefined,
                outputTokens: evt.outputTokens ?? undefined,
              })
              break
            case "error":
              streamError = evt.message
              send({ type: "error", message: evt.message })
              break
            case "done":
              break
          }
          if (streamError) break
        }
      } catch (err) {
        streamError = err instanceof Error ? err.message : String(err)
        send({ type: "error", message: streamError })
      }

      // ── 收尾：无论成败，落库 + 计费（try 内异常不允许再打断收尾）──
      let costCenticredits = 0
      try {
        // usage 缺失兜底：按字符/图片张数估算，保证计费与圆环不缺值
        const finalInputTokens =
          inputTokens ??
          contextWindow.reduce((acc, m) => acc + estimateMessageTokens(m), 0)
        const finalOutputTokens = outputTokens ?? estimateTokens(content)

        const aborted = req.signal.aborted
        // 用户主动停止（无论是否已有产出）= stopped，按实际用量计费；
        // 上游失败且无产出 = failed，不计费
        const status: "completed" | "stopped" | "failed" =
          streamError != null
            ? content
              ? "stopped"
              : "failed"
            : aborted
              ? "stopped"
              : "completed"

        await finalizeChatMessage({
          messageId: assistantMessageId,
          conversationId,
          content,
          thinkingContent: thinking,
          status,
          inputTokens: streamError != null && !content ? null : finalInputTokens,
          outputTokens: streamError != null && !content ? null : finalOutputTokens,
          durationMs: Date.now() - startedAt,
          errorMessage: streamError,
        })

        // 计费：失败无产出不计费；停止/成功按实际用量结算
        if (status !== "failed") {
          const settled = await settleChatUsage({
            enterpriseId,
            userId: ctx.user.id,
            model: {
              displayName: model.displayName,
              inputPriceCenticredits: model.inputPriceCenticredits,
              outputPriceCenticredits: model.outputPriceCenticredits,
            },
            inputTokens: finalInputTokens,
            outputTokens: finalOutputTokens,
            messageId: assistantMessageId,
          })
          costCenticredits = settled.costCenticredits
          await updateChatMessageCost(assistantMessageId, costCenticredits)
        }

        if (!isNewConversation && userMessageId) {
          await ensureConversationTitle(conversationId, truncateConversationTitle(d.content))
        }

        // 新会话首条消息完成后：AI 生成标题覆盖截断兜底（在 done 事件前完成，
        // 保证前端 done → refresh 能拿到新标题；失败静默保留截断标题）
        if (isNewConversation && d.content) {
          await generateConversationTitle({
            enterpriseId,
            conversationId,
            firstUserText: d.content,
          })
        }
      } catch (err) {
        send({
          type: "error",
          message: `收尾落库失败：${err instanceof Error ? err.message : String(err)}`,
        })
      } finally {
        await releaseChatSlot({
          userId: ctx.user.id,
          enterpriseId,
          modelId: model.id,
          enterpriseMaxConcurrent: enterpriseChatMax,
          modelMaxConcurrent: model.maxConcurrent,
        })
      }

      send({
        type: "done",
        messageId: assistantMessageId,
        status: streamError
          ? content
            ? "stopped"
            : "failed"
          : req.signal.aborted
            ? "stopped"
            : "completed",
        costCenticredits,
        durationMs: Date.now() - startedAt,
      })
      closed = true
      try {
        controller.close()
      } catch {
        // 客户端已断开
      }
    },
    cancel() {
      // 客户端断开：req.signal 触发上游 abort，收尾在 start() 的循环退出后执行
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
