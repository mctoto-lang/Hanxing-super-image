"use client"



import {
  Check,
  Crop,
  Eraser,
  Minus,
  Palette,
  Plus,
  Sparkles,
  Wand2,
  ZoomIn,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { ProductDirectionRow, SmartMatchSlot } from "@/lib/product/types"

/** 精修优化项的图标映射（按方向 key；未命中兜底 Wand2） */
const REFINE_ICONS: Record<string, LucideIcon> = {
  enhance_gloss: Sparkles,
  repair_scratches: Eraser,
  enhance_clarity: ZoomIn,
  color_correction: Palette,
  fix_perspective: Crop,
}

/** 方向选中态（count 仅 supportsCount 方向有效） */
export interface DirectionSelectionState {
  selected: boolean
  count: number
  vars?: SmartMatchSlot
}

export type DirectionSelectionMap = Record<string, DirectionSelectionState>

/** 从方向池构建默认选中态（全不选，由调用方/智能匹配决定勾选） */
export function initSelections(
  directions: ProductDirectionRow[],
): DirectionSelectionMap {
  const map: DirectionSelectionMap = {}
  for (const d of directions) {
    map[d.key] = { selected: false, count: 1 }
  }
  return map
}

/** 智能匹配结果应用到选中态 */
export function applySmartMatch(
  selections: DirectionSelectionMap,
  slots: SmartMatchSlot[],
): DirectionSelectionMap {
  const next: DirectionSelectionMap = {}
  for (const [key, cur] of Object.entries(selections)) {
    const hit = slots.find((s) => s.key === key)
    next[key] = hit
      ? {
          selected: hit.selected,
          count: hit.count ?? 1,
          vars: hit,
        }
      : { ...cur, selected: false }
  }
  return next
}

/** 单个方向卡片 */
function DirectionCard({
  direction,
  state,
  onToggle,
  onCount,
  compact,
  hideCount,
}: {
  direction: ProductDirectionRow
  state: DirectionSelectionState | undefined
  onToggle: () => void
  onCount: (delta: number) => void
  /** 紧凑模式（refine 快捷优化项：上图标下文字卡片） */
  compact?: boolean
  /** 隐藏数量步进（A+详情页：点击即 1 张） */
  hideCount?: boolean
}) {
  const selected = state?.selected ?? false
  const vars = state?.vars
  const varChips = vars
    ? [vars.angle, vars.focus, vars.copyHint, vars.target].filter(Boolean)
    : []

  if (compact) {
    const Icon = REFINE_ICONS[direction.key] ?? Wand2
    return (
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors",
          selected
            ? "border-primary bg-primary/5 text-foreground"
            : "border-border text-muted-foreground hover:border-primary/50",
        )}
      >
        <Icon className={cn("size-6", selected && "text-primary")} />
        <span className="text-xs font-medium">{direction.name}</span>
      </button>
    )
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border p-3 transition-colors",
        selected ? "border-primary/60 bg-primary/5" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
      >
        <span
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/40",
          )}
        >
          {selected && <Check className="size-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{direction.name}</span>
          {direction.description && (
            <span className="block truncate text-xs text-muted-foreground">
              {direction.description}
            </span>
          )}
        </span>
      </button>

      {/* 数量步进固定在行右（与商品套图-自定义配置的行布局一致，无文字提示） */}
      {!hideCount && selected && direction.supportsCount && direction.maxCount > 1 && (
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onCount(-1)}
            disabled={(state?.count ?? 1) <= 1}
            className="rounded border border-border p-1 disabled:opacity-40"
            aria-label="减少张数"
          >
            <Minus className="size-3" />
          </button>
          <span className="w-6 text-center text-sm tabular-nums">
            {state?.count ?? 1}
          </span>
          <button
            type="button"
            onClick={() => onCount(1)}
            disabled={(state?.count ?? 1) >= direction.maxCount}
            className="rounded border border-border p-1 disabled:opacity-40"
            aria-label="增加张数"
          >
            <Plus className="size-3" />
          </button>
        </div>
      )}

      {selected && varChips.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1">
          {varChips.map((chip, i) => (
            <span
              key={i}
              className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary"
            >
              {chip}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 方向选择器（⑤ 可选择的方向 / 精修快捷优化项） */
export function DirectionPicker({
  directions,
  selections,
  onSelectionsChange,
  compact,
  hideCount,
  disabled,
  columns = 2,
}: {
  directions: ProductDirectionRow[]
  selections: DirectionSelectionMap
  onSelectionsChange: (next: DirectionSelectionMap) => void
  compact?: boolean
  /** 隐藏数量步进（A+详情页：点击即 1 张） */
  hideCount?: boolean
  disabled?: boolean
  /** 卡片列数（商品页 2 列；穿戴-服装组图 1 行 1 列） */
  columns?: 1 | 2
}) {
  const toggle = (key: string) => {
    const cur = selections[key]
    onSelectionsChange({
      ...selections,
      [key]: { ...cur, selected: !cur?.selected, count: cur?.count ?? 1 },
    })
  }
  const setCount = (key: string, delta: number) => {
    const cur = selections[key]
    if (!cur) return
    onSelectionsChange({
      ...selections,
      [key]: { ...cur, count: Math.max(1, cur.count + delta) },
    })
  }

  return (
    <div
      className={cn(
        columns === 1 ? "grid grid-cols-1 gap-2" : "grid grid-cols-2 gap-2",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      {directions.map((d) => (
        <DirectionCard
          key={d.key}
          direction={d}
          state={selections[d.key]}
          onToggle={() => toggle(d.key)}
          onCount={(delta) => setCount(d.key, delta)}
          compact={compact}
          hideCount={hideCount}
        />
      ))}
    </div>
  )
}

/** 选中方向展开后的任务数（积分预估用） */
export function countSelectedImages(selections: DirectionSelectionMap): number {
  return Object.values(selections)
    .filter((s) => s.selected)
    .reduce((sum, s) => sum + s.count, 0)
}

/** 选中的方向 key 列表（提交用） */
export function selectedDirectionKeys(selections: DirectionSelectionMap): string[] {
  return Object.entries(selections)
    .filter(([, s]) => s.selected)
    .map(([key]) => key)
}
