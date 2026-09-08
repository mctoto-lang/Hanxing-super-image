"use client"

import { useEffect, useRef, useState } from "react"
import { Brain, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { PixelDotsLoader } from "@/components/ui/ai-agent-response"

/**
 * 思考过程 + 消息状态行（chat 流式，模板 ai-agent-response 动画结构）
 *
 * 动画生命周期（对齐参考图）：
 *
 *   连接中:   [PixelDotsLoader] 连接模型中…(shimmer)      ← AgentStatusLine
 *   思考流式: [PixelDotsLoader] 思考中…(shimmer)          ← AgentStatusLine
 *             │ 思考行（逐行 agent-fade，超 MAX_H 上滑跟随 + 上下渐隐）
 *   回复流式: [PixelDotsLoader] 正在回复…(shimmer)        ← AgentStatusLine
 *             🧠 思考了 X 秒（思考块已收起为摘要，hover 出 chevron）
 *   完成后:   🧠 思考了 X 秒（点击展开可滚动查看思考全文）
 *
 * AgentReasoning 只负责思考块：streaming=true（思考仍在产出正文未开始）时
 * 无头部、时间线展开跟随最新行；streaming=false 时收起为「思考了 X 秒」
 * 摘要，点击展开滚动查看。状态行由 message-bubble 按消息阶段渲染。
 *
 * 行高不定（真实思考文本），故用 ResizeObserver 实测内容高度驱动
 * 封顶/上滑计算；keyframes（agent-*）定义在 globals.css。
 */

// 视口几何 —— 对齐模板 NestedReasoningBlock 常量
const MAX_H = 184 // 视口最高高度，超出后封顶滚动/上滑
const FADE = 18 // 封顶后上/下渐隐高度

/** shimmer 流光文字样式（「思考中…/正在回复…」等状态文案） */
const SHIMMER_TEXT_STYLE = {
  backgroundImage:
    "linear-gradient(90deg, var(--color-muted-foreground, oklch(0.55 0 0)) 35%, var(--color-foreground, oklch(0.95 0 0)) 50%, var(--color-muted-foreground, oklch(0.55 0 0)) 65%)",
  backgroundSize: "200% 100%",
  animation: "agent-shimmer 1.5s linear infinite",
} as const

/**
 * 消息状态行：像素点阵加载器 + shimmer 阶段文案。
 * 流式全程常驻消息顶部（连接模型中… → 思考中… → 正在回复…），完成后由
 * 调用方停止渲染（思考摘要接管）。
 */
export function AgentStatusLine({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  return (
    <div className={cn("flex h-7 items-center gap-2 px-1.5", className)}>
      <PixelDotsLoader />
      <span
        className="bg-clip-text text-[13.5px] font-medium text-transparent"
        style={SHIMMER_TEXT_STYLE}
      >
        {label}
      </span>
    </div>
  )
}

export interface AgentReasoningProps {
  /** 逐行展示的思考内容（流式期间追加行，新行淡入） */
  lines: string[]
  /** 思考是否仍在产出（正文未开始）：true 展开+跟随；false 收起为摘要 */
  streaming: boolean
  /** 完成后的耗时秒数（摘要显示「思考了 X 秒」；缺省回退「思考过程」） */
  elapsedS?: number
  className?: string
}

export function AgentReasoning({
  lines,
  streaming,
  elapsedS,
  className,
}: AgentReasoningProps) {
  // 结束后的手动展开状态；流式期间由 streaming 驱动自动展开
  const [manualOpen, setManualOpen] = useState(false)
  // 展开滚动时按滚动位置显示上/下渐隐
  const [fade, setFade] = useState({ top: false, bottom: true })
  const viewportRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<HTMLDivElement>(null)
  // 真实思考文本每行高度不定，实测内容高度驱动视口/上滑计算
  const [contentH, setContentH] = useState(0)

  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    const measure = () => setContentH(el.scrollHeight)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const done = !streaming
  // 流式期间始终展开；结束后收起为摘要，仅手动点击可展开
  const expanded = done ? manualOpen : true
  const capped = contentH > MAX_H
  const viewH = capped ? MAX_H : contentH
  const scrollable = done && manualOpen
  // 未进入手动滚动模式时，封顶后整体上滑让最新行保持可见
  const translate = scrollable ? 0 : capped ? MAX_H - FADE - contentH : 0

  const showTop = scrollable ? fade.top : capped
  const showBottom = scrollable ? fade.bottom : capped

  const mask = capped
    ? `linear-gradient(to bottom, transparent 0, #000 ${showTop ? FADE : 0}px, #000 calc(100% - ${showBottom ? FADE : 0}px), transparent 100%)`
    : "none"

  const onScroll = () => {
    const el = viewportRef.current
    if (!el) return
    setFade({
      top: el.scrollTop > 1,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    })
  }

  const toggle = () => {
    const next = !manualOpen
    if (next) {
      setFade({ top: false, bottom: true })
      if (viewportRef.current) viewportRef.current.scrollTop = 0
    }
    setManualOpen(next)
  }

  return (
    <div
      className={cn("flex w-full flex-col", className)}
      style={{ animation: "agent-fade 280ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {/* 摘要头：思考结束后出现（流式期间状态行在上层，此处无头部） */}
      {done ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label="展开或收起思考过程"
          onClick={toggle}
          className={cn(
            "group/row relative flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] transition-colors duration-150",
            "cursor-pointer hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.98]"
          )}
        >
          <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            <Brain
              aria-hidden="true"
              className={cn(
                "size-3.5 opacity-75 transition-opacity duration-150",
                "group-hover/row:opacity-0",
                manualOpen && "opacity-0"
              )}
            />
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "absolute size-3.5 rotate-0 opacity-0 transition-transform duration-200",
                "group-hover/row:opacity-100",
                manualOpen ? "rotate-0 opacity-100" : "-rotate-90"
              )}
            />
          </span>

          <span className="font-medium transition-colors">
            <span className="text-foreground">
              {elapsedS != null ? (
                <>
                  思考了{" "}
                  <span className="font-mono text-[11.5px] tabular-nums">
                    {elapsedS}s
                  </span>
                </>
              ) : (
                "思考过程"
              )}
            </span>
          </span>
        </button>
      ) : null}

      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]",
          expanded
            ? "grid-rows-[1fr] opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {/* 时间线通道（模板 border-l 结构）；流式期间无摘要头，补顶部间距 */}
          <div
            className={cn(
              "border-l border-border/70 py-0.5 pl-2.5",
              done ? "mt-1 mb-1.5 ml-2.5" : "mt-1.5 mb-1 ml-1"
            )}
          >
            <div
              ref={viewportRef}
              className={cn(
                "overflow-hidden pr-1 transition-[height] duration-300 ease-out",
                scrollable &&
                  "overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              )}
              style={{
                height: `${viewH}px`,
                WebkitMaskImage: mask,
                maskImage: mask,
              }}
              onScroll={scrollable ? onScroll : undefined}
            >
              <div
                ref={streamRef}
                className="flex flex-col gap-2 transition-transform duration-400 ease-out will-change-transform"
                style={{ transform: `translateY(${translate}px)` }}
              >
                {lines.map((line, i) => (
                  <p
                    key={i}
                    className="m-0 text-pretty text-[13px] leading-[23px] font-[425] tracking-tight text-muted-foreground"
                    style={{
                      animation: "agent-fade 250ms cubic-bezier(0.23,1,0.32,1) both",
                    }}
                  >
                    {line}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
