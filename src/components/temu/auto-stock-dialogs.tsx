"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CircleAlert, CircleCheck, Filter, Loader2, Send, Truck, Zap } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  getStockableProductsAction,
  getTemuPurchaseOrdersAction,
  batchApplyTemuStockingAction,
  autoStockingLinkAction,
  type TemuStockableRow,
  type TemuStockApplyBatchResult,
  type TemuPurchaseOrderRow,
} from "@/server/actions/temu-fulfillment"
import { addShipStagingAction, getShipInventoryRefAction } from "@/server/actions/temu-ship"
import { EmptyHint } from "@/components/temu/products-table"
import { TruncTip } from "@/components/temu/trunc-tip"
import { TableSkeletonRows } from "@/components/temu/table-skeleton"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { temuImageSrc } from "@/lib/temu/image"

/**
 * 自动操作双弹窗（备货 Tab 工具栏「自动操作」入口）：
 * - AutoApplyDialog 自动申报备货：在售链接按近7日销量降序（仅本地库存>0 入列）→
 *   大数值探测官方上限（错误文案解析）回填申报量并自动勾选 → 手改（≤上限，0 锁定）→
 *   筛选（上限<X 取消勾选）→ 批量申报（仅勾选行，逐块进度+可中止，状态列圆形图标逐行结果）
 * - AutoJoinDialog 批量加入发货：可加入发货台的备货单（已接单+官方可加入标记+常规备货+
 *   本地库存>0，默认全选）→ 一键加入发货台（逐块进度+可中止；2026-11-05 口径：不再
 *   自动创建发货单——发货数/包裹/发货仓库在发货台创建视图里可控）→ 全部完成后跳转「发货」页·发货台
 * 两者均支持全部店铺视图：行级携带店铺归属，写操作按 storeId 分组逐店调用。
 */

/** 库存参考（货号 → 库存合计 + 已创建未装箱占用；服务端归一化货号匹配；
 *  超过单次上限 200 个货号时分块串行拉取合并，避免尾部货号被静默丢弃） */
type InvRef = Record<string, { totalQty: number; pendingUnpacked: number }>

/** 店铺简要（page 侧 enabledStores 透传；全部店铺扇出用） */
export interface AutoStockStore {
  id: string
  name: string
}

/** 弹窗内滚动容器 + sticky 表头公共口径：
 *  - scrollbar-hide 隐藏滚动条（保留滚动）
 *  - DialogContent 必须 overflow-y-hidden 覆盖基类 overflow-y-auto（tailwind-merge 同组覆盖），
 *    否则外层弹窗与内层表格双层滚动导致 sticky 表头错位、行内容从头缘露出
 *  - th 自身加实色 bg-muted（基类只挂 thead，避免 thead/th 子像素缝隙透出内容）
 *  - transform-gpu：滚动容器提升为合成层——否则懒加载图片等独立合成子层在分数设备缩放
 *    （Windows 125%/150%）下会越过 overflow 裁剪、画到 sticky 表头上方（主图列露头，实测） */
const DIALOG_SCROLL_CLS =
  "min-h-0 flex-1 overflow-auto scrollbar-hide rounded-md border transform-gpu"
/** thead 上探 12px 同色阴影：分数设备缩放下 sticky 表头背景顶边与容器裁剪边有取整缝隙，
 *  表体像素会从缝里露出（主线程绘制，不依赖合成层，任何缩放下都填缝）；
 *  scrollTop=0 时 thead 贴内容顶、阴影全被容器裁剪不可见。仅弹窗口径——页级表
 *  未滚动时 thead 上方有其他内容，加阴影会覆盖上方元素，不可加。
 *  注意直接工具类（无 [&_thead]: 变体）：本类挂在 thead 自身，变体会去找后代 thead 永不匹配。 */
const DIALOG_HEADER_CLS = `${TEMU_TABLE_HEADER_CLASS} [&_th]:bg-muted [box-shadow:0_-12px_0_0_var(--color-muted)]`
const DIALOG_CONTENT_CLS = "flex max-h-[85vh] flex-col overflow-y-hidden sm:max-w-3xl"

async function loadInvRef(store: string | undefined, codes: Array<string | null | undefined>): Promise<InvRef> {
  const list = [...new Set(codes.filter((c): c is string => !!c))]
  const map: InvRef = {}
  for (let i = 0; i < list.length; i += 200) {
    const r = await getShipInventoryRefAction({ ...(store ? { store } : {}), codes: list.slice(i, i + 200) })
    if (r.ok) Object.assign(map, r.rows)
  }
  return map
}

/** 表头三态全选 Checkbox（作用域=传入行键集合） */
function SelectAllCheckbox({
  allChecked,
  someChecked,
  onToggle,
}: {
  allChecked: boolean
  someChecked: boolean
  onToggle: () => void
}) {
  return (
    <Checkbox
      checked={allChecked}
      indeterminate={!allChecked && someChecked}
      onCheckedChange={onToggle}
      aria-label="全选当前列表"
    />
  )
}

/** 行级状态图标（圆形图标口径，同 EmptyHint 一族）：处理中（旋转加载）/
 *  成功（CircleCheck，悬停发货单号）/ 失败（CircleAlert，悬停官方错误原文，
 *  标识用 SKC ID / 子单号不用商品名） */
function StatusIconCell({
  status,
  rowKey,
  processing,
}: {
  status: { ok: boolean; deliveryOrderSn?: string; error?: string } | undefined
  rowKey: string
  /** 属于当前正在提交的块（旋转加载图标，逐块聚焦） */
  processing?: boolean
}) {
  if (processing) return <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="处理中" />
  if (!status) return <span className="text-muted-foreground">—</span>
  if (status.ok)
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger className="cursor-default">
            <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          </TooltipTrigger>
          {status.deliveryOrderSn && (
            <TooltipContent>发货单 {status.deliveryOrderSn}</TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
    )
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="cursor-default">
          <CircleAlert className="size-3.5 text-red-600 dark:text-red-400" />
        </TooltipTrigger>
        <TooltipContent className="max-w-72 break-all">
          {rowKey}：{status.error ?? "未知原因"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/* ─── 弹窗1：自动申报备货 ─── */

/** 单链接探测结果：max=各 SKU 上限最小值（null=解析失败），error=探测调用失败原因 */
interface ProbeLimit {
  max: number | null
  perSku: Array<{ skuId: string; maxQuantity: number | null }>
  error?: string
}

/** 行 = 在售链接 + 店铺归属（全部店铺视图跨店合并） */
interface StockRow extends TemuStockableRow {
  storeId: string
  storeName: string
}

export function AutoApplyDialog({
  store,
  stores,
  onClose,
  onApplied,
}: {
  /** 选中具体店铺；缺省=全部店铺（stores 扇出合并） */
  store?: string
  stores: AutoStockStore[]
  onClose: () => void
  /** 任一申报成功后回调（父层刷新备货单列表） */
  onApplied: () => void
}) {
  const [rows, setRows] = React.useState<StockRow[]>([])
  const [invMap, setInvMap] = React.useState<InvRef>({})
  const [error, setError] = React.useState<string | null>(null)
  const [partialErrors, setPartialErrors] = React.useState<Array<{ store: string; error: string }>>([])
  const [loading, setLoading] = React.useState(true)
  const [q, setQ] = React.useState("")
  /** 探测上限（skcId → 结果；无记录=未探测） */
  const [limits, setLimits] = React.useState<Record<string, ProbeLimit>>({})
  const [quantities, setQuantities] = React.useState<Record<string, string>>({})
  /** 勾选行（skcId；探测出正上限自动勾选，联动批量申报） */
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [probing, setProbing] = React.useState(false)
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null)
  const [cursor, setCursor] = React.useState(-1)
  /** 批量申报逐行结果（skcId → 成功/失败，悬停官方错误原文） */
  const [statusBySkc, setStatusBySkc] = React.useState<Record<string, { ok: boolean; error?: string }>>({})
  const [filterOpen, setFilterOpen] = React.useState(false)
  const [filterValue, setFilterValue] = React.useState("")
  const [applying, startApplying] = React.useTransition()
  const [confirming, setConfirming] = React.useState(false)
  /** 中止标记：关闭弹窗/点「中止」后不再继续逐链接探测或后续申报块 */
  const abortedRef = React.useRef(false)
  /** 批量申报进度（按行计）与当前正在提交块内的行键（行高亮 + 状态列旋转图标） */
  const [applyProgress, setApplyProgress] = React.useState<{ done: number; total: number } | null>(null)
  const [processingSkcs, setProcessingSkcs] = React.useState<Set<string>>(new Set())

  React.useEffect(() => {
    abortedRef.current = false
    let cancelled = false
    void (async () => {
      try {
        // 全部在售链接（不预筛 canPurchase——可申报与否交给探测上限判断）；
        // 全部店铺视图逐店扇出（本地 DB 读、无需 token），失败店收部分失败横幅
        const all: StockRow[] = []
        const partials: Array<{ store: string; error: string }> = []
        if (store) {
          const r = await getStockableProductsAction({ store, onlyCanPurchase: false })
          if (!r.ok) {
            setError(r.error)
            return
          }
          const name = stores.find((s) => s.id === store)?.name ?? ""
          all.push(...r.rows.map((x) => ({ ...x, storeId: store, storeName: name })))
        } else {
          const results = await Promise.all(
            stores.map(async (s) => ({ s, r: await getStockableProductsAction({ store: s.id, onlyCanPurchase: false }) })),
          )
          for (const { s, r } of results) {
            if (!r.ok) partials.push({ store: s.name, error: r.error })
            else all.push(...r.rows.map((x) => ({ ...x, storeId: s.id, storeName: s.name })))
          }
        }
        if (cancelled) return
        const ref = await loadInvRef(store, all.map((x) => x.productSn))
        if (cancelled) return
        // 库存联动：本地库存>0 且有 SKU 明细的链接才入列
        setRows(
          all.filter(
            (x) => x.skus.length > 0 && !!x.productSn && (ref[x.productSn]?.totalQty ?? 0) > 0,
          ),
        )
        setInvMap(ref)
        setPartialErrors(partials)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      abortedRef.current = true
    }
  }, [store, stores])

  const kw = q.trim().toLowerCase()
  const visibleRows = kw
    ? rows.filter(
        (r) =>
          r.productName?.toLowerCase().includes(kw) ||
          r.productSn?.toLowerCase().includes(kw) ||
          r.productSkcId.toLowerCase().includes(kw),
      )
    : rows

  /** 可勾选行（探测出上限 0 的行申报无意义，勾选框禁用） */
  const checkableRows = visibleRows.filter((r) => limits[r.productSkcId]?.max !== 0)
  const allChecked = checkableRows.length > 0 && checkableRows.every((r) => selected.has(r.productSkcId))
  const someChecked = checkableRows.some((r) => selected.has(r.productSkcId))

  // 部分勾选（半选「-」态）或全选时点击 = 取消全部（同 TEMU 主表/库存面板口径）
  const toggleAll = () => {
    setSelected((s) => {
      const n = new Set(s)
      if (allChecked || someChecked) checkableRows.forEach((r) => n.delete(r.productSkcId))
      else checkableRows.forEach((r) => n.add(r.productSkcId))
      return n
    })
  }

  /** 逐链接探测（dryRun 只探测不申报；探测被官方意外接受时 action 内自动取消回滚） */
  const probeAll = () => {
    if (visibleRows.length === 0) return
    abortedRef.current = false
    setProbing(true)
    setProgress({ done: 0, total: visibleRows.length })
    setCursor(0)
    void (async () => {
      let done = 0
      const next: Record<string, ProbeLimit> = { ...limits }
      for (let i = 0; i < visibleRows.length; i++) {
        if (abortedRef.current) break
        const row = visibleRows[i]!
        setCursor(i)
        try {
          const r = await autoStockingLinkAction({
            store: row.storeId,
            productSkcId: Number(row.productSkcId),
            productName: row.productName ?? undefined,
            skuIds: row.skus.map((s) => s.skuId),
            minQuantity: 1,
            probeQuantity: 100_000,
            dryRun: true,
          })
          if (r.ok && !r.result.rollbackNote) {
            const valid = r.result.skuLimits
              .map((s) => s.maxQuantity)
              .filter((x): x is number => x != null)
            const max = valid.length > 0 ? Math.min(...valid) : null
            next[row.productSkcId] = { max, perSku: r.result.skuLimits }
            if (max != null && max > 0) {
              // 回填申报量 + 自动勾选（0=不可申报无意义，不勾选）
              setQuantities((s) => ({ ...s, [row.productSkcId]: String(max) }))
              setSelected((s) => {
                const n = new Set(s)
                n.add(row.productSkcId)
                return n
              })
            } else {
              setSelected((s) => {
                if (!s.has(row.productSkcId)) return s
                const n = new Set(s)
                n.delete(row.productSkcId)
                return n
              })
            }
          } else if (r.ok) {
            // 探测被官方接受（上限 ≥ 探测值）：已自动取消回滚，上限未知需人工处理
            next[row.productSkcId] = {
              max: null,
              perSku: r.result.skuLimits,
              error: r.result.rollbackNote,
            }
          } else {
            next[row.productSkcId] = { max: null, perSku: [], error: r.error }
          }
        } catch (err) {
          next[row.productSkcId] = {
            max: null,
            perSku: [],
            error: err instanceof Error ? err.message : String(err),
          }
        }
        setLimits({ ...next })
        done++
        setProgress({ done, total: visibleRows.length })
      }
      setCursor(-1)
      setProbing(false)
      setProgress(null)
      if (abortedRef.current) {
        toast.warning(`探测已中止：完成 ${done}/${visibleRows.length}，剩余未探测`, { duration: 8000 })
      } else {
        toast.success(`探测完成：${done} 个链接`)
      }
    })()
  }

  /** 筛选：可申报上限 < X 的行自动取消勾选（需先探测） */
  const applyFilter = () => {
    const x = Math.round(Number(filterValue))
    if (!Number.isFinite(x) || x < 1) {
      toast.error("请输入 ≥1 的整数")
      return
    }
    const toRemove = rows.filter(
      (r) => selected.has(r.productSkcId) && (limits[r.productSkcId]?.max ?? 0) < x,
    )
    setSelected((s) => {
      const n = new Set(s)
      toRemove.forEach((r) => n.delete(r.productSkcId))
      return n
    })
    setFilterOpen(false)
    toast.success(`已取消勾选可申报上限小于 ${x} 的 ${toRemove.length} 行`)
  }

  /** 数量有效性：探测出正上限且 1 ≤ 值 ≤ 上限 */
  const qtyState = (row: StockRow): { valid: boolean; value: number } | null => {
    const lim = limits[row.productSkcId]
    if (!lim || lim.max == null || lim.max <= 0) return null
    const v = Math.round(Number(quantities[row.productSkcId]))
    if (!Number.isFinite(v) || v < 1 || v > lim.max) return { valid: false, value: v }
    return { valid: true, value: v }
  }

  /** 批量申报目标 = 已勾选 且 数量有效 */
  const applicable = visibleRows.filter((r) => selected.has(r.productSkcId) && qtyState(r)?.valid)

  const runApply = () => {
    // 按店铺分组（全部店铺视图跨店合并）→ 每店 ≤5/块串行（块小让逐块聚焦可见；服务端
    // 仍逐项串行调官方 apply，官方调用总次数不变）；逐块结果写状态列，进度/中止同探测口径
    const groups = new Map<string, Array<{ productSkcId: number; skuIds: string[]; quantity: number }>>()
    for (const row of applicable) {
      const item = {
        productSkcId: Number(row.productSkcId),
        skuIds: row.skus.map((s) => s.skuId),
        quantity: qtyState(row)!.value,
      }
      const list = groups.get(row.storeId) ?? []
      list.push(item)
      groups.set(row.storeId, list)
    }
    const total = applicable.length
    abortedRef.current = false
    setApplyProgress({ done: 0, total })
    startApplying(async () => {
      let done = 0
      let okCount = 0
      let badCount = 0
      const merge = (items: TemuStockApplyBatchResult[]) => {
        setStatusBySkc((prev) => {
          const n = { ...prev }
          for (const it of items)
            n[String(it.productSkcId)] = { ok: it.ok, ...(it.error ? { error: it.error } : {}) }
          return n
        })
        okCount += items.filter((x) => x.ok).length
        badCount += items.filter((x) => !x.ok).length
      }
      try {
        let stopped = false
        for (const [storeId, items] of groups) {
          if (stopped) break
          for (let i = 0; i < items.length; i += 5) {
            if (abortedRef.current) {
              stopped = true
              break
            }
            const chunk = items.slice(i, i + 5)
            setProcessingSkcs(new Set(chunk.map((c) => String(c.productSkcId))))
            const r = await batchApplyTemuStockingAction({ store: storeId, items: chunk })
            if (r.ok) merge(r.results)
            else toast.error(r.error, { duration: 8000 })
            done += chunk.length
            setApplyProgress({ done, total })
          }
        }
        if (stopped) {
          // 中止：已提交块不回滚，剩余行停留未处理，留在弹窗看结果
          if (okCount > 0) onApplied()
          toast.warning(`已中止申报：完成 ${done} / 共 ${total}，剩余 ${total - done} 行未提交`, { duration: 6000 })
        } else if (okCount + badCount > 0) {
          if (badCount === 0) toast.success(`已申报 ${okCount} 个链接的备货`)
          else toast.warning(`申报完成：${okCount} 成功 / ${badCount} 失败`, { duration: 8000 })
          if (okCount > 0) onApplied()
        }
      } catch {
        // 传输层失败（网络错/请求超限）兜底：流程走完让 applying 复位，不再卡死/未捕获
        toast.error("网络异常，操作未完成，请稍后重试", { duration: 6000 })
      } finally {
        setProcessingSkcs(new Set())
        setApplyProgress(null)
      }
    })
  }

  const doneCount = Object.keys(statusBySkc).length
  const okDone = Object.values(statusBySkc).filter((s) => s.ok).length
  const busy = probing || applying

  return (
    <>
    <Dialog
      open
      onOpenChange={(v, details) => {
        if (!v && busy) {
          // 探测中（可能触发官方创建+回滚）/申报中拦截关闭，避免后台继续调用
          details.cancel()
          toast.warning(probing ? "探测执行中，请先「中止」或等待完成" : "批量申报执行中，请先「中止」或等待完成")
          return
        }
        if (!v) onClose()
      }}
    >
      <DialogContent className={DIALOG_CONTENT_CLS}>
        <DialogHeader>
          <DialogTitle>自动申报备货（{rows.length} 个在售链接）</DialogTitle>
          <DialogDescription>
            按近7日销量降序，仅列本地库存&gt;0 的链接。探测 = 以超大数值调官方申报接口，从错误文案解析各 SKU
            可申报上限并回填、自动勾选；上限 0 = 当前不可申报（锁定不可改），修改量不得超过上限。批量申报仅提交勾选行，结果见「状态」列。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 w-52 text-xs"
            placeholder="搜索商品名 / 货号 / SKC"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={busy}
          />
          {probing ? (
            <>
              <Progress
                value={progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}
                aria-label="探测进度"
                className="min-w-24 max-w-40 flex-1"
              />
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {progress ? `${progress.done}/${progress.total}` : ""}
              </span>
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => (abortedRef.current = true)}>
                中止
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" className="h-8 text-xs" disabled={busy || loading || visibleRows.length === 0} onClick={probeAll}>
                <Zap className="size-4" />
                获取可申报量（{visibleRows.length}）
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={busy || Object.keys(limits).length === 0}
                onClick={() => {
                  setFilterValue("")
                  setFilterOpen(true)
                }}
              >
                <Filter className="size-4" /> 筛选
              </Button>
            </>
          )}
        </div>

        {partialErrors.length > 0 && (
          <p className="rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            部分店铺加载失败：{partialErrors.map((e) => `${e.store}（${e.error}）`).join("；")}
          </p>
        )}

        <div className={DIALOG_SCROLL_CLS}>
          <table className="w-full caption-bottom text-xs">
            <TableHeader className={DIALOG_HEADER_CLS}>
              <TableRow>
                <TableHead className="w-8">
                  <SelectAllCheckbox allChecked={allChecked} someChecked={someChecked} onToggle={toggleAll} />
                </TableHead>
                <TableHead className="w-14">主图</TableHead>
                <TableHead className="w-24">货号</TableHead>
                <TableHead className="w-20">近7日销量</TableHead>
                <TableHead className="w-20">本地库存</TableHead>
                <TableHead className="w-24">可申报上限</TableHead>
                <TableHead className="w-28">申报数量</TableHead>
                <TableHead className="w-20">状态</TableHead>
                {!store && <TableHead className="w-24">店铺</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && visibleRows.length === 0 && <TableSkeletonRows rows={3} colSpan={store ? 8 : 9} />}
              {!loading && visibleRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={store ? 8 : 9} className="h-20 text-center text-muted-foreground">
                    {error ?? "暂无符合条件的在售链接（需本地库存 > 0）"}
                  </TableCell>
                </TableRow>
              )}
              {visibleRows.map((r, i) => {
                const lim = limits[r.productSkcId]
                const qs = qtyState(r)
                const over = qs != null && !qs.valid
                const locked = !lim || lim.max == null || lim.max <= 0
                return (
                  <TableRow
                    key={r.productSkcId}
                    className={
                      i === cursor || processingSkcs.has(r.productSkcId) ? "bg-primary/5" : undefined
                    }
                  >
                    <TableCell>
                      <Checkbox
                        checked={selected.has(r.productSkcId)}
                        disabled={busy || lim?.max === 0}
                        onCheckedChange={() =>
                          setSelected((s) => {
                            const n = new Set(s)
                            if (n.has(r.productSkcId)) n.delete(r.productSkcId)
                            else n.add(r.productSkcId)
                            return n
                          })
                        }
                        aria-label="选择"
                      />
                    </TableCell>
                    <TableCell>
                      {/* 图片打开即解码（勿 lazy）：lazy 图滚动进视口时异步解码获独立合成层，分数缩放下会越界画到 sticky 表头上方 */}
                      {r.mainImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={temuImageSrc(r.mainImageCosUrl, r.mainImageUrl)}
                          alt=""
                          className="size-9 rounded object-cover"
                        />
                      ) : (
                        <div className="size-9 rounded bg-muted" />
                      )}
                    </TableCell>
                    <TableCell className="max-w-24 truncate font-mono">{r.productSn ?? <EmptyHint />}</TableCell>
                    <TableCell className="tabular-nums">{r.last7DaysSalesVolume ?? <EmptyHint />}</TableCell>
                    <TableCell className="tabular-nums">{invMap[r.productSn ?? ""]?.totalQty ?? <EmptyHint />}</TableCell>
                    <TableCell>
                      {(() => {
                        if (!lim)
                          return (
                            <Badge className="rounded-[4px] bg-muted px-1 text-[10px] text-muted-foreground">未探测</Badge>
                          )
                        if (lim.error)
                          return (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger className="cursor-default">
                                  <Badge className="rounded-[4px] bg-red-500/15 px-1 text-[10px] text-red-700 dark:text-red-400">
                                    探测失败
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-64 break-all">{lim.error}</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )
                        if (lim.max === 0)
                          return (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger className="cursor-default">
                                  <Badge className="rounded-[4px] bg-red-500/15 px-1 text-[10px] text-red-700 dark:text-red-400">
                                    不可申报
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>官方返回可申报上限为 0，当前不可申报</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )
                        if (lim.max == null)
                          return (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger
                                  className="cursor-default text-amber-600 dark:text-amber-400"
                                  aria-label="未能解析上限"
                                >
                                  <CircleAlert className="size-3.5" />
                                </TooltipTrigger>
                                <TooltipContent className="text-xs">
                                  官方错误文案未能解析出该 SKU 的可申报上限，可重新探测
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )
                        return (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger className="cursor-default tabular-nums">{lim.max}</TooltipTrigger>
                              <TooltipContent className="max-w-72">
                                各 SKU 上限：
                                {lim.perSku.map((s) => `${s.skuId}:${s.maxQuantity ?? "?"}`).join("、")}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )
                      })()}
                    </TableCell>
                    <TableCell>
                      <Input
                        className={`h-7 w-20 text-xs tabular-nums ${over ? "border-red-500 focus-visible:ring-red-500" : ""}`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={lim?.max ?? undefined}
                        value={quantities[r.productSkcId] ?? "0"}
                        disabled={busy || locked}
                        onChange={(e) =>
                          setQuantities((s) => ({ ...s, [r.productSkcId]: e.target.value }))
                        }
                        aria-label="申报数量"
                      />
                    </TableCell>
                    <TableCell>
                      <StatusIconCell
                        status={statusBySkc[r.productSkcId]}
                        rowKey={`SKC ${r.productSkcId}`}
                        processing={processingSkcs.has(r.productSkcId)}
                      />
                    </TableCell>
                    {!store && (
                      <TableCell className="max-w-24 truncate text-xs">{r.storeName || <EmptyHint />}</TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </table>
        </div>

        <DialogFooter className="items-center gap-2">
          <span className="mr-auto text-xs text-muted-foreground">
            {doneCount > 0
              ? `申报结果：成功 ${okDone} / 失败 ${doneCount - okDone}（悬停状态列看原因）`
              : applicable.length > 0
                ? `已勾选 ${selected.size} 行，其中 ${applicable.length} 行数量有效待申报`
                : "勾选并探测后按「批量申报」提交（数量需 ≤ 可申报上限）"}
          </span>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            关闭
          </Button>
          {applying ? (
            // 批量申报执行中：同「获取可申报量」探测口径——进度条 + done/total + 中止
            <>
              <Progress
                value={applyProgress && applyProgress.total > 0 ? Math.round((applyProgress.done / applyProgress.total) * 100) : 0}
                aria-label="申报进度"
                className="min-w-24 max-w-40"
              />
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {applyProgress ? `${applyProgress.done}/${applyProgress.total}` : ""}
              </span>
              <Button variant="outline" size="sm" onClick={() => (abortedRef.current = true)}>
                中止
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={busy || applicable.length === 0}
              onClick={() => setConfirming(true)}
            >
              <Send className="size-4" />
              批量申报（{applicable.length}）
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {confirming && (
      <ConfirmDialog
        open
        onOpenChange={(v) => !v && setConfirming(false)}
        title="确认批量申报"
        description={`将依次向官方申报 ${applicable.length} 个勾选链接的备货（每 SKU 按所填数量）。官方校验失败的单会在状态列逐行展示原因。`}
        confirmText="开始申报"
        pending={applying}
        onConfirm={() => {
          setConfirming(false)
          runApply()
        }}
      />
    )}

    {filterOpen && (
      <Dialog open onOpenChange={(v) => !v && setFilterOpen(false)}>
        <DialogContent className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle>筛选取消勾选</DialogTitle>
            <DialogDescription>
              可申报上限小于 X 的行将自动取消勾选（需先「获取可申报量」）。输入 X：
            </DialogDescription>
          </DialogHeader>
          <Input
            className="h-8 text-xs"
            inputMode="numeric"
            min={1}
            placeholder="如 100"
            value={filterValue}
            onChange={(e) => setFilterValue(e.target.value)}
            aria-label="筛选阈值 X"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setFilterOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={applyFilter}>
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )}
    </>
  )
}

/* ─── 弹窗2：批量加入发货（原自动创建发货，2026-11-05 改只入发货台不自动创建） ─── */

export function AutoJoinDialog({
  store,
  onClose,
  onCreated,
}: {
  /** 选中具体店铺；缺省=全部店铺（服务端扇出，行级店铺归属） */
  store?: string
  onClose: () => void
  /** 任一备货单加入成功后回调（父层刷新备货单列表） */
  onCreated: () => void
}) {
  const router = useRouter()
  const [rows, setRows] = React.useState<TemuPurchaseOrderRow[]>([])
  const [invMap, setInvMap] = React.useState<InvRef>({})
  const [error, setError] = React.useState<string | null>(null)
  const [partialErrors, setPartialErrors] = React.useState<Array<{ store: string; error: string }>>([])
  const [loading, setLoading] = React.useState(true)
  /** 勾选行（子单号；初始默认全选，批量加入仅提交勾选行） */
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  /** 加入结果（子单号 → 成功 / 失败原因） */
  const [statusBySn, setStatusBySn] = React.useState<Record<string, { ok: boolean; deliveryOrderSn?: string; error?: string }>>({})
  const [applying, startApplying] = React.useTransition()
  const [confirming, setConfirming] = React.useState(false)
  /** 批量加入进度（按单计）与当前正在提交块内的子单号（行高亮 + 状态列旋转图标） */
  const [applyProgress, setApplyProgress] = React.useState<{ done: number; total: number } | null>(null)
  const [processingSns, setProcessingSns] = React.useState<Set<string>>(new Set())
  /** 中止标记：点「中止」后不再继续后续块（块间生效，已提交块不回滚） */
  const abortedRef = React.useRef(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // 可加入发货台 = 已接单待发货(status=1) + 官方可加入发货台标记 + 常规备货
        // （海外备货勿创建/发货——顶部红色横幅警示，弹窗备货类型筛选固定常规且海外禁选）
        const r = await getTemuPurchaseOrdersAction({ status: "todo", ...(store ? { store } : {}) })
        if (cancelled) return
        if (!r.ok) {
          setError(r.error)
          return
        }
        const candidates = r.rows.filter(
          (x) => x.status === 1 && x.isCanJoinDeliverPlatform && x.stockingType !== 1,
        )
        const ref = await loadInvRef(store, candidates.map((x) => x.productSn))
        if (cancelled) return
        // 库存联动：本地库存>0 的货号才入列
        const filtered = candidates.filter((x) => !!x.productSn && (ref[x.productSn!]?.totalQty ?? 0) > 0)
        setRows(filtered)
        setInvMap(ref)
        setPartialErrors(r.errors ?? [])
        // 默认勾选排除库存不足行（同货号合并需求口径与 shortageOf 一致）；可手动勾选/全选
        const demand = new Map<string, number>()
        for (const x of filtered)
          demand.set(x.productSn!, (demand.get(x.productSn!) ?? 0) + Math.max(0, x.purchaseTotal ?? 0))
        const shortSn = (sn: string) => {
          const v = ref[sn]
          return !!v && (demand.get(sn) ?? 0) + v.pendingUnpacked > v.totalQty
        }
        setSelected(
          new Set(filtered.filter((x) => !shortSn(x.productSn!)).map((x) => x.subPurchaseOrderSn)),
        )
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      abortedRef.current = true
    }
  }, [store])

  /** 同货号合并需求（本弹窗各单下单量 + 已创建未装箱占用）对库存的缺口 */
  const demandBySn = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.productSn!, (m.get(r.productSn!) ?? 0) + Math.max(0, r.purchaseTotal ?? 0))
    return m
  }, [rows])

  const shortageOf = (sn: string): number => {
    const ref = invMap[sn]
    if (!ref) return 0
    const demand = (demandBySn.get(sn) ?? 0) + ref.pendingUnpacked
    return demand > ref.totalQty ? demand - ref.totalQty : 0
  }

  const shortageRows = React.useMemo(
    () => [...new Set(rows.map((r) => r.productSn!))].filter((sn) => shortageOf(sn) > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, invMap],
  )

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.subPurchaseOrderSn))
  const someChecked = rows.some((r) => selected.has(r.subPurchaseOrderSn))
  // 部分勾选（半选「-」态）或全选时点击 = 取消全部（同 TEMU 主表/库存面板口径）
  const toggleAll = () =>
    setSelected(() => (allChecked || someChecked ? new Set() : new Set(rows.map((r) => r.subPurchaseOrderSn))))

  const joinable = rows.filter((r) => selected.has(r.subPurchaseOrderSn))

  const runJoin = () => {
    // 按店铺分组 → 每店 ≤20/块串行加入发货台（官方 staging.add 单次上限 50，取 20
    // 让逐块聚焦可见）；进度/中止同申报弹窗口径，逐块结果写状态列
    const groups = new Map<string, string[]>()
    for (const r of joinable) {
      const list = groups.get(r.storeId) ?? []
      list.push(r.subPurchaseOrderSn)
      groups.set(r.storeId, list)
    }
    const total = joinable.length
    abortedRef.current = false
    setApplyProgress({ done: 0, total })
    startApplying(async () => {
      let done = 0
      let okCount = 0
      let badCount = 0
      try {
        let stopped = false
        for (const [storeId, sns] of groups) {
          if (stopped) break
          for (let i = 0; i < sns.length; i += 20) {
            if (abortedRef.current) {
              stopped = true
              break
            }
            const chunk = sns.slice(i, i + 20)
            setProcessingSns(new Set(chunk))
            const r = await addShipStagingAction({ store: storeId, subPurchaseOrderSns: chunk })
            if (!r.ok) {
              toast.error(r.error, { duration: 8000 })
              setStatusBySn((prev) => {
                const n = { ...prev }
                for (const sn of chunk) n[sn] = { ok: false, error: r.error }
                return n
              })
              badCount += chunk.length
            } else {
              setStatusBySn((prev) => {
                const n = { ...prev }
                for (const sn of chunk) n[sn] = { ok: r.joined.includes(sn) }
                for (const e of r.errors) n[e.sn] = { ok: false, error: e.reason }
                return n
              })
              okCount += r.joined.length
              badCount += r.errors.length
            }
            done += chunk.length
            setApplyProgress({ done, total })
          }
        }
        if (stopped) {
          // 中止：已提交块不回滚，剩余单停留未处理，留在弹窗看结果（不自动跳发货页）
          if (okCount > 0) onCreated()
          toast.warning(`已中止加入：完成 ${done} / 共 ${total}，剩余 ${total - done} 单未提交`, { duration: 6000 })
        } else if (okCount + badCount > 0) {
          if (badCount === 0) toast.success(`已加入发货台 ${okCount} 单，请在发货台创建发货单`)
          else toast.warning(`加入完成：${okCount} 成功 / ${badCount} 失败（状态列悬停看原因）`, { duration: 8000 })
          if (okCount > 0) {
            onCreated()
            onClose()
            // 跳转发货页（默认视图=发货台，挂载即拉官方 staging 列表，新加入的备货单直接可见）
            const p = new URLSearchParams(window.location.search)
            p.set("tab", "ship")
            router.push(`?${p.toString()}`)
          }
        }
      } catch {
        // 传输层失败（网络错/请求超限）兜底：流程走完让 applying 复位，不再卡死/未捕获
        toast.error("网络异常，操作未完成，请稍后重试", { duration: 6000 })
      } finally {
        setProcessingSns(new Set())
        setApplyProgress(null)
      }
    })
  }

  const doneCount = Object.keys(statusBySn).length
  const okDone = Object.values(statusBySn).filter((s) => s.ok).length

  return (
    <>
    <Dialog
      open
      onOpenChange={(v, details) => {
        if (!v && applying) {
          details.cancel()
          toast.warning("批量加入执行中，请先「中止」或等待完成")
          return
        }
        if (!v) onClose()
      }}
    >
      <DialogContent className={DIALOG_CONTENT_CLS}>
        <DialogHeader>
          <DialogTitle>批量加入发货（{rows.length} 个可加入单）</DialogTitle>
          <DialogDescription>
            仅列已接单待发货、官方标记可加入发货台、常规备货且本地库存&gt;0 的备货单（默认全选；库存不足的行默认不勾选，可手动勾选）。一键加入发货台后自动前往「发货」页·发货台，
            在创建发货单视图里按收货仓分组创建（可调发货数/包裹/发货仓库）。海外备货请勿加入（顶部红色横幅警示）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          {/* 备货类型筛选：官方无入参过滤，客户端口径固定常规；海外备货当前不可选（暂无海外备货计划） */}
          <Select value="0" onValueChange={() => {}}>
            <SelectTrigger className="h-8 w-32 text-xs" aria-label="备货类型筛选">
              <SelectValue>常规备货</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">常规备货</SelectItem>
              <SelectItem value="1" disabled>
                海外备货（暂不可用）
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">加入发货台不需要物流商/重量（创建发货单/装箱时才需要）</span>
        </div>

        {partialErrors.length > 0 && (
          <p className="rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            部分店铺加载失败：{partialErrors.map((e) => `${e.store}（${e.error}）`).join("；")}
          </p>
        )}

        <div className={DIALOG_SCROLL_CLS}>
          <table className="w-full caption-bottom text-xs">
            <TableHeader className={DIALOG_HEADER_CLS}>
              <TableRow>
                <TableHead className="w-8">
                  <SelectAllCheckbox allChecked={allChecked} someChecked={someChecked} onToggle={toggleAll} />
                </TableHead>
                <TableHead className="w-14">主图</TableHead>
                <TableHead className="w-24">货号</TableHead>
                <TableHead className="w-40">子单号</TableHead>
                <TableHead className="w-28">建议 / 下单</TableHead>
                <TableHead className="w-20">本地库存</TableHead>
                <TableHead className="w-24">库存核对</TableHead>
                <TableHead className="w-20">状态</TableHead>
                {!store && <TableHead className="w-24">店铺</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && rows.length === 0 && <TableSkeletonRows rows={3} colSpan={store ? 8 : 9} />}
              {!loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={store ? 8 : 9} className="h-20 text-center text-muted-foreground">
                    {error ?? "暂无可加入发货台的备货单（需已接单+可加入标记+常规备货+本地库存>0）"}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => {
                const shortage = shortageOf(r.productSn!)
                const snDemand = demandBySn.get(r.productSn!) ?? 0
                const snOrders = rows.filter((x) => x.productSn === r.productSn).length
                const snPending = invMap[r.productSn!]?.pendingUnpacked ?? 0
                return (
                  <TableRow
                    key={r.subPurchaseOrderSn}
                    className={processingSns.has(r.subPurchaseOrderSn) ? "bg-primary/5" : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        checked={selected.has(r.subPurchaseOrderSn)}
                        disabled={applying}
                        onCheckedChange={() =>
                          setSelected((s) => {
                            const n = new Set(s)
                            if (n.has(r.subPurchaseOrderSn)) n.delete(r.subPurchaseOrderSn)
                            else n.add(r.subPurchaseOrderSn)
                            return n
                          })
                        }
                        aria-label="选择"
                      />
                    </TableCell>
                    <TableCell>
                      {/* 图片打开即解码（勿 lazy）：防滚动中途异步解码的合成层越界画到表头上方 */}
                      {r.productPicture ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.productPicture} alt="" className="size-9 rounded object-cover" />
                      ) : (
                        <div className="size-9 rounded bg-muted" />
                      )}
                    </TableCell>
                    <TableCell className="max-w-24 font-mono">
                      <TruncTip text={r.productSn ?? ""} className="max-w-24 font-mono" />
                    </TableCell>
                    <TableCell className="max-w-40 font-mono">
                      <TruncTip text={r.subPurchaseOrderSn} className="max-w-40 font-mono" />
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      <span className="text-muted-foreground">建议 </span>
                      {r.adviceTotal ?? <EmptyHint />}
                      <span className="text-muted-foreground"> · 下单 </span>
                      {r.purchaseTotal ?? <EmptyHint />}
                    </TableCell>
                    <TableCell className="tabular-nums">{invMap[r.productSn!]?.totalQty ?? <EmptyHint />}</TableCell>
                    <TableCell>
                      {shortage > 0 ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger className="cursor-default">
                              <Badge className="rounded-[4px] bg-red-500/15 px-1 text-[10px] text-red-700 dark:text-red-400">
                                库存不足
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-72">
                              该货号本列表共 {snOrders} 单、合计下单 {snDemand} 件，加上已创建未装箱 {snPending} 件，共需{" "}
                              {snDemand + snPending} 件；本地库存 {invMap[r.productSn!]?.totalQty ?? 0} 件，缺 {shortage} 件
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <Badge className="rounded-[4px] bg-emerald-500/15 px-1 text-[10px] text-emerald-700 dark:text-emerald-400">
                          库存充足
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusIconCell
                        status={statusBySn[r.subPurchaseOrderSn]}
                        rowKey={r.subPurchaseOrderSn}
                        processing={processingSns.has(r.subPurchaseOrderSn)}
                      />
                    </TableCell>
                    {!store && (
                      <TableCell className="max-w-24 truncate text-xs">{r.storeName || <EmptyHint />}</TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </table>
        </div>

        <DialogFooter className="items-center gap-2">
          <span className="mr-auto text-xs text-muted-foreground">
            {doneCount > 0
              ? `加入结果：成功 ${okDone} / 失败 ${doneCount - okDone}（悬停状态列看原因）`
              : rows.length > 0
                ? shortageRows.length > 0
                  ? `已勾选 ${selected.size}/${rows.length}；${shortageRows.length} 个货号库存不足（${shortageRows.join("、")}）`
                  : `已勾选 ${selected.size}/${rows.length}；全部货号库存充足`
                : ""}
          </span>
          <Button variant="outline" size="sm" onClick={onClose} disabled={applying}>
            关闭
          </Button>
          {applying ? (
            // 批量加入执行中：同申报弹窗/探测口径——进度条 + done/total + 中止
            <>
              <Progress
                value={applyProgress && applyProgress.total > 0 ? Math.round((applyProgress.done / applyProgress.total) * 100) : 0}
                aria-label="加入进度"
                className="min-w-24 max-w-40"
              />
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {applyProgress ? `${applyProgress.done}/${applyProgress.total}` : ""}
              </span>
              <Button variant="outline" size="sm" onClick={() => (abortedRef.current = true)}>
                中止
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={joinable.length === 0} onClick={() => setConfirming(true)}>
              <Truck className="size-4" />
              批量加入（{joinable.length}）
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {confirming && (
      <ConfirmDialog
        open
        onOpenChange={(v) => !v && setConfirming(false)}
        title="确认批量加入发货台"
        description={`将对 ${joinable.length} 个勾选的备货单执行：加入发货台，成功后自动前往「发货」页·发货台创建发货单（可调发货数/包裹/发货仓库）。${
          shortageRows.length > 0
            ? `\n注意：${shortageRows.length} 个货号库存不足（${shortageRows.join("、")}），创建发货单时可能无法足量发货。`
            : ""
        }\n官方无移出发货台接口，加入后请在「发货」页继续完成创建发货单。`}
        confirmText="开始加入"
        pending={applying}
        onConfirm={() => {
          setConfirming(false)
          runJoin()
        }}
      />
    )}
    </>
  )
}
