/**
 * 各平台视图口径（client-safe）：平台标签内可用的排序项、KPI 条、表格视图列
 *
 * 每个平台只展示对自己有意义的指标——跨平台聚合会把播放/点赞/保存/赞混加，
 * 所以 KPI 与排序都按平台声明，不再有「全部平台」的通用口径。
 */

import type { PlatformCategory, SelectionPlatform } from "./platforms"
import type { PoolSort } from "./pool-types"

export type PoolStatKey =
  | "count"
  | "avgPrice"
  | "avgRating"
  | "sumReviews"
  | "sumSales"
  | "sumLikes"
  | "sumComments"
  | "sumShares"
  | "sumViews"

export type PoolStatFormat = "number" | "price" | "rating"

export interface PoolKpiDef {
  key: PoolStatKey
  label: string
  format: PoolStatFormat
}

/** 表格视图列类型（决定单元格渲染分支） */
export type PoolColumnKind =
  | "thumbnail"
  | "title"
  | "price"
  | "rating"
  | "reviews"
  | "sales"
  | "likes"
  | "rank"
  | "badges"
  | "seller"
  | "category"
  | "actions"

export interface PoolColumnDef {
  kind: PoolColumnKind
  label: string
  /** 该列可点击排序时对应的排序键 */
  sort?: PoolSort
}

export interface PlatformView {
  platform: SelectionPlatform
  category: PlatformCategory
  /** 可用排序项（顺序即下拉顺序；首项为默认「最新抓取」） */
  sorts: PoolSort[]
  /** KPI 条（随筛选联动） */
  kpis: PoolKpiDef[]
  /** 表格视图列（仅电商；社媒只有卡片） */
  columns: PoolColumnDef[]
}

export const POOL_SORT_LABELS: Record<PoolSort, string> = {
  newest: "最新抓取",
  rank_asc: "名次优先",
  sales_desc: "销量优先",
  price_asc: "价格从低到高",
  price_desc: "价格从高到低",
  rating_desc: "评分优先",
  reviews_desc: "评论数优先",
  likes_desc: "点赞优先",
  comments_desc: "评论优先",
  shares_desc: "转发优先",
  views_desc: "浏览优先",
}

const kpi = (key: PoolStatKey, label: string, format: PoolStatFormat = "number"): PoolKpiDef => ({
  key,
  label,
  format,
})

const THUMBNAIL: PoolColumnDef = { kind: "thumbnail", label: "图" }
const TITLE: PoolColumnDef = { kind: "title", label: "标题" }
const PRICE: PoolColumnDef = { kind: "price", label: "价格", sort: "price_asc" }
const RATING: PoolColumnDef = { kind: "rating", label: "评分", sort: "rating_desc" }
const REVIEWS: PoolColumnDef = { kind: "reviews", label: "评论数", sort: "reviews_desc" }
const ACTIONS: PoolColumnDef = { kind: "actions", label: "操作" }

export const PLATFORM_VIEWS: Record<SelectionPlatform, PlatformView> = {
  amazon: {
    platform: "amazon",
    category: "ecommerce",
    sorts: ["newest", "rank_asc", "sales_desc", "price_asc", "price_desc", "rating_desc", "reviews_desc"],
    kpis: [kpi("count", "商品数"), kpi("avgPrice", "均价", "price"), kpi("avgRating", "平均评分", "rating"), kpi("sumSales", "月购买合计")],
    columns: [
      THUMBNAIL,
      TITLE,
      PRICE,
      RATING,
      REVIEWS,
      { kind: "sales", label: "月购买", sort: "sales_desc" },
      { kind: "rank", label: "BSR / 名次", sort: "rank_asc" },
      { kind: "badges", label: "标记" },
      { kind: "seller", label: "品牌" },
      ACTIONS,
    ],
  },
  temu: {
    platform: "temu",
    category: "ecommerce",
    sorts: ["newest", "sales_desc", "price_asc", "price_desc", "rating_desc", "reviews_desc"],
    kpis: [kpi("count", "商品数"), kpi("avgPrice", "均价", "price"), kpi("avgRating", "平均评分", "rating"), kpi("sumSales", "销量合计")],
    columns: [
      THUMBNAIL,
      TITLE,
      PRICE,
      RATING,
      REVIEWS,
      { kind: "sales", label: "销量", sort: "sales_desc" },
      { kind: "badges", label: "标记" },
      { kind: "seller", label: "店铺" },
      ACTIONS,
    ],
  },
  etsy: {
    platform: "etsy",
    category: "ecommerce",
    sorts: ["newest", "likes_desc", "price_asc", "price_desc", "rating_desc", "reviews_desc"],
    kpis: [kpi("count", "商品数"), kpi("avgPrice", "均价", "price"), kpi("avgRating", "平均评分", "rating"), kpi("sumLikes", "收藏合计")],
    columns: [
      THUMBNAIL,
      TITLE,
      PRICE,
      RATING,
      REVIEWS,
      { kind: "likes", label: "收藏", sort: "likes_desc" },
      { kind: "seller", label: "店铺" },
      { kind: "category", label: "类目" },
      ACTIONS,
    ],
  },
  shopify: {
    platform: "shopify",
    category: "ecommerce",
    sorts: ["newest", "price_asc", "price_desc"],
    kpis: [kpi("count", "商品数"), kpi("avgPrice", "均价", "price")],
    columns: [THUMBNAIL, TITLE, PRICE, { kind: "seller", label: "店铺 / 品牌" }, { kind: "category", label: "类目" }, ACTIONS],
  },
  tiktok: {
    platform: "tiktok",
    category: "social",
    sorts: ["newest", "likes_desc", "comments_desc", "views_desc", "shares_desc"],
    kpis: [
      kpi("count", "帖子"),
      kpi("sumViews", "播放"),
      kpi("sumLikes", "点赞"),
      kpi("sumComments", "评论"),
      kpi("sumShares", "分享"),
    ],
    columns: [],
  },
  instagram: {
    platform: "instagram",
    category: "social",
    sorts: ["newest", "likes_desc", "comments_desc", "views_desc"],
    kpis: [kpi("count", "帖子"), kpi("sumLikes", "点赞"), kpi("sumComments", "评论"), kpi("sumViews", "播放")],
    columns: [],
  },
  pinterest: {
    platform: "pinterest",
    category: "social",
    sorts: ["newest", "likes_desc", "comments_desc"],
    kpis: [kpi("count", "Pin"), kpi("sumLikes", "保存"), kpi("sumComments", "评论")],
    columns: [],
  },
  reddit: {
    platform: "reddit",
    category: "social",
    sorts: ["newest", "likes_desc", "comments_desc"],
    kpis: [kpi("count", "帖子"), kpi("sumLikes", "获赞"), kpi("sumComments", "评论")],
    columns: [],
  },
  x: {
    platform: "x",
    category: "social",
    sorts: ["newest", "likes_desc", "comments_desc", "views_desc", "shares_desc"],
    kpis: [kpi("count", "帖子"), kpi("sumViews", "浏览"), kpi("sumLikes", "点赞"), kpi("sumShares", "转发"), kpi("sumComments", "回复")],
    columns: [],
  },
  facebook: {
    platform: "facebook",
    category: "social",
    sorts: ["newest", "likes_desc", "comments_desc", "shares_desc"],
    kpis: [kpi("count", "帖子"), kpi("sumLikes", "互动"), kpi("sumComments", "评论"), kpi("sumShares", "转发")],
    columns: [],
  },
}

/** 平台视图口径；未知平台回落通用口径（全部排序 + 四项基础 KPI） */
export function platformView(platform: string): PlatformView {
  return (
    PLATFORM_VIEWS[platform as SelectionPlatform] ?? {
      platform: platform as SelectionPlatform,
      category: "ecommerce",
      sorts: ["newest", "sales_desc", "price_asc", "price_desc", "rating_desc"],
      kpis: [kpi("count", "数量"), kpi("avgPrice", "均价", "price"), kpi("avgRating", "平均评分", "rating")],
      columns: [THUMBNAIL, TITLE, PRICE, RATING, REVIEWS, ACTIONS],
    }
  )
}

/** 排序项 → 下拉选项（仅保留该平台声明的键） */
export function sortOptionsFor(platform: string): Array<{ value: PoolSort; label: string }> {
  return platformView(platform).sorts.map((s) => ({ value: s, label: POOL_SORT_LABELS[s] }))
}
