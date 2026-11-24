"use client"

import * as React from "react"
import { format } from "date-fns"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { DashRing } from "@/components/ui/dash-ring"
import { compactNumber, formatPrice } from "@/components/selection/labels"
import { trendColumns, trendSeries, type MonitorSnapshot } from "@/components/selection/monitor/monitor-metrics"
import { cn } from "@/lib/utils"

/**
 * 监控趋势：按重抓批次展开的关键指标折线（指标可切换）+ 历史明细表。
 * 每个平台只列自己有数据的序列；名次类（BSR）越低越好，轴方向不做反转，
 * 在图例文案里注明。
 */

export type TrendPoint = MonitorSnapshot & { date: string }

const chartConfig = {
  value: { label: "数值", color: "var(--chart-1)" },
} satisfies ChartConfig

function tickDate(v: string): string {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : format(d, "MM-dd HH:mm")
}

export function MonitorTrend({
  platform,
  currency,
  points,
  loading,
}: {
  platform: string
  currency: string | null
  points: TrendPoint[]
  loading: boolean
}) {
  const { dates, series } = React.useMemo(() => trendSeries(platform, points), [platform, points])
  const [activeKey, setActiveKey] = React.useState<string | null>(null)
  React.useEffect(() => setActiveKey(null), [platform])

  const active = series.find((s) => s.key === activeKey) ?? series[0] ?? null
  const columns = trendColumns(platform)

  if (loading && points.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <DashRing className="size-3.5" /> 趋势加载中…
      </p>
    )
  }
  // 同一目标多次重抓才有趋势；单点只显示明细
  if (points.length < 2) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {points.length === 0
            ? "暂无历史数据（首轮抓取完成后自动积累；仅评论追踪的目标无指标趋势，评论见「评论洞察」）。"
            : "已抓取 1 次，再抓取一次即可看到趋势。"}
        </p>
        {points.length === 1 ? <HistoryTable platform={platform} currency={currency} points={points} columns={columns} /> : null}
      </div>
    )
  }

  const data = dates.map((d, i) => ({ date: tickDate(d), value: active?.values[i] ?? null }))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {series.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={s.key === active?.key}
            className={cn(
              "rounded-md px-2 py-0.5 text-[11px] transition-colors",
              s.key === active?.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setActiveKey(s.key)}
          >
            {s.label}
          </button>
        ))}
        {active?.key === "rank" ? (
          <span className="text-[11px] text-muted-foreground">BSR 越小排名越靠前</span>
        ) : null}
      </div>

      <ChartContainer config={chartConfig} className="h-48 w-full aspect-auto">
        <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={36} tickMargin={8} fontSize={11} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={46}
            fontSize={11}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => compactNumber(v)}
          />
          <ChartTooltip content={<ChartTooltipContent hideLabel />} />
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--color-value)"
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive={false}
            connectNulls={false}
          />
        </LineChart>
      </ChartContainer>

      <HistoryTable platform={platform} currency={currency} points={points} columns={columns} />
    </div>
  )
}

function cellValue(
  platform: string,
  key: keyof MonitorSnapshot,
  p: TrendPoint,
  currency: string | null,
): string {
  const v = p[key]
  if (v == null) return "—"
  if (key === "price") return formatPrice(Number(v), currency)
  if (key === "rating") return Number(v).toFixed(1)
  if (key === "rank") return `#${v}`
  return compactNumber(Number(v))
}

function HistoryTable({
  platform,
  currency,
  points,
  columns,
}: {
  platform: string
  currency: string | null
  points: TrendPoint[]
  columns: Array<{ key: keyof MonitorSnapshot; label: string }>
}) {
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted/80 backdrop-blur">
          <tr className="text-left text-muted-foreground">
            <th className="px-2 py-1.5 font-medium">抓取时间</th>
            {columns.map((c) => (
              <th key={c.key} className="px-2 py-1.5 font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...points].reverse().map((p, i) => (
            <tr key={p.date + i} className="border-t tabular-nums">
              <td className="whitespace-nowrap px-2 py-1.5">{format(new Date(p.date), "yyyy-MM-dd HH:mm")}</td>
              {columns.map((c) => (
                <td key={c.key} className="px-2 py-1.5">
                  {cellValue(platform, c.key, p, currency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
