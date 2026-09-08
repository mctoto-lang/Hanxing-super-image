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
} from "recharts"
import { format } from "date-fns"
import { type DateRange } from "react-day-picker"
import { ArrowDown, ArrowUp } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { HistoryDateRangePicker } from "@/components/product-v2/history-date-range-picker"
import { cn } from "@/lib/utils"
import { getUsageBreakdownAction } from "@/server/actions/admin-stats"
import type {
  KpiPeriodStats,
  MemberUsageStats,
  ModelStat,
  ModuleStat,
  UsageBreakdown,
} from "@/server/services/member-stats-service"

/**
 * 成员管理数据面板（客户端图表）。
 *
 * - KPI（本月口径，环比上月）：成员总数 / 生图次数 / 积分消耗 / 成功率
 * - 趋势：近 7/30/90 天按日消耗（AI 生图 + AI 对话，分层面积图）
 * - 模块 / 模型消耗占比：环形图，支持日期范围筛选
 * - 成员消耗排行：分组柱状图（调用次数 / 消耗积分，从高到低），支持日期范围筛选
 */

/**
 * 彩色分类调色板（亮暗主题均可读的中明度色）：
 * 蓝 / 绿 / 琥珀 / 紫 / 玫红 / 青，与六个业务模块一一对应。
 */
const MODULE_COLORS = [
  "#3b82f6", // chart 蓝 —— AI 对话
  "#10b981", // 绿 —— 自由创作
  "#f59e0b", // 琥珀 —— 批量生图
  "#8b5cf6", // 紫 —— 商品图片
  "#f43f5e", // 玫红 —— 穿戴图片
  "#06b6d4", // 青 —— 样机渲染
]

/** 积分数值展示（最多 1 位小数，千分位） */
function fmtCredits(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString("zh-CN", {
    maximumFractionDigits: 1,
  })
}

function ChartEmpty({ text }: { text: string }) {
  return (
    <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}

/** 模块占比 Tooltip：模块总消耗 + 该模块消耗 Top5 成员 */
function ModulePieTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: ModuleStat }>
}) {
  if (!active || !payload?.length) return null
  const d = payload[0]!.payload
  return (
    <div className="min-w-48 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md">
      <p className="text-sm font-medium">{d.label}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        消耗 <span className="font-medium text-foreground">{fmtCredits(d.credits)}</span> 积分
      </p>
      {d.topUsers.length > 0 ? (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-muted-foreground">消耗最多的成员</p>
          {d.topUsers.map((u, i) => (
            <div key={`${u.name}-${i}`} className="flex items-center justify-between gap-4 text-xs">
              <span className="min-w-0 truncate">
                {i + 1}. {u.name}
              </span>
              <span className="tabular-nums">{fmtCredits(u.credits)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 模型占比 Tooltip：模型总消耗 + 调用次数 */
function ModelPieTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: ModelStat }>
}) {
  if (!active || !payload?.length) return null
  const d = payload[0]!.payload
  return (
    <div className="min-w-44 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-md">
      <p className="text-sm font-medium">{d.label}</p>
      <p className="mt-1 text-muted-foreground">
        消耗 <span className="font-medium text-foreground">{fmtCredits(d.credits)}</span> 积分 ·
        调用 <span className="font-medium text-foreground">{d.calls.toLocaleString("zh-CN")}</span> 次
      </p>
    </div>
  )
}

/** 环比百分比（上期 <= 0 时无意义，返回 null） */
function pctDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null
  return ((current - previous) / previous) * 100
}

/** 指标卡右上角的环比徽章：上涨绿 / 下跌红；delta 为 null 时不渲染 */
function DeltaBadge({
  delta,
  format: formatDelta = (d) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`,
}: {
  delta: number | null
  format?: (delta: number) => string
}) {
  if (delta === null) return null
  const up = delta >= 0
  return (
    <Badge
      className={
        up
          ? "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : "border-transparent bg-rose-500/15 text-rose-600 dark:text-rose-400"
      }
    >
      {up ? <ArrowUp /> : <ArrowDown />}
      {formatDelta(delta)}
    </Badge>
  )
}

/** 指标卡数值下方的趋势行："较上月 ±N"，上期无数据时提示 */
function DeltaTrend({
  current,
  previous,
  formatValue,
}: {
  current: number
  previous: number
  formatValue: (n: number) => string
}) {
  if (previous <= 0) return <>上月无数据</>
  const diff = current - previous
  const up = diff >= 0
  return (
    <>
      较上月 {up ? "+" : "−"}
      {formatValue(Math.abs(diff))}
      {up ? (
        <ArrowUp className="size-3" />
      ) : (
        <ArrowDown className="size-3" />
      )}
    </>
  )
}

/** 指标卡：标题 + 右上徽章 + 大数值 + 趋势行 + 灰色说明 */
function MetricCard({
  title,
  value,
  unit,
  badge,
  trend,
  description,
}: {
  title: string
  value: string
  unit?: string
  badge?: React.ReactNode
  trend?: React.ReactNode
  description: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="text-xs">{title}</CardDescription>
        {badge ? <CardAction>{badge}</CardAction> : null}
      </CardHeader>
      <CardContent className="pt-0">
        <div className="text-2xl font-semibold tabular-nums">
          {value}
          {unit ? (
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              {unit}
            </span>
          ) : null}
        </div>
        {trend ? (
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            {trend}
          </p>
        ) : null}
        <p className="mt-0.5 text-xs text-muted-foreground/70">{description}</p>
      </CardContent>
    </Card>
  )
}

/** 成功率（已结束请求口径：生图 completed/(completed+failed)，对话同口径含 stopped） */
function successRate(kpi: KpiPeriodStats): number | null {
  const total = kpi.imageTotal + kpi.chatTotal
  if (total <= 0) return null
  return ((kpi.imageCompleted + kpi.chatCompleted) / total) * 100
}

/** 趋势图时间范围（分段控件，客户端切换 90 天序列切片） */
const TREND_RANGES = [
  { value: "7d", label: "近 7 天", days: 7 },
  { value: "30d", label: "近 30 天", days: 30 },
  { value: "90d", label: "近 90 天", days: 90 },
] as const

type TrendRange = (typeof TREND_RANGES)[number]["value"]

/**
 * 明细卡（模块 / 模型 / 成员）共用逻辑：独立日期范围 + 范围变化时
 * 拉取明细。初始数据为服务端渲染的近 30 天窗口。
 */
function useBreakdownCard(initial: UsageBreakdown, defaultRange: DateRange) {
  const [range, setRange] = React.useState<DateRange | undefined>(defaultRange)
  const [breakdown, setBreakdown] = React.useState(initial)
  const [pending, setPending] = React.useState(false)
  const handleRangeChange = React.useCallback(
    (next: DateRange | undefined) => {
      setRange(next)
      if (!next?.from || !next.to) return
      const from = format(next.from, "yyyy-MM-dd")
      const to = format(next.to, "yyyy-MM-dd")
      if (from > to) return
      setPending(true)
      getUsageBreakdownAction({ from, to })
        .then(setBreakdown)
        .catch(() => toast.error("消耗明细加载失败，请重试"))
        .finally(() => setPending(false))
    },
    [],
  )
  return { range, handleRangeChange, breakdown, pending }
}

export function MemberStatsPanel({ data }: { data: MemberUsageStats }) {
  const cur = data.monthKpi
  const prev = data.prevMonthKpi
  const curRate = successRate(cur)
  const prevRate = successRate(prev)

  // 趋势分层面积图：AI 生图前层（深灰）、AI 对话后层（浅灰），主题灰阶调色板
  const trendConfig = {
    imageCredits: { label: "AI 生图", color: "var(--chart-2)" },
    chatCredits: { label: "AI 对话", color: "var(--chart-1)" },
  } satisfies ChartConfig

  const [trendRange, setTrendRange] = React.useState<TrendRange>("30d")
  const activeRange =
    TREND_RANGES.find((r) => r.value === trendRange) ?? TREND_RANGES[1]!
  const trendData = data.trend.slice(-activeRange.days)
  const rangeTotal = trendData.reduce(
    (sum, d) => sum + d.imageCredits + d.chatCredits,
    0,
  )
  const trendHasData = data.trend.some(
    (d) => d.imageCredits > 0 || d.chatCredits > 0,
  )

  // 明细卡默认范围：近 30 天（由服务端 90 天趋势日键推导，与初始数据窗口一致）
  const defaultBreakdownRange = React.useMemo<DateRange>(() => {
    const days = data.trend.map((t) => t.day)
    const toKey = days.at(-1) ?? format(new Date(), "yyyy-MM-dd")
    const fromKey = days.at(-30) ?? toKey
    return {
      from: new Date(`${fromKey}T00:00:00`),
      to: new Date(`${toKey}T00:00:00`),
    }
  }, [data.trend])

  const moduleCard = useBreakdownCard(data.breakdown, defaultBreakdownRange)
  const modelCard = useBreakdownCard(data.breakdown, defaultBreakdownRange)
  const rankCard = useBreakdownCard(data.breakdown, defaultBreakdownRange)

  const modules = moduleCard.breakdown.modules
  const pieTotal = modules.reduce((sum, m) => sum + m.credits, 0)
  const pieConfig = Object.fromEntries(
    modules.map((m, i) => [
      m.label,
      { label: m.label, color: MODULE_COLORS[i % MODULE_COLORS.length] },
    ]),
  ) satisfies ChartConfig

  // 模型环形图：消耗 Top 7 + 其余合并为“其他”
  const modelSlices = React.useMemo(() => {
    const list = modelCard.breakdown.models
    const top = list.slice(0, 7)
    const rest = list.slice(7)
    const restCredits = rest.reduce((sum, m) => sum + m.credits, 0)
    if (restCredits <= 0) return top
    return [
      ...top,
      {
        key: "__other__",
        label: `其他（${rest.length} 个模型）`,
        credits: restCredits,
        calls: rest.reduce((sum, m) => sum + m.calls, 0),
      },
    ]
  }, [modelCard.breakdown.models])
  const modelPieTotal = modelSlices.reduce((sum, m) => sum + m.credits, 0)
  const modelPieConfig = Object.fromEntries(
    modelSlices.map((m, i) => [
      m.label,
      { label: m.label, color: MODULE_COLORS[i % MODULE_COLORS.length] },
    ]),
  ) satisfies ChartConfig

  // 成员排行分组柱状图（shadcn Bar Chart - Multiple 模板配色）
  const rankConfig = {
    calls: { label: "调用次数", color: "var(--chart-1)" },
    credits: { label: "消耗积分", color: "var(--chart-2)" },
  } satisfies ChartConfig
  const rankTotals = rankCard.breakdown.topUsers.reduce(
    (acc, u) => ({
      calls: acc.calls + u.calls,
      credits: acc.credits + u.credits,
    }),
    { calls: 0, credits: 0 },
  )

  return (
    <div className="space-y-4">
      {/* KPI 行（本月口径，环比上月） */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="成员总数"
          value={data.memberTotal.toLocaleString("zh-CN")}
          unit="人"
          badge={
            data.newMembersThisMonth > 0 ? (
              <Badge className="border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <ArrowUp />+{data.newMembersThisMonth}
              </Badge>
            ) : undefined
          }
          trend={
            <>
              本月新增 {data.newMembersThisMonth} 人
              {data.newMembersThisMonth > 0 ? (
                <ArrowUp className="size-3" />
              ) : null}
            </>
          }
          description={`活跃 ${data.memberActive} · 禁用 ${data.memberDisabled}`}
        />
        <MetricCard
          title="生图次数"
          value={cur.imageCount.toLocaleString("zh-CN")}
          unit="次"
          badge={<DeltaBadge delta={pctDelta(cur.imageCount, prev.imageCount)} />}
          trend={
            <DeltaTrend
              current={cur.imageCount}
              previous={prev.imageCount}
              formatValue={(n) => `${n.toLocaleString("zh-CN")} 次`}
            />
          }
          description="全部生图任务 · 含排队与处理中"
        />
        <MetricCard
          title="积分消耗"
          value={fmtCredits(cur.credits)}
          unit="积分"
          badge={<DeltaBadge delta={pctDelta(cur.credits, prev.credits)} />}
          trend={
            <DeltaTrend
              current={cur.credits}
              previous={prev.credits}
              formatValue={(n) => `${fmtCredits(n)} 积分`}
            />
          }
          description="生图 + AI 对话"
        />
        <MetricCard
          title="成功率"
          value={curRate === null ? "—" : curRate.toFixed(1)}
          unit={curRate === null ? undefined : "%"}
          badge={
            curRate !== null && prevRate !== null ? (
              <DeltaBadge
                delta={curRate - prevRate}
                format={(d) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`}
              />
            ) : undefined
          }
          trend={
            curRate !== null && prevRate !== null ? (
              <DeltaTrend
                current={curRate}
                previous={prevRate}
                formatValue={(n) => `${n.toFixed(1)} 个百分点`}
              />
            ) : curRate !== null ? (
              <>上月无数据</>
            ) : undefined
          }
          description={`生图 ${cur.imageCompleted}/${cur.imageTotal} · 对话 ${cur.chatCompleted}/${cur.chatTotal}（已结束请求）`}
        />
      </div>

      {/* 积分消耗趋势（分层面积图 + 时间范围切换） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">积分消耗趋势</CardTitle>
          <CardDescription>
            近 {activeRange.days} 天总消耗 {fmtCredits(rangeTotal)} 积分
          </CardDescription>
          <CardAction>
            <Tabs
              value={trendRange}
              onValueChange={(v) => {
                if (typeof v === "string") setTrendRange(v as TrendRange)
              }}
            >
              <TabsList>
                {TREND_RANGES.map((r) => (
                  <TabsTrigger key={r.value} value={r.value} className="px-2 text-xs">
                    {r.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </CardAction>
        </CardHeader>
        <CardContent>
          {trendHasData ? (
            <ChartContainer config={trendConfig} className="h-[300px] w-full">
              <AreaChart data={trendData} margin={{ left: 8, right: 8, top: 4 }}>
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={10}
                  minTickGap={32}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <ChartTooltip
                  cursor={{ stroke: "var(--border)" }}
                  content={<ChartTooltipContent indicator="line" />}
                />
                <Area
                  dataKey="imageCredits"
                  type="monotone"
                  stroke="var(--color-imageCredits)"
                  strokeWidth={2}
                  fill="var(--color-imageCredits)"
                  fillOpacity={0.4}
                />
                <Area
                  dataKey="chatCredits"
                  type="monotone"
                  stroke="var(--color-chatCredits)"
                  strokeWidth={2}
                  fill="var(--color-chatCredits)"
                  fillOpacity={0.4}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <ChartEmpty text="近 90 天暂无消耗" />
          )}
        </CardContent>
      </Card>

      {/* 模块消耗占比 + 模型消耗占比（各自独立日期筛选） */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">模块消耗占比</CardTitle>
            <CardDescription>悬浮查看各模块消耗 Top5 成员</CardDescription>
            <CardAction>
              <HistoryDateRangePicker
                size="sm"
                value={moduleCard.range}
                onChange={moduleCard.handleRangeChange}
              />
            </CardAction>
          </CardHeader>
          <CardContent
            className={cn(
              "transition-opacity",
              moduleCard.pending && "opacity-60",
            )}
          >
            {pieTotal > 0 ? (
              <ChartContainer config={pieConfig} className="mx-auto h-[240px] w-full">
                <PieChart>
                  <ChartTooltip content={<ModulePieTooltip />} />
                  <Pie
                    data={modules}
                    dataKey="credits"
                    nameKey="label"
                    innerRadius={48}
                    outerRadius={76}
                    paddingAngle={2}
                    strokeWidth={2}
                  >
                    {modules.map((m, i) => (
                      <Cell key={m.key} fill={MODULE_COLORS[i % MODULE_COLORS.length]} />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="label" />} />
                </PieChart>
              </ChartContainer>
            ) : (
              <ChartEmpty text="该时间范围暂无消耗" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">模型消耗占比</CardTitle>
            <CardDescription>按 AI 模型统计生图与对话消耗</CardDescription>
            <CardAction>
              <HistoryDateRangePicker
                size="sm"
                value={modelCard.range}
                onChange={modelCard.handleRangeChange}
              />
            </CardAction>
          </CardHeader>
          <CardContent
            className={cn(
              "transition-opacity",
              modelCard.pending && "opacity-60",
            )}
          >
            {modelPieTotal > 0 ? (
              <ChartContainer
                config={modelPieConfig}
                className="mx-auto h-[240px] w-full"
              >
                <PieChart>
                  <ChartTooltip content={<ModelPieTooltip />} />
                  <Pie
                    data={modelSlices}
                    dataKey="credits"
                    nameKey="label"
                    innerRadius={48}
                    outerRadius={76}
                    paddingAngle={2}
                    strokeWidth={2}
                  >
                    {modelSlices.map((m, i) => (
                      <Cell
                        key={m.key}
                        fill={MODULE_COLORS[i % MODULE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="label" />} />
                </PieChart>
              </ChartContainer>
            ) : (
              <ChartEmpty text="该时间范围暂无模型调用" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* 成员消耗排行（分组柱状图：调用次数 / 消耗积分，独立一行） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">成员消耗排行</CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>所选范围消耗 Top 10</span>
            <span className="flex items-center gap-1">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: "var(--chart-1)" }}
              />
              调用次数
            </span>
            <span className="flex items-center gap-1">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: "var(--chart-2)" }}
              />
              消耗积分
            </span>
          </CardDescription>
          <CardAction>
            <HistoryDateRangePicker
              size="sm"
              value={rankCard.range}
              onChange={rankCard.handleRangeChange}
            />
          </CardAction>
        </CardHeader>
        <CardContent
          className={cn("transition-opacity", rankCard.pending && "opacity-60")}
        >
          {rankCard.breakdown.topUsers.length > 0 ? (
            <ChartContainer config={rankConfig} className="h-[280px] w-full">
              <BarChart accessibilityLayer data={rankCard.breakdown.topUsers}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  tickMargin={10}
                  axisLine={false}
                  tickFormatter={(v: string) =>
                    v.length > 6 ? `${v.slice(0, 6)}…` : v
                  }
                />
                <ChartTooltip
                  cursor={false}
                  content={<ChartTooltipContent indicator="dashed" />}
                />
                <Bar dataKey="calls" fill="var(--color-calls)" radius={4} barSize={24} />
                <Bar dataKey="credits" fill="var(--color-credits)" radius={4} barSize={24} />
              </BarChart>
            </ChartContainer>
          ) : (
            <ChartEmpty text="该时间范围暂无消耗" />
          )}
        </CardContent>
        <CardFooter className="flex-col items-start gap-2 text-sm">
          <div className="flex gap-2 font-medium leading-none">
            Top 10 合计 {rankTotals.calls.toLocaleString("zh-CN")} 次调用 ·{" "}
            {fmtCredits(rankTotals.credits)} 积分
          </div>
          <div className="leading-none text-muted-foreground">
            按消耗积分从高到低排序
          </div>
        </CardFooter>
      </Card>
    </div>
  )
}
