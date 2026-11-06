"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  ArrowLeftRight,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  ScrollText,
  SlidersHorizontal,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  deleteProductAction,
  getInventoryOverviewAction,
  getInventorySettingsAction,
  updateRestockThresholdAction,
  type InventoryOverviewRow,
} from "@/server/actions/inventory"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { DataTable, type ColumnDef } from "./data-table"
import { EmptyHint } from "@/components/temu/products-table"
import { FacetedFilter } from "./faceted-filter"
import { InvBadge } from "./inv-badge"
import {
  PRODUCTION_STATE_BADGE,
  PRODUCTION_STATE_DOT,
  PRODUCTION_STATE_LABELS,
  SHIP_STATE_BADGE,
  SHIP_STATE_DOT,
  SHIP_STATE_LABELS,
  STOCK_STATUS_BADGE,
  STOCK_STATUS_DOT,
  STOCK_STATUS_LABELS,
} from "./labels"
import { ProductFormDialog, type ProductFormValue } from "./product-form-dialog"
import { MovementDialog, type MovementDialogTarget } from "./movement-dialogs"
import { ProductDetailSheet } from "./product-detail-sheet"
import { BatchMovementDialog } from "./batch-movement-dialog"
import { ExcelExportButton } from "./excel-export-button"

/**
 * 库存总览子视图：Data Table（紧凑 40px 图/列竖线/排序）+ 筛选 chips +
 * 行操作（库存变动三合一弹窗：入库/出库/调拨）+ 批量变动（弹窗内切换）+
 * 补货阈值配置（企业级，状态徽章 Tooltip 展示六态口径）
 */


/** 状态筛选选项（faceted 多选，OR 叠加；「在产」为特殊项=生产库存>0） */
const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "normal", label: "正常" },
  { value: "restock", label: "补货" },
  { value: "out_of_stock", label: "缺货" },
  { value: "stagnant", label: "滞销" },
  { value: "discontinued", label: "停产" },
  { value: "clearance", label: "清仓" },
  { value: "producing", label: "在产" },
]

/** 六态徽章 Tooltip 口径文案（可售天数=(仓库+TEMU净+在产)÷加权日销） */
function statusTip(row: InventoryOverviewRow, thresholdDays: number): string {
  const cover = `仓库 ${row.totalQty} + TEMU ${row.temuStock} + 在产 ${row.producingQty}`
  switch (row.status) {
    case "normal":
      return `${cover} = 可售 ${row.availableDays} 天 ≥ 阈值 ${thresholdDays} 天`
    case "restock":
      return `${cover} = 可售 ${row.availableDays} 天 < 阈值 ${thresholdDays} 天，需生产补货`
    case "out_of_stock":
      return "仓库库存为 0（持续生产中，等待补货/入库）"
    case "stagnant":
      return "加权日销为 0（近 30 天零销量），库存滞销待处理"
    case "discontinued":
      return "停止生产且仓库库存为 0"
    case "clearance":
      return `停止生产，仓库库存 ${row.totalQty} 件待清仓`
  }
}

export function StockOverviewPanel({
  initialRows,
  initialThresholdDays,
  initialStatus,
}: {
  initialRows: InventoryOverviewRow[]
  /** 补货阈值初值（服务端首屏带入，避免默认 14 闪烁） */
  initialThresholdDays?: number
  /** URL 下钻预设状态筛选（分析页 KPI/环形图点击跳转） */
  initialStatus?: string
}) {
  const [rows, setRows] = React.useState(initialRows)
  const [statusFilters, setStatusFilters] = React.useState<string[]>(
    initialStatus ? [initialStatus] : [],
  )
  const [q, setQ] = React.useState("")
  const [loading, startLoad] = React.useTransition()
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<ProductFormValue | null>(null)
  const [movementTarget, setMovementTarget] = React.useState<MovementDialogTarget | null>(null)
  const [detailId, setDetailId] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<InventoryOverviewRow | null>(null)
  const [deleteReason, setDeleteReason] = React.useState("")
  const [deletePending, startDelete] = React.useTransition()
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [batchOpen, setBatchOpen] = React.useState(false)
  /** 补货阈值（企业级；状态 Tooltip 与补货判定口径共用） */
  const [thresholdDays, setThresholdDays] = React.useState(initialThresholdDays ?? 14)
  const [thresholdOpen, setThresholdOpen] = React.useState(false)
  const [thresholdDraft, setThresholdDraft] = React.useState("14")
  const [thresholdPending, startThreshold] = React.useTransition()

  React.useEffect(() => {
    void getInventorySettingsAction().then((r) => {
      if (r.ok) setThresholdDays(r.thresholdDays)
    })
  }, [])

  const saveThreshold = () => {
    const days = Number(thresholdDraft)
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      toast.error("阈值须为 1-365 的整数（天）")
      return
    }
    startThreshold(async () => {
      const r = await updateRestockThresholdAction({ thresholdDays: days })
      if (r.ok) {
        setThresholdDays(r.thresholdDays)
        setThresholdOpen(false)
        toast.success(`补货阈值已更新为 ${r.thresholdDays} 天`)
        load()
      } else {
        toast.error(r.error)
      }
    })
  }

  const load = React.useCallback(() => {
    startLoad(async () => {
      const r = await getInventoryOverviewAction({})
      if (r.ok) setRows(r.rows)
      else toast.error(r.error)
    })
  }, [])

  const data = React.useMemo(() => {
    let list = rows
    if (statusFilters.length > 0) {
      list = list.filter((r) =>
        statusFilters.some((f) => (f === "producing" ? r.producingQty > 0 : r.status === f)),
      )
    }
    if (q.trim()) {
      const kw = q.trim().toLowerCase()
      list = list.filter(
        (r) =>
          r.productCode.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw),
      )
    }
    return list
  }, [rows, statusFilters, q])

  const openEdit = (row: InventoryOverviewRow) => {
    setEditing({
      id: row.id,
      productCode: row.productCode,
      name: row.name,
      imageUrl: row.imageUrl,
      cartonQty: row.cartonQty,
      leadTimeDays: row.leadTimeDays,
      stockUpper: row.stockUpper,
      moq: row.moq,
      barcodePrePasted: row.barcodePrePasted,
      productionState: row.productionState,
      shipState: row.shipState,
      note: row.note,
    })
    setFormOpen(true)
  }

  const confirmDelete = () => {
    if (!deleting) return
    if (!deleteReason.trim()) {
      toast.error("请填写删除原因")
      return
    }
    startDelete(async () => {
      const r = await deleteProductAction(deleting.id)
      if (r.ok) {
        toast.success(`货号 ${deleting.productCode} 已删除（原因：${deleteReason.trim()}）`)
        setDeleting(null)
        setDeleteReason("")
        load()
      } else {
        toast.error(r.error)
      }
    })
  }

  const columns = React.useMemo<ColumnDef<InventoryOverviewRow, unknown>[]>(
    () => [
      {
        id: "sel",
        header: () => (
          <Checkbox
            checked={data.length > 0 && data.every((r) => selectedIds.has(r.id))}
            onCheckedChange={() =>
              setSelectedIds(
                data.every((r) => selectedIds.has(r.id))
                  ? new Set()
                  : new Set(data.map((r) => r.id)),
              )
            }
            aria-label="全选"
          />
        ),
        enableSorting: false,
        cell: ({ row }) => (
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={selectedIds.has(row.original.id)}
              onCheckedChange={() =>
                setSelectedIds((prev) => {
                  const next = new Set(prev)
                  if (next.has(row.original.id)) next.delete(row.original.id)
                  else next.add(row.original.id)
                  return next
                })
              }
            />
          </span>
        ),
      },
      {
        id: "image",
        header: "图片",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.original.imageUrl}
              alt=""
              className="size-10 shrink-0 rounded object-cover"
            />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
              无图
            </span>
          ),
      },
      {
        accessorKey: "productCode",
        header: "货号",
        sortingFn: "text",
        cell: ({ row }) => <span>{row.original.productCode}</span>,
      },
      {
        accessorKey: "name",
        header: "款名",
        sortingFn: "text",
        cell: ({ row }) => (
          <span className="block max-w-44 truncate" title={row.original.name}>
            {row.original.name}
          </span>
        ),
      },
      {
        id: "total",
        header: "库存数量",
        accessorFn: (row) => row.totalQty,
        cell: ({ row }) => <span className="tabular-nums">{row.original.totalQty}</span>,
      },
      {
        id: "producing",
        header: "生产库存",
        accessorFn: (row) => row.producingQty,
        cell: ({ getValue }) => <span className="tabular-nums">{getValue() as number}</span>,
      },
      {
        id: "status",
        header: "状态",
        accessorFn: (row) => row.status,
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex cursor-default">
                  <InvBadge
                    className={STOCK_STATUS_BADGE[row.original.status]}
                    dot={STOCK_STATUS_DOT[row.original.status]}
                  >
                    {STOCK_STATUS_LABELS[row.original.status]}
                  </InvBadge>
                </span>
              }
            />
            <TooltipContent side="top" className="max-w-64">
              {statusTip(row.original, thresholdDays)}
            </TooltipContent>
          </Tooltip>
        ),
      },
      {
        id: "availableDays",
        header: "可售天数",
        accessorFn: (row) => row.availableDays ?? -1,
        cell: ({ row }) =>
          row.original.availableDays != null ? (
            <span className="tabular-nums">{row.original.availableDays}</span>
          ) : (
            <EmptyHint />
          ),
      },
      {
        accessorKey: "shipState",
        header: "发货状态",
        cell: ({ row }) => (
          <InvBadge
            className={SHIP_STATE_BADGE[row.original.shipState]}
            dot={SHIP_STATE_DOT[row.original.shipState]}
          >
            {SHIP_STATE_LABELS[row.original.shipState]}
          </InvBadge>
        ),
      },
      {
        accessorKey: "productionState",
        header: "生产状态",
        cell: ({ row }) => (
          <InvBadge
            className={PRODUCTION_STATE_BADGE[row.original.productionState]}
            dot={PRODUCTION_STATE_DOT[row.original.productionState]}
          >
            {PRODUCTION_STATE_LABELS[row.original.productionState]}
          </InvBadge>
        ),
      },
      {
        accessorKey: "cartonQty",
        header: "装箱数",
        cell: ({ row }) =>
          row.original.cartonQty != null ? (
            <span className="tabular-nums">{row.original.cartonQty}</span>
          ) : (
            <EmptyHint />
          ),
      },
      {
        accessorKey: "moq",
        header: "MOQ",
        cell: ({ row }) =>
          row.original.moq != null ? (
            <span className="tabular-nums">{row.original.moq}</span>
          ) : (
            <EmptyHint />
          ),
      },
      {
        accessorKey: "leadTimeDays",
        header: "生产周期(天)",
        cell: ({ row }) =>
          row.original.leadTimeDays != null ? (
            <span className="tabular-nums">{row.original.leadTimeDays}</span>
          ) : (
            <EmptyHint />
          ),
      },
      {
        id: "actions",
        header: "操作",
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original
          return (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0"
                      onClick={() => openEdit(r)}
                    />
                  }
                >
                  <Pencil className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent side="top">编辑档案</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-7 p-0"
                      onClick={() =>
                        setMovementTarget({
                          product: { id: r.id, productCode: r.productCode, name: r.name },
                        })
                      }
                    />
                  }
                >
                  <ArrowLeftRight className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent side="top">库存变动（入库/出库）</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-8 p-0 data-[state=open]:bg-muted"
                          />
                        }
                      />
                    }
                  >
                    <MoreHorizontal className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent side="top">更多操作</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setDetailId(r.id)}>
                    <ScrollText className="size-3.5" /> 详情与流水
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleting(r)}
                  >
                    <Trash2 className="size-3.5" /> 删除档案
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    ],
    [selectedIds, data, thresholdDays],
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-base">
          库存总览
          {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
          <span className="text-sm font-normal text-muted-foreground">
            （{data.length} 个货号）
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜货号/款名"
            className="h-8 w-[150px] lg:w-[250px]"
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => {
                    setThresholdDraft(String(thresholdDays))
                    setThresholdOpen(true)
                  }}
                />
              }
            >
              <SlidersHorizontal className="size-3.5" />
              阈值 {thresholdDays} 天
            </TooltipTrigger>
            <TooltipContent side="top">补货阈值：可售天数低于该值判定为「补货」（点击配置）</TooltipContent>
          </Tooltip>
          <FacetedFilter
            title="状态"
            options={STATUS_OPTIONS}
            values={statusFilters}
            onChange={setStatusFilters}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={selectedIds.size === 0}
            onClick={() => setBatchOpen(true)}
          >
            <ArrowLeftRight className="size-3.5" />
            批量变动{selectedIds.size > 0 ? `（${selectedIds.size}）` : ""}
          </Button>
          <Button
            size="sm"
            className="h-8"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            <Plus className="size-3.5" /> 新建档
          </Button>
          <ExcelExportButton kind="overview" />
        </div>
      </div>
      <DataTable
        columns={columns}
        data={data}
        containerClassName="min-h-0 flex-1"
        initialSorting={[{ id: "productCode", desc: false }]}
        columnDividers
        infinite
        onRowClick={(r) => setDetailId(r.id)}
        isRowSelected={(r) => selectedIds.has(r.id)}
        empty={
          <div className="space-y-2 py-6 text-center text-muted-foreground">
            <p>{rows.length === 0 ? "还没有货号档案，点「新建档」开始" : "无匹配货号"}</p>
          </div>
        }
      />

      <ProductFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editing}
        onSaved={load}
      />
      <MovementDialog
        target={movementTarget}
        onOpenChange={(open) => {
          if (!open) setMovementTarget(null)
        }}
        onDone={load}
      />
      <BatchMovementDialog
        open={batchOpen}
        products={rows.filter((r) => selectedIds.has(r.id))}
        onOpenChange={setBatchOpen}
        onDone={load}
      />
      <ProductDetailSheet
        productId={detailId}
        onOpenChange={(open) => {
          if (!open) setDetailId(null)
        }}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null)
            setDeleteReason("")
          }
        }}
        title={`删除货号 ${deleting?.productCode ?? ""}`}
        description={
          <span>
            仅可删除无任何库存流水和生产单的货号；删除原因仅作本地记录。
            <Input
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="删除原因（必填）"
              className="mt-2 h-8 text-xs"
            />
          </span>
        }
        destructive
        pending={deletePending}
        onConfirm={confirmDelete}
      />
      <Dialog
        open={thresholdOpen}
        onOpenChange={(open) => {
          setThresholdOpen(open)
          if (open) setThresholdDraft(String(thresholdDays))
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>补货阈值</DialogTitle>
            <DialogDescription>
              可售天数 =（仓库库存 + TEMU 净库存 + 在产）÷ 加权日销；低于阈值判定为「补货」状态。企业级统一配置，对所有货号生效。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input
              value={thresholdDraft}
              onChange={(e) => setThresholdDraft(e.target.value)}
              inputMode="numeric"
              className="h-8 w-24"
              aria-label="补货阈值（天）"
            />
            <span className="text-sm text-muted-foreground">天</span>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setThresholdOpen(false)} disabled={thresholdPending}>
              取消
            </Button>
            <Button size="sm" onClick={saveThreshold} disabled={thresholdPending}>
              {thresholdPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
