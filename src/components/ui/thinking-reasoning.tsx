"use client"

import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * 思考过程动画（chat 流式思考）
 *
 * 结构：header（纯文字标签 + chevron，无悬停效果，点击切换折叠/展开）
 * + 折叠容器（grid-template-rows 高度动画）+ 固定高视口（inline style 注入
 * height 与 mask）+ 逐行淡入的内容流。内容高度超过 MAX_H 后视口封顶、
 * translateY 上滑露出最新行；完成后标签变为「思考了 X 秒」摘要，展开后
 * 可滚动并按滚动位置显示上/下渐隐遮罩。
 *
 * 默认始终折叠（流式与完成态都是），仅用户点击后展开。
 */

// 类名映射：源组件随附 CSS Module 的等价全局版本，样式定义见 globals.css
const styles = {
  tr: "trr-root",
  trHeader: "trr-header",
  isClickable: "trr-clickable",
  trLabel: "trr-label",
  trVerb: "trr-verb",
  trChevron: "trr-chevron",
  trShimmer: "trr-shimmer",
  trCollapsible: "trr-collapsible",
  isCollapsed: "trr-collapsed",
  trInner: "trr-inner",
  trViewport: "trr-viewport",
  isScroll: "trr-scroll",
  trStream: "trr-stream",
  trSentence: "trr-sentence",
} as const

// 视口几何 —— 与 globals.css 中 .trr-* 的 padding/gap 保持同步
const MAX_H = 180 // 视口最高高度，超出后封顶滚动/上滑
const FADE = 16 // 封顶后上/下渐隐高度

export interface ThinkingReasoningProps {
  /** 逐行展示的思考内容（流式期间追加行，新行淡入） */
  lines: string[]
  /** 是否仍在思考：true 时 shimmer 标签；结束后标签变为「思考了 X 秒」摘要 */
  streaming: boolean
  /** 完成后的耗时秒数（摘要显示「思考了 X 秒」；缺省回退「思考过程」） */
  elapsedS?: number
  /** 思考中标签文案 */
  thinkingLabel?: string
  className?: string
}

export function ThinkingReasoning({
  lines,
  streaming,
  elapsedS,
  thinkingLabel = "思考中…",
  className,
}: ThinkingReasoningProps) {
  // 默认折叠（流式与完成态都是），点击后才展开
  const [open, setOpen] = useState(false)
  // 展开滚动时按滚动位置显示上/下渐隐
  const [fade, setFade] = useState({ top: false, bottom: true })
  const viewportRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<HTMLDivElement>(null)
  // 真实思考文本每行行数不定（源组件假设固定 2 行/条），改为实测内容高度
  // 驱动视口/上滑计算
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
  const expanded = open
  const capped = contentH > MAX_H
  const viewH = capped ? MAX_H : contentH
  const scrollable = done && open
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
    const next = !open
    if (next) {
      setFade({ top: false, bottom: true })
      if (viewportRef.current) viewportRef.current.scrollTop = 0
    }
    setOpen(next)
  }

  return (
    <div className={cn(styles.tr, className)}>
      <button
        type="button"
        className={cn(styles.trHeader, styles.isClickable)}
        aria-expanded={expanded}
        aria-label="展开或收起思考过程"
        onClick={toggle}
      >
        {done ? (
          <span className={styles.trLabel}>
            <span className={styles.trVerb}>思考</span>
            {elapsedS != null ? `了 ${elapsedS} 秒` : "过程"}
          </span>
        ) : (
          <span className={cn(styles.trLabel, styles.trShimmer)}>
            {thinkingLabel}
          </span>
        )}
        <svg
          className={styles.trChevron}
          viewBox="0 0 24 24"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path
            d="m4.5 15.75 7.5-7.5 7.5 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div
        className={cn(styles.trCollapsible, !expanded && styles.isCollapsed)}
      >
        <div className={styles.trInner}>
          <div
            ref={viewportRef}
            className={cn(styles.trViewport, scrollable && styles.isScroll)}
            style={{
              height: `${viewH}px`,
              WebkitMaskImage: mask,
              maskImage: mask,
            }}
            onScroll={scrollable ? onScroll : undefined}
          >
            <div
              ref={streamRef}
              className={styles.trStream}
              style={{ transform: `translateY(${translate}px)` }}
            >
              {lines.map((line, i) => (
                <p key={i} className={styles.trSentence}>
                  {line}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ThinkingReasoning
