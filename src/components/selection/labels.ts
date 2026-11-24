/**
 * 选品工具展示口径（服务端/客户端共用，纯常量与纯函数）
 */

export const SELECTION_STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  processing: "抓取中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

export const SELECTION_STATUS_BADGE: Record<string, string> = {
  queued: "bg-secondary text-secondary-foreground",
  processing: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  cancelled: "bg-muted text-muted-foreground",
}

export const SELECTION_TASK_TYPE_LABELS: Record<string, string> = {
  discover: "选品发现",
  market: "市场分析",
  monitor: "竞品监控",
  review: "评论洞察",
}

export const SELECTION_PRIORITY_LABELS: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
}

/** 各任务类型完成后的数据去处（「查看数据」按任务类型与平台类别跳转） */
export const SELECTION_TASK_TYPE_TARGETS: Record<string, string> = {
  monitor: "/selection/competitor",
  review: "/selection/reviews",
}

export function platformLabel(p: string): string {
  return (
    (
      {
        amazon: "Amazon",
        etsy: "Etsy",
        temu: "TEMU",
        shopify: "Shopify",
        instagram: "Instagram",
        tiktok: "TikTok",
        pinterest: "Pinterest",
        reddit: "Reddit",
        x: "X",
        facebook: "Facebook",
      } as Record<string, string>
    )[p] ?? p
  )
}

/** 大数缩写（12.3K / 4.5M） */
export function compactNumber(n: number | null | undefined): string {
  if (n == null) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** 币种前缀：USD（或缺省）用 $，其它前置 ISO 码（"GBP 12.99"） */
export function moneyPrefix(currency?: string | null): string {
  return currency && currency !== "USD" ? `${currency} ` : "$"
}

/** 金额展示：整数不带小数，否则两位；null 显示「—」 */
export function formatPrice(value: number | null | undefined, currency?: string | null): string {
  if (value == null || !Number.isFinite(value)) return "—"
  const text = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)
  return `${moneyPrefix(currency)}${text}`
}

/** 均价等聚合值固定两位小数 */
export function formatMoneyFixed(value: number | null | undefined, currency?: string | null): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return `${moneyPrefix(currency)}${value.toFixed(2)}`
}

/** 秒 → "m:ss"（时长角标） */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return ""
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, "0")}`
}

/** 相对涨跌文案：+12% / −8% / 新 */
export function formatDelta(current: number | null, previous: number | null): string | null {
  if (current == null || previous == null) return null
  if (previous === 0) return current === 0 ? "0%" : "新"
  const pct = ((current - previous) / Math.abs(previous)) * 100
  const rounded = Math.abs(pct) >= 100 ? Math.round(pct) : Math.round(pct * 10) / 10
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded)}%`
}
