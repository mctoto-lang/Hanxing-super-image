import type * as React from "react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * 统计卡（企业管理双侧统一口径，替代四套手写 KPI 卡）
 *
 * - variant="lg"：页面顶部 KPI 大卡（Card 版，值 text-2xl font-bold tabular-nums，
 *   可带 icon），用于 credits / models / chat-models / platform 看板；
 * - variant="compact"：行内概要小卡（border + bg-muted/30，值 text-lg），
 *   用于企业详情页概要区。
 * 数值千分位由调用方 toLocaleString("zh-CN") 后传入。
 */
export function StatCard({
  label,
  children,
  variant = "lg",
  icon,
  trend,
}: {
  label: string
  children: React.ReactNode
  variant?: "lg" | "compact"
  /** lg 档可选图标 */
  icon?: React.ReactNode
  /**
   * lg 档可选环比（较昨日）：涨 emerald / 跌 rose / 持平灰；base > 0 时
   * 显示百分比，否则显示绝对差值。仅用于「今日」类 KPI 卡。
   */
  trend?: {
    delta: number
    base: number
  }
}) {
  if (variant === "compact") {
    return (
      <div className="rounded-lg border bg-muted/30 px-4 py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-1 text-lg font-bold tabular-nums">{children}</div>
      </div>
    )
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {icon}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-2xl font-bold tabular-nums">
        {children}
        {trend ? <TrendBadge delta={trend.delta} base={trend.base} /> : null}
      </CardContent>
    </Card>
  )
}

/** 环比小字（较昨日）：涨 emerald ↑ / 跌 rose ↓ / 持平 muted */
function TrendBadge({ delta, base }: { delta: number; base: number }) {
  if (delta === 0) {
    return <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">与昨日持平</span>
  }
  const up = delta > 0
  const pct =
    base > 0 ? `${Math.abs((delta / base) * 100).toFixed(1)}%` : `${Math.abs(delta)}`
  return (
    <span
      className={`ml-2 align-middle text-xs font-normal ${
        up ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
      }`}
    >
      {up ? "↑" : "↓"}
      {pct}
      <span className="ml-1 text-muted-foreground">较昨日</span>
    </span>
  )
}
