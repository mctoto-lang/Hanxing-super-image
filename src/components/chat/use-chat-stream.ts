"use client"

import { useCallback, useRef, useState } from "react"
import type { ChatStreamState, ThinkingLevel } from "@/components/chat/types"
import { emitGrokEmotion } from "@/lib/grok-ball-bus"

/**
 * SSE 流式对话客户端 Hook
 *
 * fetch POST + ReadableStream reader 解析 data: JSON 行。
 * - AbortController 对接 PromptInput 的 onStop（停止后服务端仍会落库并计费）
 * - 事件流：conversation → message → delta/thinking_delta/usage* → done | error
 * - pre-stream 校验失败（4xx JSON）直接抛错给调用方 toast
 * - Grok Ball 联动（SKILL.md 状态映射）：接收任务 31 → 思考 30 → 输出 39
 *   → 完成 33（3s 回退）/ 出错 34 / 用户停止 41；到期自动回退手动表情
 */

export interface UseChatStreamResult {
  stream: ChatStreamState | null
  isStreaming: boolean
  sendMessage: (opts: {
    conversationId: string | null
    modelId: string
    content: string
    images?: string[]
    thinkingLevel: ThinkingLevel
    regenerate?: boolean
  }) => Promise<void>
  stop: () => void
  /** 清除实时状态（服务器数据已对齐后） */
  clear: () => void
}

interface SendOptions {
  conversationId: string | null
  modelId: string
  content: string
  images?: string[]
  thinkingLevel: ThinkingLevel
  regenerate?: boolean
}

export function useChatStream(hooks: {
  onConversationCreated?: (id: string) => void
  onDone?: () => void
}): UseChatStreamResult {
  const [stream, setStream] = useState<ChatStreamState | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const clear = useCallback(() => {
    setStream(null)
  }, [])

  const sendMessage = useCallback(
    async (opts: SendOptions) => {
      if (abortRef.current) return // 已有流进行中
      const controller = new AbortController()
      abortRef.current = controller

      setStream({
        conversationId: opts.conversationId ?? "__pending__",
        userText: opts.regenerate ? null : opts.content,
        userImages: opts.regenerate ? null : (opts.images ?? []),
        userMessageId: null,
        assistantMessageId: null,
        assistantText: "",
        assistantThinking: "",
        status: "connecting",
        error: null,
        inputTokens: null,
        outputTokens: null,
        costCenticredits: null,
      })

      const patch = (p: Partial<ChatStreamState>) => {
        setStream((prev) => (prev ? { ...prev, ...p } : prev))
      }

      // Grok Ball 表情阶段去重：只在阶段切换时发事件
      let grokPhase: "task" | "think" | "output" | null = null
      let grokHadError = false
      const grokPhaseEnter = (
        phase: "task" | "think" | "output",
        emotionId: string,
        duration = 0,
      ) => {
        if (grokPhase === phase) return
        grokPhase = phase
        emitGrokEmotion(emotionId, duration)
      }

      // 接收任务：发出请求即短暂提示
      grokPhaseEnter("task", "31", 1500)

      try {
        const resp = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: opts.conversationId,
            modelId: opts.modelId,
            content: opts.content,
            images: opts.images ?? [],
            thinkingLevel: opts.thinkingLevel,
            regenerate: opts.regenerate ?? false,
          }),
          signal: controller.signal,
        })

        if (!resp.ok || !resp.body) {
          let message = `请求失败（${resp.status}）`
          try {
            const data = (await resp.json()) as { error?: string }
            if (data.error) message = data.error
          } catch {
            // 非 JSON 错误体
          }
          patch({ status: "error", error: message })
          throw new Error(message)
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          for (;;) {
            const idx = buffer.indexOf("\n\n")
            if (idx === -1) break
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const dataLine = block
              .split("\n")
              .find((l) => l.startsWith("data:"))
            if (!dataLine) continue
            let evt: Record<string, unknown>
            try {
              evt = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>
            } catch {
              continue
            }
            switch (evt.type) {
              case "conversation": {
                const id = String(evt.id)
                patch({ conversationId: id })
                hooks.onConversationCreated?.(id)
                break
              }
              case "message":
                patch({
                  assistantMessageId: String(evt.id),
                  userMessageId: evt.userMessageId ? String(evt.userMessageId) : null,
                  status: "streaming",
                })
                break
              case "delta":
                grokPhaseEnter("output", "39")
                setStream((prev) =>
                  prev
                    ? { ...prev, assistantText: prev.assistantText + String(evt.text ?? "") }
                    : prev,
                )
                break
              case "thinking_delta":
                grokPhaseEnter("think", "30")
                setStream((prev) =>
                  prev
                    ? {
                        ...prev,
                        status: "streaming",
                        assistantThinking: prev.assistantThinking + String(evt.text ?? ""),
                      }
                    : prev,
                )
                break
              case "usage":
                setStream((prev) =>
                  prev
                    ? {
                        ...prev,
                        inputTokens:
                          evt.inputTokens != null
                            ? Math.max(prev.inputTokens ?? 0, Number(evt.inputTokens))
                            : prev.inputTokens,
                        outputTokens:
                          evt.outputTokens != null
                            ? Math.max(prev.outputTokens ?? 0, Number(evt.outputTokens))
                            : prev.outputTokens,
                      }
                    : prev,
                )
                break
              case "error":
                grokHadError = true
                emitGrokEmotion("34", 3000)
                patch({ error: String(evt.message ?? "未知错误") })
                break
              case "done":
                if (!grokHadError) emitGrokEmotion("33", 3000)
                patch({
                  status: "done",
                  costCenticredits:
                    evt.costCenticredits != null
                      ? Number(evt.costCenticredits)
                      : null,
                })
                break
            }
          }
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          emitGrokEmotion("34", 3000)
          patch({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          })
          throw err
        }
        // 用户主动停止：服务端收尾后仍会发 done，这里先行标记
        emitGrokEmotion("41", 2000)
        patch({ status: "done" })
      } finally {
        abortRef.current = null
        hooks.onDone?.()
      }
    },
    [hooks],
  )

  return {
    stream,
    isStreaming: stream != null && (stream.status === "connecting" || stream.status === "streaming"),
    sendMessage,
    stop,
    clear,
  }
}
