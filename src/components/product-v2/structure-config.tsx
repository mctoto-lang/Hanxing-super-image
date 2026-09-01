"use client"

import type { ReactNode } from "react"
import { Check, Minus, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"
import type { DirectionSelectionMap } from "./direction-picker"
import type { ProductDirectionRow } from "@/lib/product/types"
import {
  SUITE_STRUCTURE_MODES,
  SUITE_OTHER_CATEGORY,
} from "@/lib/product/dictionaries"

/** 「其他」行选中态（count = AI 从未选方向中补充的张数） */
export interface StructureCategoryState {
  selected: boolean
  count: number
}

/** 单行（方向行 / 其他行共用：勾选 + 名称/描述 + 数量步进） */
function StructureRow({
  label,
  description,
  selected,
  count,
  max,
  onToggle,
  onCount,
  badge,
}: {
  label: string
  description?: string | null
  selected: boolean
  count: number
  /** 张数上限（1 则不显示步进） */
  max: number
  onToggle: () => void
  onCount: (delta: number) => void
  /** 标签后追加徽章（「其他」行的 AI智能匹配） */
  badge?: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border p-3 transition-colors",
        selected
          ? "border-primary/60 bg-primary/5"
          : "border-border",
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
        <span className="min-w-0">
          <span className="block text-sm font-medium">
            {label}
            {badge}
          </span>
          {description && (
            <span className="block text-xs text-muted-foreground">
              {description}
            </span>
          )}
        </span>
      </button>

      {selected && max > 1 && (
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onCount(-1)}
            disabled={count <= 1}
            className="rounded border border-border p-1 disabled:opacity-40"
            aria-label={`减少${label}张数`}
          >
            <Minus className="size-3" />
          </button>
          <span className="w-6 text-center text-sm tabular-nums">
            {count}
          </span>
          <button
            type="button"
            onClick={() => onCount(1)}
            disabled={count >= max}
            className="rounded border border-border p-1 disabled:opacity-40"
            aria-label={`增加${label}张数`}
          >
            <Plus className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * ⑤ 套图结构配置（仅套图 tab）
 *
 * 两种模式二选一（结构在点击「生成商品套图」后才被 AI/用户确定）：
 * - 智能匹配：无额外配置（点生成时 AI 按商品信息分配 7~9 张）
 * - 自定义配置：逐行列出套图方向池（超管在「图片方向-商品套图」配置的
 *   选项，前端隐藏的不显示），可勾选/调张数；末尾「其他」行由 AI 从未选方向中补充
 */
export function SuiteStructureConfig({
  mode,
  onModeChange,
  directions,
  selections,
  onSelectionsChange,
  other,
  onOtherChange,
  totalImages,
}: {
  mode: "smart" | "custom"
  onModeChange: (next: "smart" | "custom") => void
  /** 套图方向池（自定义配置逐行展示；调用方负责过滤前端隐藏方向） */
  directions: ProductDirectionRow[]
  /** 方向选中态（自定义模式手动勾选） */
  selections: DirectionSelectionMap
  onSelectionsChange: (next: DirectionSelectionMap) => void
  /** 「其他」行选中态（从未选方向中 AI 补充） */
  other: StructureCategoryState
  onOtherChange: (next: StructureCategoryState) => void
  totalImages: number
}) {
  const otherMax = SUITE_OTHER_CATEGORY.maxCount

  const toggleDir = (key: string) => {
    const cur = selections[key]
    onSelectionsChange({
      ...selections,
      [key]: { selected: !cur?.selected, count: cur?.count ?? 1 },
    })
  }
  const setDirCount = (key: string, delta: number, max: number) => {
    const cur = selections[key]
    if (!cur) return
    onSelectionsChange({
      ...selections,
      [key]: { ...cur, count: Math.min(max, Math.max(1, cur.count + delta)) },
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>套图结构配置</Label>
        <span className="text-xs text-muted-foreground">已选 {totalImages} 张</span>
      </div>

      {/* 模式二选一（上下布局） */}
      <div className="grid grid-cols-1 gap-2">
        {SUITE_STRUCTURE_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => onModeChange(m.value)}
            className={cn(
              "rounded-lg border p-2.5 text-left text-sm transition-colors",
              mode === m.value
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50",
            )}
          >
            <span className="block font-medium">{m.label}</span>
            <span className="block text-xs text-muted-foreground">
              {m.description}
            </span>
          </button>
        ))}
      </div>

      {mode === "custom" && (
        <div className="grid grid-cols-1 gap-2">
          {directions.map((d) => {
            const state = selections[d.key]
            const max = d.supportsCount ? d.maxCount : 1
            return (
              <StructureRow
                key={d.key}
                label={d.name}
                description={d.description}
                selected={state?.selected ?? false}
                count={state?.count ?? 1}
                max={max}
                onToggle={() => toggleDir(d.key)}
                onCount={(delta) => setDirCount(d.key, delta, max)}
              />
            )
          })}
          <StructureRow
            label={SUITE_OTHER_CATEGORY.label}
            description={SUITE_OTHER_CATEGORY.description}
            selected={other.selected}
            count={other.count}
            max={otherMax}
            onToggle={() =>
              onOtherChange({ ...other, selected: !other.selected })
            }
            onCount={(delta) =>
              onOtherChange({
                ...other,
                count: Math.min(otherMax, Math.max(1, other.count + delta)),
              })
            }
            badge={
              <span className="ml-1.5 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-px align-middle text-[10px] font-medium text-primary">
                AI智能匹配
              </span>
            }
          />
        </div>
      )}
    </div>
  )
}
