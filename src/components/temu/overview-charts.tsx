"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Medal, X } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { ZoomableImage } from "@/components/ui/zoomable-image"
import { Cell, Pie, PieChart } from "recharts"
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
import { Badge } from "@/components/ui/badge"
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
import { TruncTip } from "@/components/temu/trunc-tip"
import { getTemuShipStatsAction, type TemuShipStats } from "@/server/actions/temu-ship"
import type {
  TemuCategoryShare,
  TemuStoreShare,
  TemuSalesTopBySnRow,
} from "@/server/actions/temu"

/**
 * Temu 面板概览组件：店铺切换下拉、类目/店铺占比、售出 TOP50（按货号）。
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
  app,
}: {
  tab: string
  current?: string
  stores: { id: string; name: string }[]
  allowAll?: boolean
  /** 应用（主体）筛选（URL ?app= 透传：切店时保持应用维度） */
  app?: string
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
        if (app) p.set("app", app)
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

// 20 色环形调色板（globals.css --chart-1..20），按色相交错排序：相邻两项色相差 ≥80°，
// 覆盖饼图切片上限（20 店铺 + 其他；类目 15+其他取前 15 色），不再取模循环撞色
const donutPalette = [
  "var(--chart-1)", // 蓝
  "var(--chart-4)", // 琥珀
  "var(--chart-2)", // 青
  "var(--chart-5)", // 玫红
  "var(--chart-3)", // 紫
  "var(--chart-6)", // 绿
  "var(--chart-7)", // 橙
  "var(--chart-8)", // 靛
  "var(--chart-9)", // 黄绿
  "var(--chart-10)", // 绯红
  "var(--chart-11)", // 天蓝
  "var(--chart-12)", // 金黄
  "var(--chart-13)", // 春绿
  "var(--chart-14)", // 紫红
  "var(--chart-15)", // 草绿
  "var(--chart-16)", // 品红
  "var(--chart-19)", // 黄
  "var(--chart-17)", // 紫罗兰
  "var(--chart-20)", // 朱红
  "var(--chart-18)", // 蓝紫
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

/** 共享占比卡数据行（类目/店铺占比同构：标签 + 三口径销量） */
type ShareRow = { label: string; today: number; last7: number; last30: number }

/** 占比环形卡（动态切片 + 其他；口径可切 今日/近7日/近30日）：类目占比与
 *  店铺占比共用，仅标题/描述/切片上限与占比阈值不同 */
function ShareDonutCard({
  title,
  description,
  rows,
  maxEntries = 15,
  minSharePct = 0.01,
}: {
  title: string
  description: string
  rows: ShareRow[]
  /** 切片上限（其余并入「其他」） */
  maxEntries?: number
  /** 单条占比低于该阈值即中断纳入（含其后全部，0=不过滤全展示） */
  minSharePct?: number
}) {
  const [metric, setMetric] = React.useState("today")
  const pick = (d: ShareRow) =>
    metric === "today" ? d.today : metric === "30d" ? d.last30 : d.last7

  const total = rows.reduce((s, d) => s + pick(d), 0)
  const slices = React.useMemo(() => {
    const sorted = [...rows].sort((a, b) => pick(b) - pick(a)).filter((d) => pick(d) > 0)
    // 动态纳入：占比 ≥ minSharePct 的条目全部展示（最多 maxEntries 条），其余合并「其他」
    const kept: Array<{ label: string; value: number }> = []
    for (const d of sorted) {
      if (kept.length >= maxEntries) break
      if (minSharePct > 0 && total > 0 && pick(d) / total < minSharePct) break
      kept.push({ label: d.label, value: pick(d) })
    }
    const rest = sorted.slice(kept.length).reduce((s, d) => s + pick(d), 0)
    if (rest > 0) kept.push({ label: "其他", value: rest })
    return kept.map((s, i) => ({
      ...s,
      color: s.label === "其他" ? "var(--muted)" : donutPalette[i % donutPalette.length],
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, metric, total])

  const config = Object.fromEntries(
    slices.map((s) => [s.label, { label: s.label, color: s.color }]),
  ) satisfies ChartConfig

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
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
                垫尾），条目名单行省略不折行，右侧跟占比百分比 */}
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
                    <TruncTip text={s.label} className="max-w-32" />
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

/** 售出类目占比：销售管理最新批次按类目汇总销量 */
export function TemuCategoryShare({ data }: { data: TemuCategoryShare[] }) {
  return (
    <ShareDonutCard
      title="售出类目占比"
      description="销售管理最新批次 · 按类目汇总销量（展示占比 ≥1% 的类目，至多 15 条）"
      rows={data.map((d) => ({
        label: d.category,
        today: d.todaySalesVolume,
        last7: d.last7DaysSalesVolume,
        last30: d.last30DaysSalesVolume,
      }))}
    />
  )
}

/** 售出店铺占比：各店铺销量对比（选中单店时为 100% 单切片属预期）。店铺有量即展示
 *  （无 1% 阈值——单应用店铺上限 20，小店归「其他」会丢对比信息），至多 20 条 */
export function TemuStoreShare({ data }: { data: TemuStoreShare[] }) {
  return (
    <ShareDonutCard
      title="售出店铺占比"
      description="销售管理最新批次 · 按店铺汇总销量（全部店铺对比，至多 20 条）"
      maxEntries={20}
      minSharePct={0}
      rows={data.map((d) => ({
        label: d.storeName,
        today: d.todaySalesVolume,
        last7: d.last7DaysSalesVolume,
        last30: d.last30DaysSalesVolume,
      }))}
    />
  )
}

// ---------- 售出 TOP30（按货号，概览页底部三卡） ----------

/** 领奖台名次勋章底色：金 / 银 / 铜（实底圆内嵌 Medal 白图标，名次由领奖台位置表达） */
const RANK_MEDAL = ["bg-amber-500", "bg-slate-400", "bg-orange-700"]

/** TOP50 主图缩略：取「该口径销量最高 SKC」的图（转存 URL 优先，temuImageSrc 回落
 *  kwcdn 外链），点击放大（ZoomableImage，stopPropagation 不触发货号选中），
 *  无图占位 */
function Top50Thumb({
  row,
  metric,
  className,
}: {
  row: TemuSalesTopBySnRow
  metric: "today" | "7d" | "30d"
  className?: string
}) {
  const cosUrl =
    metric === "today"
      ? row.todayMainImageCosUrl
      : metric === "7d"
        ? row.last7MainImageCosUrl
        : row.last30MainImageCosUrl
  const imageUrl =
    metric === "today"
      ? row.todayMainImageUrl
      : metric === "7d"
        ? row.last7MainImageUrl
        : row.last30MainImageUrl
  const src = temuImageSrc(cosUrl, imageUrl)
  return src ? (
    <ZoomableImage src={src} className={cn("rounded-md object-cover", className)} />
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

/** 占比徽标（1 位小数；分母=该口径全店总销量，即顶部卡片数值，含 TOP50 之外的款） */
function TopPctBadge({ pct }: { pct: number | null }) {
  if (pct == null) return null
  return (
    <Badge className="rounded-[4px] bg-muted px-1 py-0 text-[10px] font-normal tabular-nums text-muted-foreground">
      {pct.toFixed(1)}%
    </Badge>
  )
}

/** 售出 TOP50 单卡：前 3 名主图领奖台（2-1-3 排列，第一名居中更大）+
 *  第 4-50 名行内列表（序号+主图+货号+销量+占比徽标，固定高度内部滚动、隐藏滚动条）。
 *  货号可点击选中（方案A：主题色淡底+左缘主色条），再点取消；各卡独立不联动；
 *  卡右上角实时显示「已选 N 款 · 合计占比」 */
function TemuTop50Card({
  title,
  metric,
  rows,
  total,
}: {
  title: string
  metric: "today" | "7d" | "30d"
  rows: { row: TemuSalesTopBySnRow; value: number }[]
  /** 该口径全店总销量（占比分母；null/0 = 不显示占比） */
  total: number | null
}) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const toggle = (sn: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sn)) next.delete(sn)
      else next.add(sn)
      return next
    })
  const pct = (value: number) =>
    total && total > 0 ? Math.round((value / total) * 1000) / 10 : null
  // 已选合计：件数/全店总量件数（千分位同行内销量）+ 占比（1 位小数同徽标口径）
  const selectedQty = rows
    .filter((x) => selected.has(x.row.sn))
    .reduce((a, x) => a + x.value, 0)
  const selectedPct =
    selected.size > 0 && total && total > 0
      ? Math.round((selectedQty / total) * 1000) / 10
      : null

  const podium = rows.slice(0, 3).map((x, i) => ({ ...x, rank: i + 1 }))
  const podiumOrder = podium.length === 3 ? [podium[1], podium[0], podium[2]] : podium
  const rest = rows.slice(3)
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>按货号汇总销量（件）</CardDescription>
        {selected.size > 0 && (
          <CardAction className="flex items-center gap-1 text-xs font-medium text-primary">
            {/* 一键清空本卡选中（各卡独立，不影响另两卡） */}
            <button
              type="button"
              aria-label="取消选择"
              onClick={() => setSelected(new Set())}
              className="cursor-pointer rounded p-0.5 transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </button>
            已选 {selected.size} 款 · {selectedQty.toLocaleString("zh-CN")} 件
            {total != null && total > 0 && <>/{total.toLocaleString("zh-CN")}件</>}
            {selectedPct != null ? ` · ${selectedPct.toFixed(1)}%` : ""}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {rows.length === 0 ? (
          <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">
            暂无数据（数据随官方 API 定时同步更新）
          </div>
        ) : (
          <>
            <div className="flex items-end justify-center gap-4 px-2 pt-2">
              {podiumOrder.map((p) => {
                const isSel = selected.has(p.row.sn)
                return (
                  <div key={p.row.sn} className="flex w-24 min-w-0 flex-col items-center gap-1">
                    <div className={cn("relative", p.rank === 1 ? "size-20" : "size-14")}>
                      <Top50Thumb row={p.row} metric={metric} className="size-full" />
                      <div
                        className={cn(
                          "absolute -left-2 -top-2 flex size-6 items-center justify-center rounded-full text-white shadow-md",
                          RANK_MEDAL[p.rank - 1],
                        )}
                      >
                        <Medal className="size-3.5" />
                      </div>
                    </div>
                    <div className="w-full text-center text-xs font-medium">
                      <button
                        type="button"
                        aria-pressed={isSel}
                        onClick={() => toggle(p.row.sn)}
                        className={cn(
                          "w-full cursor-pointer",
                          isSel && "text-primary underline decoration-2 underline-offset-2",
                        )}
                      >
                        <TruncTip text={p.row.sn} className="max-w-full font-medium" />
                      </button>
                    </div>
                    <div className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                      {p.value.toLocaleString("zh-CN")} 件
                      <TopPctBadge pct={pct(p.value)} />
                    </div>
                  </div>
                )
              })}
            </div>
            {rest.length > 0 && (
              /* 高度 = 恰好 8 行（行高 36 + 行间 2：8×36+7×2=302），第 9 行起滚动查看 */
              <div className="scrollbar-hide mt-3 max-h-[302px] space-y-0.5 overflow-y-auto">
                {rest.map((x, i) => {
                  const isSel = selected.has(x.row.sn)
                  return (
                    <div
                      key={x.row.sn}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted/50",
                        // 选中样式（方案A）：主题色淡底 + 左缘 2px 主色条（inset 阴影不加占位）
                        isSel &&
                          "bg-primary/10 shadow-[inset_2px_0_0_0_var(--primary)] hover:bg-primary/10",
                      )}
                    >
                      <span className="w-5 shrink-0 text-center tabular-nums text-muted-foreground">
                        {i + 4}
                      </span>
                      <Top50Thumb row={x.row} metric={metric} className="size-7 shrink-0" />
                      <button
                        type="button"
                        aria-pressed={isSel}
                        onClick={() => toggle(x.row.sn)}
                        className={cn(
                          "min-w-0 flex-1 cursor-pointer text-left",
                          isSel && "font-medium text-primary",
                        )}
                      >
                        <TruncTip text={x.row.sn} className="min-w-0 flex-1" />
                      </button>
                      <span className="shrink-0 font-medium tabular-nums">
                        {x.value.toLocaleString("zh-CN")}
                      </span>
                      <TopPctBadge pct={pct(x.value)} />
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** 售出 TOP50 三卡（今日/七日/三十日，按货号汇总；口径固定无切换） */
export function TemuSalesTop50Cards({
  data,
  totals,
}: {
  data: TemuSalesTopBySnRow[]
  /** 三口径全店总销量（占比分母=顶部卡片数值，含 TOP50 之外的款） */
  totals: { today: number | null; "7d": number | null; "30d": number | null }
}) {
  const cards = [
    { key: "today", title: "今日销量 TOP 50" },
    { key: "7d", title: "七日销量 TOP 50" },
    { key: "30d", title: "三十日销量 TOP 50" },
  ] as const
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
          .slice(0, 50)
        return (
          <TemuTop50Card
            key={c.key}
            title={c.title}
            metric={c.key}
            rows={rows}
            total={totals[c.key]}
          />
        )
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

/** 发货统计卡自动重查周期：对齐 worker api-ship-orders 15 分钟同步轮 */
const SHIP_STATS_POLL_MS = 15 * 60_000

/** 发货统计两卡（概览页底部）：今日发货占比环形图（货号口径，占两列）+
 *  右列「2 行 1 列」两张 KPI 卡（货物/包裹数量，本周一~周日 7 节点 sparkline，
 *  flex-1 均分与左卡等高）。时间轴=预约取货时间（无预约回落装箱时间）：
 *  折线止于今天、未来天空心点带出已预约量。发货仓库（卖家发货地址）筛选对
 *  所有卡同时生效；初始数据由服务端预取传入，切换仓库后客户端重取（30s 缓存）。 */
export function TemuShipStatsCards({
  initial,
  storeId,
  appId,
}: {
  initial: TemuShipStats
  storeId?: string
  /** 应用（主体）过滤（全部店铺统计按应用切分） */
  appId?: string
}) {
  const [stats, setStats] = React.useState(initial)
  const [warehouse, setWarehouse] = React.useState(ALL_WAREHOUSES)
  const [pending, startTransition] = React.useTransition()
  // 竞态守卫：快速连续切换仓库时丢弃过期慢响应——统计查询带 30s 服务端缓存，
  // 命中/未命中的响应时序可倒置，只有最后一次选择的仓库结果可写回
  const statsReqRef = React.useRef(0)
  // 轮询读最新仓库筛选（interval 回调闭包不随 state 重建）+ 上次拉取时刻
  //（切回标签页时据此判断是否已过周期需补刷；0=未记时，挂载时置为当前时刻）
  const warehouseRef = React.useRef(warehouse)
  const lastFetchRef = React.useRef(0)

  React.useEffect(() => {
    warehouseRef.current = warehouse
  }, [warehouse])

  /** 按当前仓库筛选重查统计（30s 服务端缓存；失败静默保留现有数据） */
  const refreshStats = React.useCallback(() => {
    const reqId = ++statsReqRef.current
    lastFetchRef.current = Date.now()
    const w = warehouseRef.current
    startTransition(async () => {
      try {
        const res = await getTemuShipStatsAction(
          storeId ?? null,
          w === ALL_WAREHOUSES ? null : w,
          appId,
        )
        if (reqId === statsReqRef.current && res && Array.isArray(res.today)) setStats(res)
      } catch {
        // 地址标签拉取等偶发失败不阻断，保留现有数据
      }
    })
  }, [storeId, appId])

  // 15 分钟自动重查本地库（对齐后台 api-ship-orders 同步周期）：页面开着
  // 数字随 worker 落库自动增量，不调官方 API；切回标签页且已过周期立即补一次，
  // 隐藏期间跳过（计时器后台被浏览器节流，恢复可见时由补刷兜住）
  React.useEffect(() => {
    // 初始数据由服务端预取，挂载时刻即为「上次拉取」基准
    lastFetchRef.current = Date.now()
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshStats()
    }, SHIP_STATS_POLL_MS)
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastFetchRef.current >= SHIP_STATS_POLL_MS
      )
        refreshStats()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refreshStats])

  const onWarehouseChange = (v: string | null) => {
    const next = v || ALL_WAREHOUSES
    warehouseRef.current = next
    setWarehouse(next)
    refreshStats()
  }

  const today = stats.today
  const total = today.reduce((s, d) => s + d.num, 0)
  const slices = React.useMemo(() => {
    const kept: Array<{ label: string; value: number }> = []
    for (const d of today) {
      if (kept.length >= 20) break
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
          <CardDescription>今日=预约取货日为今天（无预约回落装箱时间）；按货号汇总发货件数（展示占比 ≥1% 的货号，至多 20 条；无货号归「无货号」）</CardDescription>
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
              {pending ? (
                <span className="flex items-center gap-2">
                  <DashRing className="size-4" />
                  加载中…
                </span>
              ) : (
                "今日暂无发货数据（数据随官方 API 定时同步更新）"
              )}
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
                      <TruncTip text={s.label} className="max-w-32" />
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
