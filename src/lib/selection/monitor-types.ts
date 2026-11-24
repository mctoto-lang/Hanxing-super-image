/**
 * 竞品监控列表项类型（client-safe：监控 action / 页面 / 卡片组件三方共用）
 */

/** 一次指标快照（监控目标最新值或上一次值；price / rating 为 numeric 字符串） */
export interface MonitorSnapshot {
  price: string | null
  rating: string | null
  salesCount: number | null
  reviewCount: number | null
  likesCount: number | null
  commentsCount: number | null
  viewsCount: number | null
  sharesCount: number | null
  rank: number | null
}

export interface MonitorListItem extends MonitorSnapshot {
  id: string
  userId: string
  platform: string
  targetUrl: string
  externalId: string | null
  title: string | null
  imageUrl: string | null
  country: string | null
  lastCurrency: string | null
  lastMetricsAt: Date | null
  intervalHours: number
  trackReviews: boolean
  reviewMax: number
  status: string
  pauseReason: string | null
  lastRunAt: Date | null
  nextRunAt: Date | null
  runCount: number
  createdAt: Date
  creatorName: string | null
  /** 上一次指标快照（涨跌对比） */
  prev: (MonitorSnapshot & { scrapedAt: Date | null }) | null
  /** 该平台是否支持评论抓取 */
  canScrapeReviews: boolean
  /** 该平台重抓不提供的指标说明 */
  metricsNote: string | null
}
