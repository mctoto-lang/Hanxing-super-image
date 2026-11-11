"use client"

import * as React from "react"
import { toast } from "sonner"
import { CircleCheck, CircleDashed, Loader2, RefreshCw, Warehouse } from "lucide-react"
import { type DateRange } from "react-day-picker"
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
import { TableSkeletonRows } from "@/components/temu/table-skeleton"
import { ZoomableImage } from "@/components/ui/zoomable-image"
import { ScrollJumpButtons } from "@/components/ui/scroll-jump-buttons"
import { temuImageSrc } from "@/lib/temu/image"
import { HistoryDateRangePicker } from "@/components/product-v2/history-date-range-picker"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatDateTime as fmtTs } from "@/lib/datetime"
import {
  getTemuSyncShipOrdersAction,
  syncTemuShipDeductAction,
  type TemuSyncShipOrderRow,
} from "@/server/actions/temu-ship"

/**
 * TEMU 发货单同步（库存出入面板子视图）：在 TEMU 官方后台直接发货的单子
 * 不经过本系统 packing.send，没有 ship_deduct 流水——此列表展示本地发货单快照，
 * 标注是否已扣减并附「扣减后库存」预览；人工核对后勾选一键补扣（幂等 per 单号，
 * 全店预检库存缺口，不足整体不动）。发货数量/状态独立成列（原混在发货信息格）；
 * 发货信息格竖排 发货仓库/收货仓库/预约物流；另有店铺列与发货仓库下拉筛选（选项=
 * 当前筛选结果中出现过的地址，随日期/状态/仅未同步收缩）。日期筛选默认昨日~今日（北京日界）。
 */

/** 北京今日（正午锚点：DateRange 返回本地 Date，保证 toLocaleDateString 稳定） */
function bjToday(offsetDays = 0): Date {
  const d = new Date(Date.now() + offsetDays * 86400_000)
  return new Date(
    `${d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })}T12:00:00`,
  )
}

/** Date → 北京日期串（yyyy-MM-dd） */
function toBjDay(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
}

/** 发货出库筛选（对齐发货页 STATUS_OPTIONS 语义；服务端映射 statusList） */
const STATUS_GROUP_OPTIONS = [
  { value: "pending", label: "待出库（待仓库收货）" },
  { value: "done", label: "已出库已收货" },
  { value: "all", label: "全部" },
]

/** 发货仓库筛选「全部仓库」哨兵（同发货页下拉口径） */
const WAREHOUSE_ALL = "__all__"

/** 单号列时间轴行：彩点 + 文案（同发货页 SnTimelineCell 口径） */
function TimelineItem({ color, text }: { color: string; text: string }) {
  return (
    <div className="flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
      <span className={`size-1.5 shrink-0 rounded-full ${color}`} />
      <span className="whitespace-nowrap">{text}</span>
    </div>
  )
}

export function MovementTemuSyncPanel({
  headerSlot,
}: {
  /** 行首插槽：视图切换下拉（与日期/刷新/同步按钮同排一行，由 movement-panel 传入） */
  headerSlot?: React.ReactNode
}) {
  const [range, setRange] = React.useState<DateRange | undefined>(() => ({
    from: bjToday(-1),
    to: bjToday(),
  }))
  const [statusGroup, setStatusGroup] = React.useState("pending")
  const [onlyUnsynced, setOnlyUnsynced] = React.useState(true)
  const [warehouse, setWarehouse] = React.useState(WAREHOUSE_ALL)
  const [warehouses, setWarehouses] = React.useState<Array<{ id: number; label: string }>>([])
  /** 见过的仓库标签缓存（state 而非 ref：渲染期 useMemo 要读它，ref 禁止渲染期访问）：
      换筛选后已选仓库可能不在新选项里，兜底显示用 */
  const [warehouseLabels, setWarehouseLabels] = React.useState(new Map<number, string>())
  const [rows, setRows] = React.useState<TemuSyncShipOrderRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [loading, startLoading] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  /** 勾选的未同步单（键 storeId|sn） */
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [confirming, setConfirming] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // 并发请求序号：首载 fresh 逐店实时拉官方 API（秒级）在途时改筛选会再发快查询，
  // 慢的旧响应后到不得覆盖新筛选的数据（口径同 movement-panel 的 loadSeqRef）
  const loadSeqRef = React.useRef(0)

  const load = React.useCallback((opts?: { fresh?: boolean }) => {
    setError(null)
    const seq = ++loadSeqRef.current
    startLoading(() => {
      void getTemuSyncShipOrdersAction({
        fromDay: range?.from ? toBjDay(range.from) : undefined,
        toDay: range?.to ? toBjDay(range.to) : undefined,
        statusGroup:
          statusGroup === "done" || statusGroup === "all" ? statusGroup : undefined,
        onlyUnsynced,
        warehouseId: warehouse !== WAREHOUSE_ALL ? Number(warehouse) : undefined,
        fresh: opts?.fresh ? true : undefined,
      }).then((r) => {
        // 旧响应后到（期间已再查）：丢弃，数据/报错留给最新请求
        if (seq !== loadSeqRef.current) return
        if (r.ok) {
          setRows(r.rows)
          setTotal(r.total)
          setWarehouses(r.warehouses)
          setWarehouseLabels((prev) => {
            const next = new Map(prev)
            for (const w of r.warehouses) next.set(w.id, w.label)
            return next
          })
          setSelected(new Set())
          if (r.freshStats && r.freshStats.missing > 0) {
            toast.info(`实时核对：${r.freshStats.missing} 单官方侧已移除，本地已置为「已取消」`)
          }
          if (r.freshWarning) toast.warning(r.freshWarning, { duration: 8000 })
        } else {
          setError(r.error)
          setRows([])
        }
      })
    })
  }, [range, statusGroup, onlyUnsynced, warehouse])

  // 进入子视图首载带 fresh 实时拉取官方最新单（面板随视图条件渲染，切入即 remount）；
  // 后续日期/状态/仓库等筛选变化重查不带 fresh（不打官方，口径同发货页列表）
  const firstLoadRef = React.useRef(true)
  React.useEffect(() => {
    load(firstLoadRef.current ? { fresh: true } : undefined)
    firstLoadRef.current = false
  }, [load])

  const unsyncedRows = rows.filter((r) => !r.synced)
  const selectableKeys = new Set(
    unsyncedRows.map((r) => `${r.storeId}|${r.deliveryOrderSn}`),
  )
  const allSelected =
    unsyncedRows.length > 0 &&
    unsyncedRows.every((r) => selected.has(`${r.storeId}|${r.deliveryOrderSn}`))
  const selectedRows = unsyncedRows.filter((r) =>
    selected.has(`${r.storeId}|${r.deliveryOrderSn}`),
  )

  // 仓库下拉选项：随筛选结果收缩；已选仓库缺席时用缓存标签兜底追加
  // （SelectValue 只渲染 items 里有的 label，缺项会显示裸 id）
  const warehouseItems = React.useMemo(() => {
    const items = [
      { value: WAREHOUSE_ALL, label: "全部仓库" },
      ...warehouses.map((w) => ({ value: String(w.id), label: w.label })),
    ]
    if (warehouse !== WAREHOUSE_ALL && !warehouses.some((w) => String(w.id) === warehouse)) {
      const id = Number(warehouse)
      items.push({ value: warehouse, label: warehouseLabels.get(id) ?? `地址 ${id}` })
    }
    return items
  }, [warehouses, warehouse, warehouseLabels])

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(selectableKeys))
  }
  const toggleOne = (r: TemuSyncShipOrderRow) => {
    const key = `${r.storeId}|${r.deliveryOrderSn}`
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const doSync = async () => {
    setSyncing(true)
    try {
      const r = await syncTemuShipDeductAction({
        orders: selectedRows.map((r) => ({ storeId: r.storeId, sn: r.deliveryOrderSn })),
      })
      if (r.ok) {
        toast.success(
          r.deducted > 0
            ? `已同步扣减 ${r.deducted} 张发货单（库存出入流水可查）`
            : "所选发货单均已扣减过，无需重复同步",
        )
        setConfirming(false)
        load()
      } else {
        toast.error(r.error, { duration: 6000 })
      }
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {headerSlot}
        <HistoryDateRangePicker value={range} onChange={setRange} size="sm" className="h-8" />
        <Select
          items={STATUS_GROUP_OPTIONS}
          value={statusGroup}
          onValueChange={(v) => setStatusGroup(v ?? "pending")}
        >
          <SelectTrigger className="h-8 w-40 text-xs" aria-label="发货出库筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_GROUP_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={warehouseItems}
          value={warehouse}
          onValueChange={(v) => setWarehouse(v ?? WAREHOUSE_ALL)}
        >
          <SelectTrigger className="h-8 w-40 text-xs" aria-label="发货仓库筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {warehouseItems.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex h-8 items-center gap-1.5 text-xs">
          <Checkbox checked={onlyUnsynced} onCheckedChange={(v) => setOnlyUnsynced(v === true)} />
          仅看未同步
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            共 {total} 张{onlyUnsynced ? "" : ` · 未同步 ${unsyncedRows.length} 张`}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => load({ fresh: true })}
            disabled={loading}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={selectedRows.length === 0}
            onClick={() => setConfirming(true)}
          >
            <Warehouse className="size-3.5" />
            同步扣减（{selectedRows.length}）
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        在 TEMU 官方后台直接发货的单子不经本系统装箱，库存未扣减；核对下方数量无误后勾选「同步扣减」，
        按主仓扣减并写「发货扣减」流水（已扣单自动跳过，不会重复扣）。进入本页与「刷新」会实时拉取
        官方最新单（最新一页落库 + 当前页单号核对并收敛已移除的单）；历史单据由后台同步兜底。
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto rounded-md border scrollbar-hide"
      >
        {/* 裸 table（ui Table 自带 overflow-x-auto 容器会废表头 sticky）；单元格竖线挂 table 标签（同 TEMU 表格口径） */}
        <table className="w-max min-w-full caption-bottom text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border">
          <TableHeader className={TEMU_TABLE_HEADER_CLASS}>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  disabled={unsyncedRows.length === 0}
                  aria-label="全选未同步"
                />
              </TableHead>
              <TableHead className="w-48">发货单号</TableHead>
              <TableHead className="w-44">商品信息</TableHead>
              <TableHead className="w-[4.5rem]">发货数量</TableHead>
              <TableHead className="w-28">店铺</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-56">发货信息</TableHead>
              <TableHead>
                <Tooltip>
                  <TooltipTrigger className="cursor-default">扣减后库存</TooltipTrigger>
                  <TooltipContent className="text-xs">
                    未同步单 = 货号当前库存 − 本单数量（预览）；已扣单 = 当前库存（已含扣减）。
                    同货号多张未同步单各自按当前库存预览。
                  </TooltipContent>
                </Tooltip>
              </TableHead>
              <TableHead>库存扣减</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              <TableSkeletonRows rows={8} cols={9} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-20 text-center text-muted-foreground">
                  {onlyUnsynced ? "所选条件下没有待同步的发货单" : "所选条件下没有发货单"}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const key = `${r.storeId}|${r.deliveryOrderSn}`
                const afterDeduct = r.synced
                  ? r.totalQty
                  : r.totalQty - (r.deliverSkcNum ?? 0)
                const img = temuImageSrc(r.mainImageCosUrl, r.mainImageUrl)
                return (
                  <TableRow key={key}>
                    <TableCell>
                      {r.synced ? (
                        <EmptyHint />
                      ) : (
                        <Checkbox
                          checked={selected.has(key)}
                          onCheckedChange={() => toggleOne(r)}
                          aria-label={`选择 ${r.deliveryOrderSn}`}
                        />
                      )}
                    </TableCell>
                    {/* 发货单号 + 时间轴（同发货页 SnTimelineCell：彩点小字） */}
                    <TableCell className="space-y-0.5">
                      <div className="font-mono font-medium">{r.deliveryOrderSn}</div>
                      {r.deliverTime && (
                        <TimelineItem color="bg-emerald-500" text={`已发货 ${fmtTs(r.deliverTime)}`} />
                      )}
                      {r.receiveTime && (
                        <TimelineItem color="bg-emerald-600" text={`已收货 ${fmtTs(r.receiveTime)}`} />
                      )}
                    </TableCell>
                    {/* 主图 + 备货单号/货号/SKC 竖排（同发货页 ProductInfoCell） */}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {img ? (
                          <ZoomableImage src={img} className="size-10 shrink-0 rounded object-cover" />
                        ) : (
                          <div className="size-10 shrink-0 rounded bg-muted" />
                        )}
                        <div className="min-w-0 space-y-0.5 text-[11px] leading-4">
                          <div className="truncate font-mono text-primary">
                            {r.subPurchaseOrderSn ?? <EmptyHint />}
                          </div>
                          <div className="truncate font-mono">
                            货号 {r.skcExtCode ?? <EmptyHint />}
                          </div>
                          {r.productSkcId != null && (
                            <div className="truncate text-muted-foreground">SKC {r.productSkcId}</div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    {/* 发货数量（原发货信息格拆出独立列，店铺列左侧） */}
                    <TableCell className="font-medium tabular-nums">
                      {r.deliverSkcNum ?? <EmptyHint />}
                    </TableCell>
                    {/* 店铺（跨店同单号去重后归属店） */}
                    <TableCell>
                      {r.storeName ? (
                        <TruncTip text={r.storeName} className="max-w-24" />
                      ) : (
                        <EmptyHint />
                      )}
                    </TableCell>
                    {/* 状态（彩点+文案，原发货信息格拆出独立列） */}
                    <TableCell>
                      <div className="flex items-center gap-1 text-[11px] leading-4">
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${r.status === 1 ? "bg-sky-500" : "bg-emerald-500"}`}
                        />
                        <span className="whitespace-nowrap text-muted-foreground">
                          {r.statusLabel}
                        </span>
                      </div>
                    </TableCell>
                    {/* 发货信息 label:value 竖排（同发货页 DeliverInfoCell） */}
                    <TableCell>
                      <div className="space-y-0.5 text-[11px] leading-4">
                        <div className="flex items-baseline gap-1">
                          <span className="shrink-0 text-muted-foreground">发货仓库：</span>
                          {r.deliveryAddressLabel ? (
                            <TruncTip text={r.deliveryAddressLabel} className="max-w-28" />
                          ) : (
                            <EmptyHint />
                          )}
                        </div>
                        <div className="flex items-baseline gap-1">
                          <span className="shrink-0 text-muted-foreground">收货仓库：</span>
                          {r.subWarehouseName ? (
                            <TruncTip text={r.subWarehouseName} className="max-w-28" />
                          ) : (
                            <EmptyHint />
                          )}
                        </div>
                        <div className="flex items-baseline gap-1">
                          <span className="shrink-0 text-muted-foreground">预约物流：</span>
                          {r.expressCompany || r.expressDeliverySn ? (
                            <span className="truncate">
                              {r.expressCompany ?? "—"}
                              {r.expressDeliverySn ? (
                                <span className="font-mono"> {r.expressDeliverySn}</span>
                              ) : null}
                            </span>
                          ) : (
                            <EmptyHint />
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell
                      className={`tabular-nums ${!r.synced && afterDeduct < 0 ? "font-medium text-red-600" : ""}`}
                    >
                      {afterDeduct}
                    </TableCell>
                    <TableCell>
                      {r.synced ? (
                        <Badge className="gap-0.5 rounded-[4px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                          <CircleCheck className="size-3" /> 已扣减
                        </Badge>
                      ) : (
                        <Badge className="gap-0.5 rounded-[4px] bg-amber-500/15 text-amber-700 dark:text-amber-400">
                          <CircleDashed className="size-3" /> 未同步
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </table>
      </div>

      {/* 跳顶/跳底：贴滚动容器外层右下角（容器双向 overflow 时 sticky 包含块会失效，同库存总览表口径） */}
      <ScrollJumpButtons containerRef={scrollRef} className="absolute z-10 ml-0 mr-0 mb-0" />

      {/* 同步确认弹窗：按货号汇总将扣数量 */}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>确认同步扣减库存</DialogTitle>
            <DialogDescription>
              {selectedRows.length} 张发货单将按主仓扣减并写「发货扣减」流水；任一货号库存不足时整体不执行。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 overflow-y-auto rounded-md border">
            <table className="w-full text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 px-3">货号</TableHead>
                  <TableHead>商品名</TableHead>
                  <TableHead>合计扣减</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.values(
                  selectedRows.reduce<Record<string, { code: string; name: string | null; qty: number }>>(
                    (acc, r) => {
                      const code = r.skcExtCode ?? "（无货号）"
                      const cur = acc[code] ?? { code, name: r.productName, qty: 0 }
                      cur.qty += r.deliverSkcNum ?? 0
                      acc[code] = cur
                      return acc
                    },
                    {},
                  ),
                ).map((g) => (
                  <TableRow key={g.code}>
                    <TableCell className="px-3 py-1.5 font-mono">{g.code}</TableCell>
                    <TableCell className="max-w-44 truncate whitespace-nowrap">
                      {g.name ? <TruncTip text={g.name} className="max-w-44" /> : <EmptyHint />}
                    </TableCell>
                    <TableCell className="tabular-nums">{g.qty}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={syncing}>
              取消
            </Button>
            <Button onClick={() => void doSync()} disabled={syncing}>
              {syncing ? <Loader2 className="size-4 animate-spin" /> : null}
              确认扣减
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
