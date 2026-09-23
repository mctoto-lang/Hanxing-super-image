"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
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
import { cn } from "@/lib/utils"
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
  TemuAdsEffect,
} from "@/server/actions/temu"

/**
 * Temu 面板概览组件：店铺切换下拉、类目占比、售出 TOP10、广告效果。
 * 趋势图与顶部卡片用 dashboard-01 真源组件
 * （@/components/chart-area-interactive、@/components/section-cards）。
 */

const ALL_STORES = "__all__"

/** 店铺切换下拉（URL 驱动：选值跳转 /temu?tab=&store=，保持服务端渲染数据流）。
 *  items 供 SelectValue 显示中文标签——不传时 base-ui 会显示原始 value（UUID） */
export function TemuStoreSelect({
  tab,
  current,
  stores,
}: {
  tab: string
  current?: string
  stores: { id: string; name: string }[]
}) {
  const router = useRouter()
  const items = [
    { value: ALL_STORES, label: "全部店铺" },
    ...stores.map((s) => ({ value: s.id, label: s.name })),
  ]
  return (
    <Select
      items={items}
      value={current || ALL_STORES}
      onValueChange={(v) => {
        const p = new URLSearchParams({ tab })
        if (v && v !== ALL_STORES) p.set("store", v)
        router.push(`/temu?${p.toString()}`)
      }}
    >
      <SelectTrigger size="sm" className="w-44" aria-label="切换店铺">
        <SelectValue placeholder="全部店铺" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_STORES}>全部店铺</SelectItem>
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

/** 售出类目占比（环形图，top5 + 其他；口径可切 今日/近7日/近30日） */
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
    const sorted = [...data].sort((a, b) => pick(b) - pick(a))
    const top = sorted.slice(0, 5).map((d) => ({ label: d.category, value: pick(d) }))
    const rest = sorted.slice(5).reduce((s, d) => s + pick(d), 0)
    if (rest > 0) top.push({ label: "其他", value: rest })
    return top.map((s, i) => ({
      ...s,
      color: s.label === "其他" ? "var(--muted)" : donutPalette[i % donutPalette.length],
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, metric])

  const config = Object.fromEntries(
    slices.map((s) => [s.label, { label: s.label, color: s.color }]),
  ) satisfies ChartConfig

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>售出类目占比</CardTitle>
        <CardDescription>销售管理最新批次 · 按类目汇总销量</CardDescription>
        <CardAction>
          <MetricToggle value={metric} onChange={setMetric} />
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {total === 0 ? (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
            所选口径暂无数据（插件上报后自动出现）
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
                paddingAngle={2}
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
            所选口径暂无数据（插件上报后自动出现）
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

// ---------- 广告效果 ----------

/** 广告效果：近 7 日花费/GMV/ROI 摘要 + 近 14 日每日花费迷你条形图 */
export function TemuAdsEffectCard({ effect }: { effect: TemuAdsEffect }) {
  const config = { spend: { label: "广告花费(元)", color: "var(--chart-1)" } } satisfies ChartConfig
  const { last7 } = effect
  const hasDays = effect.days.some((d) => d.adSpend > 0)

  return (
    // 图表固定 208px：卡片自然高度与同行转化漏斗卡完全贴合（实测内容均到
    // 346px），两卡等高、互不撑出底部空白（flex-1 方案会让图表失控长高）
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>广告效果</CardTitle>
        <CardDescription>近 7 日推广日报 · 近 7 日每日花费</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="text-xs text-muted-foreground">花费（近7日）</div>
            <div className="text-lg font-semibold tabular-nums">¥{last7.adSpend.toLocaleString("zh-CN")}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">广告 GMV（近7日）</div>
            <div className="text-lg font-semibold tabular-nums">¥{last7.gmv.toLocaleString("zh-CN")}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">ROI（近7日）</div>
            <div
              className={cn(
                "text-lg font-semibold tabular-nums",
                last7.roi == null ? "text-muted-foreground" : last7.roi >= 1 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
              )}
            >
              {last7.roi == null ? "—" : `${last7.roi.toFixed(2)}x`}
            </div>
          </div>
        </div>
        {hasDays ? (
          <ChartContainer config={config} className="h-[208px] w-full">
            <BarChart data={effect.days} margin={{ top: 4, left: 4, right: 4, bottom: 0 }} barSize={18}>
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                interval={0}
                minTickGap={8}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <ChartTooltip
                cursor={{ fill: "var(--muted)" }}
                content={
                  <ChartTooltipContent
                    hideLabel
                    formatter={(value, name) => [`¥${Number(value).toLocaleString("zh-CN")}`, name]}
                    labelFormatter={(v) => String(v)}
                  />
                }
              />
              {/* 数据字段为 adSpend（此前误写 spend 导致柱形全部不渲染，只剩坐标轴刻度） */}
              <Bar dataKey="adSpend" fill="var(--color-spend)" radius={4} />
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="flex h-[208px] items-center justify-center text-sm text-muted-foreground">
            暂无广告数据（插件在 ads.temu.com 采集后自动出现）
          </div>
        )}
      </CardContent>
    </Card>
  )
}
