"use client"

import * as React from "react"
import { toast } from "sonner"
import type { DateRange } from "react-day-picker"
import { ArrowLeftRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { HistoryDateRangePicker } from "@/components/product-v2/history-date-range-picker"
import {
  getInventoryMovementProductsAction,
  type InventoryMovementProductRow,
} from "@/server/actions/inventory"
import { cn } from "@/lib/utils"
import { DataTable, type ColumnDef } from "./data-table"
import { MovementDialog, type MovementDialogTarget } from "./movement-dialogs"
import { ProductDetailSheet } from "./product-detail-sheet"

/**
 * 库存出入子视图：日期范围（默认今日）内有变动的商品聚合
 * （笔数/入/出/净/当前库存）；点行开详情抽屉看完整流水；
 * 「库存变动」按钮弹三合一弹窗（与总览操作列同款入口）。
 */

/** 北京时间今日日期串（与 action 日界同口径，和浏览器本地时区解耦） */
function bjToday(): Date {
  // 正午锚点：DateRange 选择器返回本地 Date，取北京今日正午保证 toLocaleDateString 稳定
  const d = new Date()
  return new Date(
    `${d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })}T12:00:00`,
  )
}

/** Date → 北京日期串 */
function toBjDay(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
}

export function MovementPanel() {
  const [rows, setRows] = React.useState<InventoryMovementProductRow[]>([])
  const [summary, setSummary] = React.useState({ products: 0, inQty: 0, outQty: 0 })
  const [range, setRange] = React.useState<DateRange | undefined>(() => {
    const t = bjToday()
    return { from: t, to: t }
  })
  const [loading, startLoad] = React.useTransition()
  // SSR 首帧无数据：首次加载完成前恒显骨架，避免水合前闪空态文案
  const [loadedOnce, setLoadedOnce] = React.useState(false)
  const [movementTarget, setMovementTarget] = React.useState<MovementDialogTarget | null>(null)
  const [detailId, setDetailId] = React.useState<string | null>(null)

  const load = React.useCallback((r: DateRange | undefined) => {
    if (!r?.from) {
      toast.error("请选择日期范围")
      return
    }
    const from = toBjDay(r.from)
    // to 空选（只点了起始日）按单日处理
    const to = r.to ? toBjDay(r.to) : from
    startLoad(async () => {
      const res = await getInventoryMovementProductsAction({ from, to })
      if (res.ok) {
        setRows(res.rows)
        setSummary(res.summary)
      } else {
        toast.error(res.error)
      }
      setLoadedOnce(true)
    })
  }, [])

  React.useEffect(() => {
    load(range)
  }, [load, range])

  const columns = React.useMemo<ColumnDef<InventoryMovementProductRow, unknown>[]>(
    () => [
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
        cell: ({ row }) => <span className="font-normal">{row.original.productCode}</span>,
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
        accessorKey: "count",
        header: "变动笔数",
        cell: ({ row }) => <span className="tabular-nums">{row.original.count}</span>,
      },
      {
        accessorKey: "inQty",
        header: "入库",
        cell: ({ row }) =>
          row.original.inQty > 0 ? (
            <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
              +{row.original.inQty}
            </span>
          ) : (
            <span className="tabular-nums text-muted-foreground">0</span>
          ),
      },
      {
        accessorKey: "outQty",
        header: "出库",
        cell: ({ row }) =>
          row.original.outQty > 0 ? (
            <span className="tabular-nums text-red-600 dark:text-red-400">
              −{row.original.outQty}
            </span>
          ) : (
            <span className="tabular-nums text-muted-foreground">0</span>
          ),
      },
      {
        accessorKey: "netQty",
        header: "净变动",
        cell: ({ row }) => {
          const v = row.original.netQty
          return (
            <span
              className={cn(
                "font-normal tabular-nums",
                v > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : v < 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-muted-foreground",
              )}
            >
              {v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0"}
            </span>
          )
        },
      },
      {
        accessorKey: "currentQty",
        header: "当前库存",
        cell: ({ row }) => (
          <span className="font-normal tabular-nums">{row.original.currentQty}</span>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-base font-normal">
          库存出入
          {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
          <span className="text-sm font-normal text-muted-foreground">
            （{summary.products} 个货号 · 入 {summary.inQty} · 出 {summary.outQty}）
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HistoryDateRangePicker value={range} onChange={setRange} size="sm" className="h-8" />
          <Button size="sm" className="h-8" onClick={() => setMovementTarget({})}>
            <ArrowLeftRight className="size-3.5" /> 库存变动
          </Button>
        </div>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        containerClassName="min-h-0 flex-1"
        initialSorting={[{ id: "productCode", desc: false }]}
        columnDividers
        infinite
        loading={loading || !loadedOnce}
        onRowClick={(r) => setDetailId(r.productId)}
        empty={
          <div className="space-y-2 py-6 text-center text-muted-foreground">
            <p>所选日期范围无库存变动</p>
          </div>
        }
      />

      <MovementDialog
        target={movementTarget}
        onOpenChange={(open) => {
          if (!open) setMovementTarget(null)
        }}
        onDone={() => load(range)}
      />
      <ProductDetailSheet
        productId={detailId}
        onOpenChange={(open) => {
          if (!open) setDetailId(null)
        }}
      />
    </div>
  )
}
