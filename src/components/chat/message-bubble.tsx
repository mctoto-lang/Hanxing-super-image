"use client"

import * as React from "react"
import {
  Bot,
  Check,
  Copy,
  Cpu,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  User,
} from "lucide-react"
import { AgentReasoning, AgentStatusLine } from "@/components/chat/agent-reasoning"
import { SmartImage } from "@/components/ui/smart-image"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ImageViewer } from "@/components/ui/image-viewer"
import { cn, copyText, toImageSrc } from "@/lib/utils"
import { ChatMarkdown } from "@/components/chat/markdown"
import { formatCenticredits } from "@/lib/ai/chat/chat-model-config"

/**
 * 对话消息气泡
 *
 * - user：右对齐气泡（文本 + 可选图片网格，点击放大预览），hover 复制，
 *   头像用当前用户真实头像（无头像时占位图标）
 * - assistant：左侧模型头像（真实模型图标）+ 消息状态行（像素点阵 + shimmer
 *   阶段文案，仅流式中展示）+ 可折叠思考过程（AgentReasoning，模板 agent
 *   样式）+ 细分隔线（完成态有思考时）+ markdown 正文 + 失败横幅 +
 *   meta 行（模型 · tokens · 消耗 · 时长）+ hover 点赞/点踩/复制/重新生成
 * - 流式进行中：正文尾部闪烁光标
 */

export interface BubbleViewModel {
  id: string
  role: "user" | "assistant"
  content: string
  /** user 消息图片（多模态；空数组/无图为 null） */
  images?: string[] | null
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
        void copyText(text).then((ok) => {
          if (!ok) return
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

/** 点赞/点踩：纯前端互斥切换高亮，不上报后端 */
function FeedbackButtons() {
  const [feedback, setFeedback] = React.useState<"up" | "down" | null>(null)
  const toggle = (value: "up" | "down") =>
    setFeedback((prev) => (prev === value ? null : value))
  return (
    <>
      {(["up", "down"] as const).map((value) => {
        const Icon = value === "up" ? ThumbsUp : ThumbsDown
        const active = feedback === value
        return (
          <button
            key={value}
            type="button"
            onClick={() => toggle(value)}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "text-primary hover:text-primary",
            )}
            aria-label={value === "up" ? "点赞" : "点踩"}
            aria-pressed={active}
          >
            <Icon className="size-3.5" />
          </button>
        )
      })}
    </>
  )
}

/** user 消息图片网格（点击放大预览） */
function MessageImages({ images }: { images: string[] }) {
  const [viewerIndex, setViewerIndex] = React.useState<number | null>(null)
  return (
    <>
      <div className="mt-1.5 flex max-w-full flex-wrap justify-end gap-1.5">
        {images.map((url, i) => (
          <button
            key={url + i}
            type="button"
            onClick={() => setViewerIndex(i)}
            className="size-28 shrink-0 overflow-hidden rounded-xl border border-primary/30 transition-opacity hover:opacity-90"
            aria-label="查看图片"
          >
            <SmartImage
              src={toImageSrc(url, { width: 320 })}
              alt=""
              loading="lazy"
              className="size-full object-cover"
            />
          </button>
        ))}
      </div>
      <ImageViewer
        open={viewerIndex != null}
        onOpenChange={(open) => {
          if (!open) setViewerIndex(null)
        }}
        images={images}
        index={viewerIndex ?? 0}
        onIndexChange={setViewerIndex}
      />
    </>
  )
}

export function MessageBubble({
  message,
  userAvatarUrl,
  onRegenerate,
}: {
  message: BubbleViewModel
  /** 当前用户头像（user 气泡展示；null = 占位图标） */
  userAvatarUrl?: string | null
  onRegenerate?: () => void
}) {
  const isUser = message.role === "user"
  const isLive = message.status === "streaming" || message.status === "connecting"
  // 消息阶段（驱动状态行文案与思考块生命周期）：
  // 连接（啥都没有）→ 思考（思考流式、正文未开始）→ 回复（正文流式中）
  const isThinking = isLive && !message.content
  const phaseLabel =
    !message.content && !message.thinkingContent
      ? "连接模型中…"
      : isThinking
        ? "思考中…"
        : "正在回复…"

  if (isUser) {
    return (
      <div className="group flex justify-end gap-2.5 py-2">
        <div className="relative max-w-[85%]">
          {message.content ? (
            <div className="rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            </div>
          ) : null}
          {message.images && message.images.length > 0 ? (
            <MessageImages images={message.images} />
          ) : null}
          {message.content ? (
            <div className="absolute -left-9 top-1 opacity-0 transition-opacity group-hover:opacity-100">
              <CopyButton text={message.content} />
            </div>
          ) : null}
        </div>
        <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-card">
          {userAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={toImageSrc(userAvatarUrl)}
              alt=""
              className="size-full rounded-full object-cover"
            />
          ) : (
            <User className="size-4 text-muted-foreground" />
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="group flex gap-2.5 py-2"
      style={{ animation: "agent-fade 300ms ease-out both" }}
    >
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
        {/* 状态行：流式全程常驻（像素点阵 + shimmer 阶段文案：
            连接模型中… → 思考中… → 正在回复…），完成后消失 */}
        {isLive ? <AgentStatusLine label={phaseLabel} /> : null}

        {/* 思考过程（模板 agent 样式）：思考流式期间展开跟随最新行；
            正文开始后自动收起为「思考了 X 秒」摘要，点击可展开滚动查看 */}
        {message.thinkingContent ? (
          <AgentReasoning
            lines={message.thinkingContent
              .split(/\n+/)
              .map((s) => s.trim())
              .filter(Boolean)}
            streaming={isThinking}
            elapsedS={
              message.durationMs && message.durationMs > 0
                ? Math.max(1, Math.round(message.durationMs / 1000))
                : undefined
            }
          />
        ) : null}

        {/* 完成后思考摘要与正文之间的细分隔线 */}
        {!isLive && message.thinkingContent && message.content ? (
          <div aria-hidden="true" className="my-2 h-px shrink-0 bg-border/70" />
        ) : null}

        {/* 正文（markdown + 流式光标） */}
        {message.content ? (
          <ChatMarkdown content={message.content} className="min-h-6" />
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
              {message.content ? <FeedbackButtons /> : null}
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
