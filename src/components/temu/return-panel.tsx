"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
import { Input } from "@/components/ui/input"
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

/** 出库时间窗预设按视图区分：退供包裹 30/90/365；SKU 明细上限 31 天（官方 100000004） */
const PKG_WINDOWS = [
  { value: "30", label: "近30天" },
  { value: "90", label: "近90天" },
  { value: "365", label: "近365天" },
] as const
const SKU_WINDOWS = [
  { value: "7", label: "近7天" },
  { value: "30", label: "近30天" },
  { value: "31", label: "近31天" },
] as const
type Win = "30" | "90" | "365" | "7" | "31"
const WIN_LABEL: Record<Win, string> = {
  "7": "近7天",
  "30": "近30天",
  "31": "近31天",
  "90": "近90天",
  "365": "近365天",
}

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
  const [win, setWin] = React.useState<Win>("90")
  /** 精确筛选：草稿态（输入中不触发），回车/失焦提交后才进查询 */
  const [draft, setDraft] = React.useState({ express: "", sub: "", pkg: "" })
  const [applied, setApplied] = React.useState({ express: "", sub: "", pkg: "" })
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
    if (!store) return
    // SKU 视图窗口上限 31 天：状态切换时已收敛，这里兜底窄化给 action 签名
    const skuWin: "7" | "30" | "31" = SKU_WINDOWS.some((o) => o.value === win)
      ? (win as "7" | "30" | "31")
      : "30"
    const pkgWin: "30" | "90" | "365" = PKG_WINDOWS.some((o) => o.value === win)
      ? (win as "30" | "90" | "365")
      : "90"
    startLoading(async () => {
      const reqId = ++loadReqRef.current
      const base = { store, pageNo }
      const r =
        view === "packages"
          ? await getTemuReturnPackagesAction({
              ...base,
              window: pkgWin,
              ...(status === "all" ? {} : { status }),
              ...(applied.express ? { expressDeliverySn: applied.express } : {}),
              ...(applied.sub ? { purchaseSubOrderSn: applied.sub } : {}),
              ...(applied.pkg ? { returnSupplierPackageNo: applied.pkg } : {}),
            })
          : await getTemuReturnSkuDetailAction({
              ...base,
              window: skuWin,
              ...(applied.pkg ? { returnSupplierPackageNo: applied.pkg } : {}),
              ...(applied.sub ? { purchaseSubOrderSn: applied.sub } : {}),
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
  }, [store, view, status, win, applied, pageNo])

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
  const commitDraft = () => {
    setApplied(draft)
    setPageNo(1)
  }

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
                // 视图切换后时间窗预设集合不同（SKU 上限 31 天），越界回落默认
                setWin((w) =>
                  v === "sku"
                    ? SKU_WINDOWS.some((o) => o.value === w)
                      ? w
                      : "30"
                    : PKG_WINDOWS.some((o) => o.value === w)
                      ? w
                      : "90",
                )
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
          <Select value={win} onValueChange={(v) => v && setWin(v as Win)}>
            <SelectTrigger className="h-8 w-28 text-xs" aria-label="出库时间窗">
              <SelectValue>{WIN_LABEL[win]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(view === "packages" ? PKG_WINDOWS : SKU_WINDOWS).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* 精确筛选（逗号分隔多值 → 官方数组参数）；回车提交避免逐键触发查询 */}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              commitDraft()
            }}
          >
            {view === "packages" && (
              <Input
                value={draft.express}
                onChange={(e) => setDraft((d) => ({ ...d, express: e.target.value }))}
                placeholder="运单号，逗号分隔"
                className="h-8 w-36 text-xs"
                aria-label="按运单号筛选"
              />
            )}
            <Input
              value={draft.sub}
              onChange={(e) => setDraft((d) => ({ ...d, sub: e.target.value }))}
              placeholder="采购子单号，逗号分隔"
              className="h-8 w-36 text-xs"
              aria-label="按采购子单号筛选"
            />
            <Input
              value={draft.pkg}
              onChange={(e) => setDraft((d) => ({ ...d, pkg: e.target.value }))}
              placeholder="退供包裹号，逗号分隔"
              className="h-8 w-36 text-xs"
              aria-label="按退供包裹号筛选"
            />
            <Button type="submit" variant="outline" size="sm" className="h-8 text-xs">
              筛选
            </Button>
          </form>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={load} disabled={loading} aria-label="刷新退货列表">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
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
            <table className="w-max min-w-full caption-bottom text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border [&_th:not(:first-child)]:border-l [&_th:not(:first-child)]:border-border">
              {view === "packages" ? (
                <>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead>退供包裹号</TableHead>
                      <TableHead>采购子单号</TableHead>
                      <TableHead>运单号</TableHead>
                      <TableHead className="text-right">退供数量</TableHead>
                      <TableHead>包裹状态</TableHead>
                      <TableHead>退供原因</TableHead>
                      <TableHead>物流方式</TableHead>
                      <TableHead>交接方式</TableHead>
                      <TableHead>付款方式</TableHead>
                      <TableHead>出库时间</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pkgRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={11} className="h-20 text-center text-muted-foreground">
                          {loading ? "加载中…" : "该筛选下暂无退供包裹（发货至仓库被退时产生）"}
                        </TableCell>
                      </TableRow>
                    )}
                    {pkgRows.map((r, i) => (
                      <TableRow key={`${r.returnSupplierPackageNo ?? ""}-${r.purchaseSubOrderSn ?? ""}-${i}`}>
                        <TableCell className="font-mono">{r.returnSupplierPackageNo ?? <EmptyHint />}</TableCell>
                        <TableCell className="font-mono">{r.purchaseSubOrderSn ?? <EmptyHint />}</TableCell>
                        <TableCell className="font-mono">{r.expressDeliverySn ?? <EmptyHint />}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.returnSupplierQuantity ?? <EmptyHint />}</TableCell>
                        <TableCell>
                          <StatusBadge desc={r.packageStatusDesc} />
                        </TableCell>
                        <TableCell className="max-w-44">
                          <div className="truncate" title={r.returnSupplierReasonDesc ?? undefined}>
                            {r.returnSupplierReasonDesc ?? <EmptyHint />}
                          </div>
                        </TableCell>
                        <TableCell>{r.logisticsTypeDesc ?? <EmptyHint />}</TableCell>
                        <TableCell>{r.returnHandOverTypeDesc ?? <EmptyHint />}</TableCell>
                        <TableCell>{r.payMethodDesc ?? <EmptyHint />}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {r.outboundTime != null ? fmtMs(r.outboundTime) : <EmptyHint />}
                        </TableCell>
                        <TableCell className="text-right">
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
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead>退供包裹号</TableHead>
                      <TableHead>货号 / 商品名</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>主销售规格</TableHead>
                      <TableHead className="text-right">件数</TableHead>
                      <TableHead>出库时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {skuRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                          {loading ? "加载中…" : "该时间窗内暂无退供 SKU 明细"}
                        </TableCell>
                      </TableRow>
                    )}
                    {skuRows.map((r, i) => (
                      <TableRow key={`${r.packageSn ?? ""}-${r.productSkuId ?? ""}-${i}`}>
                        <TableCell className="font-mono">{r.packageSn ?? <EmptyHint />}</TableCell>
                        <TableCell className="max-w-56">
                          <div className="font-mono">{r.productSn ?? <EmptyHint />}</div>
                          <div className="truncate text-muted-foreground" title={r.productName ?? undefined}>
                            {r.productName ?? <EmptyHint />}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono">{r.productSkuId ?? <EmptyHint />}</TableCell>
                        <TableCell>{r.mainSaleSpec ?? <EmptyHint />}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.quantity ?? <EmptyHint />}</TableCell>
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
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t px-4 py-2">
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={pageNo <= 1 || loading} onClick={() => setPageNo((p) => p - 1)}>
            <ChevronLeft className="size-3.5" /> 上一页
          </Button>
          <span className="text-xs text-muted-foreground">
            {pageNo} / {totalPages}
          </span>
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={pageNo >= totalPages || loading} onClick={() => setPageNo((p) => p + 1)}>
            下一页 <ChevronRight className="size-3.5" />
          </Button>
        </div>
      )}
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
              <Loader2 className="size-4 animate-spin" /> 加载中…
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
                  <TableHead className="text-right">退供数量</TableHead>
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
                      <div className="truncate text-muted-foreground" title={r.productName ?? undefined}>
                        {r.productName ?? <EmptyHint />}
                      </div>
                    </TableCell>
                    <TableCell>{r.mainSaleSpec ?? <EmptyHint />}</TableCell>
                    <TableCell>{r.secondarySaleSpec ?? <EmptyHint />}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.returnSupplierQuantity ?? <EmptyHint />}</TableCell>
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
