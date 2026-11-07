"use client"

import * as React from "react"
import { CalendarIcon } from "lucide-react"
import { zhCN } from "react-day-picker/locale"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/** 官方可约揽收时段槽位（logisticsmatch channelScheduleTimeList 条目解析结果） */
export type PickupSlot = { date: Date; bjDate: string; start: string; end: string }

/** channelScheduleTimeList（官方对象数组，格式未文档化）→ 槽位列表（非法条目静默丢弃） */
export function parsePickupSlots(raw: unknown): PickupSlot[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((t) => {
    if (t && typeof t === "object" && typeof (t as { bjDate?: unknown }).bjDate === "string") {
      const s = t as { bjDate: string; bjStartTime?: unknown; bjEndTime?: unknown }
      const start = typeof s.bjStartTime === "string" ? s.bjStartTime : "00:00"
      const end = typeof s.bjEndTime === "string" ? s.bjEndTime : "23:59"
      const d = new Date(`${s.bjDate}T00:00`)
      if (!Number.isNaN(d.getTime())) return [{ date: d, bjDate: s.bjDate, start, end }]
    }
    return []
  })
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const cnDate = (d: Date) =>
  `${d.getMonth() + 1}月${d.getDate()}日 周${["日", "一", "二", "三", "四", "五", "六"][d.getDay()]}`

/**
 * 预约取货时间选择（装箱发货抽屉 / 自动预约发货弹窗共用）：
 * 日历仅可选槽位日期、时/分约束在当日可约窗口内；onChange 回传 epoch 毫秒
 * （日期+时+分未选全 = null = 不预约）。换物流公司时用 key 重置内部状态；
 * autoEarliest=true 时槽位到达自动预选最早可约时段。
 */
export function PickupTimePicker({
  slots,
  disabled,
  autoEarliest,
  onChange,
}: {
  slots: PickupSlot[]
  disabled?: boolean
  /** 自动预选最早可约时段（日=最早未过期槽位、时/分=窗口开始，已过则抬到当前之后） */
  autoEarliest?: boolean
  onChange: (ms: number | null) => void
}) {
  const [pickDate, setPickDate] = React.useState<Date | null>(null)
  const [pickHour, setPickHour] = React.useState("")
  const [pickMin, setPickMin] = React.useState("")
  const [calOpen, setCalOpen] = React.useState(false)

  const slotDates = React.useMemo(() => new Set(slots.map((s) => s.bjDate)), [slots])
  const pickSlot = pickDate ? slots.find((s) => s.bjDate === ymd(pickDate)) : null
  /** 小时约束在所选日期的可约窗口内（无窗口信息则全天） */
  const hourOptions = React.useMemo(() => {
    const all = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))
    if (!pickSlot) return all
    const from = Number(pickSlot.start.slice(0, 2))
    const to = Number(pickSlot.end.slice(0, 2))
    return all.filter((h) => Number(h) >= from && Number(h) <= to)
  }, [pickSlot])
  const minuteOptions = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"))
  const timeMs =
    pickDate && pickHour && pickMin
      ? new Date(`${ymd(pickDate)}T${pickHour}:${pickMin}`).getTime()
      : null

  // 槽位到达（或变化）时自动预选最早可约时段（跳过已过期槽位；全部过期则不预选=不预约）
  React.useEffect(() => {
    if (!autoEarliest || slots.length === 0) return
    const now = Date.now()
    const first = slots.find((s) => new Date(`${s.bjDate}T${s.end.slice(0, 5)}`).getTime() > now)
    if (!first) return
    setPickDate(first.date)
    setPickHour(first.start.slice(0, 2))
    setPickMin(first.start.slice(3, 5))
    // 窗口开始时刻已过 → 抬到当前时刻之后（end>now 已保证小时上界在窗口内）
    if (new Date(`${first.bjDate}T${first.start.slice(0, 5)}`).getTime() <= now) {
      const d = new Date(now + 60_000)
      setPickHour(String(d.getHours()).padStart(2, "0"))
      setPickMin(String(d.getMinutes()).padStart(2, "0"))
    }
  }, [autoEarliest, slots])

  React.useEffect(() => {
    onChange(timeMs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeMs])

  return (
    <div className="space-y-1.5">
      <Popover open={calOpen} onOpenChange={setCalOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full justify-start text-xs font-normal"
              disabled={disabled}
            />
          }
        >
          <CalendarIcon className="size-3.5" />
          {pickDate ? cnDate(pickDate) : disabled ? "先选物流公司" : "选择日期"}
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0">
          <Calendar
            locale={zhCN}
            mode="single"
            selected={pickDate ?? undefined}
            onSelect={(d) => {
              setPickDate(d ?? null)
              setPickHour("")
              setPickMin("")
              setCalOpen(false)
            }}
            disabled={(d) => !slotDates.has(ymd(d))}
          />
        </PopoverContent>
      </Popover>
      <div className="grid grid-cols-2 gap-2">
        <Select
          items={hourOptions.map((h) => ({ value: h, label: `${h} 时` }))}
          value={pickHour}
          onValueChange={(v) => {
            if (v) setPickHour(v)
          }}
          disabled={!pickDate}
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue placeholder="时" />
          </SelectTrigger>
          <SelectContent>
            {hourOptions.map((h) => (
              <SelectItem key={h} value={h}>
                {h} 时
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={minuteOptions.map((m) => ({ value: m, label: `${m} 分` }))}
          value={pickMin}
          onValueChange={(v) => {
            if (v) setPickMin(v)
          }}
          disabled={!pickDate}
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue placeholder="分" />
          </SelectTrigger>
          <SelectContent>
            {minuteOptions.map((m) => (
              <SelectItem key={m} value={m}>
                {m} 分
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
