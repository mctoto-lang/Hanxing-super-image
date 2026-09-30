"use client"

/**
 * 评分进度条（0-100）
 *
 * - 轨道按 scoreTone 档位着色（红/琥珀/绿），及格线处以细竖线标记；
 * - score = null 时展示空轨道 +「—」（未评分）；
 * - ScoreMiniBars：无标签的三条细进度条，用于卡片网格缩略图等紧凑场景。
 */
import { cn } from "@/lib/utils"
import {
  DEFAULT_SCORE_THRESHOLDS,
  scoreTone,
  type ScoreThresholds,
  type ScoreTone,
} from "@/lib/agent/score"

/** 档位 → 填充色（深浅色模式均可读） */
export const SCORE_TONE_FILL_CLASSES: Record<ScoreTone, string> = {
  low: "bg-red-500 dark:bg-red-400",
  warn: "bg-amber-500 dark:bg-amber-400",
  pass: "bg-emerald-500 dark:bg-emerald-400",
}

/** 未评分/空轨道占位色 */
const EMPTY_FILL_CLASS = "bg-zinc-400/50 dark:bg-zinc-500/40"
const TRACK_CLASS = "bg-zinc-200 dark:bg-zinc-700"

type BarSize = "sm" | "md"

const SIZE_CLASSES: Record<BarSize, { track: string; label: string; value: string }> = {
  sm: { track: "h-1.5", label: "w-12 text-[10px]", value: "text-[10px]" },
  md: { track: "h-2.5", label: "w-14 text-xs", value: "text-xs" },
}

/** 把分数/及格线收敛到 0-100，防止非法输入把轨道画穿 */
function toPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

export function ScoreBar({
  label,
  score,
  threshold,
  size = "md",
  showThreshold = false,
  className,
}: {
  /** 维度标签（如「审美分」） */
  label: string
  /** 0-100；null = 未评分，展示空轨道 + — */
  score: number | null
  /** 及格线（0-100），轨道上以细竖线标记位置 */
  threshold: number
  /** sm = 紧凑（评审员明细/缩略场景），md = 默认 */
  size?: BarSize
  /** 数值下方追加「及格 X」小字 */
  showThreshold?: boolean
  className?: string
}) {
  const sizes = SIZE_CLASSES[size]
  const tone = score === null ? null : scoreTone(score, threshold)
  const ariaLabel =
    score === null
      ? `${label}：暂无评分，及格线 ${threshold}`
      : `${label} ${score}，及格线 ${threshold}`
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className={cn("shrink-0 text-muted-foreground", sizes.label)}>{label}</span>
      <div
        role="meter"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score ?? undefined}
        className={cn("relative flex-1 rounded-full", sizes.track, TRACK_CLASS)}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            tone ? SCORE_TONE_FILL_CLASSES[tone] : EMPTY_FILL_CLASS,
          )}
          style={{ width: score === null ? "0%" : `${toPercent(score)}%` }}
        />
        <span
          aria-hidden="true"
          className="absolute top-1/2 h-[calc(100%+4px)] w-px -translate-y-1/2 bg-foreground/40"
          style={{ left: `${toPercent(threshold)}%` }}
        />
      </div>
      <div className="flex w-12 shrink-0 flex-col items-end leading-tight">
        <span className={cn("font-medium tabular-nums", sizes.value)}>
          {score === null ? "—" : score}
        </span>
        {showThreshold && (
          <span className="text-[10px] tabular-nums text-muted-foreground">及格 {threshold}</span>
        )}
      </div>
    </div>
  )
}

/** 三维度得分（ScoreMiniBars 入参，均为可空） */
export interface ScoreMiniBarsProps {
  content: number | null
  aesthetic: number | null
  consistency: number | null
  /** 覆盖默认及格线（缺省维度用 DEFAULT_SCORE_THRESHOLDS） */
  thresholds?: Partial<ScoreThresholds>
  className?: string
}

/** 无标签三条细进度条（内容/审美/一致性自上而下），供卡片网格缩略图叠加 */
export function ScoreMiniBars({ content, aesthetic, consistency, thresholds, className }: ScoreMiniBarsProps) {
  const th = { ...DEFAULT_SCORE_THRESHOLDS, ...thresholds }
  const rows = [
    { dim: "content" as const, score: content, threshold: th.content },
    { dim: "aesthetic" as const, score: aesthetic, threshold: th.aesthetic },
    { dim: "consistency" as const, score: consistency, threshold: th.consistency },
  ]
  const summary = `内容 ${content ?? "—"} · 审美 ${aesthetic ?? "—"} · 一致性 ${consistency ?? "—"}`
  return (
    <div className={cn("flex flex-col gap-1", className)} title={summary}>
      <span className="sr-only">{summary}</span>
      {rows.map(({ dim, score, threshold }) => (
        <div
          key={dim}
          aria-hidden="true"
          className={cn("h-1 w-full overflow-hidden rounded-full", TRACK_CLASS)}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500 ease-out",
              score === null ? EMPTY_FILL_CLASS : SCORE_TONE_FILL_CLASSES[scoreTone(score, threshold)],
            )}
            style={{ width: score === null ? "0%" : `${toPercent(score)}%` }}
          />
        </div>
      ))}
    </div>
  )
}
