/**
 * 选品工具展示口径（服务端/客户端共用，纯常量无副作用）
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
