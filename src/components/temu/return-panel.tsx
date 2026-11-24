"use client"

import * as React from "react"
import { RefreshCw } from "lucide-react"
import type { DateRange } from "react-day-picker"
import { toast } from "sonner"
import { DashRing } from "@/components/ui/dash-ring"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TEMU_TABLE_HEADER_CLASS } from "@/components/temu/table-header-style"
import { TablePagination } from "@/components/ui/table-pagination"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TemuSearchBar, type SearchBarField } from "@/components/temu/search-bar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getTemuReturnPackagesAction,
  getTemuReturnPackageDetailAction,
  getTemuReturnSkuDetailAction,
  type TemuReturnPackageRow,
  type TemuReturnDetailRow,
  type TemuReturnSkuRow,
} from "@/server/actions/temu-return"
import { formatDateTime as fmtMs } from "@/lib/datetime"
import { EmptyHint } from "@/components/temu/products-table"
import { TruncTip } from "@/components/temu/trunc-tip"
import { TableSkeletonRows } from "@/components/temu/table-skeleton"
import { normalizeSearchForSkuView } from "@/components/temu/return-search-normalize"
import { TemuDateRangeFilter } from "@/components/temu/date-range-filter"
import { localAddDays, localDaySpan, localDayString, localLastDays } from "@/lib/temu-bj-day"

/** SKU 明细视图出库时间范围上限（官方 returnpackagelist.get 超窗报 100000004
 *  「Participation time exceeds 31 day」——2026-10-29 真实店实测）；包裹主列表不受此限 */
const SKU_RANGE_MAX_DAYS = 31

/** 共享搜索条字段：包裹视图三字段 / SKU 视图两字段（官方入参，逗号分隔多值） */
const RETURN_PKG_SEARCH_FIELDS: SearchBarField[] = [
  { value: "express", label: "运单号", placeholder: "逗号分隔可多值…" },
  { value: "sub", label: "采购子单号", placeholder: "逗号分隔可多值…" },
  { value: "pkg", label: "退供包裹号", placeholder: "逗号分隔可多值…" },
]
const RETURN_SKU_SEARCH_FIELDS: SearchBarField[] = [
  { value: "sub", label: "采购子单号", placeholder: "逗号分隔可多值…" },
  { value: "pkg", label: "退供包裹号", placeholder: "逗号分隔可多值…" },
]

/**
 * 退货工作台（退供三件套 bg.refund.returnpackage*，实时 + 30s 缓存）：
 * 发货至仓库被退数据跟进——退供包裹列表（状态/原因/物流）+ 包裹 SKC 明细 +
 * 按出库时间窗的 SKU 明细视图（对账按货号，本地反查）。
 * 必填 supplierId 来自本地发货单（action 内解析，无发货数据时友好报错）。
 */
export function TemuReturnPanel({ store }: { store?: string }) {
  /** 视图：退供包裹（官方包裹粒度）/ SKU 明细（出库时间窗内 SKU 件数粒度） */
  const [view, setView] = React.useState<"packages" | "sku">("packages")
  const [status, setStatus] = React.useState<"all" | "1" | "2">("all")
  /** 出库时间范围（两端含）：默认近一周；两视图都恒带范围——官方无界查询报 100000001
   *  （结果超 5 万条）、SKU 明细窗口必填，故不提供清除。null=尚未初始化：挂载后
   *  layout effect 取默认值（渲染期取当前日期会与 SSR 不一致） */
  const [dateRange, setDateRange] = React.useState<DateRange | null>(null)
  React.useLayoutEffect(() => {
    setDateRange((r) => (r === null ? localLastDays(new Date(), 7) : r))
  }, [])
  /** 精确筛选（共享搜索条）：草稿态（输入中不触发），按钮/回车提交后才进查询 */
  const [draft, setDraft] = React.useState<{ field: string; keyword: string }>({
    field: "sub",
    keyword: "",
  })
  const [applied, setApplied] = React.useState<{ field: string; keyword: string }>({
    field: "sub",
    keyword: "",
  })
  const [pageNo, setPageNo] = React.useState(1)
  const [pkgRows, setPkgRows] = React.useState<TemuReturnPackageRow[]>([])
  const [skuRows, setSkuRows] = React.useState<TemuReturnSkuRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  const [detailPkg, setDetailPkg] = React.useState<TemuReturnPackageRow | null>(null)
  // 竞态守卫：视图/状态/时间窗/筛选连续切换时，后到的旧请求不得覆盖新请求结果
  //（与 quality-panel 同款；筛选与 Select 在 loading 期间不禁用，可并发在途）
  const loadReqRef = React.useRef(0)

  /** 切店（router.push 软导航、组件状态保留）时重置页码（quality-panel 同款） */
  const [prevStore, setPrevStore] = React.useState(store)
  if (prevStore !== store) {
    setPrevStore(store)
    setPageNo(1)
  }

  const load = React.useCallback(() => {
    // 日历单选（只点了起始日）按单日处理，与发货单列表「预约取货日期」同口径
    if (!store || dateRange === null || !dateRange.from) return
    const base = {
      store,
      pageNo,
      dateFrom: localDayString(dateRange.from),
      dateTo: localDayString(dateRange.to ?? dateRange.from),
    }
    startLoading(async () => {
      const reqId = ++loadReqRef.current
      const kw = applied.keyword.trim()
      const r =
        view === "packages"
          ? await getTemuReturnPackagesAction({
              ...base,
              ...(status === "all" ? {} : { status }),
              ...(view === "packages" && applied.field === "express" && kw
                ? { expressDeliverySn: kw }
                : {}),
              ...(applied.field === "sub" && kw ? { purchaseSubOrderSn: kw } : {}),
              ...(applied.field === "pkg" && kw ? { returnSupplierPackageNo: kw } : {}),
            })
          : await getTemuReturnSkuDetailAction({
              ...base,
              ...(applied.field === "sub" && kw ? { purchaseSubOrderSn: kw } : {}),
              ...(applied.field === "pkg" && kw ? { returnSupplierPackageNo: kw } : {}),
            })
      if (reqId !== loadReqRef.current) return
      if (r.ok) {
        if (view === "packages") setPkgRows(r.rows as TemuReturnPackageRow[])
        else setSkuRows(r.rows as TemuReturnSkuRow[])
        setTotal(r.total)
        setError(null)
      } else {
        if (view === "packages") setPkgRows([])
        else setSkuRows([])
        setTotal(0)
        setError(r.error)
      }
    })
  }, [store, view, status, dateRange, applied, pageNo])

  /** 改日期范围。日历已开 resetOnSelect（两步选区模型）：从完整范围点新的一天先得到
   *  只有起始日的中间态——原样保存（立即补结束日会让下一次点击变成「重新开始选」而
   *  选不出多天），中间态按单日查询（30s 缓存兜底）；空选区（点同一天取消）保持原范围。
   *  不开 resetOnSelect 时点击只会延长/截短现有范围，31 天满窗被截断逻辑原样弹回，
   *  窗口永远挪不到后面的月份。SKU 明细视图选满后超 31 天截到第 31 天并提示（官方窗口上限） */
  const onDateRangeChange = (range: DateRange | undefined) => {
    if (range?.from) {
      if (
        view === "sku" &&
        range.to &&
        localDaySpan(range.from, range.to) > SKU_RANGE_MAX_DAYS
      ) {
        toast.info(`SKU 明细时间范围最多 ${SKU_RANGE_MAX_DAYS} 天，已截到第 ${SKU_RANGE_MAX_DAYS} 天`, {
          duration: 6000,
        })
        setDateRange({ from: range.from, to: localAddDays(range.from, SKU_RANGE_MAX_DAYS - 1) })
      } else {
        setDateRange(range)
      }
      setPageNo(1)
    }
  }

  React.useEffect(load, [load])

  if (!store) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">退货</CardTitle>
          <p className="text-sm text-muted-foreground">请在右上角选择具体店铺后查看（退供接口按店铺 token 调用）。</p>
        </CardHeader>
      </Card>
    )
  }

  // 官方分页 pageNo 上限 200（schema 同口径）：封顶防点到 201 页收到 zod 英文报错
  const totalPages = Math.min(200, Math.max(1, Math.ceil(total / 20)))

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">
          {view === "packages" ? "退供包裹" : "SKU 明细"}（{total}
          {total > (view === "packages" ? pkgRows.length : skuRows.length)
            ? ` 条 · 第 ${pageNo}/${totalPages} 页`
            : " 条"}
          ）
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={[
              { value: "packages", label: "退供包裹" },
              { value: "sku", label: "SKU 明细" },
            ]}
            value={view}
            onValueChange={(v) => {
              if (v === "packages" || v === "sku") {
                setView(v)
                setPageNo(1)
                // SKU 明细视图窗口上限 31 天：已有范围越界时截到第 31 天
                if (
                  v === "sku" &&
                  dateRange?.from &&
                  dateRange.to &&
                  localDaySpan(dateRange.from, dateRange.to) > SKU_RANGE_MAX_DAYS
                ) {
                  toast.info(
                    `SKU 明细时间范围最多 ${SKU_RANGE_MAX_DAYS} 天，已截到第 ${SKU_RANGE_MAX_DAYS} 天`,
                    { duration: 6000 },
                  )
                  setDateRange({
                    from: dateRange.from,
                    to: localAddDays(dateRange.from, SKU_RANGE_MAX_DAYS - 1),
                  })
                }
                // SKU 视图无运单号字段：运单号原样改作采购子单号过滤几乎必然查空且
                // 无提示——字段归一到采购子单号并清空关键词（sub/pkg 两视图通用，保留）
                if (v === "sku") {
                  setDraft(normalizeSearchForSkuView)
                  setApplied(normalizeSearchForSkuView)
                }
              }
            }}
          >
            <SelectTrigger className="h-8 w-28 text-xs" aria-label="切换视图">
              <SelectValue>{view === "packages" ? "退供包裹" : "SKU 明细"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="packages">退供包裹</SelectItem>
              <SelectItem value="sku">SKU 明细</SelectItem>
            </SelectContent>
          </Select>
          {view === "packages" && (
            <Select value={status} onValueChange={(v) => v && setStatus(v as "all" | "1" | "2")}>
              <SelectTrigger className="h-8 w-28 text-xs" aria-label="包裹状态筛选">
                <SelectValue>
                  {status === "1" ? "待提货" : status === "2" ? "已出库" : "全部状态"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="1">待提货</SelectItem>
                <SelectItem value="2">已出库</SelectItem>
              </SelectContent>
            </Select>
          )}
          {/* 出库时间范围（默认近一周；SKU 明细视图选满后最多 31 天；resetOnSelect
              保证满窗时点新的一天能重开选区挪窗，见 onDateRangeChange 注释） */}
          <TemuDateRangeFilter
            value={dateRange ?? undefined}
            placeholder="出库日期"
            clearable={false}
            resetOnSelect
            onChange={onDateRangeChange}
          />
          {/* 精确筛选（共享搜索条，逗号分隔多值 → 官方数组参数）；按钮/回车触发 */}
          <TemuSearchBar
            fields={view === "packages" ? RETURN_PKG_SEARCH_FIELDS : RETURN_SKU_SEARCH_FIELDS}
            field={draft.field}
            onFieldChange={(v) => setDraft((d) => ({ ...d, field: v }))}
            keyword={draft.keyword}
            onKeywordChange={(v) => setDraft((d) => ({ ...d, keyword: v }))}
            onSearch={(f, kw) => {
              setDraft({ field: f, keyword: kw })
              setApplied({ field: f, keyword: kw })
              setPageNo(1)
            }}
            searching={loading}
            className="w-72"
          />
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={load} disabled={loading} aria-label="刷新退货列表">
            {loading ? <DashRing className="size-4" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto scrollbar-hide">
        {error ? (
          <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : (
          // overflow-clip 只按圆角裁剪（非滚动容器，sticky 表头仍锚定页侧 CardContent）
          <div className="w-max min-w-full overflow-clip rounded-md border">
            <table className="w-max min-w-full caption-bottom text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border">
              {view === "packages" ? (
                <>
                  <TableHeader className={TEMU_TABLE_HEADER_CLASS}>
                    <TableRow>
                      <TableHead>退供包裹号</TableHead>
                      <TableHead>采购子单号</TableHead>
                      <TableHead>运单号</TableHead>
                      <TableHead>退供数量</TableHead>
                      <TableHead>包裹状态</TableHead>
                      <TableHead>退供原因</TableHead>
                      <TableHead>物流方式</TableHead>
                      <TableHead>交接方式</TableHead>
                      <TableHead>付款方式</TableHead>
                      <TableHead>出库时间</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading && pkgRows.length === 0 && <TableSkeletonRows cols={11} />}
                    {!loading && pkgRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={11} className="h-20 text-center text-muted-foreground">
                          该筛选下暂无退供包裹（发货至仓库被退时产生）
                        </TableCell>
                      </TableRow>
                    )}
                    {pkgRows.map((r, i) => (
                      <TableRow key={`${r.returnSupplierPackageNo ?? ""}-${r.purchaseSubOrderSn ?? ""}-${i}`}>
                        <TableCell className="font-mono">{r.returnSupplierPackageNo ?? <EmptyHint />}</TableCell>
                        <TableCell className="font-mono">{r.purchaseSubOrderSn ?? <EmptyHint />}</TableCell>
                        <TableCell className="font-mono">{r.expressDeliverySn ?? <EmptyHint />}</TableCell>
                        <TableCell className="tabular-nums">{r.returnSupplierQuantity ?? <EmptyHint />}</TableCell>
                        <TableCell>
                          <StatusBadge desc={r.packageStatusDesc} />
                        </TableCell>
                        <TableCell className="max-w-44">
                          <TruncTip text={r.returnSupplierReasonDesc ?? ""} className="max-w-44" />
                        </TableCell>
                        <TableCell>{r.logisticsTypeDesc ?? <EmptyHint />}</TableCell>
                        <TableCell>{r.returnHandOverTypeDesc ?? <EmptyHint />}</TableCell>
                        <TableCell>{r.payMethodDesc ?? <EmptyHint />}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {r.outboundTime != null ? fmtMs(r.outboundTime) : <EmptyHint />}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            disabled={!r.returnSupplierPackageNo}
                            onClick={() => setDetailPkg(r)}
                          >
                            明细
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </>
              ) : (
                <>
                  <TableHeader className={TEMU_TABLE_HEADER_CLASS}>
                    <TableRow>
                      <TableHead>退供包裹号</TableHead>
                      <TableHead>货号 / 商品名</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>主销售规格</TableHead>
                      <TableHead>件数</TableHead>
                      <TableHead>出库时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading && skuRows.length === 0 && <TableSkeletonRows cols={6} />}
                    {!loading && skuRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                          该时间窗内暂无退供 SKU 明细
                        </TableCell>
                      </TableRow>
                    )}
                    {skuRows.map((r, i) => (
                      <TableRow key={`${r.packageSn ?? ""}-${r.productSkuId ?? ""}-${i}`}>
                        <TableCell className="font-mono">{r.packageSn ?? <EmptyHint />}</TableCell>
                        <TableCell className="max-w-56">
                          <div className="font-mono">{r.productSn ?? <EmptyHint />}</div>
                          <TruncTip text={r.productName ?? ""} className="max-w-56 text-muted-foreground" />
                        </TableCell>
                        <TableCell className="font-mono">{r.productSkuId ?? <EmptyHint />}</TableCell>
                        <TableCell>{r.mainSaleSpec ?? <EmptyHint />}</TableCell>
                        <TableCell className="tabular-nums">{r.quantity ?? <EmptyHint />}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {r.outboundTime != null ? fmtMs(r.outboundTime) : <EmptyHint />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </>
              )}
            </table>
          </div>
        )}
      </CardContent>
      <TablePagination
        className="justify-end border-t px-4 py-2"
        pageIndex={pageNo - 1}
        pageCount={totalPages}
        total={total}
        onPageChange={(i) => setPageNo(i + 1)}
        disabled={loading}
      />
      {detailPkg && (
        <ReturnDetailDialog store={store} pkg={detailPkg} onClose={() => setDetailPkg(null)} />
      )}
    </Card>
  )
}

/** 包裹状态徽章：官方只回文案（packageStatusDesc），按文案着色兜底未知值 */
function StatusBadge({ desc }: { desc: string | null }) {
  const label = desc ?? "—"
  const cls =
    desc?.includes("待提货")
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : desc?.includes("已出库")
        ? "bg-muted text-muted-foreground"
        : "bg-muted text-muted-foreground"
  return <Badge className={`rounded-[4px] ${cls}`}>{label}</Badge>
}

/** 退供包裹详情：SKC 明细（缩略图 + 本地反查货号/品名 + 规格 + 退供数量） */
function ReturnDetailDialog({
  store,
  pkg,
  onClose,
}: {
  store: string
  pkg: TemuReturnPackageRow
  onClose: () => void
}) {
  const [rows, setRows] = React.useState<TemuReturnDetailRow[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let alive = true
    void (async () => {
      const r = await getTemuReturnPackageDetailAction({
        store,
        returnSupplierPackageNo: pkg.returnSupplierPackageNo ?? "",
      })
      if (!alive) return
      if (r.ok) setRows(r.rows)
      else setError(r.error)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>退供包裹明细（{pkg.returnSupplierPackageNo ?? "—"}）</DialogTitle>
          <DialogDescription>
            采购子单 {pkg.purchaseSubOrderSn ?? "—"} · 退供数量 {pkg.returnSupplierQuantity ?? "—"} ·{" "}
            {pkg.returnSupplierReasonDesc ?? pkg.packageStatusDesc ?? ""}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto">
          {error ? (
            <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : !rows ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <DashRing className="size-4" /> 加载中…
            </p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">官方未返回该包裹的 SKC 明细</p>
          ) : (
            <table className="w-full caption-bottom text-xs">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 px-2">缩略图</TableHead>
                  <TableHead>货号 / 商品名</TableHead>
                  <TableHead>主销售规格</TableHead>
                  <TableHead>次销售规格</TableHead>
                  <TableHead>退供数量</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={r.productSkcId ?? i} className="hover:bg-transparent">
                    <TableCell className="px-2 py-1.5">
                      {r.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.thumbUrl} alt="" className="size-10 rounded object-cover" loading="lazy" />
                      ) : (
                        <div className="size-10 rounded bg-muted" />
                      )}
                    </TableCell>
                    <TableCell className="max-w-56">
                      <div className="font-mono">{r.productSn ?? <EmptyHint />}</div>
                      <TruncTip text={r.productName ?? ""} className="max-w-56 text-muted-foreground" />
                    </TableCell>
                    <TableCell>{r.mainSaleSpec ?? <EmptyHint />}</TableCell>
                    <TableCell>{r.secondarySaleSpec ?? <EmptyHint />}</TableCell>
                    <TableCell className="tabular-nums">{r.returnSupplierQuantity ?? <EmptyHint />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
