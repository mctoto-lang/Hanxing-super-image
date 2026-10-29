"use client"

import * as React from "react"
import { toast } from "sonner"
import { Clock3, Flame, Loader2, PackageX, RefreshCw, Truck } from "lucide-react"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  getTemuPurchaseOrdersAction,
  cancelTemuPurchaseOrdersAction,
  type TemuPurchaseOrderRow,
} from "@/server/actions/temu-fulfillment"
import { addShipStagingAction } from "@/server/actions/temu-ship"
import { StockView } from "./stock-view"
import { ProductNameCell, EmptyHint } from "@/components/temu/products-table"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { formatDateTime as fmtTs } from "@/lib/datetime"

/**
 * 备货工作台（官方 bg.purchaseorderv2.get / purchaseorder.cancel 实时拉取）：
 * - 列表：状态预设筛选（默认待办=待接单+已接单待发货）、货号、SKU 建议量/下单量、时效与标记
 * - 取消（仅早期状态，二次确认）；申报备货（VMI 批量/自动）在子视图 StockView
 * 写操作限企业管理员（action 内强制），取消走二次确认。
 */

const STATUS_OPTIONS = [
  { value: "todo", label: "待办（待接单+待发货）" },
  { value: "shipped", label: "已送货/已收货" },
  { value: "closed", label: "已验收及之后" },
  { value: "all", label: "全部状态" },
]

/** 可取消状态：待接单/已接单待发货（官方业务门槛，实测送货后报 100000002） */
function cancellable(row: TemuPurchaseOrderRow): boolean {
  return row.status === 0 || row.status === 1
}

/** 可加入发货台（创建发货单第一步）：官方标记 + 已接单状态（staging.add 门槛；
 *  待接单(0) 无 API 可推进，需在卖家中心接单后才会出现按钮） */
function canJoinStage(row: TemuPurchaseOrderRow): boolean {
  return row.status === 1 && row.isCanJoinDeliverPlatform
}

/** 取消按钮：同核价调价「拒绝」的红色描边口径（仅图标与文字着色） */
const CANCEL_BTN_CLS =
  "h-7 border-red-600/40 text-xs text-red-700 hover:bg-red-600/10 hover:text-red-700 dark:border-red-500/40 dark:text-red-400"

function StatusBadge({ status, label }: { status: number; label: string }) {
  const cls =
    status === 0 || status === 1
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
      : status === 2 || status === 3
        ? "bg-sky-500/15 text-sky-700 dark:text-sky-400"
        : status === 8 || status === 9 || status === 10 || status === 4 || status === 5
          ? "bg-red-500/15 text-red-700 dark:text-red-400"
          : "bg-muted text-muted-foreground"
  return <Badge className={`rounded-[4px] ${cls}`}>{label}</Badge>
}

export function TemuPurchasePanel({ store }: { store?: string }) {
  /** 视图：备货单（平台下的采购单）/ 申报备货（对商品主动申请新备货，VMI）。
   *  store 缺省=全部店铺（扇出合并视图，行级带店铺列；申报备货需具体店，此时不可进） */
  const [view, setView] = React.useState<"orders" | "stock">("orders")
  const [status, setStatus] = React.useState("todo")
  const [rows, setRows] = React.useState<TemuPurchaseOrderRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  /** 全部店铺视图下个别店铺失败（未录 token 等）不阻断，展示为部分失败提示 */
  const [partialErrors, setPartialErrors] = React.useState<Array<{ store: string; error: string }>>([])
  const [loading, startLoading] = React.useTransition()
  const [canceling, setCanceling] = React.useState<Array<{ sn: string; storeId: string }> | null>(null)
  const [joining, setJoining] = React.useState<{ sn: string; storeId: string } | null>(null)
  const [joiningPending, setJoiningPending] = React.useState(false)

  const load = React.useCallback(() => {
    startLoading(async () => {
      const r = await getTemuPurchaseOrdersAction({ status, ...(store ? { store } : {}) })
      if (r.ok) {
        setRows(r.rows)
        setTotal(r.total)
        setPartialErrors(r.errors ?? [])
        setError(null)
      } else {
        setRows([])
        setPartialErrors([])
        setError(r.error)
      }
    })
  }, [store, status])

  React.useEffect(load, [load])

  if (!store && view === "stock") {
    // 全部店铺下不可进申报备货（候选池按店查询）——防御性回落
    setView("orders")
  }

  if (store && view === "stock") {
    return <StockView store={store} onBack={() => setView("orders")} />
  }

  const doJoinStage = async (storeId: string, sn: string) => {
    setJoiningPending(true)
    try {
      const r = await addShipStagingAction({ store: storeId, subPurchaseOrderSns: [sn] })
      if (!r.ok) {
        toast.error(r.error, { duration: 6000 })
        return
      }
      if (r.errors.length > 0) {
        toast.warning(`加入发货台失败：${r.errors[0]?.reason ?? "官方未返回原因"}`, { duration: 8000 })
      } else {
        toast.success(`已加入发货台，可在「发货」页向导继续创建发货单`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败", { duration: 6000 })
    } finally {
      setJoiningPending(false)
      setJoining(null)
      load()
    }
  }

  /** 批量取消：全部店铺视图下勾选行可能跨店——按行级 storeId 分组逐店调用 */
  const doCancel = async (items: Array<{ sn: string; storeId: string }>) => {
    try {
      let okCount = 0
      const failed: Array<{ sn: string; reason: string }> = []
      const hardErrors: string[] = []
      for (const [storeId, group] of Object.entries(
        items.reduce<Record<string, string[]>>((acc, it) => {
          ;(acc[it.storeId] ??= []).push(it.sn)
          return acc
        }, {}),
      )) {
        const r = await cancelTemuPurchaseOrdersAction({ store: storeId, subPurchaseOrderSns: group })
        if (r.ok) {
          okCount += group.length - r.failed.length
          failed.push(...r.failed)
        } else {
          hardErrors.push(r.error)
        }
      }
      if (hardErrors.length > 0) {
        toast.error(hardErrors[0] ?? "操作失败", { duration: 6000 })
      } else if (failed.length > 0) {
        toast.warning(`取消完成：${okCount} 成功 / ${failed.length} 失败`, { duration: 8000 })
        for (const f of failed) toast.error(`${f.sn || "单据"}：${f.reason}`, { duration: 8000 })
      } else {
        toast.success(`已取消 ${okCount} 个备货单`)
      }
    } catch (e) {
      // action 内权限校验等以 throw 结束（不走 {ok:false} 分支）：提示错误并
      // 复位——确认弹窗随之关闭，pending 不再永久卡死
      toast.error(e instanceof Error ? e.message : "操作失败", { duration: 6000 })
    } finally {
      setCanceling(null)
      load()
    }
  }

  return (
    <>
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">
            备货单（{rows.length}
            {total > rows.length ? ` / 共 ${total}` : ""}）
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              items={
                store
                  ? [
                      { value: "orders", label: "备货单" },
                      { value: "stock", label: "申报备货" },
                    ]
                  : [{ value: "orders", label: "备货单" }]
              }
              value="orders"
              onValueChange={(v) => {
                if (v === "stock" && store) setView("stock")
              }}
            >
              <SelectTrigger className="h-8 w-28 text-xs" aria-label="切换视图">
                <SelectValue>备货单</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="orders">备货单</SelectItem>
                {store && <SelectItem value="stock">申报备货</SelectItem>}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => v && setStatus(v)}>
              <SelectTrigger className="h-8 w-44 text-xs" aria-label="备货单状态筛选">
                <SelectValue>{STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={load} disabled={loading} aria-label="刷新备货单">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-auto scrollbar-hide">
        {partialErrors.length > 0 && (
          <p className="mb-2 rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            部分店铺加载失败：{partialErrors.map((e) => `${e.store}（${e.error}）`).join("；")}
          </p>
        )}
        {error ? (
            <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : (
            // overflow-clip 只按圆角裁剪（非滚动容器，sticky 表头仍锚定页侧 CardContent）
            <div className="w-max min-w-full overflow-clip rounded-md border">
            <table className="w-max min-w-full caption-bottom text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border [&_th:not(:first-child)]:border-l [&_th:not(:first-child)]:border-border">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>主图</TableHead>
                  <TableHead>商品名</TableHead>
                  <TableHead>货号</TableHead>
                  <TableHead>子单号</TableHead>
                  <TableHead>SKU 明细</TableHead>
                  <TableHead className="text-right">建议量</TableHead>
                  <TableHead className="text-right">已下单</TableHead>
                  <TableHead className="text-right">已发货</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>标记</TableHead>
                  <TableHead>店铺</TableHead>
                  <TableHead>最晚发货</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={13} className="h-20 text-center text-muted-foreground">
                      {loading ? "加载中…" : "该状态下暂无备货单"}
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => {
                  return (
                    <TableRow key={r.subPurchaseOrderSn}>
                      <TableCell>
                        {r.productPicture ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.productPicture} alt="" className="size-10 rounded object-cover" loading="lazy" />
                        ) : (
                          <div className="size-10 rounded bg-muted" />
                        )}
                      </TableCell>
                      <TableCell className="max-w-56">
                        <ProductNameCell name={r.productName} />
                        {r.category && (
                          <p className="text-xs text-muted-foreground">{r.category}</p>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.productSn ?? <EmptyHint />}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.subPurchaseOrderSn}
                        {r.originalPurchaseOrderSn && (
                          <p className="text-muted-foreground">{r.originalPurchaseOrderSn}</p>
                        )}
                      </TableCell>
                      <TableCell className="max-w-56 text-xs">
                        {r.skuRows.length === 0
                          ? <EmptyHint />
                          : r.skuRows.length === 1
                            ? (r.skuRows[0]?.className ?? r.skuRows[0]?.productSkuId ?? <EmptyHint />)
                            : `${r.skuRows[0]?.className ?? r.skuRows[0]?.productSkuId ?? "—"} 等 ${r.skuRows.length} 个规格`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.adviceTotal ?? <EmptyHint />}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.purchaseTotal ?? <EmptyHint />}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.deliverTotal ?? <EmptyHint />}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} label={r.statusLabel} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {r.urgencyType === 1 && (
                            <Badge className="gap-0.5 rounded-[4px] bg-red-500/15 text-red-700 dark:text-red-400">
                              <Flame className="size-3" /> 紧急
                            </Badge>
                          )}
                          {r.lackTag && (
                            <Badge className="rounded-[4px] bg-orange-500/15 text-orange-700 dark:text-orange-400">缺货</Badge>
                          )}
                          {r.isCustomProduct && (
                            <Badge className="rounded-[4px] bg-violet-500/15 text-violet-700 dark:text-violet-400">定制</Badge>
                          )}
                          {r.todayCanDeliver && (
                            <Badge className="rounded-[4px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">今日可发</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{r.storeName}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Clock3 className="size-3" />
                          {r.expectLatestDeliverTime != null ? fmtTs(r.expectLatestDeliverTime) : <EmptyHint />}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {canJoinStage(r) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              title="加入发货台（创建发货单第一步）"
                              onClick={() => setJoining({ sn: r.subPurchaseOrderSn, storeId: r.storeId })}
                            >
                              <Truck className="size-3.5" /> 创建
                            </Button>
                          )}
                          {cancellable(r) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className={CANCEL_BTN_CLS}
                              onClick={() => setCanceling([{ sn: r.subPurchaseOrderSn, storeId: r.storeId }])}
                            >
                              <PackageX className="size-3.5" /> 取消
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 取消二次确认（渲染在 Card 外保持层级简单） */}
      {canceling && (
        <ConfirmCancel
          count={canceling.length}
          onConfirm={() => void doCancel(canceling)}
          onOpenChange={(v) => !v && setCanceling(null)}
        />
      )}

      {/* 加入发货台二次确认（官方无移出发货台接口，需确认） */}
      <ConfirmDialog
        open={joining != null}
        onOpenChange={(v) => !v && setJoining(null)}
        title="加入发货台"
        description={`将备货单 ${joining?.sn ?? ""} 加入发货台（创建发货单第一步）。官方无移出发货台接口，加入后请到「发货」页向导继续创建发货单。`}
        confirmText="确认加入"
        pending={joiningPending}
        onConfirm={() => {
          if (joining) void doJoinStage(joining.storeId, joining.sn)
        }}
      />
    </>
  )
}

function ConfirmCancel({
  count,
  onConfirm,
  onOpenChange,
}: {
  count: number
  onConfirm: () => void
  onOpenChange: (v: boolean) => void
}) {
  const [pending, setPending] = React.useState(false)
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>确认取消备货单</DialogTitle>
          <DialogDescription>
            将取消 {count} 个备货单。官方仅允许待接单/待接发货早期状态取消，送货后的单会失败并展示原因。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            再想想
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setPending(true)
              onConfirm()
            }}
          >
            {pending && <Loader2 className="animate-spin" />}
            确认取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
