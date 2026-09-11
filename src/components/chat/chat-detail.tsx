"use client"

import * as React from "react"
import { useEffect, useRef, useState } from "react"
import { ArrowUp, MessageSquareText } from "lucide-react"
import { BeamWrapper } from "@/components/create/beam-wrapper"
import { ChatInput } from "@/components/chat/chat-input"
import {
  MessageBubble,
  type BubbleViewModel,
} from "@/components/chat/message-bubble"
import type {
  ChatMessageItem,
  ChatModelCard,
  ChatStreamState,
  ThinkingLevel,
} from "@/components/chat/types"

/**
 * 右侧对话详情（复刻创作会话详情的交互骨架）
 *
 * - 中间滚动区：按日期分组的消息气泡，正序最新在下；流式期间自动滚底；
 * - 服务器消息与实时流合并渲染（user/assistant 行 id 去重）；
 * - 底部悬浮输入框：上滑收起为紧凑条，滚回底部展开（同创作页）；
 * - 最后一条 assistant 消息带「重新生成」。
 */

function formatDayLabel(date: Date): string {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round(
    (startOfDay(new Date()) - startOfDay(date)) / 86_400_000,
  )
  if (diffDays === 0) return "今天"
  if (diffDays === 1) return "昨天"
  if (diffDays === 2) return "前天"
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

function toBubble(m: ChatMessageItem): BubbleViewModel {
  return {
    id: m.id,
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
    images: m.images && m.images.length > 0 ? m.images : null,
    thinkingContent: m.thinkingContent,
    status: (m.status as BubbleViewModel["status"]) ?? "completed",
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    costCenticredits: m.costCenticredits,
    durationMs: m.durationMs,
    errorMessage: m.errorMessage,
    modelDisplayName: m.modelDisplayName,
    modelIconUrl: m.modelIconUrl,
  }
}

export function ChatDetail({
  conversationId,
  messages,
  models,
  modelId,
  onModelChange,
  thinkingLevel,
  onThinkingLevelChange,
  contextTokens,
  live,
  isStreaming,
  onSubmit,
  onStop,
  onRegenerate,
  userAvatarUrl,
}: {
  conversationId: string
  messages: ChatMessageItem[]
  models: ChatModelCard[]
  modelId: string
  onModelChange: (id: string) => void
  thinkingLevel: ThinkingLevel
  onThinkingLevelChange: (level: ThinkingLevel) => void
  contextTokens: number
  live: ChatStreamState | null
  isStreaming: boolean
  onSubmit: (text: string, images: string[]) => Promise<void>
  onStop: () => void
  onRegenerate: () => void
  /** 当前用户头像（user 气泡展示；null = 占位图标） */
  userAvatarUrl: string | null
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const [expandedFooterH, setExpandedFooterH] = useState(0)
  const [expanded, setExpanded] = useState(true)
  const [focusNonce, setFocusNonce] = useState(0)

  // 本会话的实时流（跨会话导航时其他会话的流不显示）
  const activeLive =
    live && (live.conversationId === conversationId || live.conversationId === "__pending__")
      ? live
      : null

  // 合并：服务器行去掉被实时流覆盖的 user/assistant 行，再追加实时气泡
  const displayMessages: BubbleViewModel[] = []
  for (const m of messages) {
    if (activeLive) {
      if (m.id === activeLive.assistantMessageId) continue
      if (activeLive.userMessageId && m.id === activeLive.userMessageId) continue
    }
    displayMessages.push(toBubble(m))
  }
  const selectedModel = models.find((m) => m.id === modelId)
  if (activeLive) {
    if (activeLive.userText != null && !activeLive.userMessageId) {
      displayMessages.push({
        id: "live-user",
        role: "user",
        content: activeLive.userText,
        images:
          activeLive.userImages && activeLive.userImages.length > 0
            ? activeLive.userImages
            : null,
        thinkingContent: null,
        status: "streaming",
        inputTokens: null,
        outputTokens: null,
        costCenticredits: null,
        durationMs: null,
        errorMessage: null,
      })
    }
    displayMessages.push({
      id: activeLive.assistantMessageId ?? "live-assistant",
      role: "assistant",
      content: activeLive.assistantText,
      thinkingContent: activeLive.assistantThinking || null,
      status: activeLive.status === "done" || activeLive.status === "error"
        ? activeLive.assistantText
          ? "stopped"
          : activeLive.error
            ? "failed"
            : "completed"
        : activeLive.status,
      inputTokens: activeLive.inputTokens,
      outputTokens: activeLive.outputTokens,
      costCenticredits: activeLive.costCenticredits,
      durationMs: null,
      errorMessage: activeLive.error,
      modelDisplayName: selectedModel?.displayName ?? null,
      modelIconUrl: selectedModel?.iconUrl ?? null,
    })
  }

  // 流式期间自动滚底（内容持续增长）
  const liveLen = activeLive ? activeLive.assistantText.length + activeLive.assistantThinking.length : 0
  useEffect(() => {
    if (!activeLive) return
    const el = scrollRef.current
    if (!el) return
    // 用户主动上滑离开底部时停止跟随（阈值 120px）
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight })
    }
  }, [liveLen, activeLive])

  function scrollToBottom(smooth = true) {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
    setExpanded(true)
  }, [messages.length])

  const nearBottomThreshold = expandedFooterH ? expandedFooterH + 24 + 24 : 80

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      // 流式期间不收起（保持输入/停止按钮可达）
      if (isStreaming) return
      const near =
        el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomThreshold
      setExpanded(near)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [nearBottomThreshold, isStreaming])

  // 实测悬浮容器高度（展开态跟随，收起态只增不减，防留白跳变闪烁）
  useEffect(() => {
    const el = footerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = (entry.target as HTMLElement).offsetHeight
        const expandedNow = el.querySelector("textarea") !== null
        setExpandedFooterH((prev) => (expandedNow ? h : Math.max(prev, h)))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * 点击紧凑条：滚到底部后再展开输入框。
   * 不能 setExpanded(true) 与平滑滚动同时做：展开会立即挂载输入框（zoom
   * 动画），而滚动途中的 scroll 监听判定「不在底部」会立刻把它收回，
   * 到底后再展开——表现为先闪大一下、缩回、再展开。展开时机交给「已停在
   * 底部」的判定：正常滚动由 scroll 监听（near=true）触发；贴底零位移
   * （scrollTo 无事件）等边缘情况由延迟兜底补展开。
   */
  function handleCollapsedClick() {
    const el = scrollRef.current
    const dist = el
      ? el.scrollHeight - el.scrollTop - el.clientHeight
      : 0
    setFocusNonce((n) => n + 1)
    if (dist < nearBottomThreshold) {
      // 已贴底：零位移滚动不触发 scroll 事件，直接展开
      setExpanded(true)
      return
    }
    scrollToBottom()
    window.setTimeout(() => {
      // 已由滚动到位时的 scroll 监听展开（输入框已挂载）则跳过
      if (footerRef.current?.querySelector("textarea")) return
      const el2 = scrollRef.current
      if (
        el2 &&
        el2.scrollHeight - el2.scrollTop - el2.clientHeight <
          nearBottomThreshold
      ) {
        setExpanded(true)
      }
    }, 500)
  }

  // 最后一条 assistant 气泡挂重新生成（且当前无流进行中）
  let lastAssistantIdx = -1
  displayMessages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistantIdx = i
  })

  let lastLabel = ""

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4"
        style={{ paddingBottom: expandedFooterH ? expandedFooterH + 24 : 48 }}
      >
        <div
          className="mx-auto w-full space-y-1"
          style={{ maxWidth: "calc(50% + 384px)" }}
        >
          {displayMessages.length === 0 ? (
            <div className="mt-12 flex flex-col items-center gap-2 text-center">
              <p className="text-sm text-muted-foreground">
                在下方输入消息，开始与 AI 对话
              </p>
            </div>
          ) : (
            displayMessages.map((m, i) => {
              const createdAt = messages.find((x) => x.id === m.id)?.createdAt
              const label = createdAt ? formatDayLabel(new Date(createdAt)) : null
              const showLabel = label !== null && label !== lastLabel
              if (label) lastLabel = label
              return (
                <React.Fragment key={m.id}>
                  {showLabel && (
                    <p className="px-1 pb-2 pt-5 text-lg font-semibold text-foreground first:pt-0">
                      {label}
                    </p>
                  )}
                  <MessageBubble
                    message={m}
                    userAvatarUrl={userAvatarUrl}
                    onRegenerate={
                      i === lastAssistantIdx && !isStreaming && m.content
                        ? onRegenerate
                        : undefined
                    }
                  />
                </React.Fragment>
              )
            })
          )}
        </div>
      </div>

      {/* 底部悬浮输入框：上滑收起为紧凑条（流式期间强制展开） */}
      <div
        ref={footerRef}
        className="pointer-events-none absolute bottom-0 left-0 right-0 z-50 p-4"
      >
        {expanded || isStreaming ? (
          <div
            className="pointer-events-auto mx-auto w-full animate-in fade-in zoom-in-95 duration-200"
            style={{ maxWidth: "calc(50% + 384px)" }}
          >
            <ChatInput
              models={models}
              modelId={modelId}
              onModelChange={onModelChange}
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={onThinkingLevelChange}
              contextTokens={contextTokens}
              isStreaming={isStreaming}
              onSubmit={onSubmit}
              onStop={onStop}
              focusNonce={focusNonce}
            />
          </div>
        ) : (
          <div className="pointer-events-auto mx-auto w-full max-w-md animate-in fade-in zoom-in-95 duration-200">
            <BeamWrapper active colorVariant="colorful" size="md" borderRadius={22}>
              <button
                type="button"
                onClick={handleCollapsedClick}
                className="flex h-11 w-full items-center gap-2 rounded-full border bg-card/95 px-3 shadow-lg backdrop-blur-sm transition-colors hover:bg-accent/50"
              >
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground">
                  <MessageSquareText className="size-4" />
                </span>
                <span className="flex-1 truncate text-left text-sm text-muted-foreground">
                  继续对话…
                </span>
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <ArrowUp className="size-4" />
                </span>
              </button>
            </BeamWrapper>
          </div>
        )}
      </div>
    </div>
  )
}
