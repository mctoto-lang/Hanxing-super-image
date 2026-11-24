/**
 * 选品数据池共享类型（client-safe）
 *
 * SelectionPoolItem = selection_result 行的 UI 投影（含国家/任务类型快照与来源
 * 任务关键词）。rawPoolRowToItem 把 db.execute 原生 SQL 行（snake_case）映射
 * 成该形状——数据池去重查询走窗口函数原生 SQL，不走 drizzle 查询构造器。
 * 平台专属字段由 extras.ts 在服务端从 raw_data 投影，列表项不再携带整份 rawData。
 */

import {
  SELECTION_PLATFORM_CONFIGS,
  isSelectionPlatform,
  type ResultKind,
} from "./platforms"
import { extractExtras, type ResultExtras } from "./extras"

/** 结果侧重（卡片按 kind 自适应字段：商品/帖子/店铺/趋势） */
export function resultKindFor(
  platform: string,
  taskType: string | null | undefined,
): ResultKind {
  if (!isSelectionPlatform(platform)) return "product"
  const cfg = SELECTION_PLATFORM_CONFIGS[platform]
  if (taskType === "discover" && cfg.discover?.resultKind) return cfg.discover.resultKind
  return cfg.resultKind
}

export interface SelectionPoolItem {
  id: string
  taskId: string
  platform: string
  country: string | null
  taskType: string | null
  externalId: string | null
  sourceUrl: string | null
  title: string | null
  content: string | null
  price: string | null
  originalPrice: string | null
  currency: string | null
  rating: string | null
  reviewCount: number | null
  salesCount: number | null
  likesCount: number | null
  commentsCount: number | null
  sharesCount: number | null
  viewsCount: number | null
  /** 平台名次（Amazon 榜单名次 / 主类目 BSR / 搜索位次） */
  rank: number | null
  sellerName: string | null
  images: string[] | null
  /** 可直接播放的媒体直链（平台不给直链时为 null，播放走嵌入） */
  videos: string[] | null
  category: string | null
  categoryPath: string[] | null
  tags: string[] | null
  hashtags: string[] | null
  publishedAt: Date | null
  scrapedAt: Date | null
  createdAt: Date | null
  /** 平台专属字段（服务端从 raw_data 投影，见 extras.ts） */
  extras?: ResultExtras | null
  /** 完整原始行；列表下发时不填充，详情弹窗「原始数据」按需拉取 */
  rawData?: Record<string, unknown> | null
  /** 来源任务关键词（详情弹窗「来源任务」展示；池查询批量补挂） */
  taskKeyword?: string | null
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : v == null ? null : String(v)
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function strArr(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") && v.length > 0
    ? (v as string[])
    : null
}

function date(v: unknown): Date | null {
  return v instanceof Date ? v : null
}

function rawOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * db.execute 原生行（snake_case，含 rn 窗口列）→ SelectionPoolItem。
 * 默认投影 extras 且不带 rawData（列表载荷小、不含原始行里的个人信息）；
 * includeRaw=true 时额外附带完整原始行。
 */
export function rawPoolRowToItem(
  row: Record<string, unknown>,
  opts?: { includeRaw?: boolean },
): SelectionPoolItem {
  const item: SelectionPoolItem = {
    id: String(row.id),
    taskId: String(row.task_id),
    platform: String(row.platform),
    country: str(row.country),
    taskType: str(row.task_type),
    externalId: str(row.external_id),
    sourceUrl: str(row.source_url),
    title: str(row.title),
    content: str(row.content),
    price: str(row.price),
    originalPrice: str(row.original_price),
    currency: str(row.currency),
    rating: str(row.rating),
    reviewCount: int(row.review_count),
    salesCount: int(row.sales_count),
    likesCount: int(row.likes_count),
    commentsCount: int(row.comments_count),
    sharesCount: int(row.shares_count),
    viewsCount: int(row.views_count),
    rank: int(row.rank),
    sellerName: str(row.seller_name),
    images: strArr(row.images),
    videos: strArr(row.videos),
    category: str(row.category),
    categoryPath: strArr(row.category_path),
    tags: strArr(row.tags),
    hashtags: strArr(row.hashtags),
    publishedAt: date(row.published_at),
    scrapedAt: date(row.scraped_at),
    createdAt: date(row.created_at),
    rawData: null,
  }
  const raw = rawOf(row.raw_data)
  if (raw) {
    item.extras = extractExtras(item.platform, raw, {
      images: item.images,
      videos: item.videos,
      salesCount: item.salesCount,
      sellerName: item.sellerName,
      sourceUrl: item.sourceUrl,
    })
  }
  if (opts?.includeRaw) item.rawData = raw
  return item
}

/** drizzle 结果行（camelCase）→ 列表项（同样投影 extras，不带 rawData） */
export function resultRowToItem(r: {
  id: unknown
  taskId: unknown
  platform: string
  country: string | null
  taskType: string | null
  externalId: string | null
  sourceUrl: string | null
  title: string | null
  content: string | null
  price: string | null
  originalPrice: string | null
  currency: string | null
  rating: string | null
  reviewCount: number | null
  salesCount: number | null
  likesCount: number | null
  commentsCount: number | null
  sharesCount: number | null
  viewsCount: number | null
  rank: number | null
  sellerName: string | null
  images: string[] | null
  videos: string[] | null
  category: string | null
  categoryPath: string[] | null
  tags: string[] | null
  hashtags: string[] | null
  publishedAt: Date | null
  scrapedAt: Date | null
  createdAt: Date | null
  rawData: unknown
}): SelectionPoolItem {
  return rawPoolRowToItem(
    {
      id: r.id,
      task_id: r.taskId,
      platform: r.platform,
      country: r.country,
      task_type: r.taskType,
      external_id: r.externalId,
      source_url: r.sourceUrl,
      title: r.title,
      content: r.content,
      price: r.price,
      original_price: r.originalPrice,
      currency: r.currency,
      rating: r.rating,
      review_count: r.reviewCount,
      sales_count: r.salesCount,
      likes_count: r.likesCount,
      comments_count: r.commentsCount,
      shares_count: r.sharesCount,
      views_count: r.viewsCount,
      rank: r.rank,
      seller_name: r.sellerName,
      images: r.images,
      videos: r.videos,
      category: r.category,
      category_path: r.categoryPath,
      tags: r.tags,
      hashtags: r.hashtags,
      published_at: r.publishedAt,
      scraped_at: r.scrapedAt,
      created_at: r.createdAt,
      raw_data: r.rawData,
    },
  )
}

/** 数据池排序键（URL/Action 入参共用口径） */
export const POOL_SORTS = [
  "newest",
  "rank_asc",
  "sales_desc",
  "price_asc",
  "price_desc",
  "rating_desc",
  "reviews_desc",
  "likes_desc",
  "comments_desc",
  "shares_desc",
  "views_desc",
] as const
export type PoolSort = (typeof POOL_SORTS)[number]

export function isPoolSort(v: string): v is PoolSort {
  return (POOL_SORTS as readonly string[]).includes(v)
}

/** 数据池 KPI 统计（随筛选联动；各平台取自己有意义的字段，见 platform-views） */
export interface PoolStats {
  count: number
  /** 主币种（众数） */
  currency: string | null
  avgPrice: number | null
  avgRating: number | null
  sumReviews: number | null
  sumSales: number | null
  sumLikes: number | null
  sumComments: number | null
  sumShares: number | null
  sumViews: number | null
}
