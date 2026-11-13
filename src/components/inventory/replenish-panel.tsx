"use client"

import * as React from "react"
import { toast } from "sonner"
import { AlertTriangle, PackagePlus } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { EmptyHint } from "@/components/temu/products-table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ZoomableImage } from "@/components/ui/zoomable-image"
import { DataTable, type ColumnDef } from "./data-table"
import { InvBadge } from "./inv-badge"
import type { ReplenishAdviceRow } from "@/server/actions/inventory-analysis"
import {
  createProductionOrdersFromAdviceAction,
  getReplenishmentAdviceAction,
} from "@/server/actions/inventory-analysis"
import { listFactoriesAction } from "@/server/actions/inventory-production"

/**
 * 补货建议子视图（销速单轨，仅「持续生产」货号）：
 * 建议 = max(目标覆盖−现有−生产−TEMU净, 0) → max(MOQ) → 装箱数取整 → 卡上限；
 * 日销为固定加权口径（0.7×近7天均+0.3×近30天均），缓冲天数可调；勾选批量生成生产单。
 * 「生产」=未完结生产单剩余量（旧文案「在途」）；四个关键列头带悬浮口径说明。
 */

export function ReplenishPanel() {
  const [rows, setRows] = React.useState<ReplenishAdviceRow[]>([])
  const [buffer, setBuffer] = React.useState(7)
  const [loading, startLoad] = React.useTransition()
  // SSR 首帧无数据：首次加载完成前恒显骨架，避免水合前闪空态文案
  const [loadedOnce, setLoadedOnce] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [batchOpen, setBatchOpen] = React.useState(false)
  const [factories, setFactories] = React.useState<Array<{ id: string; code: string; name: string }>>([])
  const [factoryId, setFactoryId] = React.useState("")
  const [creating, startCreate] = React.useTransition()

  // 竞态守卫：缓冲天数连续切换时，后到的旧请求不得覆盖新请求结果（quality/return-panel 同款）
  const loadReqRef = React.useRef(0)

  const load = React.useCallback(() => {
    startLoad(async () => {
      const reqId = ++loadReqRef.current
      const r = await getReplenishmentAdviceAction({ bufferDays: buffer })
      if (reqId !== loadReqRef.current) return
      if (r.ok) {
        setRows(r.rows)
        // 刷新后剔除失效勾选（行已不在或建议量≤0），避免行勾选残留与表头半选态/对话框计数不一致
        setSelected((s) => {
          if (s.size === 0) return s
          const alive = new Set(r.rows.filter((row) => row.suggestQty > 0).map((row) => row.productId))
          const next = new Set([...s].filter((id) => alive.has(id)))
          return next.size === s.size ? s : next
        })
      } else toast.error(r.error)
      setLoadedOnce(true)
    })
  }, [buffer])

  React.useEffect(() => {
    load()
  }, [load])

  React.useEffect(() => {
    void (async () => {
      const r = await listFactoriesAction()
      if (r.ok) {
        setFactories(r.rows.map((f) => ({ id: f.id, code: f.code, name: f.name })))
        setFactoryId((v) => v || r.rows[0]?.id || "")
      }
    })()
  }, [])

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const selectable = rows.filter((r) => r.suggestQty > 0)
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.productId))

  const columns = React.useMemo<ColumnDef<ReplenishAdviceRow, unknown>[]>(
    () => [
      {
        id: "sel",
        header: () => {
          const someSelected = selectable.some((r) => selected.has(r.productId))
          return (
            <Checkbox
              checked={allSelected}
              indeterminate={!allSelected && someSelected}
              // 部分勾选（半选「-」态）或全选时点击 = 取消全部
              onCheckedChange={() =>
                setSelected(
                  allSelected || someSelected
                    ? new Set()
                    : new Set(selectable.map((r) => r.productId)),
                )
              }
              aria-label="全选可生成行"
            />
          )
        },
        enableSorting: false,
        cell: ({ row }) => (
          <Checkbox
            checked={selected.has(row.original.productId)}
            onCheckedChange={() => toggle(row.original.productId)}
            disabled={row.original.suggestQty <= 0}
            onClick={(e) => e.stopPropagation()}
          />
        ),
      },
      {
        id: "product",
        header: "货号/款名",
        accessorFn: (r) => r.productCode,
        cell: ({ row }) => {
          const r = row.original
          return (
            <div className="flex items-center gap-2">
              {r.imageUrl ? (
                <ZoomableImage src={r.imageUrl} className="size-10 shrink-0 rounded object-cover" />
              ) : (
                <span className="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                  无图
                </span>
              )}
              <div className="min-w-0">
                <div className="font-normal">{r.productCode}</div>
                <div className="max-w-40 truncate text-muted-foreground" title={r.name}>
                  {r.name}
                </div>
              </div>
            </div>
          )
        },
      },
      {
        accessorKey: "dailySales",
        header: () => (
          <Tooltip>
            <TooltipTrigger className="cursor-default">日均销</TooltipTrigger>
            <TooltipContent className="max-w-64 text-xs">
              加权日销 = 0.7×近7天日均 + 0.3×近30天日均（TEMU 销量，按货号聚合）
            </TooltipContent>
          </Tooltip>
        ),
        cell: ({ row }) =>
          row.original.dailySales > 0 ? (
            <span className="tabular-nums">{row.original.dailySales}</span>
          ) : (
            <EmptyHint />
          ),
      },
      {
        accessorKey: "totalQty",
        header: () => (
          <Tooltip>
            <TooltipTrigger className="cursor-default">现有/生产</TooltipTrigger>
            <TooltipContent className="max-w-72 text-xs">
              现有 = 本地仓库库存合计；生产 = 未完结生产单剩余量（数量−已入库−已直发，
              含待出材料/生产中/工厂已发）
            </TooltipContent>
          </Tooltip>
        ),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.totalQty}
            <span className="text-muted-foreground"> / {row.original.producingQty}</span>
          </span>
        ),
      },
      {
        accessorKey: "targetQty",
        header: () => (
          <Tooltip>
            <TooltipTrigger className="cursor-default">目标覆盖</TooltipTrigger>
            <TooltipContent className="max-w-72 text-xs">
              目标覆盖件数 = ⌈日均销 ×（生产周期 + 缓冲天数）⌉，即从补货到入库期间预计要卖的件数
            </TooltipContent>
          </Tooltip>
        ),
        cell: ({ row }) =>
          row.original.targetQty != null ? (
            <span className="tabular-nums text-muted-foreground">{row.original.targetQty}</span>
          ) : (
            <EmptyHint />
          ),
      },
      {
        accessorKey: "suggestQty",
        header: () => (
          <Tooltip>
            <TooltipTrigger className="cursor-default">建议生产</TooltipTrigger>
            <TooltipContent className="max-w-72 text-xs">
              = max(目标覆盖 − 现有 − 生产 − TEMU净库存, MOQ)，按装箱数向上取整并封顶库存上限
            </TooltipContent>
          </Tooltip>
        ),
        cell: ({ row }) => {
          const v = row.original.suggestQty
          return (
            <span className={cn("font-normal tabular-nums", v > 0 ? "text-amber-600" : "text-muted-foreground")}>
              {v > 0 ? v : "0"}
            </span>
          )
        },
      },
      {
        id: "flags",
        header: "标记",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.stagnant ? (
            <InvBadge className="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400">
              <AlertTriangle className="size-3" /> 滞销
            </InvBadge>
          ) : null,
      },
      {
        accessorKey: "expectedDate",
        header: "预计到货",
        cell: ({ row }) =>
          row.original.expectedDate ? (
            <span className="whitespace-nowrap text-muted-foreground">
              {row.original.expectedDate}
            </span>
          ) : (
            <EmptyHint />
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSelected, selected, rows],
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-base font-normal">
          补货建议
          {loading ? <DashRing className="size-3.5 text-muted-foreground" /> : null}
          <span className="text-sm font-normal text-muted-foreground">
            （仅「持续生产」货号 · 已选 {selected.size} 行）
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">缓冲</span>
          <Select
            value={String(buffer)}
            onValueChange={(v) => v && setBuffer(Number(v))}
            items={[3, 5, 7, 10, 14].map((d) => ({ value: String(d), label: `${d} 天` }))}
          >
            <SelectTrigger className="h-8 w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[3, 5, 7, 10, 14].map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d} 天
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-8"
            disabled={selected.size === 0}
            onClick={() => setBatchOpen(true)}
          >
            <PackagePlus className="size-3.5" /> 生成生产单
          </Button>
        </div>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        containerClassName="min-h-0 flex-1"
        initialSorting={[{ id: "suggestQty", desc: true }]}
        pageSize={50}
        loading={loading || !loadedOnce}
        empty="暂无补货建议（库存充足或均为停止生产货号）"
      />

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>批量生成生产单（{selected.size} 单）</DialogTitle>
            <DialogDescription>
              每行一张生产单（待出材料态，数量=建议量）；生产日期=今天。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label>工厂 *</Label>
            <Select
              value={factoryId}
              onValueChange={(v) => v && setFactoryId(v)}
              items={factories.map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))}
            >
              <SelectTrigger className="h-9!">
                <SelectValue placeholder="选择工厂（应用于全部）" />
              </SelectTrigger>
              <SelectContent>
                {factories.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.code} · {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button
              disabled={creating}
              onClick={() =>
                startCreate(async () => {
                  if (!factoryId) {
                    toast.error("请选择工厂")
                    return
                  }
                  const items = rows
                    .filter((r) => selected.has(r.productId) && r.suggestQty > 0)
                    .map((r) => ({ productId: r.productId, qty: r.suggestQty }))
                  const r = await createProductionOrdersFromAdviceAction({ factoryId, items })
                  if (r.ok) {
                    toast.success(`已生成 ${r.created} 张生产单（待出材料）`)
                    setBatchOpen(false)
                    setSelected(new Set())
                    load()
                  } else toast.error(r.error)
                })
              }
            >
              {creating && <DashRing className="size-3.5" />}
              生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
