"use client"

import * as React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Coins } from "lucide-react"
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
  type PromptInputStatus,
} from "@/components/ui/ai-chat-input"
import { BeamWrapper } from "@/components/create/beam-wrapper"
import { ChatModelPicker } from "@/components/chat/chat-model-picker"
import { ThinkingLevelPicker } from "@/components/chat/thinking-level-picker"
import { ContextRing } from "@/components/chat/context-ring"
import { formatPricePerMillion } from "@/lib/ai/chat/chat-model-config"
import type { ChatModelCard, ThinkingLevel } from "@/components/chat/types"

/**
 * AI 对话输入框（改造自生图 CreatePromptInput）
 *
 * 基于 ai-chat-input 组合式 PromptInput + BeamWrapper 光效：
 * - 模型切换（图标 + 名称 + 徽章 + 价格摘要）
 * - 思考强度（仅 supportsThinking 模型渲染；档位随会话持久化）
 * - 上下文已用进度环（弧长 = contextTokens / maxContextTokens）
 * - 流式中提交按钮变停止按钮（PromptInput 自带 onStop 语义）
 * - 文本草稿 localStorage 持久化（chat:input-draft:text）
 */

const TEXT_DRAFT_KEY = "chat:input-draft:text"

function loadTextDraft(): string {
  if (typeof window === "undefined") return ""
  try {
    return localStorage.getItem(TEXT_DRAFT_KEY) ?? ""
  } catch {
    return ""
  }
}

export function ChatInput({
  models,
  modelId,
  onModelChange,
  thinkingLevel,
  onThinkingLevelChange,
  contextTokens,
  isStreaming,
  onSubmit,
  onStop,
  focusNonce,
}: {
  models: ChatModelCard[]
  modelId: string
  onModelChange: (id: string) => void
  thinkingLevel: ThinkingLevel
  onThinkingLevelChange: (level: ThinkingLevel) => void
  contextTokens: number
  isStreaming: boolean
  /** 提交；抛错时输入框保留文本便于重试 */
  onSubmit: (text: string) => Promise<void>
  onStop: () => void
  /** 变化时聚焦输入框 */
  focusNonce?: number
}) {
  const [beamHovered, setBeamHovered] = React.useState(false)
  const [beamFocused, setBeamFocused] = React.useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 初始文本（草稿恢复）经 key 重挂载以 defaultValue 声明式写入
  //（原理同生图输入框：BeamWrapper 懒加载换树会丢弃命令式赋值）
  const [initialText, setInitialText] = useState<string | null>(null)
  const draftRestoredRef = useRef(false)
  useEffect(() => {
    if (draftRestoredRef.current) return
    draftRestoredRef.current = true
    const draft = loadTextDraft()
    if (draft) setInitialText(draft)
  }, [])

  // 防抖草稿
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleDraftSave = useCallback((text: string) => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(TEXT_DRAFT_KEY, text)
      } catch {
        // 存储满/隐私模式静默失败
      }
    }, 400)
  }, [])
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (focusNonce) textareaRef.current?.focus()
  }, [focusNonce])

  const selectedModel = models.find((m) => m.id === modelId)
  const hasModels = models.length > 0

  const status: PromptInputStatus = isStreaming ? "streaming" : "ready"

  async function handleSubmit(message: { text: string }) {
    const text = message.text.trim()
    if (!text || isStreaming) return
    await onSubmit(text)
    // 成功：清空草稿（文本已被 form.reset 清空）
    try {
      localStorage.setItem(TEXT_DRAFT_KEY, "")
    } catch {
      // ignore
    }
  }

  if (!hasModels) {
    return (
      <div className="flex h-32 items-center justify-center rounded-3xl border border-dashed text-sm text-muted-foreground">
        暂无可用对话模型，请联系管理员配置
      </div>
    )
  }

  const free =
    (selectedModel?.inputPriceCenticredits ?? 0) <= 0 &&
    (selectedModel?.outputPriceCenticredits ?? 0) <= 0
  const beamActive = beamHovered || beamFocused || isStreaming

  return (
    <BeamWrapper
      active={beamActive}
      colorVariant="colorful"
      size="md"
      borderRadius={24}
      onMouseEnter={() => setBeamHovered(true)}
      onMouseLeave={() => setBeamHovered(false)}
      onFocus={() => setBeamFocused(true)}
      onBlur={() => setBeamFocused(false)}
    >
      <PromptInput
        onSubmit={handleSubmit}
        status={status}
        onStop={onStop}
        className="rounded-3xl"
      >
        <PromptInputBody>
          <PromptInputTextarea
            key={initialText ?? "empty"}
            ref={textareaRef}
            defaultValue={initialText ?? ""}
            onChange={(e) => scheduleDraftSave(e.target.value)}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            maxLength={20000}
            disabled={isStreaming}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            {/* 模型切换 */}
            <ChatModelPicker models={models} value={modelId} onChange={onModelChange} />

            {/* 思考强度（仅支持思考的模型） */}
            {selectedModel?.supportsThinking ? (
              <ThinkingLevelPicker
                value={thinkingLevel}
                onChange={onThinkingLevelChange}
              />
            ) : null}

            {/* 上下文已用进度环 */}
            <ContextRing
              usedTokens={contextTokens}
              maxTokens={selectedModel?.maxContextTokens ?? 32768}
            />
          </PromptInputTools>

          {/* 右侧：价格提示 + 提交/停止按钮 */}
          <div className="flex items-center gap-1.5">
            <Coins className="size-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground tabular-nums">
              {free
                ? "免费"
                : `${formatPricePerMillion(selectedModel?.inputPriceCenticredits ?? 0)} / ${formatPricePerMillion(selectedModel?.outputPriceCenticredits ?? 0)} 积分·百万tokens`}
            </span>
            <PromptInputSubmit status={status} onStop={onStop} />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </BeamWrapper>
  )
}
