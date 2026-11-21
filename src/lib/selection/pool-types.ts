/**
 * 选品数据池共享类型（client-safe）
 *
 * SelectionPoolItem = selection_result 行的 UI 投影（含国家/任务类型快照与来源
 * 任务关键词）。rawPoolRowToItem 把 db.execute 原生 SQL 行（snake_case）映射
 * 成该形状——数据池去重查询走窗口函数原生 SQL，不走 drizzle 查询构造器。
 */

import {
  SELECTION_PLATFORM_CONFIGS,
  isSelectionPlatform,
  type ResultKind,
} from "./platforms"

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
  /** 完整原始行（详情弹窗折叠展示，调试/溯源） */
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

/** db.execute 原生行（snake_case，含 rn 窗口列）→ SelectionPoolItem */
export function rawPoolRowToItem(row: Record<string, unknown>): SelectionPoolItem {
  return {
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
    rawData:
      row.raw_data && typeof row.raw_data === "object" && !Array.isArray(row.raw_data)
        ? (row.raw_data as Record<string, unknown>)
        : null,
  }
}

/** 数据池排序键（URL/Action 入参共用口径） */
export const POOL_SORTS = [
  "newest",
  "sales_desc",
  "price_asc",
  "price_desc",
  "rating_desc",
  "likes_desc",
  "comments_desc",
  "views_desc",
] as const
export type PoolSort = (typeof POOL_SORTS)[number]
