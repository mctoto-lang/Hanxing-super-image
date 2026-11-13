"use client"

import React, { useState, useRef, useEffect } from "react"
import {
  motion,
  useMotionValue,
  useTransform,
  AnimatePresence,
  type PanInfo,
} from "motion/react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * 滑动开礼物卡片（21st.dev reward-card 模板移植）
 *
 * 移植口径（先例见 bento-variant-1.tsx / kpi-tile.tsx）：
 *   - framer-motion → motion/react（项目未装 framer-motion）；
 *   - 内嵌 ChevronRightIcon → lucide-react ChevronRight；
 *   - shimmer 流光类 .animate-shimmer 在 globals.css（keyframes shimmer）；
 *   - 增补：把手支持键盘 Enter/Space 解锁（拖拽不可达时的无障碍兜底）；
 *   - 修正：children 仅锁前渲染（原模板恒渲染，解锁后锁面与揭示内容同卡叠放）。
 */

// ---PROPS---
interface SlideToUnlockProps {
  children: React.ReactNode
  onUnlock: () => void
  sliderText?: string
  unlockedContent: React.ReactNode
  className?: string
  shimmer?: boolean
  /** 滑轨主题覆盖（默认模板灰底） */
  trackClassName?: string
  /** 把手主题覆盖（默认模板前景色圆钮） */
  handleClassName?: string
  /** 提示文字流光渐变覆盖（默认模板灰阶渐变） */
  shimmerClassName?: string
}

// ---COMPONENT---
export const SlideToUnlock = ({
  children,
  onUnlock,
  sliderText = "滑动开启礼物",
  unlockedContent,
  className,
  shimmer = true,
  trackClassName,
  handleClassName,
  shimmerClassName,
}: SlideToUnlockProps) => {
  const [unlocked, setUnlocked] = useState(false)
  const [dragConstraint, setDragConstraint] = useState(0)
  const x = useMotionValue(0)

  const sliderRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)

  // Effect to calculate the correct drag constraint after the component mounts
  useEffect(() => {
    const sliderWidth = sliderRef.current?.offsetWidth || 0
    const handleWidth = handleRef.current?.offsetWidth || 0
    setDragConstraint(sliderWidth - handleWidth)
  }, [])

  // When the drag ends, check if it's past the threshold
  const onDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.x > dragConstraint * 0.8) { // Unlock if dragged over 80%
      setUnlocked(true)
      onUnlock()
    } else {
      // Snap back to the start
      x.set(0)
    }
  }

  const textOpacity = useTransform(x, [0, 50], [1, 0])

  return (
    <div className={cn("relative w-full max-w-xs overflow-hidden rounded-2xl border bg-card p-6 text-card-foreground shadow-sm", className)}>
      <AnimatePresence>
        {!unlocked ? (
          <motion.div
            key="locked-face"
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence mode="wait">
        {!unlocked ? (
          <motion.div
            key="slider"
            initial={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.3 }}
            className="relative mt-6"
          >
            <div
              ref={sliderRef}
              className={cn(
                "relative h-14 w-full rounded-full bg-secondary",
                trackClassName,
              )}
            >
              <motion.div
                ref={handleRef}
                drag="x"
                dragConstraints={{ left: 0, right: dragConstraint }}
                dragElastic={0.1}
                whileDrag={{ scale: 1.08 }}
                style={{ x }}
                onDragEnd={onDragEnd}
                role="button"
                tabIndex={0}
                aria-label={sliderText}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setUnlocked(true)
                    onUnlock()
                  }
                }}
                className={cn(
                  "absolute left-0 top-0 z-10 flex h-14 w-14 cursor-grab items-center justify-center rounded-full bg-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:cursor-grabbing",
                  handleClassName,
                )}
              >
                <ChevronRight className="h-6 w-6 text-background" />
              </motion.div>
              <motion.span
                style={{ opacity: textOpacity }}
                className={cn(
                  "absolute inset-0 flex items-center justify-center text-sm font-medium text-muted-foreground",
                  shimmer &&
                    (shimmerClassName ??
                      "animate-shimmer bg-[linear-gradient(110deg,#9ca3af,45%,#e5e7eb,55%,#9ca3af)] bg-[length:200%_100%] bg-clip-text text-transparent"),
                )}
              >
                {sliderText}
              </motion.span>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="unlocked"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            {unlockedContent}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
