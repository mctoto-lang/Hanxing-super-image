"use client"

import * as React from "react"
import { SmartImage } from "@/components/ui/smart-image"
import { cn } from "@/lib/utils"

/**
 * 图片前后对比滑块（左右拖动分割线）
 *
 * 分割线左侧（before）为基准图，右侧（after）为比对图：before 作底层
 * 完整绘制，after 以 clip-path 只露出分割线右侧；拖动手柄/点击任意位置
 * 移动分割线，两图按容器尺寸 object-contain 对齐。
 * 角标为顶部左右胶囊（黑底白字），分割线 3px 纯白 + 圆形拖动手柄。
 * 高度由父级容器给定（传 className="h-full" 即可撑满舞台）。
 */
export function ImageCompareSlider({
  before,
  after,
  beforeLabel = "原图",
  afterLabel = "AI",
  className,
}: {
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  className?: string
}) {
  const [ratio, setRatio] = React.useState(0.5)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const draggingRef = React.useRef(false)

  const updateFromClientX = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const next = (clientX - rect.left) / rect.width
    setRatio(Math.min(1, Math.max(0, next)))
  }

  React.useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return
      e.preventDefault()
      updateFromClientX(e.clientX)
    }
    const onUp = () => {
      draggingRef.current = false
    }
    window.addEventListener("pointermove", onMove, { passive: false })
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative select-none overflow-hidden rounded-lg bg-neutral-900/60 ring-1 ring-white/10",
        className,
      )}
      onPointerDown={(e) => {
        draggingRef.current = true
        updateFromClientX(e.clientX)
      }}
    >
      {/* 底层：基准图（高度撑满父级，宽度随比例收缩，不超容器宽） */}
      <SmartImage
        src={before}
        alt={beforeLabel}
        className="h-full w-auto max-w-full object-contain"
        draggable={false}
      />
      {/* 上层：比对图（clip 出分割线右侧部分） */}
      <div
        className="absolute inset-0"
        style={{ clipPath: `inset(0 0 0 ${ratio * 100}%)` }}
      >
        <SmartImage
          src={after}
          alt={afterLabel}
          className="h-full w-full object-contain"
          draggable={false}
        />
      </div>

      {/* 分割线 + 手柄 */}
      <div
        className="absolute inset-y-0 z-10 w-[3px] -translate-x-1/2 bg-white shadow"
        style={{ left: `${ratio * 100}%` }}
      >
        <span className="absolute left-1/2 top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full bg-white text-neutral-700 shadow-lg">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18-6-6 6-6" />
            <path d="m15 6 6 6-6 6" />
          </svg>
        </span>
      </div>

      {/* 顶部左右胶囊角标 */}
      <span className="absolute left-3 top-3 z-10 rounded-full bg-black/60 px-3 py-1 text-xs text-white backdrop-blur">
        {beforeLabel}
      </span>
      <span className="absolute right-3 top-3 z-10 rounded-full bg-black/60 px-3 py-1 text-xs text-white backdrop-blur">
        {afterLabel}
      </span>
    </div>
  )
}
