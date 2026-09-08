"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { format } from "date-fns"
import { type DateRange } from "react-day-picker"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { HistoryDateRangePicker } from "@/components/product-v2/history-date-range-picker"
import { MODULE_LABELS } from "@/lib/admin/table-filters"

/** Select「全部」占位值（与空筛选互斥） */
const ALL = "__all__"

/**
 * 管理端列表筛选栏（URL 驱动）：搜索用户 + 模块下拉 + 日期范围。
 * 任一筛选变化重置回第 1 页；保留其余无关 query 参数（如 tab）。
 */
export function AdminListFilters({
  basePath,
  q = "",
  module = "",
  from = "",
  to = "",
  moduleOptions,
  searchPlaceholder = "搜索用户",
}: {
  basePath: string
  q?: string
  module?: string
  from?: string
  to?: string
  moduleOptions: readonly string[]
  searchPlaceholder?: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [search, setSearch] = React.useState(q)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // 外部值变化（翻页带回、清除筛选）时同步本地输入框
  React.useEffect(() => {
    setSearch(q)
  }, [q])

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const pushParams = React.useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value)
        else params.delete(key)
      }
      params.delete("page") // 筛选变化重置回第 1 页
      const qs = params.toString()
      router.replace(qs ? `${basePath}?${qs}` : basePath)
    },
    [basePath, router, searchParams],
  )

  const navigateSearch = React.useCallback(
    (value: string) => pushParams({ q: value }),
    [pushParams],
  )

  const dateValue: DateRange | undefined =
    from && to
      ? { from: new Date(`${from}T00:00:00`), to: new Date(`${to}T00:00:00`) }
      : undefined

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-56 max-w-full">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(
              () => navigateSearch(e.target.value.trim()),
              300,
            )
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              if (timerRef.current) clearTimeout(timerRef.current)
              navigateSearch(search.trim())
            }
          }}
          placeholder={searchPlaceholder}
          className="pl-8"
        />
      </div>
      <Select
        value={module || ALL}
        onValueChange={(v) => pushParams({ module: v && v !== ALL ? v : "" })}
      >
        <SelectTrigger className="w-32">
          <SelectValue>
            {module ? (MODULE_LABELS[module] ?? module) : "全部模块"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部模块</SelectItem>
          {moduleOptions.map((m) => (
            <SelectItem key={m} value={m}>
              {MODULE_LABELS[m] ?? m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <HistoryDateRangePicker
        size="default"
        value={dateValue}
        onChange={(range) => {
          if (range?.from && range?.to) {
            pushParams({
              from: format(range.from, "yyyy-MM-dd"),
              to: format(range.to, "yyyy-MM-dd"),
            })
          } else {
            pushParams({ from: "", to: "" })
          }
        }}
      />
    </div>
  )
}
