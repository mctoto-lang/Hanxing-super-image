"use client"

import { useEffect, useState } from "react"
import { format, isSameYear } from "date-fns"
import { CalendarIcon } from "lucide-react"
import { zhCN } from "react-day-picker/locale"
import { type DateRange } from "react-day-picker"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * 日期范围选择按钮（Popover + Calendar range 官方配方，中文日历）。
 * 全站复用（商品生成历史 / 选品工具筛选栏）；value/onChange 受控。
 */
export function DateRangePicker({
  value,
  onChange,
  size = "default",
  className,
  placeholder = "日期范围",
}: {
  value: DateRange | undefined
  onChange: (range: DateRange | undefined) => void
  /** 触发按钮尺寸（工具栏场景用 sm） */
  size?: "default" | "sm"
  /** 触发按钮追加类（如 h-8 与同行按钮对齐） */
  className?: string
  placeholder?: string
}) {
  // 受控 + 关闭时整体卸载内容：避免退场动画结束后 Portal 残留悬浮日历
  const [open, setOpen] = useState(false)
  // 渲染期不直接 new Date()（SSR 与客户端时钟差异可能引发 hydration 不一致）；
  // 首帧统一不带年份，挂载后按当前年份校正一次
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
  }, [])
  const dayLabel = (d: Date) =>
    format(d, !now || isSameYear(d, now) ? "MM/dd" : "yyyy/MM/dd")
  const label = value?.from
    ? value.to
      ? `${dayLabel(value.from)} - ${dayLabel(value.to)}`
      : `${dayLabel(value.from)} 起`
    : placeholder

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size={size}
            className={cn("gap-1.5 font-normal", value && "text-primary", className)}
          />
        }
      >
        <CalendarIcon className="size-4" />
        {label}
      </PopoverTrigger>
      {open && (
        <PopoverContent align="end" className="w-auto">
          <Calendar
            mode="range"
            selected={value}
            onSelect={onChange}
            numberOfMonths={1}
            locale={zhCN}
            autoFocus
          />
        </PopoverContent>
      )}
    </Popover>
  )
}
