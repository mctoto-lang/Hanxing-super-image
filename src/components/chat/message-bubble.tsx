"use client"

import * as React from "react"
import {
  Bot,
  Check,
  Copy,
  Cpu,
  RefreshCw,
  TriangleAlert,
  User,
} from "lucide-react"
import { ThinkingReasoning } from "@/components/ui/thinking-reasoning"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { toImageSrc } from "@/lib/utils"
import { ChatMarkdown } from "@/components/chat/markdown"
import { formatCenticredits } from "@/lib/ai/chat/chat-model-config"

/**
 * 对话消息气泡
 *
 * - user：右对齐纯文本气泡（whitespace-pre-wrap），hover 复制
 * - assistant：左侧模型头像 + markdown 正文 + 可折叠思考过程 +
 *   meta 行（模型 · tokens · 消耗 · 时长）+ 失败横幅 + 复制/重新生成
 * - 流式进行中：正文尾部闪烁光标；思考块自动展开、结束自动收起
 */

export interface BubbleViewModel {
  id: string
  role: "user" | "assistant"
  content: string
  thinkingContent: string | null
  status: "connecting" | "streaming" | "completed" | "failed" | "stopped"
  inputTokens: number | null
  outputTokens: number | null
  costCenticredits: number | null
  durationMs: number | null
  errorMessage: string | null
  modelDisplayName?: string | null
  modelIconUrl?: string | null
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label="复制"
    >
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
    </button>
  )
}

export function MessageBubble({
  message,
  onRegenerate,
}: {
  message: BubbleViewModel
  onRegenerate?: () => void
}) {
  const isUser = message.role === "user"
  const isLive = message.status === "streaming" || message.status === "connecting"

  if (isUser) {
    return (
      <div className="group flex justify-end gap-2.5 py-2">
        <div className="relative max-w-[85%]">
          <div className="rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>
          <div className="absolute -left-9 top-1 opacity-0 transition-opacity group-hover:opacity-100">
            <CopyButton text={message.content} />
          </div>
        </div>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
          <User className="size-4 text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="group flex gap-2.5 py-2">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-card">
        {message.modelIconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={toImageSrc(message.modelIconUrl)}
            alt=""
            className="size-full rounded-full object-cover"
          />
        ) : (
          <Bot className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {/* 思考过程（有思考内容时展示：默认折叠，点击展开；流式时 shimmer
            标签 + 逐行淡入，结束后标签变为「思考了 X 秒」摘要，展开可滚动） */}
        {message.thinkingContent ? (
          <ThinkingReasoning
            lines={message.thinkingContent
              .split(/\n+/)
              .map((s) => s.trim())
              .filter(Boolean)}
            streaming={isLive}
            elapsedS={
              message.durationMs && message.durationMs > 0
                ? Math.max(1, Math.round(message.durationMs / 1000))
                : undefined
            }
          />
        ) : null}

        {/* 正文（markdown + 流式光标） */}
        {message.content ? (
          <ChatMarkdown content={message.content} className="min-h-6" />
        ) : isLive ? (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" />
            {message.status === "connecting" ? "连接模型中…" : "正在回复…"}
          </div>
        ) : null}
        {message.content && isLive ? (
          <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse rounded-sm bg-primary align-text-bottom" />
        ) : null}

        {/* 失败横幅 */}
        {message.errorMessage && message.status === "failed" ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-all">{message.errorMessage}</span>
          </div>
        ) : null}

        {/* meta + 操作行：完成后展示；流式中仅展示轻量占位防跳动 */}
        {!isLive ? (
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="truncate">{message.modelDisplayName ?? "AI"}</span>
            {message.inputTokens != null || message.outputTokens != null ? (
              <>
                <span>·</span>
                <span className="tabular-nums">
                  {message.inputTokens ?? 0}/{message.outputTokens ?? 0} tokens
                </span>
              </>
            ) : null}
            {message.costCenticredits != null && message.costCenticredits > 0 ? (
              <>
                <span>·</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger render={<span className="tabular-nums cursor-default" />}>
                      <span className="inline-flex items-center gap-0.5">
                        <Cpu className="size-3" />
                        {formatCenticredits(message.costCenticredits)} 积分
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      本条消息计费（输入 + 输出 tokens 按模型单价折算）
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            ) : null}
            {message.durationMs != null && message.durationMs > 0 ? (
              <>
                <span>·</span>
                <span className="tabular-nums">{(message.durationMs / 1000).toFixed(1)}s</span>
              </>
            ) : null}
            {message.status === "stopped" ? (
              <>
                <span>·</span>
                <span>已停止</span>
              </>
            ) : null}
            <span className="ml-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              {message.content ? <CopyButton text={message.content} /> : null}
              {onRegenerate ? (
                <button
                  type="button"
                  onClick={onRegenerate}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="重新生成"
                >
                  <RefreshCw className="size-3.5" />
                </button>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
