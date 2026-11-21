"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { format } from "date-fns"
import { X } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { DateRangePicker } from "@/components/shared/date-range-picker"
import { TemuSearchBar } from "@/components/temu/search-bar"
import { SELECTION_PLATFORMS, countryLabel } from "@/lib/selection/platforms"
import { platformLabel } from "@/components/selection/labels"

/**
 * 数据池筛选工具栏（选品发现/市场分析页，URL 驱动对齐 TEMU 商品页口径）
 *
 * 关键词/平台/国家/类型/抓取日期范围/来源任务/排序/去重开关；任一变更重置
 * 回第 1 页。国家与来源任务选项来自 getSelectionPoolMetaAction（企业内已出
 * 现的数据）。marketProps 存在时 = 市场分析页口径（社媒平台聚焦 + 类型锁定）。
 */

export interface PoolFilterState {
  platform: string
  country: string
  taskType: string
  task: string
  q: string
  sort: string
  dedupe: boolean
  dateFrom: string
  dateTo: string
}

export interface PoolMetaTask {
  id: string
  platform: string
  taskType: string
  keyword: string | null
  country: string | null
  fetchedCount: number
  completedAt: Date | null
}

const SORT_OPTIONS = [
  { value: "newest", label: "最新抓取" },
  { value: "sales_desc", label: "销量优先" },
  { value: "price_asc", label: "价格从低到高" },
  { value: "price_desc", label: "价格从高到低" },
  { value: "rating_desc", label: "评分优先" },
  { value: "likes_desc", label: "点赞优先" },
  { value: "comments_desc", label: "评论优先" },
  { value: "views_desc", label: "浏览优先" },
]

/** 市场分析页排序（社媒帖子口径） */
const SOCIAL_SORT_OPTIONS = [
  { value: "newest", label: "最新抓取" },
  { value: "likes_desc", label: "点赞优先" },
  { value: "comments_desc", label: "评论优先" },
  { value: "views_desc", label: "浏览优先" },
]

const SEARCH_FIELDS = [
  { value: "title", label: "标题/内容", placeholder: "搜索标题或帖子内容" },
]

function FilterSelect({
  value,
  onChange,
  ariaLabel,
  items,
  placeholder,
  width = "w-28",
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
  items: Array<{ value: string; label: string }>
  placeholder: string
  width?: string
}) {
  return (
    <Select
      items={items}
      value={value || null}
      onValueChange={(v) => onChange(v ?? "")}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className={`${width} text-xs`}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function PoolFilterBar({
  state,
  countries,
  tasks,
  basePath,
  category,
}: {
  state: PoolFilterState
  countries: string[]
  tasks: PoolMetaTask[]
  basePath: string
  /** 页面口径：ecommerce=选品发现（平台仅电商）/ social=市场分析（平台仅社媒、社媒排序、隐藏类型与来源任务筛选） */
  category?: "ecommerce" | "social"
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [keyword, setKeyword] = React.useState(state.q)

  React.useEffect(() => {
    setKeyword(state.q)
  }, [state.q])

  const pushState = (patch: Partial<PoolFilterState>) => {
    const next = { ...state, ...patch }
    const params = new URLSearchParams()
    if (next.platform) params.set("platform", next.platform)
    if (next.country) params.set("country", next.country)
    if (category !== 'social' && next.taskType) params.set("taskType", next.taskType)
    if (category !== 'social' && next.task) params.set("task", next.task)
    if (next.q) params.set("q", next.q)
    if (next.sort && next.sort !== "newest") params.set("sort", next.sort)
    if (next.dateFrom) params.set("dateFrom", next.dateFrom)
    if (next.dateTo) params.set("dateTo", next.dateTo)
    if (!next.dedupe) params.set("dedupe", "0")
    // 筛选跳转（重置回第 1 页）时保留用户选择的每页数量
    const pageSize = searchParams.get("pageSize")
    if (pageSize) params.set("pageSize", pageSize)
    const qs = params.toString()
    router.push(qs ? `${basePath}?${qs}` : basePath)
  }

  const platformItems = category
    ? [
        { value: "", label: category === "social" ? "全部社媒" : "全部电商" },
        ...SELECTION_PLATFORMS.filter((p) =>
          category === "social"
            ? ["instagram", "tiktok", "pinterest", "reddit", "x", "facebook"].includes(p)
            : ["amazon", "etsy", "temu", "shopify"].includes(p),
        ).map((p) => ({ value: p, label: platformLabel(p) })),
      ]
    : [
        { value: "", label: "全部平台" },
        ...SELECTION_PLATFORMS.map((p) => ({ value: p, label: platformLabel(p) })),
      ]

  const hasDate = state.dateFrom || state.dateTo

  return (
    <div className="flex flex-wrap items-center gap-2">
      <TemuSearchBar
        fields={SEARCH_FIELDS}
        field="title"
        onFieldChange={() => {}}
        keyword={keyword}
        onKeywordChange={setKeyword}
        onSearch={(_f, kw) => pushState({ q: kw })}
        maxLength={120}
        className="w-64"
      />
      <FilterSelect
        ariaLabel="平台筛选"
        placeholder={category === "social" ? "全部社媒" : category === "ecommerce" ? "全部电商" : "全部平台"}
        value={state.platform}
        onChange={(v) => pushState({ platform: v })}
        items={platformItems}
        width="w-32"
      />
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
      {category !== 'social' ? (
        <FilterSelect
          ariaLabel="类型筛选"
          placeholder="全部类型"
          value={state.taskType}
          onChange={(v) => pushState({ taskType: v })}
          items={[
            { value: "", label: "全部类型" },
            { value: "discover", label: "发现" },
            { value: "market", label: "市场" },
            { value: "monitor", label: "监控" },
          ]}
        />
      ) : null}
      <FilterSelect
        ariaLabel="排序"
        placeholder="最新抓取"
        value={state.sort || "newest"}
        onChange={(v) => pushState({ sort: v })}
        items={category === 'social' ? SOCIAL_SORT_OPTIONS : SORT_OPTIONS}
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
      {category !== 'social' && tasks.length > 0 ? (
        <FilterSelect
          ariaLabel="来源任务"
          placeholder="全部任务"
          value={state.task}
          onChange={(v) => pushState({ task: v })}
          items={[
            { value: "", label: "全部任务" },
            ...tasks.slice(0, 20).map((t) => ({
              value: t.id,
              label: `${platformLabel(t.platform)}「${(t.keyword ?? "").slice(0, 12)}」${t.fetchedCount}条`,
            })),
          ]}
          width="w-44"
        />
      ) : null}
      <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <Switch
          checked={state.dedupe}
          onCheckedChange={(v) => pushState({ dedupe: Boolean(v) })}
        />
        {category === 'social' ? "按帖子去重" : "按商品去重"}
      </label>
    </div>
  )
}
