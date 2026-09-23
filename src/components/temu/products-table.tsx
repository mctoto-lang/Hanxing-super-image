"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { FileDown, TrendingUp } from "lucide-react"
import { toast } from "sonner"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
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
  getTemuProductsPageAction,
  type TemuProductRow,
  type TemuProductSalesInfo,
} from "@/server/actions/temu"

/**
 * Temu 商品信息页组件族：销量趋势弹层、在售筛选、商品无限滚动表格
 *（渐进渲染 + TooltipProvider 上提）、流量/商品名单元格。
 */

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

/** 导出当前已加载商品为 CSV（带 BOM，Excel 直接打开中文不乱码；P2-3） */
function exportRowsCsv(
  rows: TemuProductRow[],
  salesInfo: TemuProductSalesInfo,
): void {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = [
    "SKC", "SPU", "商品名", "货号", "申报价格(元)", "在售",
    "今日销量", "七日销量", "可售天数", "仓内可用", "已发货", "平台库存",
  ]
  const lines = [header.join(",")]
  for (const r of rows) {
    const s = salesInfo.latest[r.productSkcId]
    const stock =
      (s?.warehouseAvailableStock ?? 0) + (s?.shippedStock ?? 0)
    lines.push(
      [
        r.productSkcId,
        r.productId ?? "",
        r.productName ?? "",
        r.productSn ?? "",
        r.supplierPrice != null ? (r.supplierPrice / 100).toFixed(2) : "",
        r.skcStatus === 11 ? "在售" : "非在售",
        s?.todaySalesVolume ?? "",
        r.last7DaysSalesVolume ?? "",
        s?.availableSaleDays ?? "",
        s?.warehouseAvailableStock ?? "",
        s?.shippedStock ?? "",
        stock,
      ]
        .map(esc)
        .join(","),
    )
  }
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `temu-商品-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

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
    days >= 15 ? "var(--chart-2)" : days >= 10 ? "var(--chart-5)" : days >= 5 ? "var(--color-yellow-500)" : "var(--color-red-500)"
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
  // 渐进渲染：已加载行先按批露出，滚到底再露下一批/拉下一页——无限滚动只追加
  // 不清除，几千 SKU 全量渲染时 DOM 与 React 树持续膨胀，表格滚动明显卡顿
  const ROW_STEP = 40
  const [visibleCount, setVisibleCount] = React.useState(ROW_STEP)
  const visibleRows = rows.slice(0, visibleCount)

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
      // 网络抖动等：提示用户本轮加载失败，滚动到底可重试
      toast.error("加载更多失败，请稍后重试")
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [store, q, sale])

  React.useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        // 已加载行未露完：先露下一批；露完且服务端还有更多：拉下一页。
        // done 后仍需保留 observer：末页补齐的行也要能逐批露出，
        // 否则 total 非 ROW_STEP 整数倍时尾部行永久不可见
        if (visibleCount < rows.length) {
          setVisibleCount((prev) => prev + ROW_STEP)
        } else if (!done) {
          void loadMore()
        }
      },
      { rootMargin: "200px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, done, visibleCount, rows.length])

  return (
    <>
      {/* TooltipProvider 上提共享：原先每行两个 Provider，几百行时 DOM 显著膨胀 */}
      <TooltipProvider>
      <table className="w-max min-w-full caption-bottom text-sm">
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
          {visibleRows.map((r) => {
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
                  ) : (
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
      </TooltipProvider>
      <div ref={sentinelRef} className="py-4 text-center text-xs text-muted-foreground">
        {done && visibleCount >= rows.length
          ? `已全部加载 ${rows.length} 条`
          : loading
            ? "加载中…"
            : ""}
      </div>

      {/* 导出 CSV（P2-3）：固定右下角悬浮，导出当前已加载的商品行 */}
      {rows.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="fixed bottom-6 right-6 z-30 h-8 gap-1.5 rounded-full bg-background/95 shadow-lg backdrop-blur"
          onClick={() => {
            exportRowsCsv(rows, salesInfo)
            toast.success(`已导出 ${rows.length} 条商品数据（CSV）`)
          }}
        >
          <FileDown className="size-3.5" />
          导出 CSV（{rows.length} 条）
        </Button>
      )}
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
