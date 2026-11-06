"use client"

import * as React from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { AnalyticsBento } from "@/components/ui/analytics-bento"
import {
  getInventoryAnalysisAction,
  type AnalysisTreemapRow,
} from "@/server/actions/inventory-analysis"

/**
 * 库存分析（Bento 三卡）：库存总量趋势（折线）→ 出入库流量（双波，上=入库
 * 下=出库）→ 库存分布（树图全宽：全部货号、颜色分组=六态、三档=仓库/TEMU净/
 * 在产，块面积按 √数量缩放保证货号+数量可见）。窗口固定近 30 天；日销/状态
 * 为固定加权口径（见 inventory-core）。
 */

type StockStatusKey =
  | "normal"
  | "restock"
  | "out_of_stock"
  | "stagnant"
  | "discontinued"
  | "clearance"

type AnalysisData = {
  window: 7 | 14 | 30
  thresholdDays: number
  cards: {
    totalQty: number
    productCount: number
    stockedCount: number
    outOfStockCount: number
    restockCount: number
    stagnantCount: number
    discontinuedCount: number
    clearanceCount: number
  }
  statusCounts: Record<StockStatusKey, number>
  trend: Array<{ day: string; qty: number }>
  flowDaily: Array<{ day: string; inQty: number; outQty: number }>
  treemap: AnalysisTreemapRow[]
}

/** 六态树图分组配色（与总览徽章同色系：绿/琥珀/红/紫/灰/橙） */
const STATUS_COLORS: Record<StockStatusKey, string> = {
  normal: "#10b981",
  restock: "#f59e0b",
  out_of_stock: "#ef4444",
  stagnant: "#8b5cf6",
  discontinued: "#94a3b8",
  clearance: "#f97316",
}

const STATUS_ORDER: StockStatusKey[] = [
  "normal",
  "restock",
  "out_of_stock",
  "stagnant",
  "discontinued",
  "clearance",
]

const STATUS_LABELS: Record<StockStatusKey, string> = {
  normal: "正常",
  restock: "补货",
  out_of_stock: "缺货",
  stagnant: "滞销",
  discontinued: "停产",
  clearance: "清仓",
}

/** 固定窗口（近 30 天） */
const WIN = 30

const mdLabel = (day: string) => {
  const d = new Date(`${day}T00:00:00`)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function AnalysisPanel() {
  const [data, setData] = React.useState<AnalysisData | null>(null)
  const [loading, startLoad] = React.useTransition()

  React.useEffect(() => {
    startLoad(async () => {
      const r = await getInventoryAnalysisAction({ window: WIN })
      if (r.ok) setData(r as AnalysisData)
      else toast.error(r.error)
    })
  }, [])

  if (!data) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
        {loading ? (
          <>
            <Loader2 className="size-4 animate-spin" /> 加载中…
          </>
        ) : (
          "暂无数据"
        )}
      </div>
    )
  }

  if (data.cards.productCount === 0) {
    return (
      <div className="space-y-2 py-10 text-center text-sm text-muted-foreground">
        <p>还没有货号档案</p>
        <p>
          去
          <Link href="/inventory/stock?view=overview" className="mx-1 underline underline-offset-2">
            库存总览
          </Link>
          新建档后即可分析
        </p>
      </div>
    )
  }

  // ── 卡A 库存总量：环比昨日（快照不足两天则不展示涨跌） ──
  const trend = data.trend
  let totalDelta: string | undefined
  if (trend.length >= 2) {
    const prev = trend[trend.length - 2].qty
    const last = trend[trend.length - 1].qty
    if (prev > 0) totalDelta = `${(((last - prev) / prev) * 100).toFixed(1)}%`
  }

  // ── 卡B 出入库流量：窗口出库总量 ──
  const outTotal = data.flowDaily.reduce((a, b) => a + b.outQty, 0)

  // ── 卡C 库存分布（全宽）：三口径 = 仓库库存 / TEMU净库存 / 在产量（全量货号） ──
  const tm = data.treemap
  const treemapTotals: number[] = tm.reduce(
    (a, t) => [a[0] + t.totalQty, a[1] + t.temuStock, a[2] + t.producingQty],
    [0, 0, 0],
  )
  const top1 = tm[0]
  const compareText = `共 ${tm.length} 个货号${top1 ? ` · 最大 ${top1.productCode}` : ""}`

  return (
    <AnalyticsBento
      colors={{
        revenue: ["#22d3ee", "#10b981"],
        desktop: ["#34d399", "#059669"],
        mobile: ["#f87171", "#dc2626"],
      }}
      revenue={{
        label: "库存总量",
        value: data.cards.totalQty,
        delta: totalDelta,
        note: `货号 ${data.cards.productCount} 个 · 补货阈值 ${data.thresholdDays} 天`,
        caption: `近 ${WIN} 天`,
        metricName: "库存总量",
        series: trend.map((p) => ({ label: mdLabel(p.day), value: p.qty })),
      }}
      sessions={{
        label: "出库总量",
        value: outTotal,
        note: `按日 · 近 ${WIN} 天`,
        desktop: [data.flowDaily.map((d) => d.inQty)],
        mobile: [data.flowDaily.map((d) => d.outQty)],
        xLabels: data.flowDaily.map((d) => mdLabel(d.day)),
        labels: { desktop: "入库", mobile: "出库", current: `近 ${WIN} 天` },
      }}
      categories={{
        title: "库存分布",
        groups: STATUS_ORDER.map((s) => ({
          id: s,
          name: STATUS_LABELS[s],
          color: STATUS_COLORS[s],
          // slate 停产色较浅，深字更清晰；其余白字
          ink: s === "discontinued" ? ("dark" as const) : ("light" as const),
        })),
        periods: [
          { label: "仓库库存", total: treemapTotals[0], compare: compareText },
          { label: "TEMU净库存", total: treemapTotals[1], compare: compareText },
          { label: "在产量", total: treemapTotals[2], compare: compareText },
        ],
        items: tm.map((t) => ({
          name: t.productCode,
          group: t.status,
          values: [t.totalQty, t.temuStock, t.producingQty],
          image: t.imageUrl,
        })),
        // 无库存区固定按仓库库存=0（不随三档切换；按货号升序，方块内显未完结
        // 生产单总量，悬停可看 TEMU净/在产余量）
        zeros: tm
          .filter((t) => t.totalQty === 0)
          .sort((a, b) => a.productCode.localeCompare(b.productCode))
          .map((t) => ({
            name: t.productCode,
            group: t.status,
            image: t.imageUrl,
            values: [t.totalQty, t.temuStock, t.producingQty],
            orderQty: t.producingOrderQty,
          })),
      }}
    />
  )
}
