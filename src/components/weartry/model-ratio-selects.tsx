"use client"

import { useMemo } from "react"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { resolveSizePresets } from "@/lib/image-sizes"
import type { WeartryModelRow } from "@/lib/weartry/types"

/**
 * 图片模型 + 图片比例 选择段（穿戴四 tab 共用，即「可选模型 / 可选尺寸」）。
 * 与商品页 ③ 区块同构。
 */
export function ModelRatioSelects({
  models,
  modelId,
  onModelChange,
  size,
  onSizeChange,
}: {
  models: WeartryModelRow[]
  modelId: string | null
  onModelChange: (id: string | null) => void
  size: string | null
  onSizeChange: (size: string | null) => void
}) {
  const selectedModel = models.find((m) => m.id === modelId) ?? null
  const modelLabel = selectedModel?.displayName || "选择模型"
  /** 归一化预设（ratio 优先、滤停用项——原始 presets 的 label 已被 0103 迁移收敛进 ratio，直接读会空白） */
  const sizePresets = useMemo(
    () => resolveSizePresets(selectedModel?.sizePresets),
    [selectedModel?.sizePresets],
  )
  /** 未选 → 通用比例；已选 → 模型预设比例名 */
  const ratioValueLabel = () => {
    if (!size) return "通用比例"
    return sizePresets.find((p) => p.value === size)?.label ?? size
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="space-y-1.5">
        <Label>图片模型</Label>
        <Select
          value={modelId ?? ""}
          onValueChange={(v) => {
            onModelChange(v ?? null)
            onSizeChange(null)
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="选择模型">{modelLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="flex items-center gap-1">
                  {m.displayName}
                  {m.apiFormat === "jimeng" && (
                    <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-600 dark:text-amber-400">
                      英文文字较弱
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>图片比例</Label>
        <Select value={size ?? ""} onValueChange={(v) => onSizeChange(v || null)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="通用比例">{ratioValueLabel()}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {sizePresets.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

/** 模型行 → 单张积分（预估按钮文案用） */
export function unitCostOf(models: WeartryModelRow[], modelId: string | null) {
  return models.find((m) => m.id === modelId)?.costPerImage ?? 0
}
