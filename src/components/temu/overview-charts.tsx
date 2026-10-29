"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Medal } from "lucide-react"
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
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
import { KpiTile } from "@/components/ui/kpi-tile"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { temuImageSrc } from "@/lib/temu/image"
import { getTemuShipStatsAction, type TemuShipStats } from "@/server/actions/temu-ship"
import type {
  TemuCategoryShare,
  TemuSalesTopBySnRow,
  TemuSalesTopRow,
} from "@/server/actions/temu"

/**
 * Temu 面板概览组件：店铺切换下拉、类目占比、售出 TOP10、售出 TOP20（按货号）。
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
      <SelectTrigger className="h-8 w-44 text-xs" aria-label="切换店铺">
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
  payload?: Array<{ name?: string | number; value?: number | string; payload?: { imageUrl?: string | null; imageCosUrl?: string | null } }>
  total: number
}) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  const value = Number(p.value ?? 0)
  const pct = total > 0 ? Math.round((value / total) * 1000) / 10 : 0
  const d = p.payload
  const src = d?.imageCosUrl || d?.imageUrl ? temuImageSrc(d.imageCosUrl ?? null, d.imageUrl ?? null) : null
  return (
    <div className="flex min-w-36 items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs shadow-xl">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- TEMU/COS image URLs are external
        <img src={src} alt="" className="size-10 shrink-0 rounded object-cover" />
      ) : null}
      <div className="min-w-0">
        <div className="max-w-48 truncate font-medium">{String(p.name ?? "")}</div>
        <div className="mt-0.5 whitespace-nowrap text-muted-foreground">
          {value.toLocaleString("zh-CN")} 件 · 占比 <span className="text-foreground">{pct}%</span>
        </div>
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
          <>
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
              </PieChart>
            </ChartContainer>
            {/* 自渲染图例（替代 ChartLegend）：slices 已按当前口径占比降序（「其他」
                垫尾），类目名单行省略不折行，右侧跟占比百分比 */}
            <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
              {slices.map((s) => {
                const pct = total > 0 ? Math.round((s.value / total) * 1000) / 10 : 0
                return (
                  <div
                    key={s.label}
                    className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: s.color }}
                    />
                    <span className="max-w-32 truncate" title={s.label}>
                      {s.label}
                    </span>
                    <span className="tabular-nums">{pct}%</span>
                  </div>
                )
              })}
            </div>
          </>
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

// ---------- 售出 TOP20（按货号，概览页底部三卡） ----------

/** 领奖台名次勋章底色：金 / 银 / 铜（实底圆内嵌 Medal 白图标，名次由领奖台位置表达） */
const RANK_MEDAL = ["bg-amber-500", "bg-slate-400", "bg-orange-700"]

/** TOP20 主图缩略：转存 URL 优先（temuImageSrc 回落 kwcdn 外链），无图占位 */
function Top20Thumb({ row, className }: { row: TemuSalesTopBySnRow; className?: string }) {
  const src = temuImageSrc(row.mainImageCosUrl, row.mainImageUrl)
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- kwcdn/COS 外链不走 next/image
    <img src={src} alt="" loading="lazy" className={cn("rounded-md object-cover", className)} />
  ) : (
    <div
      className={cn(
        "flex items-center justify-center rounded-md bg-muted text-muted-foreground",
        className,
      )}
    >
      <span className="text-[10px]">无图</span>
    </div>
  )
}

/** 售出 TOP20 单卡：前 3 名主图领奖台（2-1-3 排列，第一名居中更大）+
 *  第 4-20 名行内列表（序号+主图+货号+销量，固定高度内部滚动、隐藏滚动条） */
function TemuTop20Card({
  title,
  rows,
}: {
  title: string
  rows: { row: TemuSalesTopBySnRow; value: number }[]
}) {
  const podium = rows.slice(0, 3).map((x, i) => ({ ...x, rank: i + 1 }))
  const podiumOrder = podium.length === 3 ? [podium[1], podium[0], podium[2]] : podium
  const rest = rows.slice(3)
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>按货号汇总销量（件）</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {rows.length === 0 ? (
          <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">
            暂无数据（数据随官方 API 定时同步更新）
          </div>
        ) : (
          <>
            <div className="flex items-end justify-center gap-4 px-2 pt-2">
              {podiumOrder.map((p) => (
                <div key={p.row.sn} className="flex w-24 min-w-0 flex-col items-center gap-1">
                  <div className={cn("relative", p.rank === 1 ? "size-20" : "size-14")}>
                    <Top20Thumb row={p.row} className="size-full" />
                    <div
                      className={cn(
                        "absolute -left-2 -top-2 flex size-6 items-center justify-center rounded-full text-white shadow-md",
                        RANK_MEDAL[p.rank - 1],
                      )}
                    >
                      <Medal className="size-3.5" />
                    </div>
                  </div>
                  <div className="w-full truncate text-center text-xs font-medium" title={p.row.sn}>
                    {p.row.sn}
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {p.value.toLocaleString("zh-CN")} 件
                  </div>
                </div>
              ))}
            </div>
            {rest.length > 0 && (
              /* 高度 = 恰好 8 行（行高 36 + 行间 2：8×36+7×2=302），第 9 行起滚动查看 */
              <div className="scrollbar-hide mt-3 max-h-[302px] space-y-0.5 overflow-y-auto">
                {rest.map((x, i) => (
                  <div
                    key={x.row.sn}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50"
                  >
                    <span className="w-5 shrink-0 text-center tabular-nums text-muted-foreground">
                      {i + 4}
                    </span>
                    <Top20Thumb row={x.row} className="size-7 shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={x.row.sn}>
                      {x.row.sn}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">
                      {x.value.toLocaleString("zh-CN")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** 售出 TOP20 三卡（今日/七日/三十日，按货号汇总；口径固定无切换） */
export function TemuSalesTop20Cards({ data }: { data: TemuSalesTopBySnRow[] }) {
  const cards = [
    { key: "today", title: "今日销量 TOP 20" },
    { key: "7d", title: "七日销量 TOP 20" },
    { key: "30d", title: "三十日销量 TOP 20" },
  ]
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      {cards.map((c) => {
        const rows = data
          .map((r) => ({
            row: r,
            value:
              c.key === "today"
                ? r.todaySalesVolume
                : c.key === "7d"
                  ? r.last7DaysSalesVolume
                  : r.last30DaysSalesVolume,
          }))
          .filter((x) => x.value > 0)
          .sort((a, b) => b.value - a.value)
          .slice(0, 20)
        return <TemuTop20Card key={c.key} title={c.title} rows={rows} />
      })}
    </div>
  )
}

// ---------- 发货统计（概览页底部两卡） ----------

const ALL_WAREHOUSES = "__all__"

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const

/** "2026-10-28" → "10/28 周二"（按日期串本地构造取星期，不受运行时区影响） */
function weekDayLabel(day: string) {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number)
  const weekday = WEEKDAY_ZH[new Date(y, m - 1, d).getDay()] ?? ""
  return `${day.slice(5).replace("-", "/")} ${weekday}`
}

/** 本周发货两张 KPI 卡共用 props：value=本周合计、delta=较上周 ±%、trend=本周 7 天逐日 */
function shipWeekTile(
  label: string,
  current: number,
  last: number,
  trend: number[],
  trendLabels: string[],
) {
  return {
    label,
    value: current,
    format: (v: number) => v.toLocaleString("zh-CN"),
    delta: last > 0 ? ((current - last) / last) * 100 : undefined,
    deltaLabel: "较上周",
    trend,
    trendLabels,
  }
}

/** 发货统计两卡（概览页底部）：今日发货占比环形图（货号口径，占两列）+
 *  右列「2 行 1 列」两张 KPI 卡（货物/包裹数量，本周一~周日 7 节点 sparkline，
 *  flex-1 均分与左卡等高）。时间轴=预约取货时间（无预约回落装箱时间）：
 *  折线止于今天、未来天空心点带出已预约量。发货仓库（卖家发货地址）筛选对
 *  所有卡同时生效；初始数据由服务端预取传入，切换仓库后客户端重取（30s 缓存）。 */
export function TemuShipStatsCards({
  initial,
  storeId,
}: {
  initial: TemuShipStats
  storeId?: string
}) {
  const [stats, setStats] = React.useState(initial)
  const [warehouse, setWarehouse] = React.useState(ALL_WAREHOUSES)
  const [pending, startTransition] = React.useTransition()
  // 竞态守卫：快速连续切换仓库时丢弃过期慢响应——统计查询带 30s 服务端缓存，
  // 命中/未命中的响应时序可倒置，只有最后一次选择的仓库结果可写回
  const statsReqRef = React.useRef(0)

  const onWarehouseChange = (v: string | null) => {
    const next = v || ALL_WAREHOUSES
    setWarehouse(next)
    const reqId = ++statsReqRef.current
    startTransition(async () => {
      try {
        const res = await getTemuShipStatsAction(storeId ?? null, next === ALL_WAREHOUSES ? null : next)
        if (reqId === statsReqRef.current && res && Array.isArray(res.today)) setStats(res)
      } catch {
        // 地址标签拉取等偶发失败不阻断，保留现有数据
      }
    })
  }

  const today = stats.today
  const total = today.reduce((s, d) => s + d.num, 0)
  const slices = React.useMemo(() => {
    const kept: Array<{ label: string; value: number }> = []
    for (const d of today) {
      if (kept.length >= 15) break
      if (total > 0 && d.num / total < 0.01) break
      kept.push({ label: d.name, value: d.num })
    }
    const rest = today.slice(kept.length).reduce((s, d) => s + d.num, 0)
    if (rest > 0) kept.push({ label: "其他", value: rest })
    return kept.map((s, i) => {
      const product = s.label === "其他" ? null : today.find((d) => d.name === s.label)
      return {
        ...s,
        imageUrl: product?.imageUrl ?? null,
        imageCosUrl: product?.imageCosUrl ?? null,
        color: s.label === "其他" ? "var(--muted)" : donutPalette[i % donutPalette.length],
      }
    })
  }, [today, total])

  const config = Object.fromEntries(
    slices.map((s) => [s.label, { label: s.label, color: s.color }]),
  ) satisfies ChartConfig

  // 周卡趋势：未来天（已预约量）从首个 future 项起折线止步、画空心点，label 后缀「已预约」
  const weekFutureFrom = stats.weekDaily.findIndex((d) => d.future)
  const weekTrendLabels = stats.weekDaily.map((d) =>
    d.future ? `${weekDayLabel(d.day)}（已预约）` : weekDayLabel(d.day),
  )

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs xl:grid-cols-3 dark:*:data-[slot=card]:bg-card",
        pending && "opacity-60",
      )}
    >
      <Card className="@container/card xl:col-span-2">
        <CardHeader>
          <CardTitle>今日发货占比</CardTitle>
          <CardDescription>今日=预约取货日为今天（无预约回落装箱时间）；按货号汇总发货件数（展示占比 ≥1% 的货号，至多 15 条；无货号归「无货号」）</CardDescription>
          <CardAction>
            <Select
              items={[
                { value: ALL_WAREHOUSES, label: "全部发货仓库" },
                ...stats.warehouses.map((w) => ({ value: w.key, label: w.label })),
              ]}
              value={warehouse}
              onValueChange={onWarehouseChange}
            >
              <SelectTrigger className="h-8 w-40 text-xs" aria-label="筛选发货仓库（对下方发货卡全部生效）">
                <SelectValue placeholder="全部发货仓库" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_WAREHOUSES}>全部发货仓库</SelectItem>
                {stats.warehouses.map((w) => (
                  <SelectItem key={w.key} value={w.key}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardAction>
        </CardHeader>
        <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
          {total === 0 ? (
            <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
              {pending ? "加载中…" : "今日暂无发货数据（数据随官方 API 定时同步更新）"}
            </div>
          ) : (
            <>
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
                </PieChart>
              </ChartContainer>
              <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
                {slices.map((s) => {
                  const pct = total > 0 ? Math.round((s.value / total) * 1000) / 10 : 0
                  return (
                    <div
                      key={s.label}
                      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: s.color }}
                      />
                      <span className="max-w-32 truncate" title={s.label}>
                        {s.label}
                      </span>
                      <span className="tabular-nums">{pct}%</span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      {/* 右列 2 行 1 列两张 KPI 卡（货物/包裹数量 + 本周 7 节点 sparkline，折线止于今天、
          未来天空心点=已预约量），flex-1 均分与左卡等高 */}
      <div className="flex min-w-0 flex-col gap-4">
        <KpiTile
          className="flex-1"
          showPoints
          futureFrom={weekFutureFrom >= 0 ? weekFutureFrom : undefined}
          {...shipWeekTile(
            "本周发货货物数量",
            stats.week.skcNum,
            stats.lastWeek.skcNum,
            stats.weekDaily.map((d) => d.skcNum),
            weekTrendLabels,
          )}
        />
        <KpiTile
          className="flex-1"
          showPoints
          futureFrom={weekFutureFrom >= 0 ? weekFutureFrom : undefined}
          {...shipWeekTile(
            "本周发货包裹数量",
            stats.week.packageNum,
            stats.lastWeek.packageNum,
            stats.weekDaily.map((d) => d.packageNum),
            weekTrendLabels,
          )}
        />
      </div>
    </div>
  )
}
