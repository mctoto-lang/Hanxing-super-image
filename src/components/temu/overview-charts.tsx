"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  TemuCategoryShare,
  TemuSalesTopRow,
} from "@/server/actions/temu"

/**
 * Temu 面板概览组件：店铺切换下拉、类目占比、售出 TOP10。
 * 趋势图与顶部卡片用 dashboard-01 真源组件
 * （@/components/chart-area-interactive、@/components/section-cards）。
 */

const ALL_STORES = "__all__"

/** 店铺切换下拉（URL 驱动：选值跳转 /temu?tab=&store=，保持服务端渲染数据流）。
 *  items 供 SelectValue 显示中文标签——不传时 base-ui 会显示原始 value（UUID）。
 *  allowAll=false 时不提供「全部店铺」（发品等必须落到具体店的 tab） */
export function TemuStoreSelect({
  tab,
  current,
  stores,
  allowAll = true,
}: {
  tab: string
  current?: string
  stores: { id: string; name: string }[]
  allowAll?: boolean
}) {
  const router = useRouter()
  const items = [
    ...(allowAll ? [{ value: ALL_STORES, label: "全部店铺" }] : []),
    ...stores.map((s) => ({ value: s.id, label: s.name })),
  ]
  return (
    <Select
      items={items}
      value={current || (allowAll ? ALL_STORES : stores[0]?.id ?? "")}
      onValueChange={(v) => {
        const p = new URLSearchParams({ tab })
        if (v && v !== ALL_STORES) p.set("store", v)
        router.push(`/temu?${p.toString()}`)
      }}
    >
      <SelectTrigger className="h-9! w-44" aria-label="切换店铺">
        <SelectValue placeholder={allowAll ? "全部店铺" : "选择店铺"} />
      </SelectTrigger>
      <SelectContent>
        {allowAll && <SelectItem value={ALL_STORES}>全部店铺</SelectItem>}
        {stores.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 统计口径选择（今日/近7日/近30日；半宽卡片用，紧凑无 Select 兜底） */
function MetricToggle({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const opts = [
    { v: "today", label: "今日" },
    { v: "7d", label: "近7日" },
    { v: "30d", label: "近30日" },
  ]
  return (
    <ToggleGroup
      multiple={false}
      value={value ? [value] : []}
      onValueChange={(v: string[]) => onChange(v[0] ?? "7d")}
      variant="outline"
      size="sm"
      spacing={0}
    >
      {opts.map((o) => (
        <ToggleGroupItem key={o.v} value={o.v}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

// ---------- 售出类目占比 ----------

const donutPalette = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

/** 类目占比 tooltip：类目名 · 数量 · 占圆环合计百分比 */
function ShareTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean
  payload?: Array<{ name?: string | number; value?: number | string }>
  total: number
}) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  const value = Number(p.value ?? 0)
  const pct = total > 0 ? Math.round((value / total) * 1000) / 10 : 0
  return (
    <div className="min-w-36 rounded-lg border bg-background px-3 py-2 text-xs shadow-xl">
      <div className="max-w-48 truncate font-medium">{String(p.name ?? "")}</div>
      <div className="mt-0.5 text-muted-foreground">
        {value.toLocaleString("zh-CN")} 件 · 占比 <span className="text-foreground">{pct}%</span>
      </div>
    </div>
  )
}

/** 售出类目占比（环形图，动态切片 + 其他；口径可切 今日/近7日/近30日） */
export function TemuCategoryShare({ data }: { data: TemuCategoryShare[] }) {
  const [metric, setMetric] = React.useState("today")
  const pick = (d: TemuCategoryShare) =>
    metric === "today"
      ? d.todaySalesVolume
      : metric === "30d"
        ? d.last30DaysSalesVolume
        : d.last7DaysSalesVolume

  const total = data.reduce((s, d) => s + pick(d), 0)
  const slices = React.useMemo(() => {
    const sorted = [...data].sort((a, b) => pick(b) - pick(a)).filter((d) => pick(d) > 0)
    // 动态纳入：占比 ≥1% 的类目全部展示（最多 15 条），其余合并「其他」
    const kept: Array<{ label: string; value: number }> = []
    for (const d of sorted) {
      if (kept.length >= 15) break
      if (total > 0 && pick(d) / total < 0.01) break
      kept.push({ label: d.category, value: pick(d) })
    }
    const rest = sorted.slice(kept.length).reduce((s, d) => s + pick(d), 0)
    if (rest > 0) kept.push({ label: "其他", value: rest })
    return kept.map((s, i) => ({
      ...s,
      color: s.label === "其他" ? "var(--muted)" : donutPalette[i % donutPalette.length],
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, metric, total])

  const config = Object.fromEntries(
    slices.map((s) => [s.label, { label: s.label, color: s.color }]),
  ) satisfies ChartConfig

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>售出类目占比</CardTitle>
        <CardDescription>销售管理最新批次 · 按类目汇总销量（展示占比 ≥1% 的类目，至多 15 条）</CardDescription>
        <CardAction>
          <MetricToggle value={metric} onChange={setMetric} />
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {total === 0 ? (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
            所选口径暂无数据（数据随官方 API 定时同步更新）
          </div>
        ) : (
          <ChartContainer config={config} className="mx-auto h-[280px] w-full">
            <PieChart>
              <ChartTooltip content={<ShareTooltip total={total} />} />
              <Pie
                data={slices}
                dataKey="value"
                nameKey="label"
                innerRadius={52}
                outerRadius={86}
                paddingAngle={slices.length > 10 ? 1 : 2}
                strokeWidth={2}
              >
                {slices.map((s) => (
                  <Cell key={s.label} fill={s.color} />
                ))}
              </Pie>
              <ChartLegend content={<ChartLegendContent nameKey="label" />} />
            </PieChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- 售出 TOP20 ----------

type TopDatum = {
  name: string
  value: number
  skcId: string
  productSn: string | null
  category: string | null
  mainImageUrl: string | null
  /** 主图转存 URL（COS/本地；展示优先于 kwcdn 外链） */
  mainImageCosUrl: string | null
  supplierPrice: number | null
}

/** TOP20 自定义 tooltip：货号 / 类目 / 销量 / 预估销售额（申报价 × 销量） */
function TopTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TopDatum }> }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  const estAmount =
    d.supplierPrice != null ? Math.round((d.value * d.supplierPrice) / 100 * 100) / 100 : null
  return (
    <div className="min-w-44 rounded-lg border bg-background px-3 py-2 text-xs shadow-xl">
      <div className="max-w-56 truncate font-medium" title={d.name}>
        {d.name}
      </div>
      <div className="mt-1 grid gap-0.5 text-muted-foreground">
        <span>货号：{d.productSn ?? "—"}</span>
        {d.category && <span>类目：{d.category}</span>}
        <span className="text-foreground">销量：{d.value.toLocaleString("zh-CN")} 件</span>
        {estAmount != null && <span>预估销售额：¥{estAmount.toLocaleString("zh-CN")}</span>}
      </div>
    </div>
  )
}

/** 售出 TOP10（横向条形图；条形按排名循环色板区分；口径可切 今日/近7日/近30日） */
export function TemuSalesTop10({ data }: { data: TemuSalesTopRow[] }) {
  const [metric, setMetric] = React.useState("today")

  const rows = React.useMemo(() => {
    const pick = (r: TemuSalesTopRow) =>
      metric === "today"
        ? r.todaySalesVolume ?? 0
        : metric === "30d"
          ? r.last30DaysSalesVolume ?? 0
          : r.last7DaysSalesVolume ?? 0
    return [...data]
      .map((r) => ({
        name: r.productName?.trim() || `SKC ${r.skcId}`,
        value: pick(r),
        skcId: r.skcId,
        productSn: r.productSn,
        category: r.category,
        mainImageUrl: r.mainImageUrl,
        mainImageCosUrl: r.mainImageCosUrl,
        supplierPrice: r.supplierPrice,
      }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
  }, [data, metric])

  const config = { value: { label: "销量(件)" } } satisfies ChartConfig

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>售出 TOP10</CardTitle>
        <CardDescription>SKC 销量排行 · 悬停查看货号与预估销售额</CardDescription>
        <CardAction>
          <MetricToggle value={metric} onChange={setMetric} />
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {rows.length === 0 ? (
          <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">
            所选口径暂无数据（数据随官方 API 定时同步更新）
          </div>
        ) : (
          <ChartContainer config={config} className="h-[320px] w-full">
            <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }} barSize={18}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
              <XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={120}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: string) => (v.length > 9 ? `${v.slice(0, 9)}…` : v)}
              />
              <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<TopTooltip />} />
              <Bar dataKey="value" radius={4}>
                {rows.map((r, i) => (
                  <Cell key={r.skcId} fill={donutPalette[i % donutPalette.length]} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
