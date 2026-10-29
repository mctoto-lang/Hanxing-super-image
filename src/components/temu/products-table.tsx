"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { ChevronDown, ChevronRight, CircleAlert, TrendingUp } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
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
import { temuImageSrc } from "@/lib/temu/image"
import {
  getTemuProductsPageAction,
  type TemuProductRow,
  type TemuProductSalesInfo,
  type TemuSkuDetailRow,
  type TemuInventoryInfo,
  type TemuProductDetailExtra,
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

/** 商品信息工具行：防抖搜索（输入即搜）+ 在售筛选 + 排序（URL 驱动，与切店下拉同交互） */
export function TemuProductsSaleFilter({
  current,
  saleAll = false,
  store,
  q,
  sort,
}: {
  current?: string
  /** URL 显式携带 sale=all（页面把 saleRaw==="all" 下传）：current 为 undefined
   *  时区分「全部状态」与「URL 无 sale 参数的缺省在售」两种语义 */
  saleAll?: boolean
  store?: string
  q?: string
  sort?: string
}) {
  const router = useRouter()
  // "全部"用哨兵 sale=all 显式携带：URL 无 sale 参数时页面缺省"在售"
  const ALL = "all"
  const saleItems = [
    { value: ALL, label: "全部状态" },
    { value: "on", label: "在售" },
    { value: "off", label: "未上架" },
  ]
  const sortItems = [
    { value: "listed", label: "上架时间" },
    { value: "today", label: "今日销量" },
    { value: "last7", label: "七日销量" },
    { value: "sn", label: "货号" },
  ]
  const currentSort = sort === "today" || sort === "last7" || sort === "sn" ? sort : "listed"

  /** 组 URL：q/sale/sort 任意变化都重置回第 1 页（page 参数本就不携带） */
  const push = (next: { q?: string; sale?: string; sort?: string }) => {
    const p = new URLSearchParams({ tab: "products" })
    if (store) p.set("store", store)
    const qVal = next.q !== undefined ? next.q : q
    if (qVal) p.set("q", qVal)
    const saleVal = next.sale !== undefined ? next.sale : current
    if (saleVal === ALL || saleVal === "on" || saleVal === "off") p.set("sale", saleVal)
    // 切排序/提交搜索时 next.sale 不带、current 为 undefined：若用户显式
    // 选过「全部状态」（URL sale=all）须保留，否则参数丢失、页面回落缺省
    // "在售"；URL 本无 sale 参数（缺省在售）则保持缺省，不写 sale 参数
    else if (saleVal === undefined && saleAll) p.set("sale", ALL)
    const sortVal = next.sort !== undefined ? next.sort : currentSort
    p.set("sort", sortVal)
    router.push(`/temu?${p.toString()}`)
  }

  // 防抖即搜：停顿 500ms 后提交；卸载清定时器避免离开页面后仍跳转
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])
  const onSearch = (raw: string) => {
    const value = raw.trim()
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      // 与当前值相同不重复跳转（初次挂载 defaultValue 不触发 onChange）
      if (value === (q ?? "")) return
      push({ q: value || "" })
    }, 500)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        defaultValue={q ?? ""}
        placeholder="搜索 SKC/SPU/货号/商品名"
        onChange={(e) => onSearch(e.target.value)}
        className="h-8 w-56 text-xs"
      />
      <Select
        items={saleItems}
        value={current === "on" || current === "off" ? current : ALL}
        onValueChange={(v) => {
          if (v) push({ sale: v })
        }}
      >
        <SelectTrigger className="h-8 w-28 text-xs" aria-label="状态筛选">
          <SelectValue placeholder="全部状态" />
        </SelectTrigger>
        <SelectContent>
          {saleItems.map((it) => (
            <SelectItem key={it.value} value={it.value}>
              {it.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        items={sortItems}
        value={currentSort}
        onValueChange={(v) => {
          if (v) push({ sort: v })
        }}
      >
        <SelectTrigger className="h-8 w-28 text-xs" aria-label="排序方式">
          <SelectValue placeholder="上架时间" />
        </SelectTrigger>
        <SelectContent>
          {sortItems.map((it) => (
            <SelectItem key={it.value} value={it.value}>
              {it.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// ---------- 商品信息无限滚动表格 ----------

/** 空值占位：圆形感叹号 + 悬浮提示（数值为空或无数据）——TEMU 各页空值统一口径 */
export function EmptyHint() {
  return (
    <Tooltip>
      <TooltipTrigger className="cursor-default text-muted-foreground" aria-label="数值为空或无数据">
        <CircleAlert className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="text-xs">数值为空或无数据</TooltipContent>
    </Tooltip>
  )
}

/**
 * 货号分组归一化键：取首段数字去前导零——早期 2 位货号可能缺 0，
 * B7=B07=B007、B066=B66 视为同货号（与服务端 sn 排序的
 * substring('[0-9]+')::numeric 同口径，同号行排序天然相邻）；
 * 无数字的货号原样返回（空串自成一组，排序时空值最上恰好连续）。
 */
function snGroupKey(sn: string): string {
  const m = /[0-9]+/.exec(sn.trim())
  return m ? `#${Number(m[0])}` : sn.trim()
}

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
/** 库存数据单元格：主值 = 仓内库存（warehouseInventoryNum，卖家口径「可用库存」，
 *  与申报备货视图同口径）；悬停按官方参数表顺序逐项展示九项官方 desc 文案 */
function AvailableStockCell({ info }: { info: TemuInventoryInfo | null }) {
  if (!info) return <EmptyHint />
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="cursor-default tabular-nums">
          {info.warehouseInventoryNum ?? 0}
        </TooltipTrigger>
        <TooltipContent className="text-xs">
          {/* 固定宽度单列容器：TooltipContent 多子元素默认会横向铺开成多列 */}
          <div className="flex w-44 flex-col gap-0.5">
            {INVENTORY_LABELS.map(([key, label]) => (
              <div key={key} className="flex items-baseline justify-between gap-4">
                <span>{label}</span>
                <span className="tabular-nums">{info[key] ?? 0}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/* ─── SKC 状态映射 ───
 * 官方 bg.glo.goods.list.get 响应 skcSiteStatus 实测为 0/1（与查询参数
 * skcTopStatus 的 0/100/200/300 是两套值空间）：1=在售（实测 100% 落在
 * 销售管理数据内）、0=未发布到站点；11 为插件历史口径的在售，一并兼容。
 */
type SkcStatusView = { label: string; className: string }

export function skcStatusView(skcStatus: number | null): SkcStatusView {
  if (skcStatus === 1 || skcStatus === 11) {
    return {
      label: "在售",
      className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    }
  }
  if (skcStatus === 0) {
    return {
      label: "未上架",
      className: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    }
  }
  if (skcStatus == null) {
    return {
      label: "未知",
      className: "bg-muted text-muted-foreground",
    }
  }
  return {
    label: `状态码 ${skcStatus}`,
    className: "bg-muted text-muted-foreground",
  }
}

/** 上架时间戳格式化（goods-list createdAt 实测为毫秒；按量级自适应兼容秒；无效返回 null 由外层显空值占位） */
function formatListedAt(ts: number | null): string | null {
  if (ts == null) return null
  const ms = ts >= 1e12 ? ts : ts * 1000
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("zh-CN")
}

/** 悬停明细文案 = 官方 bg.goods.salesv2.get 参数表 desc 原文，顺序同官方（消除歧义） */
const INVENTORY_LABELS: Array<[keyof TemuInventoryInfo, string]> = [
  ["waitOnShelfNum", "待上架库存"],
  ["warehouseInventoryNum", "仓内库存"],
  ["expectedOccupiedInventoryNum", "预计占用库存"],
  ["waitApproveInventoryNum", "待审核备货库存"],
  ["waitQcNum", "已上架待质检库存"],
  ["unavailableWarehouseInventoryNum", "仓内暂不可用库存"],
  ["waitInStock", "待入库库存"],
  ["waitReceiveNum", "待收货库存"],
  ["waitDeliveryInventoryNum", "待发货库存"],
]

/** 商品级信息面板（展开行上半段）：三组呈现——商品 / 交易与备货 / 其他信息 */
function ProductDetailPanel({
  row,
  extra,
  leafCategory,
  skus,
}: {
  row: TemuProductRow
  extra?: TemuProductDetailExtra
  /** 叶子类目（salesv2 口径；goods-list 的 leafCat 官方不返回） */
  leafCategory?: string | null
  /** SKU 明细（仓组/备货配置聚合源） */
  skus?: TemuSkuDetailRow[]
}) {
  if (!extra) {
    return <p className="text-xs text-muted-foreground">该商品暂无销售管理数据（未进入销售管理范围）</p>
  }
  const num = (v: number | null | undefined) =>
    v == null ? <EmptyHint /> : v.toLocaleString("zh-CN")
  const picText =
    extra.pictureAuditStatus == null ? (
      <EmptyHint />
    ) : extra.pictureAuditStatus === 2 ? (
      "已完成"
    ) : (
      "未完成"
    )
  // 类目路径：一级 / 叶子（叶子优先销售管理口径，goods-list leafCat 实测不返回；
  // 缺一级时只显叶子），长名由外层 truncate + title 兜底
  const categoryPath = [row.cat1Name, leafCategory ?? row.leafCategoryName]
    .filter((v): v is string => !!v)
    .join(" / ")
  // 仓组/备货配置：SKU 明细去重聚合（多仓组「、」拼接）
  const distinct = (pick: (s: TemuSkuDetailRow) => string | null | undefined) => {
    const vals = [...new Set((skus ?? []).map(pick).filter((v): v is string => !!v))]
    return vals.length > 0 ? vals.join("、") : <EmptyHint />
  }
  const warehouseGroups = distinct((s) => s.warehouseGroupName)
  const purchaseConfigs = distinct((s) => s.purchaseConfig)
  const groups: Array<{ title: string; items: Array<{ label: string; value: React.ReactNode }> }> = [
    {
      title: "商品信息",
      items: [
        { label: "上架时间", value: formatListedAt(row.skcCreatedAt) ?? <EmptyHint /> },
        {
          label: "加入站点时长",
          value: extra.onSalesDurationDays != null ? `${extra.onSalesDurationDays} 天` : <EmptyHint />,
        },
        { label: "商品类目", value: categoryPath || <EmptyHint /> },
        { label: "图片审核", value: picText },
      ],
    },
    {
      title: "加购备货",
      items: [
        { label: "近 7 日加购", value: num(extra.inCartNumber7d) },
        { label: "当前加购", value: num(extra.inCardNumber) },
        {
          label: "备货/安全库存天数",
          value: extra.stockDays != null ? `${extra.stockDays} 天` : <EmptyHint />,
        },
        { label: "可否备货", value: extra.canPurchase ? "可备货" : "不可" },
      ],
    },
    {
      title: "其他信息",
      items: [
        { label: "SPU 编号", value: row.productId ?? <EmptyHint /> },
        { label: "仓组", value: warehouseGroups },
        { label: "备货配置", value: purchaseConfigs },
        { label: "归属店铺", value: row.storeName ?? <EmptyHint /> },
      ],
    },
  ]
  return (
    <div className="grid gap-x-8 gap-y-3 md:grid-cols-3">
      {groups.map((g) => (
        <section key={g.title} className="min-w-0 space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">{g.title}</h4>
          <dl className="space-y-1">
            {g.items.map((it) => (
              <div key={it.label} className="flex items-baseline justify-between gap-3 text-xs">
                <dt className="whitespace-nowrap text-muted-foreground">{it.label}</dt>
                <dd
                  className="min-w-0 truncate text-right font-medium tabular-nums"
                  title={typeof it.value === "string" ? it.value : undefined}
                >
                  {it.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}

/** SKU 明细展开子表：尺码/货号/申报价/今日·7日·30日·总销量（salesv2 priceDetail） */
function SkuDetailSubtable({ skus }: { skus: TemuSkuDetailRow[] }) {
  const num = (v: unknown) =>
    typeof v === "number" ? v.toLocaleString("zh-CN") : v == null ? <EmptyHint /> : String(v)
  return (
    <table className="w-full caption-bottom text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-8 px-3">SKU 编号</TableHead>
          <TableHead>尺码</TableHead>
          <TableHead>货号</TableHead>
          <TableHead className="text-right">申报价格</TableHead>
          <TableHead className="text-right">今日销量</TableHead>
          <TableHead className="text-right">近 7 日</TableHead>
          <TableHead className="text-right">近 30 日</TableHead>
          <TableHead className="text-right">总销量</TableHead>
          <TableHead className="text-right">缺货数量</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {skus.map((s, i) => (
          <TableRow key={String(s.productSkuId ?? i)} className="hover:bg-transparent">
            <TableCell className="px-3 py-1.5 font-mono">{s.productSkuId ?? <EmptyHint />}</TableCell>
            <TableCell>{s.className ?? <EmptyHint />}</TableCell>
            <TableCell className="font-mono">{s.skuExtCode ?? <EmptyHint />}</TableCell>
            <TableCell className="text-right tabular-nums">
              {s.supplierPrice != null ? `¥${(s.supplierPrice / 100).toFixed(2)}` : <EmptyHint />}
            </TableCell>
            <TableCell className="text-right tabular-nums">{num(s.todaySaleVolume)}</TableCell>
            <TableCell className="text-right tabular-nums">{num(s.lastSevenDaysSaleVolume)}</TableCell>
            <TableCell className="text-right tabular-nums">{num(s.lastThirtyDaysSaleVolume)}</TableCell>
            <TableCell className="text-right tabular-nums">{num(s.totalSaleVolume)}</TableCell>
            <TableCell className="text-right tabular-nums">{num(s.lackQuantity)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </table>
  )
}

export function ProductsInfiniteTable({
  store,
  q,
  sale,
  sort,
  initialRows,
  initialSalesInfo,
}: {
  store?: string
  q?: string
  sale?: "on" | "off"
  sort?: string
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
  /** SKU 明细展开行（按行 id 记录；展开后追加行不计入渐进渲染批次） */
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  // 渐进渲染：已加载行先按批露出，滚到底再露下一批/拉下一页——无限滚动只追加
  // 不清除，几千 SKU 全量渲染时 DOM 与 React 树持续膨胀，表格滚动明显卡顿
  const ROW_STEP = 40
  const [visibleCount, setVisibleCount] = React.useState(ROW_STEP)
  const visibleRows = rows.slice(0, visibleCount)
  // 货号排序（sort=sn）时按货号分组交替浅底：全部店铺视图下同货号跨店链接
  // 一眼可辨；其他排序同货号不相邻，不适用。分组号按全量已加载行计算，
  // 翻页追加时既有行分组保持稳定
  const snGroupOf = React.useMemo(() => {
    const m = new Map<string, number>()
    if (sort !== "sn") return m
    let g = -1
    let prev: string | null = null
    for (const r of rows) {
      const key = snGroupKey(r.productSn ?? "")
      if (prev == null || key !== prev) {
        g += 1
        prev = key
      }
      m.set(r.id, g)
    }
    return m
  }, [rows, sort])
  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const loadMore = React.useCallback(async () => {
    if (loadingRef.current || doneRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const next = pageRef.current + 1
      const r = await getTemuProductsPageAction(store, q, sale, next, sort)
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
  }, [store, q, sale, sort])

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
      {/* 无滚动容器（保 sticky 吸顶锚定页侧 CardContent）；overflow-clip 仅按圆角裁剪内容 */}
      <div className="w-max min-w-full overflow-clip rounded-md border">
      <table className="w-max min-w-full caption-bottom text-xs">
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="[&_th:not(:first-child)]:border-l [&_th:not(:first-child)]:border-border">
            <TableHead className="w-8" />
            <TableHead>主图</TableHead>
            <TableHead>SKC</TableHead>
            <TableHead>商品名</TableHead>
            <TableHead>货号</TableHead>
            <TableHead className="text-right">申报价格</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">今日销量</TableHead>
            <TableHead className="text-right">七日销量</TableHead>
            <TableHead className="text-right">三十日销量</TableHead>
            <TableHead className="text-right">可售天数</TableHead>
            <TableHead className="text-right">库存数据</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleRows.map((r) => {
            const sales = salesInfo.latest[r.productSkcId]
            const status = skcStatusView(r.skcStatus)
            const isOpen = expanded.has(r.id)
            const skuRows = sales?.skus ?? []
            // 可展开 = 有 SKU 明细：price_detail 为空的行（多为插件历史行）
            // 展开只会得到空面板，不再给展开按钮
            const expandable = skuRows.length > 0
            return (
              <React.Fragment key={r.id}>
              {/* 整行点击即可展开/收纳（chevron 仅为视觉提示，行内无其他可点元素）；
                  货号排序时同组行共享浅蓝/浅紫交替底色（同货号跨店分组辨识） */}
              <TableRow
                className={[
                  // 列间竖线挂行上而非外层 table：变体按后代匹配，挂 table 会波及展开行内嵌套的 SKU 子表
                  "[&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border",
                  expandable ? "cursor-pointer" : "",
                  (() => {
                    const g = snGroupOf.get(r.id)
                    if (g == null) return ""
                    return g % 2 === 0
                      ? "bg-sky-100 dark:bg-sky-950/60"
                      : "bg-violet-100 dark:bg-violet-950/60"
                  })(),
                ].filter(Boolean).join(" ") || undefined}
                onClick={expandable ? () => toggleExpanded(r.id) : undefined}
              >
                <TableCell className="px-2">
                  {expandable && (
                    <span
                      aria-hidden
                      className="inline-flex rounded p-0.5 text-muted-foreground"
                    >
                      {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {r.mainImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={temuImageSrc(r.mainImageCosUrl, r.mainImageUrl)}
                      alt=""
                      className="size-10 rounded object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="size-10 rounded bg-muted" />
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.productSkcId}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1">
                    {r.productName ? <ProductNameCell name={r.productName} /> : <EmptyHint />}
                    {sales?.hotTag && (
                      <Tooltip>
                        <TooltipTrigger className="cursor-default text-xs" aria-label="热销款">
                          🔥
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">热销款（销售管理标记）</TooltipContent>
                      </Tooltip>
                    )}
                    {sales?.extra.isFirst && (
                      <Tooltip>
                        <TooltipTrigger className="cursor-default" aria-label="首单">
                          <Badge className="rounded-[4px] bg-sky-100 px-1 text-[10px] text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                            首单
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">平台标记的首单商品（isFirst）</TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.productSn ?? <EmptyHint />}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.supplierPrice != null ? `¥${(r.supplierPrice / 100).toFixed(2)}` : <EmptyHint />}
                </TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger className="cursor-default">
                      <Badge className={`rounded-[4px] ${status.className}`}>{status.label}</Badge>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">
                      <div>SKC 站点状态码：{r.skcStatus ?? "未知"}</div>
                      {r.lifecycleStatus && <div>生命周期：{r.lifecycleStatus}</div>}
                      {sales?.extra.priceReview.reviewStatus != null && (
                        <div>核价状态码：{sales.extra.priceReview.reviewStatus}</div>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="text-right tabular-nums">{sales?.todaySalesVolume ?? <EmptyHint />}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {sales?.extra.last7DaysSalesVolume ?? <EmptyHint />}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {sales?.extra.last30DaysSalesVolume ?? <EmptyHint />}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {sales?.availableSaleDays != null ? Math.round(sales.availableSaleDays) : <EmptyHint />}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <AvailableStockCell info={sales?.extra.inventoryInfo ?? null} />
                </TableCell>
              </TableRow>
              {isOpen && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={12} className="space-y-3 bg-muted/30 px-4 py-3">
                    <ProductDetailPanel
                      row={r}
                      extra={sales?.extra}
                      leafCategory={sales?.leafCategory}
                      skus={skuRows}
                    />
                    {skuRows.length > 0 && <SkuDetailSubtable skus={skuRows} />}
                  </TableCell>
                </TableRow>
              )}
              </React.Fragment>
            )
          })}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={12} className="h-20 text-center text-muted-foreground">
                暂无数据：店铺完成一次官方 API 同步后自动出现
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </table>
      </div>
      </TooltipProvider>
      <div ref={sentinelRef} className="py-4 text-center text-xs text-muted-foreground">
        {done && visibleCount >= rows.length
          ? `已全部加载 ${rows.length} 条`
          : loading
            ? "加载中…"
            : ""}
      </div>

    </>
  )
}
