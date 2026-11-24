import { compactNumber, formatDelta, moneyPrefix } from "@/components/selection/labels"

/**
 * 监控指标口径（纯函数）：各平台展示自己有的指标，并给出相对上一次抓取的涨跌。
 *   Amazon：价格 / BSR / 月购买 / 评分 / 评论数
 *   TEMU：价格 / 评分 / 评论数（单品抓取不含销量）
 *   社媒：点赞 / 评论 / 浏览 / 转发；Shopify：价格；Etsy 仅评论追踪（无指标重抓）
 */

export type { MonitorSnapshot } from "@/lib/selection/monitor-types"
import type { MonitorSnapshot } from "@/lib/selection/monitor-types"

export interface MonitorMetric {
  key: string
  label: string
  /** 展示值 */
  text: string
  /** 涨跌百分比文案（无上一次数据为 null） */
  delta: string | null
  /** 这次涨跌是向好（着色用） */
  deltaGood: boolean | null
}

const SOCIAL = ["instagram", "tiktok", "pinterest", "reddit", "x", "facebook"]

function moneyText(v: string | null, currency: string | null): string | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? `${moneyPrefix(currency)}${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}` : null
}

/**
 * 指标列表。lowerIsBetter：名次类指标下降是好事；价格变化对选品方中性（不着色）。
 */
export function monitorMetrics(
  platform: string,
  cur: MonitorSnapshot,
  prev: MonitorSnapshot | null,
  currency: string | null,
): MonitorMetric[] {
  const out: MonitorMetric[] = []
  const push = (
    key: string,
    label: string,
    text: string | null,
    current: number | null,
    previous: number | null,
    good: "up" | "down" | "neutral" = "up",
  ) => {
    // 无数据的指标整个不显示（compactNumber 对 null 返回「—」），不出「销量 —」这种空壳
    if (text == null || text === "—") return
    const delta = formatDelta(current, previous)
    let deltaGood: boolean | null = null
    if (delta != null && delta !== "新" && delta !== "0%") {
      if (good === "neutral") deltaGood = null
      else deltaGood = delta.startsWith("+") ? good === "up" : good === "down"
    }
    out.push({ key, label, text, delta, deltaGood })
  }
  const num = (v: string | null) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null)

  if (SOCIAL.includes(platform)) {
    push("likes", platform === "reddit" ? "获赞" : platform === "pinterest" ? "保存" : "点赞", compactNumber(cur.likesCount), cur.likesCount, prev?.likesCount ?? null)
    push("comments", "评论", compactNumber(cur.commentsCount), cur.commentsCount, prev?.commentsCount ?? null)
    push("views", platform === "x" ? "浏览" : "播放", compactNumber(cur.viewsCount), cur.viewsCount, prev?.viewsCount ?? null)
    push("shares", platform === "x" ? "转发" : "分享", compactNumber(cur.sharesCount), cur.sharesCount, prev?.sharesCount ?? null)
    return out
  }
  if (platform === "etsy") {
    push("reviews", "评论数", compactNumber(cur.reviewCount), cur.reviewCount, prev?.reviewCount ?? null)
    return out
  }
  if (platform !== "amazon" && platform !== "temu" && platform !== "shopify") return out
  push("price", "价格", moneyText(cur.price, currency), num(cur.price), num(prev?.price ?? null), "neutral")
  if (platform === "amazon") {
    push("rank", "BSR", cur.rank != null ? `#${cur.rank}` : null, cur.rank, prev?.rank ?? null, "down")
  }
  push("sales", platform === "amazon" ? "月购买" : "销量", compactNumber(cur.salesCount), cur.salesCount, prev?.salesCount ?? null)
  push("rating", "评分", cur.rating != null ? Number(cur.rating).toFixed(1) : null, num(cur.rating), num(prev?.rating ?? null))
  push("reviews", "评论数", compactNumber(cur.reviewCount), cur.reviewCount, prev?.reviewCount ?? null)
  return out
}

/** 趋势图可选的指标序列（只列该平台有数据的） */
export interface TrendSeries {
  key: string
  label: string
  values: Array<number | null>
}

export function trendSeries(
  platform: string,
  points: Array<MonitorSnapshot & { date: string }>,
): { dates: string[]; series: TrendSeries[] } {
  const dates = points.map((p) => p.date)
  const has = (pick: (p: MonitorSnapshot) => number | null) => points.some((p) => pick(p) != null)
  const num = (v: string | null) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null)
  const mk = (key: string, label: string, pick: (p: MonitorSnapshot) => number | null): TrendSeries | null =>
    has(pick) ? { key, label, values: points.map((p) => pick(p)) } : null
  let series: Array<TrendSeries | null>
  if (SOCIAL.includes(platform)) {
    series = [
      mk("likes", "点赞", (p) => p.likesCount),
      mk("comments", "评论", (p) => p.commentsCount),
      mk("views", platform === "x" ? "浏览" : "播放", (p) => p.viewsCount),
      mk("shares", "转发", (p) => p.sharesCount),
    ]
  } else if (platform === "etsy") {
    series = [mk("reviews", "评论数", (p) => p.reviewCount)]
  } else {
    series = [
      mk("price", "价格", (p) => num(p.price)),
      mk("sales", platform === "amazon" ? "月购买" : "销量", (p) => p.salesCount),
      mk("rank", "BSR", (p) => p.rank),
      mk("rating", "评分", (p) => num(p.rating)),
      mk("reviews", "评论数", (p) => p.reviewCount),
    ]
  }
  return { dates, series: series.filter((s): s is TrendSeries => s != null) }
}

/** 历史表列（按平台） */
export function trendColumns(platform: string): Array<{ key: keyof MonitorSnapshot; label: string }> {
  if (SOCIAL.includes(platform)) {
    return [
      { key: "likesCount", label: "点赞" },
      { key: "commentsCount", label: "评论" },
      { key: "viewsCount", label: platform === "x" ? "浏览" : "播放" },
      { key: "sharesCount", label: "转发" },
    ]
  }
  if (platform === "etsy") return [{ key: "reviewCount", label: "评论数" }]
  const cols: Array<{ key: keyof MonitorSnapshot; label: string }> = [{ key: "price", label: "价格" }]
  if (platform === "amazon") cols.push({ key: "rank", label: "BSR" })
  cols.push(
    { key: "salesCount", label: platform === "amazon" ? "月购买" : "销量" },
    { key: "rating", label: "评分" },
    { key: "reviewCount", label: "评论数" },
  )
  return cols
}
