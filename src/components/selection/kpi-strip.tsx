import type * as React from "react"

import { compactNumber, formatMoneyFixed } from "@/components/selection/labels"
import { platformView, type PoolKpiDef } from "@/lib/selection/platform-views"
import type { PoolStats } from "@/lib/selection/pool-types"

/**
 * KPI 条（选品工具各页统一形态）：一行自适应卡片，label 小字 + 数值大字。
 * discover / market 按平台视图口径取指标；其它页面直接传 items。
 */
export interface KpiItem {
  key: string
  label: string
  value: React.ReactNode
}

export function KpiStrip({ items, className }: { items: KpiItem[]; className?: string }) {
  if (items.length === 0) return null
  return (
    <div
      className={className ?? "grid gap-3"}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(132px, 1fr))` }}
    >
      {items.map((k) => (
        <div key={k.key} className="rounded-xl border bg-card px-3.5 py-2.5">
          <p className="truncate text-xs text-muted-foreground">{k.label}</p>
          <p className="mt-0.5 truncate text-lg leading-tight font-semibold tabular-nums">
            {k.value}
          </p>
        </div>
      ))}
    </div>
  )
}

/** 平台视图口径的 KPI 条：按 platform-views 声明取统计字段并格式化 */
export function poolKpiItems(platform: string, stats: PoolStats | null): KpiItem[] {
  return platformView(platform).kpis.map((def) => ({
    key: def.key,
    label: def.label,
    value: stats ? formatPoolStat(def, stats) : "—",
  }))
}

export function formatPoolStat(def: PoolKpiDef, stats: PoolStats): string {
  switch (def.key) {
    case "avgPrice":
      return formatMoneyFixed(stats.avgPrice, stats.currency)
    case "avgRating":
      return stats.avgRating != null ? stats.avgRating.toFixed(2) : "—"
    default:
      return compactNumber(stats[def.key])
  }
}
