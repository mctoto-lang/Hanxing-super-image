"use client"

import * as React from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"

/**
 * 平台数据看板图表（shadcn chart + recharts，客户端组件）。
 *
 * 数据由服务端聚合后以普通数组传入；配色使用主题 chart-1..5 CSS 变量，
 * 自动适配暗色模式。
 */

/** 近 30 天趋势面积图（任务数 + 完成数双序列） */
export function TrendAreaChart({
  data,
  emptyText = "近 30 天暂无数据",
}: {
  data: Array<{ day: string; taskCount: number; completedCount: number }>
  emptyText?: string
}) {
  const config = {
    taskCount: { label: "任务数", color: "var(--chart-1)" },
    completedCount: { label: "完成数", color: "var(--chart-2)" },
  } satisfies ChartConfig

  if (data.length === 0) {
    return (
      <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    )
  }

  return (
    <ChartContainer config={config} className="h-[240px] w-full">
      <AreaChart data={data} margin={{ left: 4, right: 8 }}>
        <defs>
          <linearGradient id="fillTask" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor="var(--color-taskCount)"
              fillOpacity={0.6}
            />
            <stop
              offset="95%"
              stopColor="var(--color-taskCount)"
              fillOpacity={0.05}
            />
          </linearGradient>
          <linearGradient id="fillCompleted" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor="var(--color-completedCount)"
              fillOpacity={0.5}
            />
            <stop
              offset="95%"
              stopColor="var(--color-completedCount)"
              fillOpacity={0.05}
            />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(v: string) => v.slice(5)}
        />
        <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area
          dataKey="taskCount"
          type="monotone"
          stroke="var(--color-taskCount)"
          fill="url(#fillTask)"
          stackId="a"
        />
        <Area
          dataKey="completedCount"
          type="monotone"
          stroke="var(--color-completedCount)"
          fill="url(#fillCompleted)"
          stackId="a"
        />
        <ChartLegend content={<ChartLegendContent />} />
      </AreaChart>
    </ChartContainer>
  )
}

/** 分布环形图（状态 / 任务类型等） */
export function DistributionPieChart({
  data,
  emptyText = "暂无数据",
}: {
  data: Array<{ label: string; value: number }>
  emptyText?: string
}) {
  const palette = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
  ]
  const config = Object.fromEntries(
    data.slice(0, 5).map((d, i) => [
      d.label,
      { label: d.label, color: palette[i % palette.length] },
    ]),
  ) satisfies ChartConfig
  const total = data.reduce((sum, d) => sum + d.value, 0)

  if (total === 0) {
    return (
      <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    )
  }

  return (
    <ChartContainer config={config} className="mx-auto h-[240px] w-full">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Pie
          data={data}
          dataKey="value"
          nameKey="label"
          innerRadius={48}
          outerRadius={80}
          paddingAngle={2}
          strokeWidth={2}
        >
          {data.map((d, i) => (
            <Cell key={d.label} fill={palette[i % palette.length]} />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent nameKey="label" />} />
      </PieChart>
    </ChartContainer>
  )
}

/** 使用排行横向条形图（模型 Top N） */
export function RankingBarChart({
  data,
  emptyText = "暂无数据",
}: {
  data: Array<{ name: string; value: number }>
  emptyText?: string
}) {
  const config = {
    value: { label: "调用次数", color: "var(--chart-1)" },
  } satisfies ChartConfig

  if (data.length === 0) {
    return (
      <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    )
  }

  return (
    <ChartContainer config={config} className="h-[280px] w-full">
      <BarChart
        data={data}
        layout="vertical"
        margin={{ left: 8, right: 16 }}
        barSize={16}
      >
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: string) =>
            v.length > 8 ? `${v.slice(0, 8)}…` : v
          }
        />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="value" fill="var(--color-value)" radius={4} />
      </BarChart>
    </ChartContainer>
  )
}
