"use client"

import { useState } from "react"
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

/** 历史记录筛选：日期范围按钮（Popover + Calendar range 官方配方，中文日历） */
export function HistoryDateRangePicker({
  value,
  onChange,
  size = "default",
}: {
  value: DateRange | undefined
  onChange: (range: DateRange | undefined) => void
  /** 触发按钮尺寸（工具栏场景用 sm） */
  size?: "default" | "sm"
}) {
  // 受控 + 关闭时整体卸载内容：避免退场动画结束后 Portal 残留悬浮日历
  const [open, setOpen] = useState(false)
  const now = new Date()
  const dayLabel = (d: Date) =>
    format(d, isSameYear(d, now) ? "MM/dd" : "yyyy/MM/dd")
  const label = value?.from
    ? value.to
      ? `${dayLabel(value.from)} - ${dayLabel(value.to)}`
      : `${dayLabel(value.from)} 起`
    : "日期范围"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size={size}
            className={cn("gap-1.5 font-normal", value && "text-primary")}
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
