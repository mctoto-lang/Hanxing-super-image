"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts"
import { TrendingUp } from "lucide-react"
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
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  updateTemuStoreAction,
  resetTemuStoreTokenAction,
  toggleTemuStoreAction,
  deleteTemuStoreAction,
  clearTemuStoreDataAction,
  confirmDiscoveredStoreAction,
  reorderTemuStoresAction,
  getTemuProductsPageAction,
  type TemuStoreBrief,
  type TemuCategoryShare,
  type TemuSalesTopRow,
  type TemuAdsEffect,
  type TemuProductRow,
  type TemuProductSalesInfo,
} from "@/server/actions/temu"
import { useDragSort, DragHandle } from "@/hooks/use-drag-sort"

/**
 * Temu 面板客户端组件：类目占比、售出 TOP10、广告效果、店铺切换下拉
 * + 店铺管理（发现-确认-同步）。趋势图与顶部卡片用 dashboard-01
 * 真源组件（@/components/chart-area-interactive、@/components/section-cards）。
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

// ---------- 商品销量趋势弹层（商品信息页"七日销量"列悬停图标） ----------

/** 日销量序列点 */
export type SalesSeriesPoint = { day: string; value: number }

const trendConfig = { value: { label: "日销量", color: "var(--chart-1)" } } satisfies ChartConfig

/**
 * 销量趋势图标：悬停在上方弹出近 7 天/近 30 天日销量趋势（temu_sales_overview
 * 分日最后批次的 todaySalesVolume）。无序列时由调用方不渲染本组件（纯数字）。
 * 蓝色（chart-1）趋势线/渐变/数据点——深浅色主题下均清晰。
 */
export function ProductSalesTrendPopover({ series }: { series: SalesSeriesPoint[] }) {
  const [open, setOpen] = React.useState(false)
  const [range, setRange] = React.useState("7d")
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }
  React.useEffect(() => cancelClose, [])

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - (range === "7d" ? 7 : 30))
  const cutoffStr = cutoff.toLocaleDateString("sv-SE")
  const points = series.filter((p) => p.day >= cutoffStr)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon" className="size-6" aria-label="悬停查看销量趋势" />
        }
        onMouseEnter={() => {
          cancelClose()
          setOpen(true)
        }}
        onMouseLeave={scheduleClose}
      >
        <TrendingUp className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={8}
        className="w-96 p-4"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">日销量趋势（件）</span>
          <ToggleGroup
            multiple={false}
            value={[range]}
            onValueChange={(v: string[]) => setRange(v[0] ?? "7d")}
            variant="outline"
            size="sm"
            spacing={0}
          >
            <ToggleGroupItem value="7d">近7天</ToggleGroupItem>
            <ToggleGroupItem value="30d">近30天</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="mt-2">
          {points.length === 0 ? (
            <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
              暂无数据
            </div>
          ) : (
            <ChartContainer config={trendConfig} className="h-[180px] w-full">
              {/* 左右各留 20px：首末数据点贴绘图区边缘时，居中的日期刻度与
                  末端 activeDot 会溢出 SVG 被裁（"09-1…"截断的根因） */}
              <AreaChart data={points} margin={{ top: 8, left: 20, right: 20, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillProductTrend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                {/* 点数少时（如仅 2 天数据）强制逐点显示日期刻度——默认的
                    minTickGap 间隔裁剪会把左端点的日期吞掉，只剩右端有日期 */}
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={points.length <= 8 ? 0 : 30}
                  interval={points.length <= 8 ? 0 : undefined}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      hideLabel
                      indicator="dot"
                      formatter={(value) => [`${Number(value).toLocaleString("zh-CN")} 件`, "日销量"]}
                    />
                  }
                />
                <Area
                  dataKey="value"
                  type="natural"
                  stroke="var(--color-value)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "var(--color-value)", stroke: "var(--background)", strokeWidth: 2 }}
                  fill="url(#fillProductTrend)"
                />
              </AreaChart>
            </ChartContainer>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 商品信息在售状态筛选下拉（URL 驱动 sale=on/off，与切店下拉同交互） */
export function TemuProductsSaleFilter({
  current,
  store,
  q,
}: {
  current?: string
  store?: string
  q?: string
}) {
  const router = useRouter()
  // "全部"用哨兵 sale=all 显式携带：URL 无 sale 参数时页面缺省"在售"
  const ALL = "all"
  const items = [
    { value: ALL, label: "全部在售状态" },
    { value: "on", label: "在售" },
    { value: "off", label: "不在售" },
  ]
  return (
    <Select
      items={items}
      value={current === "on" || current === "off" ? current : ALL}
      onValueChange={(v) => {
        const p = new URLSearchParams({ tab: "products" })
        if (store) p.set("store", store)
        if (q) p.set("q", q)
        if (v) p.set("sale", v)
        router.push(`/temu?${p.toString()}`)
      }}
    >
      <SelectTrigger className="h-9 w-32" aria-label="在售状态筛选">
        <SelectValue placeholder="全部在售状态" />
      </SelectTrigger>
      <SelectContent>
        {items.map((it) => (
          <SelectItem key={it.value} value={it.value}>
            {it.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------- 商品信息无限滚动表格 ----------

/** 商品名单元格：前 10 字符截断，超长时 Tooltip 显示全名（短文本不弹冗余提示） */
export function ProductNameCell({ name }: { name: string | null }) {
  if (!name) return <span className="text-muted-foreground">—</span>
  if (name.length <= 10) return <span>{name}</span>
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="cursor-default text-left">{`${name.slice(0, 10)}…`}</TooltipTrigger>
        <TooltipContent className="max-w-72 break-all">{name}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const PRODUCTS_PAGE_SIZE = 20

/**
 * 商品信息无限滚动表格：首屏 20 条由服务端渲染，滚动到底（哨兵 + IntersectionObserver
 * 预载 200px）自动调用组合 action 追加下一页；按 id 去重，销量/趋势信息浅合并；
 * 取回不足一页即"已全部加载"。表头 sticky 吸顶（滚动容器在页侧 CardContent）。
 */
/** 可售天数圆环：进度 = min(天数/15, 100%)；≥15 天蓝（满环）、10-15 绿、5-10 黄、<5 红 */
function SaleDaysRing({ days }: { days: number | null }) {
  if (days == null) return <span className="text-muted-foreground">—</span>
  const pct = Math.min(days / 15, 1)
  const r = 9
  const c = 2 * Math.PI * r
  const color =
    days >= 15 ? "var(--chart-2)" : days >= 10 ? "var(--chart-5)" : days >= 5 ? "#eab308" : "#ef4444"
  const text = days >= 15 ? "text-sky-600 dark:text-sky-400" : days >= 10 ? "text-emerald-600 dark:text-emerald-400" : days >= 5 ? "text-yellow-600 dark:text-yellow-400" : "text-red-600 dark:text-red-400"
  return (
    <span className="relative inline-flex size-7 items-center justify-center" title={`可售天数 ${days} 天`}>
      <svg viewBox="0 0 24 24" className="size-7 -rotate-90">
        <circle cx="12" cy="12" r={r} fill="none" stroke="var(--muted)" strokeWidth="3" />
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
        />
      </svg>
      <span className={`absolute text-[9px] font-semibold tabular-nums ${text}`}>
        {days >= 100 ? "99+" : Math.round(days)}
      </span>
    </span>
  )
}

/** 平台库存单元格：数值 = 仓内可用 + 已发货，悬停 Tooltip 分解两项 */
function PlatformStockCell({
  warehouse,
  shipped,
}: {
  warehouse: number | null
  shipped: number | null
}) {
  const total = (warehouse ?? 0) + (shipped ?? 0)
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="cursor-default tabular-nums">{total}</TooltipTrigger>
        <TooltipContent className="text-xs">
          <div>仓内可用库存 {warehouse ?? 0}</div>
          <div>已发货库存 {shipped ?? 0}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function ProductsInfiniteTable({
  store,
  q,
  sale,
  initialRows,
  initialSalesInfo,
}: {
  store?: string
  q?: string
  sale?: "on" | "off"
  initialRows: TemuProductRow[]
  initialSalesInfo: TemuProductSalesInfo
}) {
  const [rows, setRows] = React.useState(initialRows)
  const [salesInfo, setSalesInfo] = React.useState(initialSalesInfo)
  const [loading, setLoading] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const sentinelRef = React.useRef<HTMLDivElement>(null)
  const loadingRef = React.useRef(false)
  const doneRef = React.useRef(false)
  const pageRef = React.useRef(1)

  const loadMore = React.useCallback(async () => {
    if (loadingRef.current || doneRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const next = pageRef.current + 1
      const r = await getTemuProductsPageAction(store, q, sale, next)
      setRows((prev) => {
        const seen = new Set(prev.map((x) => x.id))
        return prev.concat(r.rows.filter((x) => !seen.has(x.id)))
      })
      setSalesInfo((prev) => ({
        latest: { ...prev.latest, ...r.salesInfo.latest },
        series: { ...prev.series, ...r.salesInfo.series },
      }))
      pageRef.current = next
      if (r.rows.length < PRODUCTS_PAGE_SIZE) {
        doneRef.current = true
        setDone(true)
      }
    } catch {
      // 网络抖动等：静默结束本轮，滚动再触发重试
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [store, q, sale])

  React.useEffect(() => {
    const el = sentinelRef.current
    if (!el || done) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      { rootMargin: "200px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, done])

  return (
    <>
      <table className="w-full caption-bottom text-sm">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead>主图</TableHead>
            <TableHead>SKC</TableHead>
            <TableHead>商品名</TableHead>
            <TableHead>货号</TableHead>
            <TableHead className="text-right">申报价格</TableHead>
            <TableHead>在售</TableHead>
            <TableHead className="text-right">今日销量</TableHead>
            <TableHead className="text-right">七日销量</TableHead>
            <TableHead className="text-right">可售天数</TableHead>
            <TableHead className="text-right">平台库存</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const sales = salesInfo.latest[r.productSkcId]
            const series = salesInfo.series[r.productSkcId]
            const onSale = r.skcStatus === 11
            return (
              <TableRow key={r.id}>
                <TableCell>
                  {r.mainImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.mainImageUrl}
                      alt=""
                      className="size-10 rounded-md object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="size-10 rounded-md bg-muted" />
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.productSkcId}</TableCell>
                <TableCell>
                  <ProductNameCell name={r.productName} />
                </TableCell>
                <TableCell className="font-mono text-xs">{r.productSn ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.supplierPrice != null ? `¥${(r.supplierPrice / 100).toFixed(2)}` : "—"}
                </TableCell>
                <TableCell>
                  {onSale ? (
                    // 生命周期状态（价格申报中/已发布到站点等）收进在售徽章悬停展示
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger className="cursor-default">
                          <span className="rounded-sm bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                            在售
                          </span>
                        </TooltipTrigger>
                        {r.lifecycleStatus ? (
                          <TooltipContent className="text-xs">状态：{r.lifecycleStatus}</TooltipContent>
                        ) : (
                          <TooltipContent className="text-xs text-muted-foreground">暂无生命周期状态</TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger className="cursor-default">
                          <span className="rounded-sm bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                            未在售
                          </span>
                        </TooltipTrigger>
                        {r.lifecycleStatus ? (
                          <TooltipContent className="text-xs">状态：{r.lifecycleStatus}</TooltipContent>
                        ) : (
                          <TooltipContent className="text-xs text-muted-foreground">暂无生命周期状态</TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{sales?.todaySalesVolume ?? "—"}</TableCell>
                <TableCell className="text-right">
                  <span className="inline-flex items-center justify-end gap-0.5 tabular-nums">
                    {r.last7DaysSalesVolume ?? "—"}
                    {series && series.length > 0 && <ProductSalesTrendPopover series={series} />}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end">
                    <SaleDaysRing days={sales?.availableSaleDays ?? null} />
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <PlatformStockCell warehouse={sales?.warehouseAvailableStock ?? null} shipped={sales?.shippedStock ?? null} />
                </TableCell>
              </TableRow>
            )
          })}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={10} className="h-20 text-center text-sm text-muted-foreground">
                暂无数据：插件完成一轮采集上报后自动出现
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </table>
      <div ref={sentinelRef} className="py-4 text-center text-xs text-muted-foreground">
        {done ? `已全部加载 ${rows.length} 条` : loading ? "加载中…" : ""}
      </div>
    </>
  )
}

/** 流量曝光量单元格：数字悬停 Tooltip 拆分显示 搜索曝光量/推荐曝光量 */
export function FlowExposeCell({
  expose,
  searchExpose,
  recommendExpose,
}: {
  expose: number | null
  searchExpose: number | null
  recommendExpose: number | null
}) {
  const num = (v: number | null) => (v ?? 0).toLocaleString('zh-CN')
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className='cursor-default tabular-nums'>
          {(expose ?? 0).toLocaleString('zh-CN')}
        </TooltipTrigger>
        <TooltipContent className='text-xs'>
          <div>搜索曝光量：{num(searchExpose)}</div>
          <div>推荐曝光量：{num(recommendExpose)}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ---------- 店铺管理 ----------

type ActionResult = { ok: boolean; error?: string }

async function wrap<T>(fn: () => Promise<T>): Promise<ActionResult> {
  try {
    await fn()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) }
  }
}

export function TemuStoreManager({
  stores,
  discovered,
}: {
  stores: TemuStoreBrief[]
  discovered: { mallId: string; mallName: string | null; firstSeenAt: Date; lastSeenAt: Date }[]
}) {
  const [tokenShown, setTokenShown] = React.useState<{ name: string; token: string } | null>(null)
  const [result, setResult] = React.useState<ActionResult | null>(null)
  const [editing, setEditing] = React.useState<{ id: string; name: string; mallId: string; mallName: string } | null>(null)
  const [confirming, setConfirming] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  return (
    <div className="space-y-6">
      {/* 新 token 弹层（仅重置时展示一次） */}
      {tokenShown && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-background p-6 shadow-lg">
            <h3 className="text-lg font-semibold">「{tokenShown.name}」上报 Token</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              无需手动复制：插件在浏览器登录 super-image 后会自动同步该店铺（如需手动对接，Token 仅此一次明文展示）。
            </p>
            <code className="mt-3 block break-all rounded-md bg-muted p-3 font-mono text-sm">
              {tokenShown.token}
            </code>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => navigator.clipboard?.writeText(tokenShown.token)}
              >
                复制
              </Button>
              <Button onClick={() => setTokenShown(null)}>我已保存</Button>
            </div>
          </div>
        </div>
      )}

      {/* 插件发现的店铺（数据内嵌 supplierId 自动登记）→ 首次确认收录 */}
      <div className="rounded-xl border p-4">
        <h3 className="text-sm font-semibold">插件发现的店铺</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          企业下登录用户使用插件采集时自动发现的 Temu 店铺。确认收录后建店并自动绑定 mallId，
          插件会在 10 分钟内同步该店铺，之后采集的数据归属到它。
        </p>
        {result && !result.ok && (
          <p className="mt-2 text-sm text-destructive">{result.error}</p>
        )}
        <div className="mt-3 space-y-2">
          {discovered.length === 0 && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              暂无待确认的新店铺：插件登录卖家中心后会实时上报账号下的店铺列表；
              若一直未出现，请确认已在插件中登录本面板账号，且下方已收录至少一个店铺作为上报通道
              （首个店铺需手动添加）。
            </p>
          )}
          {discovered.map((d) => (
            <div key={d.mallId} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{d.mallName || "未命名店铺"}</div>
                <div className="text-xs text-muted-foreground">
                  mall:{d.mallId} · 首次发现{" "}
                  {new Date(d.firstSeenAt).toLocaleString("zh-CN", { hour12: false })} · 最近上报{" "}
                  {new Date(d.lastSeenAt).toLocaleString("zh-CN", { hour12: false })}
                </div>
              </div>
              <Button
                size="sm"
                disabled={pending || confirming === d.mallId}
                onClick={() => {
                  setConfirming(d.mallId)
                  startTransition(async () => {
                    const r = await wrap(() => confirmDiscoveredStoreAction({ mallId: d.mallId }))
                    setResult(r)
                    setConfirming(null)
                  })
                }}
              >
                {confirming === d.mallId ? "收录中…" : "确认收录"}
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* 编辑店铺（名称 / mallId 绑定）弹层 */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-background p-6 shadow-lg">
            <h3 className="text-lg font-semibold">编辑店铺</h3>
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-sm text-muted-foreground">店铺名称</label>
                <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="mt-1" />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Temu mallId（多店巡检归属跟随的依据）</label>
                <Input
                  value={editing.mallId}
                  onChange={(e) => setEditing({ ...editing, mallId: e.target.value })}
                  placeholder="如 634418211196072（留空 = 未绑定）"
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground">Temu 店铺名</label>
                <Input value={editing.mallName} onChange={(e) => setEditing({ ...editing, mallName: e.target.value })} className="mt-1" />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>取消</Button>
              <Button
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await wrap(() =>
                      updateTemuStoreAction({
                        id: editing.id,
                        name: editing.name.trim() || undefined,
                        mallId: editing.mallId.trim() || null,
                        mallName: editing.mallName.trim() || null,
                      }),
                    )
                    setResult(r)
                    if (r.ok) setEditing(null)
                  })
                }
              >
                保存
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <StoreList
          stores={stores}
          pending={pending}
          onEdit={(s) => setEditing({ id: s.id, name: s.name, mallId: s.mallId || "", mallName: s.mallName || "" })}
          onResetToken={async (s) => {
            try {
              const r = await resetTemuStoreTokenAction({ id: s.id })
              setTokenShown({ name: s.name, token: r.deviceToken })
            } catch (e) {
              setResult({ ok: false, error: String(e).slice(0, 200) })
            }
          }}
          onToggle={(s) => wrap(() => toggleTemuStoreAction({ id: s.id, enabled: !s.enabled }))}
          onDelete={(s) => {
            if (!confirm(`删除店铺「${s.name}」及其全部采集数据？`)) return Promise.resolve({ ok: true })
            return wrap(() => deleteTemuStoreAction({ id: s.id }))
          }}
          onClearData={(s) => {
            if (
              !confirm(
                `清空店铺「${s.name}」的全部采集数据？店铺本身与 token 保留。\n` +
                  "（用于重新采集测试：插件去重缓存约 30 秒自动重置，清空后稍候再采集即可全量入库）",
              )
            )
              return Promise.resolve({ ok: true })
            return wrap(() => clearTemuStoreDataAction({ id: s.id }))
          }}
          onResult={setResult}
        />
        {stores.length === 0 && (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            还没有店铺。在上方「插件发现的店铺」中确认收录，或等插件上报后自动出现。
          </p>
        )}
      </div>
    </div>
  )
}

/** 已收录店铺列表：行首手柄拖拽排序（useDragSort，drop 后保存新顺序） */
function StoreList({
  stores,
  pending,
  onEdit,
  onResetToken,
  onToggle,
  onDelete,
  onClearData,
  onResult,
}: {
  stores: TemuStoreBrief[]
  pending: boolean
  onEdit: (s: TemuStoreBrief) => void
  onResetToken: (s: TemuStoreBrief) => Promise<void>
  onToggle: (s: TemuStoreBrief) => Promise<ActionResult>
  onDelete: (s: TemuStoreBrief) => Promise<ActionResult>
  onClearData: (s: TemuStoreBrief) => Promise<ActionResult>
  onResult: (r: ActionResult) => void
}) {
  const [, startTransition] = React.useTransition()
  const { ordered, rowProps, handleProps } = useDragSort({
    items: stores,
    commit: (ids) => reorderTemuStoresAction({ ids }).then((r) => ({ ok: !!r.ok })),
  })
  return (
    <>
      {ordered.map((s) => (
        <div
          key={s.id}
          {...rowProps(s.id, "flex flex-wrap items-center gap-3 rounded-xl border p-4")}
        >
          <DragHandle handleProps={handleProps(s.id)} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {s.name}
              {s.mallName && <span className="ml-2 text-sm text-muted-foreground">（{s.mallName}）</span>}
            </div>
            <div className="text-xs text-muted-foreground">
              {s.mallId ? `mall:${s.mallId} · ` : "未绑定 mallId · "}
              {s.enabled ? "启用" : "已停用"} · 最近上报{" "}
              {s.lastSeenAt
                ? new Date(s.lastSeenAt).toLocaleString("zh-CN", { hour12: false })
                : "从未"}
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => onEdit(s)}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => startTransition(() => void onResetToken(s))}
          >
            重置 Token
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => startTransition(async () => onResult(await onToggle(s)))}
          >
            {s.enabled ? "停用" : "启用"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => startTransition(async () => onResult(await onClearData(s)))}
          >
            清空数据
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => startTransition(async () => onResult(await onDelete(s)))}
          >
            删除
          </Button>
        </div>
      ))}
    </>
  )
}
