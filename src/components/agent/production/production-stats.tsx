"use client"

/**
 * 统计卡（StatCard）：彩色图标 chip + 大数字 + 可选副行/迷你进度条。
 * 工作台顶部常驻 4 信息卡（文本/图片/产出/积分）使用；生产统计统一由
 * 顶部信息卡承担（art 阶段不再有第二份重复统计）。
 */
import type { Coins } from "lucide-react"
import { cn } from "@/lib/utils"

/** 统计卡：彩色图标 chip + 大数字 + 可选副行（生产视图与历史只读看板共用） */
export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  chipClass,
  progress,
}: {
  icon: typeof Coins
  label: string
  value: string
  /** 副行补充指标（小字，顿号/点号分隔） */
  sub?: string
  chipClass: string
  progress?: { percent: number; running: boolean }
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-3.5 shadow-xs">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", chipClass)}>
        <Icon className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-xl font-semibold leading-tight tabular-nums">{value}</p>
        {sub && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>}
        {progress && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full bg-violet-500 transition-[width] duration-500",
                progress.running && "motion-safe:animate-pulse",
              )}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
