"use client"

import { Fragment } from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * 通用分段步骤条：完成=绿勾 · 当前=主题色填充 · 未来=muted。
 * 从塔罗工作台 StageProgress 抽象（当前色固定 violet 与工坊主题一致）。
 */
export function Stepper({
  steps,
  currentIndex,
  className,
}: {
  steps: { id: string; label: string }[]
  /** 当前步骤（0 起；等于 steps.length 时全部完成） */
  currentIndex: number
  className?: string
}) {
  return (
    <ol className={cn("flex items-start", className)}>
      {steps.map((step, index) => {
        const done = index < currentIndex
        const current = index === currentIndex
        return (
          <Fragment key={step.id}>
            <li className="flex w-16 shrink-0 flex-col items-center gap-1.5">
              <span
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-[11px] font-semibold transition-colors",
                  done && "bg-emerald-500 text-white",
                  current && "bg-violet-500 text-white ring-4 ring-violet-500/20",
                  !done && !current && "bg-muted text-muted-foreground",
                )}
              >
                {done ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "max-w-full truncate text-[11px] leading-tight",
                  current
                    ? "font-medium text-violet-600 dark:text-violet-300"
                    : done
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </li>
            {index < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "mt-[11px] h-0.5 min-w-3 flex-1 rounded-full transition-colors",
                  index < currentIndex ? "bg-emerald-500/70" : "bg-muted",
                )}
              />
            )}
          </Fragment>
        )
      })}
    </ol>
  )
}
