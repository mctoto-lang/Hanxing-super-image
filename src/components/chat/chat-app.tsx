"use client"

import * as React from "react"
import { useEffect, useMemo, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Bot } from "lucide-react"
import { toast } from "sonner"
import { ChatConversationList } from "@/components/chat/chat-conversation-list"
import { ChatDetail } from "@/components/chat/chat-detail"
import { ChatInput } from "@/components/chat/chat-input"
import { useChatStream } from "@/components/chat/use-chat-stream"
import type {
  ChatConversationListItem,
  ChatMessageItem,
  ChatModelCard,
  ThinkingLevel,
} from "@/components/chat/types"
import { isThinkingLevel } from "@/components/chat/types"

/**
 * AI 对话页根组件（布局复刻自由创作：左 280px 历史栏 + 右内容区）
 *
 * - 选中态由 URL `?c=` 驱动；新对话模式右侧居中欢迎 + 输入框；
 * - 流式状态挂在根组件：首条消息建会话后立即导航到 ?c=<id>，
 *   详情面板通过行 id 与服务器数据去重合并实时气泡；
 * - 模型/思考档位选择在根组件持有（跨挂载保留，随会话初始化）；
 * - done 后 router.refresh() 同步服务器数据，对齐后清除实时状态。
 */

const CONFIG_DRAFT_KEY = "chat:input-draft:config"

interface ConfigDraft {
  modelId: string | null
  thinkingLevel: ThinkingLevel | null
}

function loadConfigDraft(): ConfigDraft {
  if (typeof window === "undefined") return { modelId: null, thinkingLevel: null }
  try {
    const raw = localStorage.getItem(CONFIG_DRAFT_KEY)
    if (!raw) return { modelId: null, thinkingLevel: null }
    const parsed = JSON.parse(raw) as ConfigDraft
    return {
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : null,
      thinkingLevel: isThinkingLevel(parsed.thinkingLevel)
        ? parsed.thinkingLevel
        : null,
    }
  } catch {
    return { modelId: null, thinkingLevel: null }
  }
}

function saveConfigDraft(draft: ConfigDraft) {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(CONFIG_DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // ignore
  }
}

export function ChatApp({
  models,
  conversations,
  selectedConversation,
  messages,
  userAvatarUrl,
}: {
  models: ChatModelCard[]
  conversations: ChatConversationListItem[]
  selectedConversation: ChatConversationListItem | null
  messages: ChatMessageItem[]
  /** 当前用户头像（消息气泡展示；null = 占位图标） */
  userAvatarUrl: string | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  // —— 模型 / 思考档位 ——
  const [modelId, setModelId] = React.useState(models[0]?.id ?? "")
  const [thinkingLevel, setThinkingLevel] = React.useState<ThinkingLevel>("off")
  const configInitRef = useRef(false)
  const lastConvIdRef = useRef<string | null>(null)

  // 挂载：恢复草稿配置；切换会话：随会话初始化（会话未配置时保留草稿）
  useEffect(() => {
    if (!configInitRef.current) {
      configInitRef.current = true
      const draft = loadConfigDraft()
      if (draft.modelId && models.some((m) => m.id === draft.modelId)) {
        setModelId(draft.modelId)
      }
      if (draft.thinkingLevel) setThinkingLevel(draft.thinkingLevel)
    }
    const convId = selectedConversation?.id ?? null
    if (convId !== lastConvIdRef.current) {
      lastConvIdRef.current = convId
      if (selectedConversation?.modelId) {
        setModelId(selectedConversation.modelId)
      } else if (models[0]) {
        setModelId(models[0].id)
      }
      if (selectedConversation?.thinkingLevel) {
        setThinkingLevel(selectedConversation.thinkingLevel as ThinkingLevel)
      }
    }
  }, [selectedConversation, models])

  // 当前模型不支持思考时重置为 off
  const selectedModel = models.find((m) => m.id === modelId)
  useEffect(() => {
    if (selectedModel && !selectedModel.supportsThinking && thinkingLevel !== "off") {
      setThinkingLevel("off")
    }
  }, [selectedModel, thinkingLevel])

  useEffect(() => {
    saveConfigDraft({ modelId, thinkingLevel })
  }, [modelId, thinkingLevel])

  // —— 流式 ——
  const handleConversationCreated = React.useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set("c", id)
      router.push(`/chat?${params.toString()}`)
    },
    [router, searchParams],
  )
  const handleStreamDone = React.useCallback(() => {
    router.refresh()
  }, [router])
  const { stream, isStreaming, sendMessage, stop, clear } = useChatStream({
    onConversationCreated: handleConversationCreated,
    onDone: handleStreamDone,
  })

  // 服务器数据对齐后清除实时状态（assistant 行 id 出现且非 streaming）
  useEffect(() => {
    if (!stream) return
    if (stream.status !== "done" && stream.status !== "error") return
    if (!stream.assistantMessageId) {
      // 极端：连 message 事件都没到（建连失败），短暂展示后清除
      const t = setTimeout(clear, 4000)
      return () => clearTimeout(t)
    }
    const final = messages.find((m) => m.id === stream.assistantMessageId)
    if (final && final.status !== "streaming") {
      clear()
      return
    }
    // 兜底：refresh 未带回（如会话被删）时 6s 后强制清除
    const t = setTimeout(clear, 6000)
    return () => clearTimeout(t)
  }, [stream, messages, clear])

  const handleSubmit = React.useCallback(
    async (text: string, images: string[]) => {
      if (!selectedModel) {
        toast.error("请先选择模型")
        throw new Error("未选择模型")
      }
      try {
        await sendMessage({
          conversationId: selectedConversation?.id ?? null,
          modelId: selectedModel.id,
          content: text,
          images,
          thinkingLevel: selectedModel.supportsThinking ? thinkingLevel : "off",
        })
      } catch (err) {
        // 预检失败（余额/频率/权限/连接）在此提示；流中错误由消息气泡展示
        toast.error(err instanceof Error ? err.message : "发送失败，请重试")
        throw err
      }
    },
    [selectedModel, thinkingLevel, sendMessage, selectedConversation],
  )

  const handleRegenerate = React.useCallback(async () => {
    if (!selectedModel || isStreaming) return
    // 复用会话内最后一条 user 消息内容（服务端同样按最后 user 行截断上下文）
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    await sendMessage({
      conversationId: selectedConversation?.id ?? null,
      modelId: selectedModel.id,
      content: lastUser?.content ?? "重新生成",
      thinkingLevel: selectedModel.supportsThinking ? thinkingLevel : "off",
      regenerate: true,
    })
  }, [selectedModel, isStreaming, sendMessage, selectedConversation, messages, thinkingLevel])

  function navigateTo(id: string | null) {
    if (isStreaming) {
      toast.info("请等待当前回复完成或先停止")
      return
    }
    const params = new URLSearchParams(searchParams.toString())
    if (id) {
      params.set("c", id)
    } else {
      params.delete("c")
    }
    const qs = params.toString()
    router.push(qs ? `/chat?${qs}` : "/chat")
  }

  const contextTokens = selectedConversation?.contextTokens ?? 0
  const hasModels = models.length > 0

  const welcomeInput = useMemo(
    () => (
      <ChatInput
        models={models}
        modelId={modelId}
        onModelChange={setModelId}
        thinkingLevel={thinkingLevel}
        onThinkingLevelChange={setThinkingLevel}
        contextTokens={0}
        isStreaming={isStreaming}
        onSubmit={handleSubmit}
        onStop={stop}
      />
    ),
    [models, modelId, thinkingLevel, isStreaming, handleSubmit, stop],
  )

  return (
    <div className="flex h-full overflow-hidden">
      {/* 左侧：对话历史栏（固定 280px） */}
      <aside className="w-[280px] shrink-0 border-r bg-sidebar/30">
        <ChatConversationList
          conversations={conversations}
          selectedId={selectedConversation?.id ?? null}
          onSelect={navigateTo}
        />
      </aside>

      {/* 右侧：内容区 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedConversation ? (
          <ChatDetail
            conversationId={selectedConversation.id}
            messages={messages}
            models={models}
            modelId={modelId}
            onModelChange={setModelId}
            thinkingLevel={thinkingLevel}
            onThinkingLevelChange={setThinkingLevel}
            contextTokens={contextTokens}
            live={stream}
            isStreaming={isStreaming}
            onSubmit={handleSubmit}
            onStop={stop}
            onRegenerate={handleRegenerate}
            userAvatarUrl={userAvatarUrl}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center overflow-auto p-6">
            <div className="w-full max-w-2xl space-y-6">
              <div className="text-center">
                <div className="mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-primary/10">
                  <Bot className="size-6 text-primary" />
                </div>
                <h1 className="text-xl font-semibold">开始你的对话</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {hasModels
                    ? "选择模型，向 AI 提问任何问题"
                    : "暂无可用对话模型，请联系管理员配置"}
                </p>
              </div>
              {welcomeInput}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
