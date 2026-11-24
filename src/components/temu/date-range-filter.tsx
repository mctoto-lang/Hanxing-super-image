"use client"

import { X } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { DateRangePicker } from "@/components/shared/date-range-picker"

/**
 * 日期范围筛选（DateRangePicker + 右侧清除）：发货单列表 / 质检 / 退货工具行共用，
 * 与同行下拉/搜索条等高（h-8 text-xs）。
 * clearable=false 不显示清除——入参必须带范围的场景（退货：官方无界查询报 100000001、
 * SKU 明细窗口必填）。
 */
export function TemuDateRangeFilter({
  value,
  onChange,
  placeholder,
  clearable = true,
  resetOnSelect = false,
}: {
  value: DateRange | undefined
  onChange: (range: DateRange | undefined) => void
  placeholder: string
  clearable?: boolean
  /** 透传 DateRangePicker.resetOnSelect（两步选区模型）；默认 false=发货单列表等既有行为 */
  resetOnSelect?: boolean
}) {
  return (
    <div className="flex items-center gap-1">
      <DateRangePicker
        size="sm"
        className="h-8 text-xs"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        resetOnSelect={resetOnSelect}
      />
      {clearable && value && (
        <button
          type="button"
          aria-label={`清除${placeholder}`}
          className="text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => onChange(undefined)}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
