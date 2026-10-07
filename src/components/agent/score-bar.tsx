"use client"

/**
 * 评分进度条（0-100）
 *
 * - ScoreBar：分格竖条带（「服务可用性」同款分段样式）——50 根细竖条、
 *   每根 2 分（gap 2px 细密间隔），按分数点亮对应数量；颜色按 scoreTone
 *   档位（红/琥珀/绿）；无及格线刻度，达线与否由颜色体现；
 * - score = null 时全部置灰 +「—」（未评分）；
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

/** 分数条带配色（与服务状态 UptimeBar 同款 400 亮色系；未点亮 = bg-muted） */
const SEGMENT_TONE_CLASSES: Record<ScoreTone, string> = {
  low: "bg-red-400",
  warn: "bg-yellow-400",
  pass: "bg-green-400",
}

/** 通过状态圆点颜色：绿=达到及格线 / 黄=未达线但 ≥60（接近及格）/ 红=<60 或不通过 */
const STATUS_DOT_CLASSES: Record<"pass" | "warn" | "low", string> = {
  pass: "bg-emerald-500",
  warn: "bg-amber-500",
  low: "bg-red-500",
}

/** 竖条带总分格数（每根 2 分；柱 w-1(4px) + gap-0.5(2px) 与 UptimeBar 完全
 * 相同，50 根总宽 298px 恰好适配弹窗中列；100 根需 600px 超宽放不下） */
export const SCORE_SEGMENTS = 50

type BarSize = "sm" | "md"

/** 条带高度统一 h-6、硬编码在 ScoreSegmentsBar（与服务状态 UptimeBar 一致），
 * 故此处只需 label/value 两档字号宽度 */
const SIZE_CLASSES: Record<BarSize, { label: string; value: string }> = {
  sm: { label: "w-12 text-[10px]", value: "text-[10px]" },
  md: { label: "w-14 text-xs", value: "text-xs" },
}

/** 把分数/及格线收敛到 0-100，防止非法输入画穿 */
function toPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** 分数 → 点亮格数（每根 2 分，四舍五入，0-SCORE_SEGMENTS） */
function toSegments(value: number): number {
  return Math.max(0, Math.min(SCORE_SEGMENTS, Math.round((toPercent(value) / 100) * SCORE_SEGMENTS)))
}

/** 纯分数条带（无标签/数值/圆点；柱参数固定与服务状态 UptimeBar 一致）——列表式评分行等场景单独使用 */
export function ScoreSegmentsBar({
  label,
  score,
  threshold,
  className,
}: {
  /** 无障碍标签（如「审美分」） */
  label: string
  score: number | null
  threshold: number
  className?: string
}) {
  const tone = score === null ? null : scoreTone(score, threshold)
  const lit = score === null ? 0 : toSegments(score)
  const ariaLabel =
    score === null
      ? `${label}：暂无评分，及格线 ${threshold}`
      : `${label} ${score}，及格线 ${threshold}`
  return (
    <div
      role="meter"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score ?? undefined}
      aria-valuetext={score === null ? "暂无评分" : `${score} 分（及格线 ${threshold}）`}
      className={cn("flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden", className)}
    >
      {Array.from({ length: SCORE_SEGMENTS }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            // 与服务状态 UptimeBar 完全相同的柱参数：h-6 / w-1(4px) /
            // rounded-sm / gap-0.5(2px)；固定宽度不参与 flex 均分（均分会
            // 产生亚像素舍入，柱宽与间隔忽宽忽窄）。无及格线刻度——
            // UptimeBar 没有该元素，通过颜色（绿=达线）体现状态。
            "h-6 w-1 shrink-0 rounded-sm transition-colors duration-300",
            index < lit
              ? tone
                ? SEGMENT_TONE_CLASSES[tone]
                : EMPTY_FILL_CLASS
              : "bg-muted",
          )}
        />
      ))}
    </div>
  )
}

export function ScoreBar({
  label,
  score,
  threshold,
  size = "md",
  showThreshold = false,
  status = null,
  className,
}: {
  /** 维度标签（如「审美分」） */
  label: string
  /** 0-100；null = 未评分，展示全灰竖条 + — */
  score: number | null
  /** 及格线（0-100），竖条带以分隔缺口标记位置 */
  threshold: number
  /** sm = 紧凑（评审员明细/缩略场景），md = 默认 */
  size?: BarSize
  /** 数值下方追加「及格 X」小字 */
  showThreshold?: boolean
  /** 名称后方的通过状态圆点（绿/黄/红）；null = 不显示 */
  status?: "pass" | "warn" | "low" | null
  className?: string
}) {
  const sizes = SIZE_CLASSES[size]
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className={cn("flex shrink-0 items-center gap-1.5 text-muted-foreground", sizes.label)}>
        {label}
        {status && (
          <span
            aria-label={status === "pass" ? "通过" : status === "warn" ? "接近及格" : "未通过"}
            className={cn("inline-block size-2 shrink-0 rounded-full", STATUS_DOT_CLASSES[status])}
          />
        )}
      </span>
      <ScoreSegmentsBar label={label} score={score} threshold={threshold} />
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
