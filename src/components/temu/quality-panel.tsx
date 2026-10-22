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
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getTemuQualityInspectionsAction,
  getTemuQualityInspectionDetailAction,
  type TemuQcInspectionRow,
  type TemuQcDetail,
} from "@/server/actions/temu-fulfillment"

/**
 * 质检工作台（bg.goods.qualityinspection.get/detail，实时 + 30s 缓存）：
 * 平台仓质检结果跟进——列表（默认筛不合格）+ 详情（质检历史/疵点/尺码表）。
 * 参数表 2026-10-21 官方文档站实证（docs §8.17）：必填分页是 pageInfo 包装。
 */
export function TemuQualityPanel({ store }: { store?: string }) {
  const [filter, setFilter] = React.useState<"1" | "2" | "all">("2")
  const [pageNo, setPageNo] = React.useState(1)
  const [rows, setRows] = React.useState<TemuQcInspectionRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  const [detailBillId, setDetailBillId] = React.useState<number | null>(null)
  /** 切店（router.push 软导航、组件状态保留）时重置页码：若原店翻到第 N 页、新店
   *  不足 N 页，列表为空且分页条隐藏，用户被困空页。渲染期重置保证 load 只按第 1
   *  页发起，避免先按旧页码多发一次请求与第 1 页结果竞态。 */
  const [prevStore, setPrevStore] = React.useState(store)
  if (prevStore !== store) {
    setPrevStore(store)
    setPageNo(1)
  }

  const load = React.useCallback(() => {
    if (!store) return
    startLoading(async () => {
      const r = await getTemuQualityInspectionsAction({
        store,
        ...(filter === "all" ? {} : { skuQcResult: Number(filter) as 1 | 2 }),
        pageNo,
      })
      if (r.ok) {
        setRows(r.rows)
        setTotal(r.total)
        setError(null)
      } else {
        setRows([])
        setError(r.error)
      }
    })
  }, [store, filter, pageNo])

  React.useEffect(load, [load])

  if (!store) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">质检</CardTitle>
          <p className="text-sm text-muted-foreground">请在右上角选择具体店铺后查看（质检接口按店铺 token 调用）。</p>
        </CardHeader>
      </Card>
    )
  }

  const totalPages = Math.max(1, Math.ceil(total / 20))

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">
          质检（{total}
          {total > rows.length ? ` 条 · 第 ${pageNo}/${totalPages} 页` : " 条"}）
        </CardTitle>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={(v) => {
            if (v === "1" || v === "2" || v === "all") {
              setFilter(v)
              setPageNo(1)
            }
          }}>
            <SelectTrigger size="sm" className="h-9! w-36 text-xs" aria-label="质检结果筛选">
              <SelectValue>{filter === "2" ? "不合格" : filter === "1" ? "合格" : "全部结果"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2">不合格</SelectItem>
              <SelectItem value="1">合格</SelectItem>
              <SelectItem value="all">全部结果</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-9! text-xs" onClick={load} disabled={loading} aria-label="刷新质检列表">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto scrollbar-hide">
        {error ? (
          <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {loading ? "加载中…" : "该筛选下暂无质检记录（仅平台送检后产生）"}
          </p>
        ) : (
          <table className="w-max min-w-full caption-bottom text-sm">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>缩略图</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>商品名 / 类目</TableHead>
                <TableHead>采购单号</TableHead>
                <TableHead>结果更新时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.qcBillId ?? ""}-${r.productSkuId ?? ""}`}>
                  <TableCell>
                    {r.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.thumbUrl} alt="" className="size-10 rounded-md object-cover" loading="lazy" />
                    ) : (
                      <div className="size-10 rounded-md bg-muted" />
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-xs">{r.productSkuId ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{r.spec ?? "—"}</div>
                  </TableCell>
                  <TableCell className="max-w-56">
                    <div className="truncate text-xs">{r.skuName ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{r.catName ?? "—"}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.purchaseNo ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {r.qcResultUpdateTime ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      disabled={r.qcBillId == null}
                      onClick={() => setDetailBillId(r.qcBillId)}
                    >
                      详情
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </table>
        )}
      </CardContent>
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t px-4 py-2">
          <Button variant="outline" size="sm" disabled={pageNo <= 1 || loading} onClick={() => setPageNo((p) => p - 1)}>
            <ChevronLeft className="size-4" /> 上一页
          </Button>
          <span className="text-xs text-muted-foreground">
            {pageNo} / {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={pageNo >= totalPages || loading} onClick={() => setPageNo((p) => p + 1)}>
            下一页 <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
      {detailBillId != null && (
        <QcDetailDialog store={store} qcBillId={detailBillId} onClose={() => setDetailBillId(null)} />
      )}
    </Card>
  )
}

const QC_TYPE_LABEL: Record<number, string> = { 1: "质检单", 2: "稽查单", 3: "更正单" }

const fmtMs = (t: number | null) => {
  if (t == null) return "—"
  const ms = t < 1e12 ? t * 1000 : t
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false })
}

/** 质检详情：基本信息 + 质检历史时间线 + 疵点（含图）+ SKU 尺码表 */
function QcDetailDialog({
  store,
  qcBillId,
  onClose,
}: {
  store: string
  qcBillId: number
  onClose: () => void
}) {
  const [detail, setDetail] = React.useState<TemuQcDetail | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let alive = true
    void (async () => {
      const r = await getTemuQualityInspectionDetailAction({ store, qcBillId })
      if (!alive) return
      if (r.ok) setDetail(r.detail)
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
          <DialogTitle>质检详情（qcBillId {qcBillId}）</DialogTitle>
          <DialogDescription>平台仓质检结果：应检/次品/疵点明细与尺码实测。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto">
          {error ? (
            <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : !detail ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 加载中…
            </p>
          ) : detail.histories.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">官方未返回质检明细</p>
          ) : (
            /* 真实结构：每条质检历史内嵌完整明细（qcDetail 在 historyVOS 项内）——逐单据成卡 */
            detail.histories.map((h, i) => (
              <section key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded bg-muted px-1 py-0.5 text-muted-foreground">
                    {h.qcType != null ? QC_TYPE_LABEL[h.qcType] ?? `码 ${h.qcType}` : "单据"}
                  </span>
                  <span className="font-mono">{h.qcBillNo ?? "—"}</span>
                  <span className="text-muted-foreground">
                    {h.startTime ?? "—"} ~ {h.finishTime ?? "—"}
                  </span>
                  {h.qcResult != null && (
                    <span
                      className={
                        h.qcResult === 2
                          ? "font-medium text-red-600 dark:text-red-400"
                          : "font-medium text-emerald-600 dark:text-emerald-400"
                      }
                    >
                      {h.qcResult === 1 ? "合格" : h.qcResult === 2 ? "不合格" : `结果码 ${h.qcResult}`}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-3">
                  <Info label="应检数" value={h.expectQcQuantity != null ? String(h.expectQcQuantity) : null} />
                  <Info label="次品数" value={h.defectiveQcQuantity != null ? String(h.defectiveQcQuantity) : null} />
                  <Info label="发货单总量" value={h.totalQuantity != null ? String(h.totalQuantity) : null} />
                  <Info label="收货单号" value={h.receiptNo} />
                  <Info label="送检时间" value={fmtMs(h.deliveryQcTime)} />
                  <Info label="质检组别" value={h.qcGroupName} />
                </div>

                {h.skus.length > 0 && (
                  <table className="w-full caption-bottom text-xs">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="h-8 px-2">SKU</TableHead>
                        <TableHead>尺码</TableHead>
                        <TableHead className="text-right">应检</TableHead>
                        <TableHead className="text-right">次品</TableHead>
                        <TableHead className="text-right">总量</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {h.skus.map((s, j) => (
                        <TableRow key={j} className="hover:bg-transparent">
                          <TableCell className="px-2 py-1.5 font-mono">{s.productSkuId ?? "—"}</TableCell>
                          <TableCell>{s.sizeName ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.expectQcQuantity ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.defectiveQcQuantity ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.totalQuantity ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </table>
                )}

                {h.flaws.length > 0 && (
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-medium text-muted-foreground">疵点明细（{h.flaws.length}）</h4>
                    {h.flaws.map((f, j) => (
                      <div key={j} className="space-y-1 rounded-md border p-2.5 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{f.name ?? "疵点"}</span>
                          {f.degreeDesc && (
                            <span className="rounded bg-red-500/10 px-1 py-0.5 text-red-600 dark:text-red-400">
                              {f.degreeDesc}
                              {f.degree != null ? `（${f.degree}）` : ""}
                            </span>
                          )}
                          {f.productSkuIds.length > 0 && (
                            <span className="font-mono text-muted-foreground">SKU {f.productSkuIds.join("、")}</span>
                          )}
                        </div>
                        {f.desc && <p className="text-muted-foreground">{f.desc}</p>}
                        {f.remark && <p className="text-muted-foreground">备注：{f.remark}</p>}
                        {f.images.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {f.images.map((u, k) => (
                              <a key={k} href={u} target="_blank" rel="noreferrer">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={u} alt={`疵点图 ${k + 1}`} className="size-16 rounded-md border object-cover" loading="lazy" />
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {h.sizes.length > 0 && (
                  <table className="w-full caption-bottom text-xs">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="h-8 px-2">部位</TableHead>
                        <TableHead>尺码</TableHead>
                        <TableHead>实测</TableHead>
                        <TableHead>标准范围</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {h.sizes.map((s, j) => (
                        <TableRow key={j} className="hover:bg-transparent">
                          <TableCell className="px-2 py-1.5">{s.location ?? "—"}</TableCell>
                          <TableCell>{s.sizeName ?? "—"}</TableCell>
                          <TableCell>{s.minQcSize ?? "?"} ~ {s.maxQcSize ?? "?"}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {s.expectMinSize ?? "?"} ~ {s.expectMaxSize ?? "?"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </table>
                )}
              </section>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Info({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{value ?? "—"}</span>
    </div>
  )
}
