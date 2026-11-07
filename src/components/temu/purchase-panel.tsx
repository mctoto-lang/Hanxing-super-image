"use client"

import * as React from "react"
import { toast } from "sonner"
import { Clock3, Flame, Loader2, PackageX, RefreshCw, Send, Truck, Zap } from "lucide-react"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TEMU_TABLE_HEADER_CLASS } from "@/components/temu/table-header-style"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ZoomableImage } from "@/components/ui/zoomable-image"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  getTemuPurchaseOrdersAction,
  cancelTemuPurchaseOrdersAction,
  type TemuPurchaseOrderRow,
} from "@/server/actions/temu-fulfillment"
import { addShipStagingAction, getShipInventoryRefAction } from "@/server/actions/temu-ship"
import { AutoApplyDialog, AutoJoinDialog, type AutoStockStore } from "./auto-stock-dialogs"
import { ProductNameCell, EmptyHint } from "@/components/temu/products-table"
import { TruncTip } from "@/components/temu/trunc-tip"
import { TableSkeletonRows } from "@/components/temu/table-skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { formatDateTime as fmtTs } from "@/lib/datetime"

/**
 * 备货工作台（官方 bg.purchaseorderv2.get / purchaseorder.cancel 实时拉取）：
 * - 列表：状态预设筛选（默认待办=待接单+已接单待发货）、货号、SKU 建议量/下单量、时效与标记
 * - 取消（仅早期状态，二次确认）；「自动操作」双弹窗（VMI 申报探测 / 一键创建发货单，均库存联动）
 * 写操作限企业管理员（action 内强制），取消走二次确认。
 */

const STATUS_OPTIONS = [
  { value: "todo", label: "待办（待接单+待发货）" },
  { value: "shipped", label: "已送货/已收货" },
  { value: "closed", label: "已验收及之后" },
  { value: "all", label: "全部状态" },
]

/** 备货类型筛选（客户端过滤已拉取行；stockingType 为出参，官方无入参过滤）：
 *  仅常规/海外两档切换，默认常规备货 */
const STOCKING_TYPE_OPTIONS = [
  { value: "0", label: "常规备货" },
  { value: "1", label: "海外备货" },
]

/** 可取消状态：待接单/已接单待发货（官方业务门槛，实测送货后报 100000002） */
function cancellable(row: TemuPurchaseOrderRow): boolean {
  return row.status === 0 || row.status === 1
}

/** 可加入发货台（创建发货单第一步）：官方标记 + 已接单状态 + 常规备货（staging.add 门槛；
 *  待接单(0) 无 API 可推进，需在卖家中心接单后才会出现按钮；海外备货(stockingType=1)
 *  勿创建发货单，与 AutoJoinDialog 过滤口径一致） */
function canJoinStage(row: TemuPurchaseOrderRow): boolean {
  return row.status === 1 && row.isCanJoinDeliverPlatform && row.stockingType !== 1
}

/** 取消按钮：同核价调价「拒绝」的红色描边口径（仅图标与文字着色） */
const CANCEL_BTN_CLS =
  "h-7 border-red-600/40 text-xs text-red-700 hover:bg-red-600/10 hover:text-red-700 dark:border-red-500/40 dark:text-red-400"

/** 最晚发货是否已超时（epoch 秒/毫秒同 formatDateTime 口径归一后与当前时刻比较；
 *  未超时=默认前景色（深色主题下白色）/ 已超时=黄） */
function latestOverdue(ts: number): boolean {
  return ts > 0 && (ts < 1e12 ? ts * 1000 : ts) < Date.now()
}

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

export function TemuPurchasePanel({
  store,
  stores,
}: {
  store?: string
  /** 企业内启用店铺（全部店铺视图下自动申报弹窗逐店扇出用，page 侧透传） */
  stores?: AutoStockStore[]
}) {
  /** 自动备货弹窗：apply=自动申报备货（在售链接探测上限批量申报）/
   *  create=自动创建备货（待接单单按量创建）；单店直查，全部店铺扇出（行级店铺归属） */
  const [autoDlg, setAutoDlg] = React.useState<"apply" | "create" | null>(null)
  const [status, setStatus] = React.useState("todo")
  const [stockType, setStockType] = React.useState("0")
  const [rows, setRows] = React.useState<TemuPurchaseOrderRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  /** 全部店铺视图下个别店铺失败（未录 token 等）不阻断，展示为部分失败提示 */
  const [partialErrors, setPartialErrors] = React.useState<Array<{ store: string; error: string }>>([])
  /** 库存参考（批次4）：货号 → 库存合计 + 已创建未装箱（充足/不足徽章参考） */
  const [invRef, setInvRef] = React.useState<Record<string, { totalQty: number; pendingUnpacked: number }>>({})
  const [loading, startLoading] = React.useTransition()
  const [canceling, setCanceling] = React.useState<Array<{ sn: string; storeId: string }> | null>(null)
  const [joining, setJoining] = React.useState<{ sn: string; storeId: string } | null>(null)
  const [joiningPending, setJoiningPending] = React.useState(false)

  React.useEffect(() => {
    const codes = [...new Set(rows.map((r) => r.productSn).filter((c): c is string => Boolean(c)))]
    if (codes.length === 0) {
      setInvRef({})
      return
    }
    let cancelled = false
    // 失败（ok:false 或传输层 reject）同样清空：刷新/换状态后同货号行不残留
    // 上一批的库存徽章；reject 静默吞掉，避免 unhandled rejection
    void getShipInventoryRefAction({ store, codes })
      .then((r) => {
        if (!cancelled) setInvRef(r.ok ? r.rows : {})
      })
      .catch(() => {
        if (!cancelled) setInvRef({})
      })
    return () => {
      cancelled = true
    }
  }, [rows, store])

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

  /** 备货类型筛选只作用于展示（拉取仍按状态预设整页取） */
  const visibleRows = rows.filter((r) => String(r.stockingType) === stockType)

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
            备货单（{visibleRows.length}）
            {total > rows.length && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                已加载 {rows.length} / 官方共 {total}（含全部备货类型）
              </span>
            )}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {/* 自动操作双弹窗：申报备货（单店直查，全部店铺扇出）+ 批量加入发货台（成功后跳发货页） */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="sm" className="h-8 text-xs" aria-label="自动操作">
                    <Zap className="size-4" /> 自动操作
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuItem onClick={() => setAutoDlg("apply")}>
                  <Send className="size-3.5" /> 自动申报备货
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAutoDlg("create")}>
                  <Truck className="size-3.5" /> 批量加入发货
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Select value={stockType} onValueChange={(v) => v && setStockType(v)}>
              <SelectTrigger className="h-8 w-28 text-xs" aria-label="备货类型筛选">
                <SelectValue>
                  {STOCKING_TYPE_OPTIONS.find((o) => o.value === stockType)?.label ?? stockType}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {STOCKING_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
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
            <table className="w-max min-w-full caption-bottom text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border">
              <TableHeader className={TEMU_TABLE_HEADER_CLASS}>
                <TableRow>
                  {/* 全列显式定宽（压缩口径：商品名/货号截断+Tooltip，目标主流屏免横向滚动）：
                      列宽由表头决定，不随筛选行集漂移（口径同 ship-panel/ship-staging） */}
                  <TableHead className="w-14">主图</TableHead>
                  <TableHead className="w-44">商品名</TableHead>
                  <TableHead className="w-24">货号</TableHead>
                  <TableHead className="w-28">子单号</TableHead>
                  <TableHead className="w-36">建议 / 下单 / 发货</TableHead>
                  <TableHead className="w-32">库存参考</TableHead>
                  <TableHead className="w-24 text-center">备货类型</TableHead>
                  <TableHead className="w-28 text-center">状态</TableHead>
                  <TableHead className="w-24 text-center">标记</TableHead>
                  {/* 单店筛选下店铺列冗余，隐藏让表格更紧凑 */}
                  {!store && <TableHead className="w-24">店铺</TableHead>}
                  <TableHead className="w-40">最晚发货</TableHead>
                  <TableHead className="w-36">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && rows.length === 0 && <TableSkeletonRows cols={store ? 11 : 12} />}
                {/* 空态按 visibleRows 判（备货类型为客户端过滤）：rows 非空但全被
                    类型筛掉时提示切换，避免表体整块空白无提示 */}
                {!loading && visibleRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={store ? 11 : 12} className="h-20 text-center text-muted-foreground">
                      {rows.length === 0
                        ? "当前筛选下暂无备货单"
                        : `当前筛选下暂无备货单（已加载 ${rows.length} 单均为${stockType === "1" ? "常规" : "海外"}备货，可切换备货类型）`}
                    </TableCell>
                  </TableRow>
                )}
                {visibleRows.map((r) => {
                  return (
                    <TableRow key={r.subPurchaseOrderSn}>
                      <TableCell>
                        {r.productPicture ? (
                          <ZoomableImage src={r.productPicture} className="size-10 rounded object-cover" />
                        ) : (
                          <div className="size-10 rounded bg-muted" />
                        )}
                      </TableCell>
                      <TableCell className="max-w-40">
                        <ProductNameCell name={r.productName} />
                        {r.category && (
                          <TruncTip text={r.category} className="max-w-40 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell className="max-w-24 font-mono text-xs">
                        <TruncTip text={r.productSn ?? ""} className="max-w-24 font-mono" />
                      </TableCell>
                      <TableCell className="max-w-28 font-mono text-xs">
                        <TruncTip text={r.subPurchaseOrderSn} className="max-w-28 font-mono">
                          {r.subPurchaseOrderSn}
                          {r.originalPurchaseOrderSn && (
                            <span className="block truncate text-muted-foreground">{r.originalPurchaseOrderSn}</span>
                          )}
                        </TruncTip>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        <span className="tabular-nums">
                          <span className="text-muted-foreground">建议 </span>{r.adviceTotal ?? <EmptyHint />}
                          <span className="text-muted-foreground"> · 下单 </span>{r.purchaseTotal ?? <EmptyHint />}
                          <span className="text-muted-foreground"> · 发货 </span>{r.deliverTotal ?? <EmptyHint />}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {(() => {
                          const ref = r.productSn ? invRef[r.productSn] : undefined
                          if (!ref) return <EmptyHint center />
                          const toDeliver = Math.max(0, (r.purchaseTotal ?? 0) - (r.deliverTotal ?? 0))
                          const okStock = ref.totalQty >= toDeliver && toDeliver > 0
                          const lack = toDeliver > 0 && ref.totalQty < toDeliver
                          return (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="inline-flex cursor-default items-center gap-1 tabular-nums">
                                    {ref.totalQty}
                                    {lack ? (
                                      <Badge className="rounded-[4px] bg-red-500/15 px-1 text-[10px] text-red-700 dark:text-red-400">
                                        库存不足
                                      </Badge>
                                    ) : okStock ? (
                                      <Badge className="rounded-[4px] bg-emerald-500/15 px-1 text-[10px] text-emerald-700 dark:text-emerald-400">
                                        库存充足
                                      </Badge>
                                    ) : null}
                                  </span>
                                }
                              />
                              <TooltipContent className="max-w-72">
                                库存 {ref.totalQty} · 待发货 {toDeliver}
                                {lack ? ` · 缺 ${toDeliver - ref.totalQty}` : ""} · 已创建未装箱 {ref.pendingUnpacked}
                              </TooltipContent>
                            </Tooltip>
                          )
                        })()}
                      </TableCell>
                      <TableCell className="text-center">
                        {r.stockingType === 1 ? (
                          <Badge className="rounded-[4px] bg-violet-500/15 text-violet-700 dark:text-violet-400">海外备货</Badge>
                        ) : (
                          <Badge className="rounded-[4px] bg-blue-500/15 text-blue-700 dark:text-blue-400">常规备货</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusBadge status={r.status} label={r.statusLabel} />
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex flex-wrap justify-center gap-1">
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
                      {!store && (
                        <TableCell className="max-w-24 truncate whitespace-nowrap text-xs">{r.storeName}</TableCell>
                      )}
                      <TableCell className="whitespace-nowrap text-xs">
                        {r.expectLatestDeliverTime != null ? (
                          <span
                            className={`inline-flex items-center gap-1 ${
                              cancellable(r) && latestOverdue(r.expectLatestDeliverTime)
                                ? "text-amber-600 dark:text-amber-400"
                                : ""
                            }`}
                          >
                            <Clock3 className="size-3" />
                            {fmtTs(r.expectLatestDeliverTime)}
                          </span>
                        ) : (
                          <EmptyHint center />
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-end gap-1">
                          {canJoinStage(r) && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={() => setJoining({ sn: r.subPurchaseOrderSn, storeId: r.storeId })}
                                  >
                                    <Truck className="size-3.5" /> 创建
                                  </Button>
                                }
                              />
                              <TooltipContent>加入发货台（创建发货单第一步）</TooltipContent>
                            </Tooltip>
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

      {/* 自动备货双弹窗（单店直查/全部店铺扇出；申报/创建成功后刷新备货单列表） */}
      {autoDlg === "apply" && (
        <AutoApplyDialog
          store={store}
          stores={stores ?? []}
          onClose={() => setAutoDlg(null)}
          onApplied={load}
        />
      )}
      {autoDlg === "create" && (
        <AutoJoinDialog store={store} onClose={() => setAutoDlg(null)} onCreated={load} />
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
