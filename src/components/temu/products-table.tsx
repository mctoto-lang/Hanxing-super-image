"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { Ban, ChevronDown, ChevronRight, ImagePlus, Settings, SlidersHorizontal, TrendingUp, Video, Zap } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
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
import { TEMU_TABLE_HEADER_CLASS } from "@/components/temu/table-header-style"
import { EmptyHint } from "@/components/temu/empty-hint"
import { TruncTip } from "@/components/temu/trunc-tip"
import { ProductMediaEditDialog } from "@/components/temu/product-media-edit-dialog"
import { ProductVideoEditDialog } from "@/components/temu/product-video-edit-dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ZoomableImage } from "@/components/ui/zoomable-image"
import { Input } from "@/components/ui/input"
import { TemuSearchBar, type SearchBarField } from "@/components/temu/search-bar"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { formatDate } from "@/lib/datetime"
import {
  getTemuProductsPageAction,
  getPriorityShipLinksAction,
  setPriorityShipAction,
  unsetPriorityShipAction,
  getStopReplenishLinksAction,
  setStopReplenishAction,
  unsetStopReplenishAction,
  getTemuSettingsAction,
  updateTemuStagnantSettingsAction,
  type TemuProductRow,
  type TemuProductSalesInfo,
  type TemuSkuDetailRow,
  type TemuInventoryInfo,
  type TemuProductDetailExtra,
  type TemuSaleFilter,
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

/** 滞销阈值设置按钮 + 弹窗（搜索框右侧；企业级共享配置 temu_settings） */
/** 商品页共享搜索条字段（本地库 ilike：全部=五字段混合，其余单列） */
const PRODUCT_SEARCH_FIELDS: SearchBarField[] = [
  { value: "all", label: "全部", placeholder: "搜索 SKC/SPU/货号/商品名" },
  { value: "sn", label: "货号", placeholder: "输入货号…" },
  { value: "name", label: "商品名", placeholder: "输入商品名…" },
  { value: "skc", label: "SKC", placeholder: "输入 SKC…" },
]

function StagnantThresholdButton() {
  const [open, setOpen] = React.useState(false)
  const [days, setDays] = React.useState("30")
  const [qty, setQty] = React.useState("0")
  const [saving, setSaving] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    if (open && !loaded) {
      setLoaded(true)
      void getTemuSettingsAction().then((s) => {
        setDays(String(s.stagnantWindowDays))
        setQty(String(s.stagnantThresholdQty))
      })
    }
  }, [open, loaded])

  const save = async () => {
    const d = Number(days)
    const n = Number(qty)
    if (!Number.isInteger(d) || d < 1 || d > 365) {
      toast.error("滞销窗口天数须为 1-365 的整数")
      return
    }
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      toast.error("滞销销量上限须为 0-100000 的整数")
      return
    }
    setSaving(true)
    try {
      const r = await updateTemuStagnantSettingsAction({
        stagnantWindowDays: d,
        stagnantThresholdQty: n,
      })
      if (r.ok) {
        toast.success("滞销阈值已保存")
        setOpen(false)
      } else {
        toast.error(r.error)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 w-8 p-0 text-xs"
        aria-label="滞销阈值设置"
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>滞销阈值</DialogTitle>
            <DialogDescription>
              状态筛选「滞销」口径：近 X 天销量合计 ≤ X 件的链接。企业级共享配置，全企业生效。
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="stagnant-days">窗口天数（1-365）</Label>
              <Input
                id="stagnant-days"
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="stagnant-qty">销量上限（件，0-100000）</Label>
              <Input
                id="stagnant-qty"
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="h-9"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <DashRing className="size-4" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 商品信息工具行：防抖搜索（输入即搜）+ 在售/热销/滞销筛选 + 排序（URL 驱动，与切店下拉同交互） */
export function TemuProductsSaleFilter({
  current,
  saleAll = false,
  store,
  q,
  qf,
  sort,
}: {
  current?: string
  /** URL 显式携带 sale=all（页面把 saleRaw==="all" 下传）：current 为 undefined
   *  时区分「全部状态」与「URL 无 sale 参数的缺省在售」两种语义 */
  saleAll?: boolean
  store?: string
  q?: string
  qf?: string
  sort?: string
}) {
  const router = useRouter()
  // "全部"用哨兵 sale=all 显式携带：URL 无 sale 参数时页面缺省"在售"
  const ALL = "all"
  const saleItems = [
    { value: ALL, label: "全部状态" },
    { value: "on", label: "在售" },
    { value: "off", label: "未上架" },
    { value: "hot", label: "热销" },
    { value: "stagnant", label: "滞销" },
  ]
  const sortItems = [
    { value: "listed", label: "上架时间" },
    { value: "today", label: "今日销量" },
    { value: "last7", label: "七日销量" },
    { value: "sn", label: "货号" },
  ]
  const currentSort = sort === "today" || sort === "last7" || sort === "sn" ? sort : "listed"

  /** 搜索条草稿态（URL q/qf 回填）：按钮/回车提交才跳转，空关键词=清除筛选 */
  const [searchField, setSearchField] = React.useState(
    qf === "sn" || qf === "name" || qf === "skc" ? qf : "all",
  )
  const [searchKeyword, setSearchKeyword] = React.useState(q ?? "")

  /** 组 URL：q/qf/sale/sort 任意变化都重置回第 1 页（page 参数本就不携带） */
  const push = (next: { q?: string; qf?: string; sale?: string; sort?: string }) => {
    const p = new URLSearchParams({ tab: "products" })
    if (store) p.set("store", store)
    const qVal = next.q !== undefined ? next.q : q
    if (qVal) p.set("q", qVal)
    const qfVal = next.qf !== undefined ? next.qf : qf
    if (qfVal && qfVal !== "all") p.set("qf", qfVal)
    const saleVal = next.sale !== undefined ? next.sale : current
    if (saleVal === ALL || saleVal === "on" || saleVal === "off" || saleVal === "hot" || saleVal === "stagnant") {
      p.set("sale", saleVal)
    }
    // 切排序/提交搜索时 next.sale 不带、current 为 undefined：若用户显式
    // 选过「全部状态」（URL sale=all）须保留，否则参数丢失、页面回落缺省
    // "在售"；URL 本无 sale 参数（缺省在售）则保持缺省，不写 sale 参数
    else if (saleVal === undefined && saleAll) p.set("sale", ALL)
    const sortVal = next.sort !== undefined ? next.sort : currentSort
    p.set("sort", sortVal)
    router.push(`/temu?${p.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <TemuSearchBar
        fields={PRODUCT_SEARCH_FIELDS}
        field={searchField}
        onFieldChange={setSearchField}
        keyword={searchKeyword}
        onKeywordChange={setSearchKeyword}
        onSearch={(f, kw) => push({ q: kw || "", qf: f })}
        className="w-80"
      />
      <StagnantThresholdButton />
      <Select
        items={saleItems}
        value={
          current === "on" || current === "off" || current === "hot" || current === "stagnant"
            ? current
            : ALL
        }
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

/** 空值占位（口径不变）——实现移至 ./empty-hint，此处再导出保持既有引用路径兼容 */
export { EmptyHint } from "@/components/temu/empty-hint"

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

/** 上架时间戳格式化（goods-list createdAt 实测为毫秒；按量级自适应兼容秒；日粒度 YYYY-MM-DD；
 *  无效返回 null 由外层显空值占位） */
function formatListedAt(ts: number | null): string | null {
  if (ts == null) return null
  const s = formatDate(ts)
  return s === "—" ? null : s
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
                <dd className="min-w-0 text-right font-medium tabular-nums">
                  {typeof it.value === "string" && it.value.length > 14 ? (
                    <TruncTip text={it.value} className="max-w-40 justify-end text-right font-medium tabular-nums" />
                  ) : (
                    it.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}

/** SKU 明细展开子表：尺码/货号/申报价/今日·7日·30日·总销量（salesv2 priceDetail）。
 *  「缺货数量」右侧「设置」列：链接级操作菜单（换图片/换视频/优先发货/停止补货；换标题
 *  需本土店授权，docs §8.12 四/五轮探针，已按要求移出入口）——
 *  操作作用于该 SKU 所属链接（SKC），任一尺码行入口等价 */
function SkuDetailSubtable({
  skus,
  row,
  isPriority,
  onTogglePriority,
  isStopped,
  onToggleStopped,
  onEditImages,
  onEditVideo,
}: {
  skus: TemuSkuDetailRow[]
  /** 所属链接主行（productId/货号/商品名快照源） */
  row: TemuProductRow
  isPriority: boolean
  onTogglePriority: () => void
  isStopped: boolean
  onToggleStopped: () => void
  onEditImages: () => void
  onEditVideo: () => void
}) {
  // 空值图标居中与主表同口径（数值列数字保持左对齐、仅空值图标居中）
  const num = (v: unknown) =>
    typeof v === "number" ? v.toLocaleString("zh-CN") : v == null ? <EmptyHint /> : String(v)
  const hasProductId = !!row.productId
  return (
    <table className="w-full caption-bottom text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-8 px-3">SKU 编号</TableHead>
          <TableHead>尺码</TableHead>
          <TableHead>货号</TableHead>
          <TableHead>申报价格</TableHead>
          <TableHead>今日销量</TableHead>
          <TableHead>近 7 日</TableHead>
          <TableHead>近 30 日</TableHead>
          <TableHead>总销量</TableHead>
          <TableHead>缺货数量</TableHead>
          <TableHead>设置</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {skus.map((s, i) => (
          <TableRow key={String(s.productSkuId ?? i)} className="hover:bg-transparent">
            <TableCell className="px-3 py-1.5 font-mono">{s.productSkuId ?? <EmptyHint />}</TableCell>
            <TableCell>{s.className ?? <EmptyHint />}</TableCell>
            <TableCell className="font-mono">{s.skuExtCode ?? <EmptyHint />}</TableCell>
            <TableCell className="tabular-nums">
              {s.supplierPrice != null ? `¥${(s.supplierPrice / 100).toFixed(2)}` : <EmptyHint />}
            </TableCell>
            <TableCell className="tabular-nums">{num(s.todaySaleVolume)}</TableCell>
            <TableCell className="tabular-nums">{num(s.lastSevenDaysSaleVolume)}</TableCell>
            <TableCell className="tabular-nums">{num(s.lastThirtyDaysSaleVolume)}</TableCell>
            <TableCell className="tabular-nums">{num(s.totalSaleVolume)}</TableCell>
            <TableCell className="tabular-nums">{num(s.lackQuantity)}</TableCell>
            <TableCell>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      aria-label="链接设置"
                      onClick={(e) => e.stopPropagation()}
                    />
                  }
                >
                  <Settings className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-44">
                  <DropdownMenuItem onClick={onEditImages} disabled={!hasProductId}>
                    <ImagePlus className="size-3.5 text-sky-500" /> 换图片{!hasProductId ? "（缺 SPU 编号）" : ""}
                  </DropdownMenuItem>
                  {/* 换视频：sign→galerie 直传→result.get{vid}→edit.pictures.submit 视频位
                      （2026-11-12 探针全通，docs §8.12）——主图轮播视频位/详情视频位 */}
                  <DropdownMenuItem onClick={onEditVideo} disabled={!hasProductId}>
                    <Video className="size-3.5 text-violet-500" /> 换视频{!hasProductId ? "（缺 SPU 编号）" : ""}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onTogglePriority}>
                    <Zap className="size-3.5 text-amber-500" /> {isPriority ? "取消优先发货" : "设为优先发货"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onToggleStopped}>
                    <Ban className="size-3.5 text-rose-500" /> {isStopped ? "取消停止补货" : "设为停止补货"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </table>
  )
}

export function ProductsInfiniteTable({
  store,
  q,
  qf,
  sale,
  sort,
  app,
  initialRows,
  initialSalesInfo,
}: {
  store?: string
  q?: string
  qf?: string
  sale?: TemuSaleFilter
  sort?: string
  /** 应用（主体）过滤（全部店铺视图按应用切分） */
  app?: string
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
  /** 优先发货链接集合（temu_priority_link 本地标记；进页拉一次，set/unset 后本地增删） */
  const [prioritySkcs, setPrioritySkcs] = React.useState<Set<string>>(new Set())
  /** 停止补货链接集合（temu_stop_replenish_link 本地标记；同优先发货口径） */
  const [stoppedSkcs, setStoppedSkcs] = React.useState<Set<string>>(new Set())
  /** 换图片弹窗目标行（null=关） */
  const [editImagesRow, setEditImagesRow] = React.useState<TemuProductRow | null>(null)
  /** 换视频弹窗目标行（null=关） */
  const [editVideoRow, setEditVideoRow] = React.useState<TemuProductRow | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void getPriorityShipLinksAction(store).then((r) => {
      if (!cancelled) setPrioritySkcs(new Set(r.skcIds))
    })
    void getStopReplenishLinksAction(store).then((r) => {
      if (!cancelled) setStoppedSkcs(new Set(r.skcIds))
    })
    return () => {
      cancelled = true
    }
  }, [store])

  const togglePriority = async (r: TemuProductRow) => {
    const isPriority = prioritySkcs.has(r.productSkcId)
    const res = isPriority
      ? await unsetPriorityShipAction({ storeId: r.storeId ?? "", productSkcId: r.productSkcId })
      : await setPriorityShipAction({
          storeId: r.storeId ?? "",
          productSkcId: r.productSkcId,
          productSn: r.productSn,
          productName: r.productName,
        })
    if (res.ok) {
      setPrioritySkcs((prev) => {
        const next = new Set(prev)
        if (isPriority) next.delete(r.productSkcId)
        else next.add(r.productSkcId)
        return next
      })
      toast.success(isPriority ? "已取消优先发货" : "已设为优先发货")
    } else {
      toast.error(res.error)
    }
  }

  const toggleStopped = async (r: TemuProductRow) => {
    const isStopped = stoppedSkcs.has(r.productSkcId)
    const res = isStopped
      ? await unsetStopReplenishAction({ storeId: r.storeId ?? "", productSkcId: r.productSkcId })
      : await setStopReplenishAction({
          storeId: r.storeId ?? "",
          productSkcId: r.productSkcId,
          productSn: r.productSn,
          productName: r.productName,
        })
    if (res.ok) {
      setStoppedSkcs((prev) => {
        const next = new Set(prev)
        if (isStopped) next.delete(r.productSkcId)
        else next.add(r.productSkcId)
        return next
      })
      toast.success(
        isStopped
          ? "已取消停止补货"
          : "已设为停止补货：备货自动操作（申报/加入发货）将排除该链接",
      )
    } else {
      toast.error(res.error)
    }
  }
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
      const r = await getTemuProductsPageAction(store, q, sale, next, sort, qf, app)
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
  }, [store, q, qf, sale, sort, app])

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
        <TableHeader className={TEMU_TABLE_HEADER_CLASS}>
          <TableRow className="">
            <TableHead className="w-8" />
            <TableHead>主图</TableHead>
            <TableHead>SKC</TableHead>
            <TableHead>商品名</TableHead>
            <TableHead>货号</TableHead>
            <TableHead>申报价格</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>今日销量</TableHead>
            <TableHead>七日销量</TableHead>
            <TableHead>三十日销量</TableHead>
            <TableHead>可售天数</TableHead>
            <TableHead>库存数据</TableHead>
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
                    <ZoomableImage
                      src={temuImageSrc(r.mainImageCosUrl, r.mainImageUrl)}
                      className="size-10 rounded object-cover"
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
                <TableCell className="tabular-nums">
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
                <TableCell className="tabular-nums">{sales?.todaySalesVolume ?? <EmptyHint />}</TableCell>
                <TableCell className="tabular-nums">
                  {sales?.extra.last7DaysSalesVolume ?? <EmptyHint />}
                </TableCell>
                <TableCell className="tabular-nums">
                  {sales?.extra.last30DaysSalesVolume ?? <EmptyHint />}
                </TableCell>
                <TableCell className="tabular-nums">
                  {sales?.availableSaleDays != null ? Math.round(sales.availableSaleDays) : <EmptyHint />}
                </TableCell>
                <TableCell className="tabular-nums">
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
                    {skuRows.length > 0 && (
                      <SkuDetailSubtable
                        skus={skuRows}
                        row={r}
                        isPriority={prioritySkcs.has(r.productSkcId)}
                        onTogglePriority={() => void togglePriority(r)}
                        isStopped={stoppedSkcs.has(r.productSkcId)}
                        onToggleStopped={() => void toggleStopped(r)}
                        onEditImages={() => setEditImagesRow(r)}
                        onEditVideo={() => setEditVideoRow(r)}
                      />
                    )}
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
            ? (
              <span className="inline-flex items-center gap-1.5">
                <DashRing className="size-3.5" />
                加载中…
              </span>
            )
            : ""}
      </div>

      {/* 换图片弹窗（设置菜单入口；作用于所属链接） */}
      <ProductMediaEditDialog
        open={editImagesRow !== null}
        onOpenChange={(v) => {
          if (!v) setEditImagesRow(null)
        }}
        row={editImagesRow}
        storeId={editImagesRow?.storeId ?? store}
      />

      {/* 换视频弹窗（设置菜单入口；作用于所属链接 SPU） */}
      <ProductVideoEditDialog
        open={editVideoRow !== null}
        onOpenChange={(v) => {
          if (!v) setEditVideoRow(null)
        }}
        row={editVideoRow}
        storeId={editVideoRow?.storeId ?? store}
      />
    </>
  )
}
