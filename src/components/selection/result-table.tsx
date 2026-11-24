"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, Crosshair, Play, Star } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TableEmpty } from "@/components/shared/table-empty"
import { SmartImage } from "@/components/ui/smart-image"
import { compactNumber, formatPrice } from "@/components/selection/labels"
import { canMonitorItem } from "@/components/selection/result-card"
import type { PoolColumnDef } from "@/lib/selection/platform-views"
import type { PoolSort, SelectionPoolItem } from "@/lib/selection/pool-types"
import { cn } from "@/lib/utils"

/**
 * 选品发现的表格视图（电商）：按平台列定义横向对比（Amazon 品牌 / 价格 / 评分 /
 * 评论数 / 月购买 / BSR / 标记…）。带 sort 的列可点击排序（URL 驱动）；
 * 全表左对齐，对齐库存 / TEMU 表格口径。注：ui Table 自带 overflow-x-auto 包裹
 * div 是最近的滚动祖先且高度随内容撑开，th 的 sticky top-0 永远不触发（同
 * inventory/data-table 的结论），故不做表头吸顶。
 */

function Cell({
  col,
  item,
}: {
  col: PoolColumnDef
  item: SelectionPoolItem
}) {
  const price = item.price != null ? Number(item.price) : null
  const originalPrice = item.originalPrice != null ? Number(item.originalPrice) : null
  const rating = item.rating != null ? Number(item.rating) : null
  switch (col.kind) {
    case "thumbnail":
      return (
        <div className="relative size-10 shrink-0 overflow-hidden rounded-md border bg-muted">
          {item.images?.[0] ? (
            <SmartImage src={item.images[0]} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">无图</span>
          )}
          {item.videos?.length ? (
            <span className="absolute right-0 bottom-0 rounded-tl bg-black/70 p-0.5 text-white">
              <Play className="size-2.5 fill-current" />
            </span>
          ) : null}
        </div>
      )
    case "title":
      return (
        <div className="line-clamp-2 max-w-[420px] min-w-[200px] text-xs leading-snug font-normal whitespace-normal" title={item.title ?? ""}>
          {item.title ?? "（无标题）"}
        </div>
      )
    case "price":
      return (
        <span className="tabular-nums">
          <span className="text-xs font-semibold">{formatPrice(price, item.currency)}</span>
          {originalPrice != null && price != null && originalPrice > price ? (
            <span className="ml-1 text-[10px] text-muted-foreground line-through">{originalPrice.toFixed(2)}</span>
          ) : null}
        </span>
      )
    case "rating":
      return rating != null ? (
        <span className="inline-flex items-center gap-0.5 text-xs tabular-nums">
          <span className="text-amber-500">★</span>
          {rating.toFixed(1)}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    case "reviews":
      return <span className="tabular-nums">{compactNumber(item.reviewCount)}</span>
    case "sales":
      return <span className="tabular-nums">{compactNumber(item.salesCount)}</span>
    case "likes":
      return <span className="tabular-nums">{compactNumber(item.likesCount)}</span>
    case "rank":
      return item.rank != null ? (
        <span className="font-medium text-amber-600 tabular-nums dark:text-amber-400">#{item.rank}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    case "badges":
      return item.tags?.length ? (
        <div className="flex flex-wrap gap-1">
          {item.tags.slice(0, 3).map((t) => (
            <span
              key={t}
              className={cn(
                "rounded px-1 py-px text-[10px]",
                t === "广告" || t === "缺货"
                  ? "bg-muted text-muted-foreground"
                  : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
              )}
            >
              {t}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    case "seller":
      return item.sellerName ? (
        <span className="line-clamp-1 max-w-32 text-xs" title={item.sellerName}>
          {item.sellerName}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    case "category":
      return (
        <span className="line-clamp-1 max-w-36 text-xs text-muted-foreground">
          {item.categoryPath?.[item.categoryPath.length - 1] ?? item.category ?? "—"}
        </span>
      )
    default:
      return null
  }
}

export function ResultTable({
  items,
  columns,
  sort,
  bookmarkedIds,
  monitoredIds,
  onSort,
  onOpen,
  onToggleBookmark,
  onAddMonitor,
}: {
  items: SelectionPoolItem[]
  columns: PoolColumnDef[]
  /** 当前排序键（URL） */
  sort: PoolSort
  bookmarkedIds: Set<string>
  /** 已在监控中的平台原生 ID */
  monitoredIds: Set<string>
  onSort: (sort: PoolSort) => void
  onOpen: (item: SelectionPoolItem) => void
  onToggleBookmark: (id: string) => void
  onAddMonitor?: (item: SelectionPoolItem) => void
}) {
  /** 价格列：低→高 → 高→低 → 回默认；其它列：本列排序 → 回默认 */
  const toggle = (col: PoolColumnDef) => {
    if (!col.sort) return
    if (col.kind === "price") {
      onSort(sort === "price_asc" ? "price_desc" : sort === "price_desc" ? "newest" : "price_asc")
      return
    }
    onSort(sort === col.sort ? "newest" : col.sort)
  }

  return (
    // contain-inline-size：表格的最小内容宽度不再向主内容区（flex 子项）传播，避免整页横向溢出
    <div className="w-full min-w-0 contain-inline-size overflow-hidden rounded-xl border">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow>
            {columns.map((col) => {
              const active = col.sort != null && sort === col.sort
              const priceActive = col.kind === "price" && (sort === "price_asc" || sort === "price_desc")
              return (
                <TableHead
                  key={col.kind}
                  className={cn(
                    "whitespace-nowrap text-left",
                    col.kind === "thumbnail" && "w-14",
                    col.kind === "actions" && "w-20",
                  )}
                >
                  {col.sort ? (
                    <button
                      type="button"
                      className={cn(
                        "inline-flex items-center gap-1 text-xs hover:text-foreground",
                        (active || priceActive) ? "font-semibold text-foreground" : "text-muted-foreground",
                      )}
                      onClick={() => toggle(col)}
                      aria-label={`按${col.label}排序`}
                    >
                      {col.label}
                      {(active || priceActive) && sort !== "price_desc" ? <ArrowUp className="size-3" /> : null}
                      {sort === "price_desc" && priceActive ? <ArrowDown className="size-3" /> : null}
                    </button>
                  ) : (
                    col.label
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableEmpty colSpan={columns.length} noun="数据" filtered />
          ) : (
            items.map((item) => {
              const monitored =
                (item.externalId != null && monitoredIds.has(item.externalId)) ||
                (item.sourceUrl != null && monitoredIds.has(item.sourceUrl))
              return (
                <TableRow
                  key={item.id}
                  className="cursor-pointer"
                  onClick={() => onOpen(item)}
                >
                  {columns.map((col) =>
                    col.kind === "actions" ? (
                      <TableCell key={col.kind} onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          {onAddMonitor && canMonitorItem(item) ? (
                            <button
                              type="button"
                              aria-label={monitored ? "已在竞品监控中" : "加入竞品监控"}
                              title={monitored ? "已在竞品监控中" : "加入竞品监控"}
                              className={cn(
                                "rounded-md p-1 transition-colors",
                                monitored ? "text-sky-500" : "text-muted-foreground hover:text-foreground",
                              )}
                              onClick={() => onAddMonitor(item)}
                            >
                              <Crosshair className="size-3.5" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            aria-label={bookmarkedIds.has(item.id) ? "取消收藏" : "收藏"}
                            className={cn(
                              "rounded-md p-1 transition-colors",
                              bookmarkedIds.has(item.id)
                                ? "text-amber-500"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                            onClick={() => onToggleBookmark(item.id)}
                          >
                            <Star className={cn("size-3.5", bookmarkedIds.has(item.id) && "fill-current")} />
                          </button>
                        </div>
                      </TableCell>
                    ) : (
                      <TableCell key={col.kind} className="py-2 align-middle whitespace-nowrap">
                        <Cell col={col} item={item} />
                      </TableCell>
                    ),
                  )}
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </div>
  )
}
