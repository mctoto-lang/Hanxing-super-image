"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  Barcode,
  BookOpen,
  Building2,
  CalendarClock,
  ImageDown,
  Inbox,
  Loader2,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Send,
  Ship,
  Trash2,
  TriangleAlert,
  Truck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { SectionCards, type SectionCardData } from "@/components/section-cards"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ExcelExportButton } from "./excel-export-button"
import { cn } from "@/lib/utils"
import {
  finishProductionOrderAction,
  getProductionStatsAction,
  listFactoriesAction,
  listProductionOrdersAction,
  type ProductionOrderRow,
} from "@/server/actions/inventory-production"
import { DataTable, type ColumnDef } from "./data-table"
import { FacetedFilter } from "./faceted-filter"
import { InvBadge } from "./inv-badge"
import { PRODUCTION_STATUS_BADGE, PRODUCTION_STATUS_DOT, PRODUCTION_STATUS_LABELS } from "./labels"
import {
  ActionButton,
  DeleteOrderDialog,
  DirectShipDialog,
  FactoryDialog,
  FactoryShipDialog,
  OrderDetailSheet,
  OrderFormDialog,
  ReceiveDialog,
  ReceiveSheetDialog,
  SendMaterialsDialog,
  type Factory,
} from "./production"

/**
 * 生产规划面板：统计条四卡 + 生产单 Data Table（五态流转/直发/分批入库/
 * 删除冲正/超期标红）。弹窗组件在 ./production/ 下。
 */

/** 状态筛选选项（faceted 多选，按当前分组内的行过滤） */
const STATUS_OPTIONS = Object.entries(PRODUCTION_STATUS_LABELS).map(([value, label]) => ({
  value,
  label,
}))

export function ProductionPanel() {
  // ---- 列表与统计 ----
  const [group, setGroup] = React.useState<"open" | "archive">("open")
  const [rows, setRows] = React.useState<ProductionOrderRow[]>([])
  const [stats, setStats] = React.useState<{
    openBatches: number
    openQty: number
    waitReceiveQty: number
    monthReceivedQty: number
  } | null>(null)
  const [factories, setFactories] = React.useState<Factory[]>([])
  const [q, setQ] = React.useState("")
  const [statusFilters, setStatusFilters] = React.useState<string[]>([])
  const [loading, startLoad] = React.useTransition()
  // SSR 首帧无数据：首次加载完成前恒显骨架，避免水合前闪空态文案
  const [loadedOnce, setLoadedOnce] = React.useState(false)

  // ---- 多选（仅进行中组）→ 生成入库核对单图片 ----
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [sheetOpen, setSheetOpen] = React.useState(false)

  // ---- 弹窗状态 ----
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<ProductionOrderRow | null>(null)
  const [factoryOpen, setFactoryOpen] = React.useState(false)
  const [materialsFor, setMaterialsFor] = React.useState<ProductionOrderRow | null>(null)
  const [shipFor, setShipFor] = React.useState<ProductionOrderRow | null>(null)
  const [directFor, setDirectFor] = React.useState<ProductionOrderRow | null>(null)
  const [receiveFor, setReceiveFor] = React.useState<ProductionOrderRow | null>(null)
  const [finishFor, setFinishFor] = React.useState<ProductionOrderRow | null>(null)
  const [finishPending, startFinish] = React.useTransition()
  const [deleting, setDeleting] = React.useState<ProductionOrderRow | null>(null)
  const [detailId, setDetailId] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    startLoad(async () => {
      const [list, st, fs] = await Promise.all([
        listProductionOrdersAction({ group }),
        getProductionStatsAction(),
        listFactoriesAction(),
      ])
      if (list.ok) setRows(list.rows)
      else toast.error(list.error)
      if (st.ok) setStats(st.stats)
      if (fs.ok) setFactories(fs.rows)
      setLoadedOnce(true)
    })
  }, [group])

  React.useEffect(() => {
    load()
  }, [load])

  const data = React.useMemo(() => {
    let list = rows
    if (statusFilters.length > 0) list = list.filter((r) => statusFilters.includes(r.status))
    if (q.trim()) {
      const kw = q.trim().toLowerCase()
      list = list.filter(
        (r) =>
          r.productCode.toLowerCase().includes(kw) || r.productName.toLowerCase().includes(kw),
      )
    }
    return list
  }, [rows, statusFilters, q])

  const selectedOrders = React.useMemo(
    () => data.filter((r) => selectedIds.has(r.id)),
    [data, selectedIds],
  )

  const columns = React.useMemo<ColumnDef<ProductionOrderRow, unknown>[]>(
    () => [
      // 多选列（仅进行中组；已入满 remainQty≤0 的单不可勾——核对单上数量恒 0 无意义）
      ...(group === "open"
        ? ([
            {
              id: "sel",
              header: () => {
                const selectable = data.filter((r) => r.remainQty > 0)
                const all = selectable.length > 0 && selectable.every((r) => selectedIds.has(r.id))
                return (
                  <Checkbox
                    checked={all}
                    onCheckedChange={() =>
                      setSelectedIds(all ? new Set() : new Set(selectable.map((r) => r.id)))
                    }
                    aria-label="全选（仅含剩余待入的单）"
                  />
                )
              },
              enableSorting: false,
              cell: ({ row }) => {
                const r = row.original
                if (r.remainQty <= 0) {
                  return (
                    <span className="flex justify-center" title="已入满，无剩余待入">
                      <Checkbox checked={false} disabled />
                    </span>
                  )
                }
                return (
                  <span onClick={(e) => e.stopPropagation()} className="flex justify-center">
                    <Checkbox
                      checked={selectedIds.has(r.id)}
                      onCheckedChange={() =>
                        setSelectedIds((prev) => {
                          const next = new Set(prev)
                          if (next.has(r.id)) next.delete(r.id)
                          else next.add(r.id)
                          return next
                        })
                      }
                      aria-label={`选择 ${r.productCode}`}
                    />
                  </span>
                )
              },
            },
          ] as ColumnDef<ProductionOrderRow, unknown>[])
        : []),
      {
        id: "product",
        header: "图片/货号款名",
        accessorFn: (r) => r.productCode,
        cell: ({ row }) => {
          const r = row.original
          return (
            <div className="flex items-center gap-2">
              {r.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.imageUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
              ) : (
                <span className="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                  无图
                </span>
              )}
              <div className="min-w-0">
                <div className="font-normal">{r.productCode}</div>
                <div className="max-w-40 truncate text-muted-foreground" title={r.productName}>
                  {r.productName}
                </div>
              </div>
            </div>
          )
        },
      },
      {
        id: "factory",
        header: "工厂",
        accessorFn: (r) => r.factoryCode,
        cell: ({ row }) => (
          <span title={row.original.factoryName} className="whitespace-nowrap">
            {row.original.factoryCode}
          </span>
        ),
      },
      {
        accessorKey: "quantity",
        header: "数量",
        cell: ({ row }) => <span className="tabular-nums">{row.original.quantity}</span>,
      },
      {
        id: "progress",
        header: "直发/入库/余量",
        accessorFn: (r) => r.shippedQty + r.directQty,
        cell: ({ row }) => {
          const r = row.original
          return (
            <span className="tabular-nums">
              <span className="text-sky-600">{r.directQty}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-emerald-600">{r.shippedQty}</span>
              <span className="text-muted-foreground"> / 剩 </span>
              <span className={cn(r.remainQty === 0 && "text-muted-foreground")}>
                {r.remainQty}
              </span>
            </span>
          )
        },
      },
      {
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => (
          <InvBadge
            className={PRODUCTION_STATUS_BADGE[row.original.status]}
            dot={PRODUCTION_STATUS_DOT[row.original.status]}
          >
            {PRODUCTION_STATUS_LABELS[row.original.status]}
          </InvBadge>
        ),
      },
      {
        id: "days",
        header: "耗时",
        accessorFn: (r) => r.daysElapsed,
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.daysElapsed} 天</span>
        ),
      },
      {
        accessorKey: "expectedDate",
        header: "预计交期",
        cell: ({ row }) =>
          row.original.expectedDate ? (
            <span
              className={cn(
                "whitespace-nowrap",
                row.original.overdue && "font-normal text-red-600",
              )}
            >
              {row.original.expectedDate}
              {row.original.overdue ? " 超期" : ""}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "aux",
        header: "辅料",
        enableSorting: false,
        cell: ({ row }) => {
          const a = row.original.aux
          // 4 图标（勾选=亮 / 未勾=灰半透明），悬停 Tooltip 显示中文名
          const items = [
            ["条码", a.barcode, Barcode],
            ["说明书", a.manual, BookOpen],
            ["气泡袋", a.bubble, Package],
            ["警告标", a.warn, TriangleAlert],
          ] as const
          return (
            <div className="flex items-center gap-2">
              {items.map(([label, on, Icon]) => (
                <Tooltip key={label}>
                  <TooltipTrigger
                    render={
                      <span
                        className={cn(
                          "inline-flex cursor-default",
                          on ? "text-foreground" : "text-muted-foreground opacity-50",
                        )}
                      />
                    }
                  >
                    <Icon className="size-4" />
                  </TooltipTrigger>
                  <TooltipContent side="top">{label}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          )
        },
      },
      {
        accessorKey: "productionDate",
        header: "生产日期",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {row.original.productionDate}
          </span>
        ),
      },
      {
        id: "actions",
        header: "操作",
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original
          const open = group === "open"
          const canShip = open && (r.status === "producing" || r.status === "factory_shipped")
          const canReceive = open && r.remainQty > 0 && r.status !== "materials_pending"
          const canEdit = open && ["materials_pending", "producing", "factory_shipped"].includes(r.status)
          const hasFlow =
            (open && r.status === "materials_pending") || canShip || canReceive || (open && r.status === "received")
          return (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              {canEdit ? (
                <ActionButton
                  title="编辑"
                  icon={<Pencil className="size-3.5" />}
                  onClick={() => {
                    setEditing(r)
                    setFormOpen(true)
                  }}
                />
              ) : null}
              <ActionButton
                title="详情"
                icon={<CalendarClock className="size-3.5" />}
                onClick={() => setDetailId(r.id)}
              />
              {open ? (
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
                    {open && r.status === "materials_pending" ? (
                      <DropdownMenuItem onClick={() => setMaterialsFor(r)}>
                        <Send className="size-3.5" /> 发材料
                      </DropdownMenuItem>
                    ) : null}
                    {canShip ? (
                      <DropdownMenuItem onClick={() => setShipFor(r)}>
                        <Truck className="size-3.5" /> 工厂出货
                      </DropdownMenuItem>
                    ) : null}
                    {canShip && r.remainQty > 0 ? (
                      <DropdownMenuItem onClick={() => setDirectFor(r)}>
                        <Ship className="size-3.5" /> 工厂代发
                      </DropdownMenuItem>
                    ) : null}
                    {canReceive ? (
                      <DropdownMenuItem onClick={() => setReceiveFor(r)}>
                        <Inbox className="size-3.5" /> 货物入库
                      </DropdownMenuItem>
                    ) : null}
                    {open && r.status === "received" ? (
                      <DropdownMenuItem onClick={() => setFinishFor(r)}>
                        <Package className="size-3.5" /> 完结
                      </DropdownMenuItem>
                    ) : null}
                    {hasFlow ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleting(r)}>
                      <Trash2 className="size-3.5" /> 删除生产单
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          )
        },
      },
    ],
    [group, selectedIds, data],
  )

  const statCards: SectionCardData[] = [
    {
      label: "在产批次",
      value: `${stats?.openBatches ?? "—"} 批`,
      footerLead: "未完结生产单（前三态）",
    },
    {
      label: "在产件数",
      value: `${stats?.openQty ?? "—"} 件`,
      footerLead: "未完结生产单合计数量",
    },
    {
      label: "待入库件数",
      value: `${stats?.waitReceiveQty ?? "—"} 件`,
      footerLead: "工厂已发待入库余量",
    },
    {
      label: "本月入库",
      value: `${stats?.monthReceivedQty ?? "—"} 件`,
      footerLead: "本月生产入库流水合计",
    },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 统计条四卡（SectionCards 同款样式；无环比） */}
      <SectionCards cards={statCards} className="grid-cols-2 gap-3 xl:grid-cols-4" />

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-base font-normal">
            生产单
            {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
            <span className="text-sm font-normal text-muted-foreground">（{data.length} 单）</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜货号/款名"
              className="h-8 w-[150px] lg:w-[250px]"
            />
            <FacetedFilter
              title="状态"
              options={STATUS_OPTIONS}
              values={statusFilters}
              onChange={setStatusFilters}
            />
            <div className="inline-flex h-8 items-center rounded-lg bg-muted p-0.5 text-xs">
              {(
                [
                  ["open", "进行中"],
                  ["archive", "已入库/已结束"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  className={cn(
                    "rounded-md px-2.5 py-1 transition-colors",
                    group === v
                      ? "bg-background font-normal shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => {
                    setGroup(v)
                    setSelectedIds(new Set())
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="h-8" onClick={() => setFactoryOpen(true)}>
              <Building2 className="size-3.5" /> 工厂档案
            </Button>
            <ExcelExportButton kind="production" />
            {group === "open" && selectedOrders.length > 0 ? (
              <Button variant="outline" size="sm" className="h-8" onClick={() => setSheetOpen(true)}>
                <ImageDown className="size-3.5" /> 生成入库单（{selectedOrders.length}）
              </Button>
            ) : null}
            <Button
              size="sm"
              className="h-8"
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              <Plus className="size-3.5" /> 新建生产单
            </Button>
          </div>
        </div>
        <DataTable
          columns={columns}
          data={data}
          containerClassName="min-h-0 flex-1"
          initialSorting={[{ id: "days", desc: true }]}
          loading={loading || !loadedOnce}
          onRowClick={(r) => setDetailId(r.id)}
          isRowSelected={group === "open" ? (r) => selectedIds.has(r.id) : undefined}
          empty={group === "open" ? "暂无进行中生产单，点「新建生产单」开始" : "暂无归档生产单"}
        />
      </div>

      {/* 建单/编辑 */}
      <OrderFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        factories={factories}
        onSaved={load}
      />

      {/* 发材料 */}
      <SendMaterialsDialog order={materialsFor} onOpenChange={(o) => !o && setMaterialsFor(null)} onDone={load} />

      {/* 登记工厂发货 */}
      <FactoryShipDialog order={shipFor} onOpenChange={(o) => !o && setShipFor(null)} onDone={load} />

      {/* 直发登记 */}
      <DirectShipDialog
        order={directFor}
        onOpenChange={(o) => !o && setDirectFor(null)}
        onDone={load}
      />

      {/* 入库 */}
      <ReceiveDialog
        order={receiveFor}
        onOpenChange={(o) => !o && setReceiveFor(null)}
        onDone={load}
      />

      {/* 入库核对单图片（多选生产单生成，仅图片不落库） */}
      <ReceiveSheetDialog open={sheetOpen} onOpenChange={setSheetOpen} orders={selectedOrders} />

      {/* 完结确认 */}
      <ConfirmDialog
        open={Boolean(finishFor)}
        onOpenChange={(o) => !o && setFinishFor(null)}
        title={`完结生产单 ${finishFor?.productCode ?? ""}（${finishFor?.quantity ?? 0} 件）`}
        description="完结后进入归档视图，不可再操作。"
        confirmText="确认完结"
        pending={finishPending}
        onConfirm={() => {
          startFinish(async () => {
            if (!finishFor) return
            const r = await finishProductionOrderAction(finishFor.id)
            if (r.ok) {
              toast.success("已完结")
              setFinishFor(null)
              load()
            } else toast.error(r.error)
          })
        }}
      />

      {/* 删除（原因+冲正提示） */}
      <DeleteOrderDialog order={deleting} onOpenChange={(o) => !o && setDeleting(null)} onDone={load} />

      {/* 详情抽屉 */}
      <OrderDetailSheet orderId={detailId} onOpenChange={(o) => !o && setDetailId(null)} />

      {/* 工厂档案 */}
      <FactoryDialog
        open={factoryOpen}
        onOpenChange={setFactoryOpen}
        factories={factories}
        onSaved={load}
      />
    </div>
  )
}
