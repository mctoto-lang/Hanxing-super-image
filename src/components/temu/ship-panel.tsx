"use client"

import * as React from "react"
import { toast } from "sonner"
import { Loader2, Printer, RefreshCw, TriangleAlert } from "lucide-react"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TEMU_TABLE_HEADER_CLASS } from "@/components/temu/table-header-style"
import { TablePagination } from "@/components/ui/table-pagination"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import {
  cancelShipOrderAction,
  changeShipLogisticsAction,
  editShipPackagesAction,
  getShipExpressNoteAction,
  getShipOrdersNeedingBarcodeAction,
  getShipPackagesAction,
  getShipWarehouseOptionsAction,
  getTemuShipOrdersAction,
  getThirdPartyLogisticsAction,
  type TemuExpressNoteItem,
  type TemuShipOrderRow,
} from "@/server/actions/temu-ship"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyHint } from "@/components/temu/products-table"
import { TruncTip } from "@/components/temu/trunc-tip"
import { TableSkeletonRows } from "@/components/temu/table-skeleton"
import {
  EXPRESS_REJECT_STATUS,
  EXPRESS_WEIGHT_FEEDBACK_STATUS,
  SHIP_DELIVERY_METHOD,
  SHIP_ORDER_STATUS,
} from "@/lib/temu-api/workbench-labels"
import { formatDateTime as fmtTs } from "@/lib/datetime"
import { ShipStaging, PackageSplitTable, type ShipPackageDraft } from "./ship-staging"
import {
  DeliverMethodTabs,
  PackingDialog,
  openShipBarcodePrint,
  openShipBoxMarkPage,
  requestShipBoxMark,
  type DeliverPayload,
} from "./ship-packing"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * 发货工作台（两视图）：「发货单列表」（本地落库列表，官方块状列：发货单号时间轴/
 * 商品信息/发货信息/包裹号/状态/链接式操作；待装箱+待仓库收货支持勾选批量）与
 * 「发货台」（备货单勾选 → 独立创建发货单视图）。装箱发货弹窗在待装箱态承接。
 */

const STATUS_OPTIONS = [
  { value: "pending", label: "待装箱发货" },
  { value: "shipping", label: "待仓库收货" },
  { value: "done", label: "已收货/已入库" },
  { value: "closed", label: "已退货/已取消" },
  { value: "partial", label: "部分收货" },
  { value: "all", label: "全部状态" },
]

const VIEW_OPTIONS = [
  { value: "staging", label: "发货台" },
  { value: "orders", label: "发货单列表" },
]

/** 绝对截止时间 → 「X小时Y分后自动取消」；过期返回「已到期」 */
const fmtCancelLeft = (iso: string | null): string | null => {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return null
  if (ms <= 0) return "已到期"
  const h = Math.floor(ms / 3_600_000)
  if (h >= 24) return `${Math.floor(h / 24)}天${h % 24}小时后自动取消`
  if (h >= 1) return `${h}小时${Math.floor((ms % 3_600_000) / 60_000)}分后自动取消`
  return `${Math.max(1, Math.floor(ms / 60_000))}分钟后自动取消`
}

function StatusBadge({ status }: { status: number }) {
  const label = SHIP_ORDER_STATUS[status] ?? `状态 ${status}`
  const dot =
    status === 0
      ? "bg-amber-500"
      : status === 1
        ? "bg-sky-500"
        : status === 2 || status === 3 || status === 6
          ? "bg-emerald-500"
          : "bg-red-500"
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

/** 商品信息块（官方图3/图4）：图 + 备货单号（链接色）+ 货号 + SKC + 标记（柔和底徽章） */
function ProductInfoCell({ row, needBarcode }: { row: TemuShipOrderRow; needBarcode?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      {row.productImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={row.productImageUrl} alt="" className="size-10 shrink-0 rounded object-cover" loading="lazy" />
      ) : (
        <div className="size-10 shrink-0 rounded bg-muted" />
      )}
      <div className="min-w-0">
        <p className="font-mono text-xs text-primary">{row.subPurchaseOrderSn ?? <EmptyHint />}</p>
        {row.skcExtCode ? (
          <TruncTip text={row.skcExtCode} className="mt-0.5 max-w-56 text-[11px]">
            <span>货号 {row.skcExtCode}</span>
          </TruncTip>
        ) : (
          <p className="mt-0.5 text-[11px]">货号 <EmptyHint /></p>
        )}
        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <span>SKC {row.productSkcId ?? <EmptyHint />}</span>
          {row.urgencyType === 1 && <Badge className="rounded-[4px] bg-red-500/15 px-1 text-[10px] text-red-700 dark:text-red-400">急采</Badge>}
          {row.purchaseStockType === 1 && <Badge className="rounded-[4px] bg-muted px-1 text-[10px] text-muted-foreground">JIT</Badge>}
          {row.isCustomProduct && <Badge className="rounded-[4px] bg-violet-500/15 px-1 text-[10px] text-violet-700 dark:text-violet-400">定制</Badge>}
          {row.fragileTag && <Badge className="rounded-[4px] bg-orange-500/15 px-1 text-[10px] text-orange-700 dark:text-orange-400">易破损</Badge>}
          {needBarcode && <Badge className="rounded-[4px] bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-400">需要打印条码</Badge>}
        </p>
      </div>
    </div>
  )
}

/** 发货信息块：发货数量 / 发货仓库（卖家地址）/ 收货仓库 */
function DeliverInfoCell({ row }: { row: TemuShipOrderRow }) {
  return (
    <div className="space-y-0.5 text-[11px] leading-4">
      <p>
        <span className="text-muted-foreground">发货数量：</span>
        <span className="tabular-nums">{row.deliverSkcNum ?? <EmptyHint />}</span> 件
      </p>
      <p>
        <span className="text-muted-foreground">发货仓库：</span>
        {row.deliveryAddressLabel ?? <EmptyHint />}
      </p>
      <p className="flex items-center gap-0.5">
        <span className="text-muted-foreground">收货仓库：</span>
        {row.subWarehouseName ? (
          <TruncTip text={row.subWarehouseName} className="max-w-36" />
        ) : (
          <EmptyHint />
        )}
      </p>
    </div>
  )
}

/** 包裹号块：官方口径——打印商品打包标签前不显示包裹号，打印后显示「N 个包裹」+包裹号 */
function PackageCell({ row }: { row: TemuShipOrderRow }) {
  if (row.isPrintBoxMark !== true || row.packageSns.length === 0) {
    return <span className="text-[11px] text-muted-foreground">打印打包标签后显示</span>
  }
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] text-muted-foreground">
        {row.deliverPackageNum && row.deliverPackageNum > 0 ? row.deliverPackageNum : row.packageSns.length} 个包裹
      </p>
      {row.packageSns.map((sn) => (
        <p key={sn} className="font-mono text-[11px]">
          {sn}
        </p>
      ))}
    </div>
  )
}

/** 发货单号 + 时间轴（按状态渲染可用节点；无数据不造假） */
function SnTimelineCell({ row }: { row: TemuShipOrderRow }) {
  const cancelLeft = row.status === 0 ? fmtCancelLeft(row.cancelDeadline) : null
  return (
    <div className="space-y-0.5">
      <p className="font-mono text-xs font-medium">{row.deliveryOrderSn}</p>
      {cancelLeft && (
        <p className="text-[11px] font-medium text-red-600 dark:text-red-400">{cancelLeft}</p>
      )}
      {row.status !== 0 && row.deliverTime && (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="size-1 rounded-full bg-emerald-500" /> 已发货 {fmtTs(row.deliverTime)}
        </p>
      )}
      {row.status === 1 && row.expectLatestPickTime && (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="size-1 rounded-full bg-amber-500" /> 需 {fmtTs(row.expectLatestPickTime)} 前揽收
        </p>
      )}
      {row.receiveTime && (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="size-1 rounded-full bg-emerald-500" /> 已收货 {fmtTs(row.receiveTime)}
        </p>
      )}
    </div>
  )
}

/** 物流信息块（官方图4）：发货方式 / 揽收方式 / 物流单号 / 预约取货时间 */
function LogisticsInfoCell({ row }: { row: TemuShipOrderRow }) {
  // 揽收方式：方式 1 商家自送，其余（平台推荐/第三方）均为快递上门取件
  const pickup = row.deliveryMethod === 1 ? "自送" : row.driverName ? `上门取件（${row.driverName}）` : "上门取件"
  return (
    <div className="space-y-0.5 text-[11px] leading-4">
      <p>
        <span className="text-muted-foreground">发货方式：</span>
        {row.deliveryMethod != null ? SHIP_DELIVERY_METHOD[row.deliveryMethod] ?? "—" : <EmptyHint />}
      </p>
      <p>
        <span className="text-muted-foreground">揽收方式：</span>
        {pickup}
      </p>
      <p>
        <span className="text-muted-foreground">物流单号：</span>
        {row.expressCompany ? (
          <>
            {row.expressCompany}
            {row.expressDeliverySn && <span className="ml-1 font-mono">{row.expressDeliverySn}</span>}
          </>
        ) : (
          <EmptyHint />
        )}
      </p>
      {row.expectPickUpGoodsTime && (
        <p>
          <span className="text-muted-foreground">预约取货时间：</span>
          {fmtTs(row.expectPickUpGoodsTime)}
        </p>
      )}
    </div>
  )
}

/** 官方链接式操作按钮 */
function LinkButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-1 text-xs text-primary hover:underline"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  )
}

export function TemuShipPanel({ store, storeName }: { store?: string; storeName?: string | null }) {
  const [view, setView] = React.useState<"orders" | "staging">("staging")
  const [statusPreset, setStatusPreset] = React.useState("pending")
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(20)
  const [extCode, setExtCode] = React.useState("")
  /** 发货仓库筛选（null=全部；addrId=卖家发货地址 id）与选项（随店拉取） */
  const [warehouseId, setWarehouseId] = React.useState<number | null>(null)
  const [warehouseOptions, setWarehouseOptions] = React.useState<Array<{ id: number; label: string }>>([])
  const [rows, setRows] = React.useState<TemuShipOrderRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  /** 创建发货单/装箱成功后强制刷新列表的信号 */
  const [reloadTick, setReloadTick] = React.useState(0)
  /** 待装箱发货单「需要打印条码」标记（含未预贴码货号=档案条码为空的单号集合） */
  const [barcodeSns, setBarcodeSns] = React.useState<Set<string>>(new Set())

  // 待装箱/待仓库收货勾选批量操作
  const [selSns, setSelSns] = React.useState<Set<string>>(new Set())
  const [packingRows, setPackingRows] = React.useState<TemuShipOrderRow[] | null>(null)

  // 行内操作
  const [cancelingSn, setCancelingSn] = React.useState<string | null>(null)
  const [cancelPending, setCancelPending] = React.useState(false)
  const [pkgEdit, setPkgEdit] = React.useState<{ sn: string; skuIds: number[]; deliverNums: Record<number, number>; packages: ShipPackageDraft[] } | null>(null)
  const [pkgPending, startPkgPending] = React.useTransition()
  const [changeTarget, setChangeTarget] = React.useState<TemuShipOrderRow | null>(null)
  const [changeDeliver, setChangeDeliver] = React.useState<DeliverPayload>({ deliverMethod: 1, driverName: "", plateNumber: "", expressPackageNum: 1 })
  const [changeThirdParty, setChangeThirdParty] = React.useState<Array<{ expressCompanyId: number; expressCompanyName: string }>>([])
  const [changePending, startChangePending] = React.useTransition()
  /** 打印商品打包标签两步确认（图2：继续打印/先发货后打印；图3：件数锁定二次确认） */
  const [boxMarkConfirm, setBoxMarkConfirm] = React.useState<string[] | null>(null)
  const [shipAfterPrint, setShipAfterPrint] = React.useState(false)

  const load = React.useCallback((opts?: { fresh?: boolean }) => {
    void reloadTick // 创建发货单/装箱成功后靠 reloadTick 变化触发重查
    if (!store) return
    startLoading(async () => {
      const r = await getTemuShipOrdersAction({
        store,
        page,
        pageSize,
        statusPreset,
        skcExtCode: extCode.trim() || undefined,
        warehouseId: warehouseId ?? undefined,
        fresh: opts?.fresh ? true : undefined,
      })
      if (r.ok) {
        setRows(r.rows)
        setTotal(r.total)
        setError(null)
        if (r.freshStats && r.freshStats.missing > 0) {
          toast.info(`实时核对：${r.freshStats.missing} 单官方侧已移除，本地已置为「已取消」`)
        }
        if (r.freshWarning) toast.warning(r.freshWarning, { duration: 8000 })
      } else {
        setRows([])
        setTotal(0)
        setError(r.error)
      }
    })
  }, [store, page, pageSize, statusPreset, extCode, warehouseId, reloadTick])

  // 货号输入即搜索：有关键字防抖 400ms，清空立即重查（筛选拍本地）
  React.useEffect(() => {
    const t = setTimeout(() => load(), extCode.trim() ? 400 : 0)
    return () => clearTimeout(t)
  }, [load, extCode])

  // 进入「发货单列表」即拉实时单（action 内：裸查最新一页落库 + 当前页单号核对；
  // 待装箱等新单无须等 15 分钟同步；筛选/翻页/防抖不再打官方）
  React.useEffect(() => {
    if (view === "orders") {
      load({ fresh: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // 切状态/店铺/视图清空勾选
  React.useEffect(() => {
    setSelSns(new Set())
  }, [statusPreset, store, view])

  // 待装箱行「需要打印条码」标记：发货单含已建档且条码为空（未预贴）的货号
  React.useEffect(() => {
    const sns = Array.from(
      new Set(rows.filter((r) => r.status === 0).map((r) => r.deliveryOrderSn)),
    )
    if (sns.length === 0) {
      setBarcodeSns(new Set())
      return
    }
    void getShipOrdersNeedingBarcodeAction({ sns }).then((r) => {
      if (r.ok) setBarcodeSns(new Set(r.sns))
    })
  }, [rows])

  // 发货仓库筛选选项（随店拉取；切店重置选中仓库，避免跨店残留无效 addrId）
  React.useEffect(() => {
    setWarehouseId(null)
    if (!store) {
      setWarehouseOptions([])
      return
    }
    let cancelled = false
    void getShipWarehouseOptionsAction({ store }).then((r) => {
      if (!cancelled) setWarehouseOptions(r.ok ? r.rows : [])
    })
    return () => {
      cancelled = true
    }
  }, [store])

  if (!store) {
    return (
      <Card>
        <CardHeader>
          <p className="text-sm font-medium">发货单</p>
          <p className="text-sm text-muted-foreground">请在右上角选择具体店铺后操作（发货接口按店铺 token 调用）。</p>
        </CardHeader>
      </Card>
    )
  }

  const viewSwitch = (
    <Select
      items={VIEW_OPTIONS}
      value={view}
      onValueChange={(v) => {
        if (v === "staging" || v === "orders") setView(v)
      }}
    >
      <SelectTrigger className="h-8 w-32 text-xs" aria-label="切换视图">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {VIEW_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  if (view === "staging") {
    return (
      <ShipStaging
        store={store}
        storeName={storeName}
        viewSwitch={viewSwitch}
        onCreated={() => {
          setView("orders")
          setStatusPreset("pending")
          setPage(1)
          setReloadTick((t) => t + 1)
        }}
      />
    )
  }

  const selectedRows = rows.filter((r) => selSns.has(r.deliveryOrderSn))
  const selWarehouses = new Set(selectedRows.map((r) => r.subWarehouseId ?? 0))
  const mixedWarehouse = selWarehouses.size > 1
  const isPendingView = statusPreset === "pending"
  const isShippingView = statusPreset === "shipping"
  /** 勾选列与批量条只在待装箱/待仓库收货出现（官方两视图才有批量操作） */
  const selectable = isPendingView || isShippingView
  const allPageSelected = rows.length > 0 && rows.every((r) => selSns.has(r.deliveryOrderSn))

  /** 待仓库收货：按物流批次聚簇（保持首现顺序、组内原顺序；无批次号行各自成组）。
   *  同批次多行时「发货批次/物流信息/物流操作」三列合并居中（官方两级结构），
   *  行级列（发货单号/商品/发货信息/状态/操作）逐行独立——同批次可能含不同货号条码。 */
  const shippingGroups: TemuShipOrderRow[][] = (() => {
    if (!isShippingView) return []
    const groups: TemuShipOrderRow[][] = []
    const byKey = new Map<string, TemuShipOrderRow[]>()
    for (const r of rows) {
      const key = r.expressBatchSn ?? `__single__:${r.deliveryOrderSn}`
      let list = byKey.get(key)
      if (!list) {
        list = []
        byKey.set(key, list)
        groups.push(list)
      }
      list.push(r)
    }
    return groups
  })()

  const doCancel = async (sn: string) => {
    setCancelPending(true)
    try {
      const r = await cancelShipOrderAction({ store, deliveryOrderSn: sn })
      if (r.ok && r.warning) toast.warning(r.warning, { duration: 8000 })
      else if (r.ok) toast.success(`已取消 ${sn}`)
      else
        toast.error(`${r.error}（本地状态可能滞后于官方，已实时核对并刷新列表）`, { duration: 8000 })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败", { duration: 6000 })
    } finally {
      setCancelPending(false)
      setCancelingSn(null)
      load({ fresh: true })
    }
  }

  const openPkgEdit = async (row: TemuShipOrderRow) => {
    const r = await getShipPackagesAction({ store, deliveryOrderSn: row.deliveryOrderSn }).catch(() => null)
    if (!r || !r.ok) {
      toast.error(r && !r.ok ? r.error : "包裹查询失败", { duration: 6000 })
      return
    }
    const deliverNums: Record<number, number> = {}
    const packages: ShipPackageDraft[] = r.rows.map((p) => {
      const draft: ShipPackageDraft = {}
      for (const d of p.packageDetails) {
        if (d.productSkuId != null) {
          draft[d.productSkuId] = d.skuNum ?? 0
          deliverNums[d.productSkuId] = (deliverNums[d.productSkuId] ?? 0) + (d.skuNum ?? 0)
        }
      }
      return draft
    })
    setPkgEdit({ sn: row.deliveryOrderSn, skuIds: Object.keys(deliverNums).map(Number), deliverNums, packages: packages.length > 0 ? packages : [{}] })
  }

  const pkgSumValid =
    pkgEdit != null &&
    pkgEdit.skuIds.every(
      (id) => pkgEdit.packages.reduce((acc, p) => acc + (p[id] ?? 0), 0) === pkgEdit.deliverNums[id],
    )

  const submitPkgEdit = () => {
    if (!pkgEdit) return
    startPkgPending(async () => {
      const r = await editShipPackagesAction({
        store,
        deliveryOrderSn: pkgEdit.sn,
        deliverOrderDetailInfos: pkgEdit.skuIds.map((id) => ({ productSkuId: id, deliverSkuNum: pkgEdit.deliverNums[id] })),
        packageInfos: pkgEdit.packages.map((p) => ({
          packageDetailSaveInfos: Object.entries(p)
            .filter(([, n]) => n > 0)
            .map(([id, n]) => ({ productSkuId: Number(id), skuNum: n })),
        })),
      })
      if (r.ok) {
        if (r.warning) toast.warning(r.warning, { duration: 8000 })
        else toast.success("包裹已调整")
        setPkgEdit(null)
        setReloadTick((t) => t + 1)
      } else {
        toast.error(r.error, { duration: 8000 })
      }
    })
  }

  const openChange = (row: TemuShipOrderRow) => {
    setChangeTarget(row)
    setChangeDeliver({ deliverMethod: 1, driverName: "", plateNumber: "", expressPackageNum: Math.max(1, row.deliverPackageNum ?? 1) })
    getThirdPartyLogisticsAction(store).then((r) => {
      if (r.ok) setChangeThirdParty(r.rows)
    })
  }

  const submitChange = () => {
    if (!changeTarget) return
    if (changeDeliver.deliverMethod !== 1 && changeDeliver.expressCompanyId == null) {
      toast.error("请选择物流公司")
      return
    }
    startChangePending(async () => {
      const r = await changeShipLogisticsAction({
        store,
        expressBatchSn: changeTarget.expressBatchSn!,
        deliveryAddressId: changeTarget.deliveryAddressId ?? 0,
        payload: changeDeliver,
      })
      if (r.ok) {
        toast.success("物流信息已修改（列表随后续同步刷新）")
        setChangeTarget(null)
      } else {
        toast.error(r.error, { duration: 8000 })
      }
    })
  }

  const toggleSelRow = (sn: string) =>
    setSelSns((s) => {
      const n = new Set(s)
      if (n.has(sn)) n.delete(sn)
      else n.add(sn)
      return n
    })

  const batchPrintBoxMark = () => {
    const sns = [...selSns]
    if (sns.length === 0) return
    // 两步确认（图2/图3）：两条路径统一「仅请求标记已打印」不打开官方打印页
    setBoxMarkConfirm(sns)
  }

  /** 确认后执行打印请求（请求 dataKey 即官方标记已打印+锁定件数；viaShipAfter=先发货后打印路径文案） */
  const runBoxMarkPrint = (sns: string[], viaShipAfter: boolean) => {
    startLoading(async () => {
      // schema deliveryOrderSns 单次上限 50：按 ≤50 一组循环分批请求；
      // 单批失败已在 requestShipBoxMark 内 toast 该批错误并继续其余批
      let anyOk = false
      for (let i = 0; i < sns.length; i += 50) {
        const ok = await requestShipBoxMark(store, sns.slice(i, i + 50))
        if (ok) anyOk = true
      }
      // 官方标记已打印后实时核对刷新（isPrintBoxMark 回填，解锁装箱发货与包裹号显示）
      if (anyOk) {
        await load({ fresh: true })
        if (viaShipAfter)
          toast.info(
            "件数已锁定（视为已打印）；请在列表勾选后「批量装箱发货」；发货后可在【待仓库收货】列表打印运单标签",
            { duration: 10_000 },
          )
      }
    })
  }

  const batchPrintBarcode = () => {
    const ids = [...new Set(selectedRows.flatMap((r) => r.productSkuIds).filter((v) => v > 0))]
    if (ids.length === 0) return
    // schema productSkuIds 单次上限 200：先去重再分批打印（同步循环开窗避免弹窗拦截；
    // 单批失败已在 openShipBarcodePrint 内 toast 该批错误并继续其余批）
    for (let i = 0; i < ids.length; i += 200) {
      void openShipBarcodePrint(store, ids.slice(i, i + 200))
    }
  }

  /** 打印运单标签：按快递单号去重（≤10/批分批）→ 服务端签名代理取内容 → 自渲染打印文档（非官方页跳转） */
  const printExpressNotes = (pairsIn: Array<{ expressCompanyId: number; expressDeliverySn: string }>) => {
    if (!store || pairsIn.length === 0) return
    // 同一快递单号去重（多单合并发货共用一单号）
    const seen = new Set<string>()
    const pairs = pairsIn.filter((p) => {
      const key = `${p.expressCompanyId}:${p.expressDeliverySn}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    startLoading(async () => {
      const items: TemuExpressNoteItem[] = []
      const failed: string[] = []
      for (let i = 0; i < pairs.length; i += 10) {
        const r = await getShipExpressNoteAction({ store, notes: pairs.slice(i, i + 10) }).catch(() => null)
        if (!r) {
          toast.error("运单标签请求失败", { duration: 8000 })
          return
        }
        if (!r.ok) {
          toast.error(r.error, { duration: 8000 })
          return
        }
        for (const res of r.results) {
          if (res.ok) items.push(...res.items)
          else failed.push(`${res.expressDeliverySn}：${res.error ?? "未返回标签"}`)
        }
      }
      if (items.length === 0) {
        toast.error(failed[0] ?? "官方未返回运单标签", { duration: 8000 })
        return
      }
      // 组装打印文档：image/* 用 dataURI 图、text/html 内嵌 iframe，其余回落下载
      const pages: string[] = []
      const downloads: Array<{ contentType: string; dataBase64: string }> = []
      for (const it of items) {
        if (it.contentType.startsWith("image/")) {
          pages.push(
            `<div class="page"><img src="data:${it.contentType};base64,${it.dataBase64}" alt="${it.childWaybillSn}"/></div>`,
          )
        } else if (it.contentType.includes("html")) {
          pages.push(
            `<div class="page"><iframe src="data:text/html;base64,${it.dataBase64}" title="${it.childWaybillSn}"></iframe></div>`,
          )
        } else {
          downloads.push(it)
        }
      }
      if (pages.length > 0) {
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>运单标签</title><style>
          @page { margin: 8mm } body { margin: 0 } .page { page-break-after: always; }
          .page:last-child { page-break-after: auto }
          img { max-width: 100%; } iframe { width: 100%; height: 96vh; border: 0 }
        </style></head><body>${pages.join("")}<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),400))</script></body></html>`
        const url = URL.createObjectURL(new Blob([html], { type: "text/html" }))
        window.open(url, "_blank", "noopener")
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      for (const d of downloads) {
        const url = URL.createObjectURL(
          new Blob([Uint8Array.from(atob(d.dataBase64), (c) => c.charCodeAt(0))], { type: d.contentType }),
        )
        const a = document.createElement("a")
        a.href = url
        a.download = `运单标签.${d.contentType.split("/")[1] ?? "bin"}`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      const okN = items.length
      if (failed.length > 0) {
        toast.warning(`运单标签：成功 ${okN} 张 / 失败 ${failed.length} 个单号（${failed[0]}）`, { duration: 10_000 })
      } else {
        toast.success(`已获取 ${okN} 张运单标签并打开打印预览`)
      }
    })
  }

  const openPacking = () => {
    if (mixedWarehouse) {
      toast.error("勾选了多个收货仓的单据；官方按同收货地址合并发货，请分批装箱", { duration: 8000 })
      return
    }
    const sel = rows.filter((r) => selSns.has(r.deliveryOrderSn))
    if (sel.length === 0) return
    if (sel.some((r) => r.status !== 0)) {
      toast.error("仅「待装箱发货」状态的单据可装箱发货")
      return
    }
    // 硬拦截：官方规定须先打印商品打包标签（打印后包裹数与件数锁定）才可装箱发货
    const unprinted = sel.filter((r) => r.isPrintBoxMark !== true)
    if (unprinted.length > 0) {
      toast.error(
        `${unprinted.length} 单未打印商品打包标签：请先点「批量打印商品打包标签」（打印后包裹数与件数锁定）再装箱发货`,
        { duration: 8000 },
      )
      return
    }
    setPackingRows(sel)
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    // h-full 高度链（tab 包装层 flex-1）：CardHeader 固定，CardContent 为内部滚动区
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={STATUS_OPTIONS}
            value={statusPreset}
            onValueChange={(v) => {
              if (v) {
                setStatusPreset(v)
                setPage(1)
              }
            }}
          >
            <SelectTrigger className="h-8 w-40 text-xs" aria-label="状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={[
              { value: "__all__", label: "全部仓库" },
              ...warehouseOptions.map((o) => ({ value: String(o.id), label: o.label })),
            ]}
            value={warehouseId != null ? String(warehouseId) : "__all__"}
            onValueChange={(v) => {
              setWarehouseId(v && v !== "__all__" ? Number(v) : null)
              setPage(1)
            }}
          >
            <SelectTrigger className="h-8 w-44 text-xs" aria-label="发货仓库筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部仓库</SelectItem>
              {warehouseOptions.map((o) => (
                <SelectItem key={o.id} value={String(o.id)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Combobox
            value={extCode || null}
            onChange={(v) => {
              setExtCode(v)
              setPage(1)
            }}
            onSearchChange={(v) => {
              setExtCode(v)
              setPage(1)
            }}
            options={rows.reduce<ComboboxOption[]>((acc, r) => {
              if (r.skcExtCode && !acc.some((o) => o.value === r.skcExtCode)) {
                acc.push({ value: r.skcExtCode, label: r.skcExtCode, description: r.productName ?? r.subWarehouseName ?? null })
              }
              return acc
            }, [])}
            placeholder="货号"
            searchPlaceholder="输入货号搜索…"
            className="h-8 w-40 text-xs"
          />
          <div className="ml-auto flex items-center gap-2">
            {viewSwitch}
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => load({ fresh: true })} disabled={loading}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} 刷新
            </Button>
          </div>
        </div>
        {isPendingView && (
          /* 官方橙色发货提醒条 */
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            发货提醒：请先打印商品打包标签再装箱发货；超时未发货的发货单将被平台自动取消，备货单会被移出发货台。
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          进入本页与「刷新」会实时拉取官方最新单（最新一页落库 + 当前页单号核对并收敛已移除的单）；历史单据由后台同步兜底。共 {total} 单。
        </p>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-hide">
        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : (
          <>
            {selectable && selSns.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2.5 text-xs">
                <span>
                  已选 {selSns.size} 单
                  {isPendingView && mixedWarehouse && (
                    <span className="text-orange-600 dark:text-orange-400">
                      {" "}· 跨收货仓（官方按同收货地址合并发货，请分批装箱）
                    </span>
                  )}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={loading}
                    onClick={() => {
                      if (isShippingView) {
                        // 待仓库收货：件数已锁定（首打完成），无需确认弹窗，直接开官方打印页补打（多单一页）；
                        // schema deliveryOrderSns 单次上限 50：分批各开一页（同步循环开窗避免拦截，
                        // 单批失败已在 openShipBoxMarkPage 内 toast 该批错误并继续其余批）
                        const all = [...selSns]
                        for (let i = 0; i < all.length; i += 50) {
                          void openShipBoxMarkPage(store, all.slice(i, i + 50))
                        }
                      } else {
                        batchPrintBoxMark()
                      }
                    }}
                  >
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Printer className="size-3.5" />} 批量打印商品打包标签
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={batchPrintBarcode} disabled={loading}>
                    批量打印商品条码
                  </Button>
                  {isShippingView && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={loading || selectedRows.every((r) => !r.expressDeliverySn || r.expressCompanyId == null)}
                      onClick={() =>
                        printExpressNotes(
                          selectedRows
                            .filter((r) => r.expressDeliverySn && r.expressCompanyId != null)
                            .map((r) => ({ expressCompanyId: r.expressCompanyId!, expressDeliverySn: r.expressDeliverySn! })),
                        )
                      }
                    >
                      批量打印运单标签
                    </Button>
                  )}
                  {isPendingView && (
                    <Button size="sm" className="h-8 text-xs" onClick={openPacking} disabled={loading || mixedWarehouse}>
                      批量装箱发货
                    </Button>
                  )}
                </div>
              </div>
            )}
            <div className="w-max min-w-full overflow-clip rounded-md border">
              <table className="w-max min-w-full caption-bottom text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border">
                <TableHeader className={TEMU_TABLE_HEADER_CLASS}>
                  <TableRow>
                    {selectable && (
                      <TableHead className="w-8">
                        <Checkbox
                          checked={allPageSelected}
                          onCheckedChange={() =>
                            setSelSns(() =>
                              allPageSelected
                                ? new Set()
                                : new Set(rows.map((r) => r.deliveryOrderSn)),
                            )
                          }
                          aria-label="全选本页"
                        />
                      </TableHead>
                    )}
                    {isShippingView && <TableHead className="w-36">发货批次</TableHead>}
                    {isShippingView && <TableHead className="w-48">物流信息</TableHead>}
                    <TableHead className="w-44">发货单号</TableHead>
                    <TableHead className="min-w-64">商品信息</TableHead>
                    <TableHead className="w-44">发货信息</TableHead>
                    {!isShippingView && <TableHead className="w-40">包裹号</TableHead>}
                    <TableHead className="w-32">发货单状态</TableHead>
                    <TableHead className="w-52">操作</TableHead>
                    {isShippingView && <TableHead className="w-40">物流操作</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && rows.length === 0 ? (
                    <TableSkeletonRows cols={selectable ? (isShippingView ? 10 : 8) : isShippingView ? 9 : 7} />
                  ) : rows.length === 0 && !loading ? (
                    <TableRow>
                      <TableCell colSpan={selectable ? (isShippingView ? 10 : 8) : isShippingView ? 9 : 7} className="h-20 text-center text-muted-foreground">
                        暂无发货单（当前筛选下）；可在「发货台」创建新发货单，或点「刷新」实时拉取。
                      </TableCell>
                    </TableRow>
                  ) : isShippingView ? (
                    /* 待仓库收货：批次聚簇渲染——发货批次/物流信息/物流操作组内合并居中，
                       行级列逐行独立（同批次可含不同货号条码，条码/单单补打必须行级） */
                    shippingGroups.flatMap((group) =>
                      group.map((r, gi) => {
                        const head = group[0]!
                        const isFirst = gi === 0
                        return (
                          <TableRow key={r.deliveryOrderSn}>
                            {selectable &&
                              (isFirst ? (
                                /* 勾选按钮随批次合并居中：组级三态（全选/半选/清空）= 选中该批次全部发货单 */
                                <TableCell rowSpan={group.length} className="align-middle">
                                  {(() => {
                                    const groupSns = group.map((g) => g.deliveryOrderSn)
                                    const allIn = groupSns.every((sn) => selSns.has(sn))
                                    const someIn = groupSns.some((sn) => selSns.has(sn))
                                    return (
                                      <Checkbox
                                        checked={allIn}
                                        indeterminate={!allIn && someIn}
                                        onCheckedChange={() =>
                                          setSelSns((s) => {
                                            const n = new Set(s)
                                            if (allIn) groupSns.forEach((sn) => n.delete(sn))
                                            else groupSns.forEach((sn) => n.add(sn))
                                            return n
                                          })
                                        }
                                        aria-label={`选择批次 ${head.expressBatchSn ?? head.deliveryOrderSn}`}
                                      />
                                    )
                                  })()}
                                </TableCell>
                              ) : null)}
                            {isFirst && (
                              <TableCell rowSpan={group.length} className="align-middle text-xs">
                                <p className="font-mono">{head.expressBatchSn ?? <EmptyHint />}</p>
                                {(() => {
                                  // 官方无物流轨迹状态（待揽收/运输中为卖家中心内部链路），
                                  // 仅以接口已有的异常字段做组级徽章：拒收 / 计费重量异常
                                  const badges: Array<{ text: string; tip: string; cls: string }> = []
                                  if (head.expressRejectStatus != null && head.expressRejectStatus > 0)
                                    badges.push({
                                      text: "物流拒收",
                                      tip:
                                        EXPRESS_REJECT_STATUS[head.expressRejectStatus] ??
                                        `拒收状态 ${head.expressRejectStatus}`,
                                      cls: "bg-red-500/15 text-red-700 dark:text-red-400",
                                    })
                                  if (
                                    head.expressWeightFeedbackStatus != null &&
                                    [1, 2, 4].includes(head.expressWeightFeedbackStatus)
                                  )
                                    badges.push({
                                      text: "重量异常",
                                      tip:
                                        EXPRESS_WEIGHT_FEEDBACK_STATUS[head.expressWeightFeedbackStatus] ??
                                        `重量异常状态 ${head.expressWeightFeedbackStatus}`,
                                      cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                                    })
                                  if (badges.length === 0) return null
                                  return (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {badges.map((b) => (
                                        <TooltipProvider key={b.text}>
                                          <Tooltip>
                                            <TooltipTrigger className="cursor-default">
                                              <Badge className={`rounded-[4px] px-1 text-[10px] ${b.cls}`}>{b.text}</Badge>
                                            </TooltipTrigger>
                                            <TooltipContent>{b.tip}</TooltipContent>
                                          </Tooltip>
                                        </TooltipProvider>
                                      ))}
                                    </div>
                                  )
                                })()}
                              </TableCell>
                            )}
                            {isFirst && (
                              <TableCell rowSpan={group.length} className="align-middle">
                                <LogisticsInfoCell row={head} />
                              </TableCell>
                            )}
                            {/* 续行首格显式左边线：rowSpan 合并后 :not(:first-child) 边线选择器会漏画 */}
                            <TableCell className={isFirst ? undefined : "border-l border-border"}>
                              <SnTimelineCell row={r} />
                            </TableCell>
                            <TableCell>
                              <ProductInfoCell
                                row={r}
                                needBarcode={r.status === 0 && barcodeSns.has(r.deliveryOrderSn)}
                              />
                            </TableCell>
                            <TableCell>
                              <DeliverInfoCell row={r} />
                            </TableCell>
                            <TableCell>
                              <StatusBadge status={r.status} />
                            </TableCell>
                            <TableCell>
                              {/* 行级操作：打包标签=单单补打（件数已在首打锁定，直接开官方页）+ 行级条码 */}
                              <div className="flex flex-col items-start gap-0.5">
                                {r.status !== 4 && r.status !== 5 && (
                                  <LinkButton onClick={() => void openShipBoxMarkPage(store, [r.deliveryOrderSn])}>
                                    打印商品打包标签
                                  </LinkButton>
                                )}
                                <LinkButton
                                  onClick={() => void openShipBarcodePrint(store, r.productSkuIds)}
                                  disabled={r.productSkuIds.length === 0}
                                >
                                  打印商品条码
                                </LinkButton>
                              </div>
                            </TableCell>
                            {isFirst && (
                              /* 组级物流操作：打包标签多单合并一页 / 运单标签按批次快递单号 / 更换物流按批次 */
                              <TableCell rowSpan={group.length} className="align-middle">
                                <div className="flex flex-col items-start gap-0.5">
                                  <LinkButton
                                    onClick={() =>
                                      void openShipBoxMarkPage(store, group.map((g) => g.deliveryOrderSn))
                                    }
                                  >
                                    合并打印商品打包标签
                                  </LinkButton>
                                  {head.status === 1 && head.expressDeliverySn && head.expressCompanyId != null && (
                                    <LinkButton
                                      onClick={() =>
                                        printExpressNotes([
                                          {
                                            expressCompanyId: head.expressCompanyId!,
                                            expressDeliverySn: head.expressDeliverySn!,
                                          },
                                        ])
                                      }
                                    >
                                      打印运单标签
                                    </LinkButton>
                                  )}
                                  {head.status !== 5 && head.expressBatchSn && (
                                    <LinkButton onClick={() => openChange(head)}>更换物流</LinkButton>
                                  )}
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        )
                      }),
                    )
                  ) : (
                    rows.map((r) => (
                      <TableRow key={r.deliveryOrderSn}>
                        {selectable && (
                          <TableCell>
                            <Checkbox
                              checked={selSns.has(r.deliveryOrderSn)}
                              onCheckedChange={() => toggleSelRow(r.deliveryOrderSn)}
                              aria-label={`选择 ${r.deliveryOrderSn}`}
                            />
                          </TableCell>
                        )}
                        <TableCell>
                          <SnTimelineCell row={r} />
                        </TableCell>
                        <TableCell>
                          <ProductInfoCell
                            row={r}
                            needBarcode={r.status === 0 && barcodeSns.has(r.deliveryOrderSn)}
                          />
                        </TableCell>
                        <TableCell>
                          <DeliverInfoCell row={r} />
                        </TableCell>
                        <TableCell>
                          <PackageCell row={r} />
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={r.status} />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-0.5">
                            {r.status !== 4 && r.status !== 5 && (
                              <LinkButton onClick={() => setBoxMarkConfirm([r.deliveryOrderSn])}>
                                打印商品打包标签
                              </LinkButton>
                            )}
                            <LinkButton
                              onClick={() => void openShipBarcodePrint(store, r.productSkuIds)}
                              disabled={r.productSkuIds.length === 0}
                            >
                              打印商品条码
                            </LinkButton>
                            {r.status === 0 && r.isPrintBoxMark !== true && (
                              <LinkButton onClick={() => void openPkgEdit(r)}>调整备货信息</LinkButton>
                            )}
                            {r.status === 0 && (
                              <LinkButton onClick={() => setCancelingSn(r.deliveryOrderSn)}>取消发货单</LinkButton>
                            )}
                            {r.status !== 5 && r.expressBatchSn && (
                              <LinkButton onClick={() => openChange(r)}>更换物流</LinkButton>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </table>
            </div>
          </>
        )}
        <TablePagination
          className="mt-1 justify-end px-0"
          pageIndex={page - 1}
          pageCount={totalPages}
          total={total}
          pageSize={pageSize}
          onPageChange={(i) => setPage(i + 1)}
          onPageSizeChange={(n) => {
            setPageSize(n)
            setPage(1)
          }}
          disabled={loading}
        />
      </CardContent>

      {/* 装箱发货（待装箱勾选进入；打印门槛 + 三方式 + 比价） */}
      <PackingDialog
        store={store}
        rows={packingRows ?? []}
        open={packingRows != null}
        onOpenChange={(v) => !v && setPackingRows(null)}
        onDone={() => {
          setSelSns(new Set())
          setReloadTick((t) => t + 1)
        }}
      />

      {/* 取消确认 */}
      <ConfirmDialog
        open={cancelingSn != null}
        onOpenChange={(v) => !v && setCancelingSn(null)}
        title="取消发货单"
        description={`确认取消 ${cancelingSn ?? ""}？仅装箱发货前可取消，取消后库存台额度回退（官方侧）。`}
        confirmText="确认取消"
        destructive
        pending={cancelPending}
        onConfirm={() => {
          if (cancelingSn) void doCancel(cancelingSn)
        }}
      />

      {/* 打印商品打包标签两步确认（官方同款图2/图3；两条路径统一仅请求不打开网页） */}
      <Dialog open={boxMarkConfirm != null} onOpenChange={(v) => !v && !shipAfterPrint && setBoxMarkConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 shrink-0 text-amber-500" />
              确认打印商品打包标签？
            </DialogTitle>
            {/* render 换根为 div：DialogDescription 默认渲染 <p>，内部 div/button 会触发水合错误 */}
            <DialogDescription render={<div />} className="space-y-1.5 text-left text-xs leading-5">
              <div>1. 打印后，包裹内商品件数将不可调整。</div>
              <div>
                2. 当前商品打包标签<b>无物流信息</b>
                ，如需打印包含物流信息的标签，请点击
                <button
                  type="button"
                  className="mx-0.5 text-primary underline underline-offset-2"
                  onClick={() => setShipAfterPrint(true)}
                >
                  先发货后打印
                </button>
                ，并在装箱发货后前往【待仓库收货】菜单下打印。
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBoxMarkConfirm(null)} disabled={loading}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={loading}
              onClick={() => {
                const sns = boxMarkConfirm ?? []
                setBoxMarkConfirm(null)
                runBoxMarkPrint(sns, false)
              }}
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : null}
              继续打印
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 先发货后打印：件数锁定二次确认（图3） */}
      <Dialog
        open={shipAfterPrint}
        onOpenChange={(v) => !v && setShipAfterPrint(false)}
      >
        <DialogContent className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <TriangleAlert className="size-4 shrink-0 text-amber-500" />
              确认后包裹商品件数不再支持调整，确认继续？
            </DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShipAfterPrint(false)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={loading}
              onClick={() => {
                const sns = boxMarkConfirm ?? []
                setShipAfterPrint(false)
                setBoxMarkConfirm(null)
                runBoxMarkPrint(sns, true)
              }}
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 调整备货信息（官方 package.edit） */}
      <Dialog open={pkgEdit != null} onOpenChange={(v) => !v && setPkgEdit(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>调整备货信息 · {pkgEdit?.sn}</DialogTitle>
            <DialogDescription>
              官方 package.edit：重新分配各包裹 SKU 数量；每 SKU 分箱合计须等于发货数（上方可改发货数）。
            </DialogDescription>
          </DialogHeader>
          {pkgEdit && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3">
                {pkgEdit.skuIds.map((id) => (
                  <div key={id} className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px] text-muted-foreground">{id}</span>
                    <Input
                      className="h-7 w-20 text-xs tabular-nums"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={pkgEdit.deliverNums[id] ?? 0}
                      onChange={(e) => {
                        const v = Math.max(0, Math.round(Number(e.target.value) || 0))
                        setPkgEdit((p) => (p ? { ...p, deliverNums: { ...p.deliverNums, [id]: v } } : p))
                      }}
                    />
                  </div>
                ))}
              </div>
              <PackageSplitTable
                skuIds={pkgEdit.skuIds}
                skuLabels={(id) => String(id)}
                packages={pkgEdit.packages}
                deliverNums={pkgEdit.deliverNums}
                onPackageChange={(pi, id, n) =>
                  setPkgEdit((p) =>
                    p ? { ...p, packages: p.packages.map((pkg, k) => (k === pi ? { ...pkg, [id]: n } : pkg)) } : p,
                  )
                }
                onAddPackage={() =>
                  setPkgEdit((p) =>
                    p
                      ? { ...p, packages: [...p.packages, Object.fromEntries(p.skuIds.map((id) => [id, 0]))] }
                      : p,
                  )
                }
                onRemovePackage={(pi) =>
                  setPkgEdit((p) => (p ? { ...p, packages: p.packages.filter((_, k) => k !== pi) } : p))
                }
              />
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setPkgEdit(null)}>
              取消
            </Button>
            <Button size="sm" className="h-8 text-xs" disabled={!pkgSumValid || pkgPending} onClick={submitPkgEdit}>
              {pkgPending ? "提交中…" : "保存包裹"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 更换物流（官方 logistics.change） */}
      <Dialog open={changeTarget != null} onOpenChange={(v) => !v && setChangeTarget(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>更换物流 · {changeTarget?.expressBatchSn}</DialogTitle>
            <DialogDescription>
              官方 logistics.change：按发货批次修改配送方式与承运信息（{changeTarget?.deliveryOrderSn}）。
            </DialogDescription>
          </DialogHeader>
          {changeTarget && (
            <div className="space-y-3">
              <DeliverMethodTabs
                store={store}
                value={changeDeliver}
                onChange={setChangeDeliver}
                thirdParty={changeThirdParty}
              />
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setChangeTarget(null)}>
              取消
            </Button>
            <Button size="sm" className="h-8 text-xs" disabled={changePending} onClick={submitChange}>
              {changePending ? "提交中…" : "保存修改"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
