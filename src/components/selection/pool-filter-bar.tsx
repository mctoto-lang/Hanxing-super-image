"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { format } from "date-fns"
import { LayoutGrid, List, X } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { DateRangePicker } from "@/components/shared/date-range-picker"
import { TemuSearchBar } from "@/components/temu/search-bar"
import { FilterSelect } from "@/components/selection/filter-select"
import { countryLabel } from "@/lib/selection/platforms"
import { poolQuery, type PoolFilterState } from "@/lib/selection/pool-url"
import { cn } from "@/lib/utils"

/**
 * 数据池筛选工具栏（选品发现 / 市场分析的平台标签视图共用）
 *
 * 平台由页面标签条决定，工具栏不再有平台下拉。关键词 / 国家 / 类型 / 来源任务 /
 * 排序 / 抓取日期范围 / 去重开关 / 视图切换全部 URL 驱动；任一变更重置回第 1 页。
 * 国家与来源任务选项来自 getSelectionPoolMetaAction（当前平台内已出现的数据）。
 */

export interface PoolMetaTask {
  id: string
  platform: string
  taskType: string
  keyword: string | null
  country: string | null
  fetchedCount: number
  completedAt: Date | null
}

const TASK_TYPE_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "discover", label: "发现" },
  { value: "market", label: "市场" },
  { value: "monitor", label: "监控" },
]

export function PoolFilterBar({
  state,
  countries,
  tasks,
  basePath,
  sortOptions,
  showTaskFilters = false,
  showViewToggle = false,
  dedupeLabel,
}: {
  state: PoolFilterState
  countries: string[]
  tasks: PoolMetaTask[]
  basePath: string
  /** 当前平台可用的排序项（见 platform-views） */
  sortOptions: Array<{ value: string; label: string }>
  /** 是否显示类型 / 来源任务筛选（选品发现页） */
  showTaskFilters?: boolean
  /** 是否显示卡片 / 表格视图切换（电商有表格视图） */
  showViewToggle?: boolean
  dedupeLabel: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const [keyword, setKeyword] = React.useState(state.q)

  React.useEffect(() => {
    setKeyword(state.q)
  }, [state.q])

  const pushState = (patch: Partial<PoolFilterState>) => {
    const next = { ...state, ...patch }
    const params = new URLSearchParams(
      Object.entries(poolQuery(next)).filter((pair): pair is [string, string] => pair[1] != null),
    )
    // 筛选跳转（重置回第 1 页）时保留用户选择的每页数量
    const pageSize = searchParams.get("pageSize")
    if (pageSize) params.set("pageSize", pageSize)
    const qs = params.toString()
    startTransition(() => {
      router.push(qs ? `${basePath}?${qs}` : basePath)
    })
  }

  const hasDate = Boolean(state.dateFrom || state.dateTo)
  const activeSort = sortOptions.some((o) => o.value === state.sort) ? state.sort : "newest"

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 transition-opacity",
        pending && "opacity-70",
      )}
    >
      <TemuSearchBar
        fields={[{ value: "title", label: "标题/内容", placeholder: "搜索标题或内容" }]}
        field="title"
        onFieldChange={() => {}}
        keyword={keyword}
        onKeywordChange={setKeyword}
        onSearch={(_f, kw) => pushState({ q: kw })}
        maxLength={120}
        className="w-56"
      />
      {countries.length > 0 ? (
        <FilterSelect
          ariaLabel="国家筛选"
          placeholder="全部国家"
          value={state.country}
          onChange={(v) => pushState({ country: v })}
          items={[
            { value: "", label: "全部国家" },
            ...countries.map((c) => ({ value: c, label: `${countryLabel(c)} ${c}` })),
          ]}
          width="w-30"
        />
      ) : null}
      {showTaskFilters ? (
        <FilterSelect
          ariaLabel="类型筛选"
          placeholder="全部类型"
          value={state.taskType}
          onChange={(v) => pushState({ taskType: v })}
          items={TASK_TYPE_OPTIONS}
        />
      ) : null}
      <FilterSelect
        ariaLabel="排序"
        placeholder="最新抓取"
        value={activeSort}
        onChange={(v) => pushState({ sort: v })}
        items={sortOptions}
        width="w-36"
      />
      {/* 抓取日期范围（全站共用日历范围选择器；含端点） */}
      <div className="flex items-center gap-1">
        <DateRangePicker
          size="sm"
          className="h-8 text-xs"
          placeholder="抓取日期"
          value={{
            from: state.dateFrom ? new Date(`${state.dateFrom}T00:00:00`) : undefined,
            to: state.dateTo ? new Date(`${state.dateTo}T00:00:00`) : undefined,
          }}
          onChange={(range) =>
            pushState({
              dateFrom: range?.from ? format(range.from, "yyyy-MM-dd") : "",
              dateTo: range?.to ? format(range.to, "yyyy-MM-dd") : "",
            })
          }
        />
        {hasDate ? (
          <button
            type="button"
            aria-label="清除日期范围"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-muted"
            onClick={() => pushState({ dateFrom: "", dateTo: "" })}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      {showTaskFilters && tasks.length > 0 ? (
        <FilterSelect
          ariaLabel="来源任务"
          placeholder="全部任务"
          value={state.task}
          onChange={(v) => pushState({ task: v })}
          items={[
            { value: "", label: "全部任务" },
            ...tasks.slice(0, 30).map((t) => ({
              value: t.id,
              label: `${t.taskType === "discover" ? "发现" : t.taskType === "market" ? "市场" : t.taskType}「${(t.keyword ?? "").slice(0, 12)}」${t.fetchedCount}条`,
            })),
          ]}
          width="w-48"
        />
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        {showViewToggle ? (
          <div className="flex items-center rounded-md border p-0.5" role="group" aria-label="视图切换">
            {[
              { view: "card", Icon: LayoutGrid, label: "卡片视图" },
              { view: "table", Icon: List, label: "表格视图" },
            ].map(({ view, Icon, label }) => (
              <button
                key={view}
                type="button"
                aria-label={label}
                aria-pressed={state.view === view}
                className={cn(
                  "flex h-7 w-8 items-center justify-center rounded-[5px] transition-colors",
                  state.view === view
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={() => pushState({ view: view as PoolFilterState["view"] })}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </div>
        ) : null}
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={state.dedupe}
            onCheckedChange={(v) => pushState({ dedupe: Boolean(v) })}
          />
          {dedupeLabel}
        </label>
      </div>
    </div>
  )
}
