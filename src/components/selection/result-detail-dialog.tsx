"use client"

import * as React from "react"
import Link from "next/link"
import { BadgeCheck, ExternalLink, Loader2, MessageSquareQuote, Star, ThumbsUp } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SmartImage } from "@/components/ui/smart-image"
import { Button } from "@/components/ui/button"
import { compactNumber, platformLabel } from "@/components/selection/labels"
import {
  CountryFlag,
  PlatformInlineIcon,
} from "@/components/selection/platform-badges"
import { getResultReviewsAction } from "@/server/actions/selection-monitor"
import { formatDateTime } from "@/lib/datetime"
import { countryLabel } from "@/lib/selection/platforms"
import type { SelectionPoolItem } from "@/lib/selection/pool-types"
import { cn } from "@/lib/utils"

/**
 * 数据池结果详情弹窗：左图集（主图 + 缩略图切换）、右指标网格 + 来源任务 +
 * 源链接，正文 + 抓取评论区（监控抓取的评论按 sourceUrl 关联展示）+ 底部
 * rawData 折叠（原始 JSON，调试/溯源用）。
 */

interface DialogReview {
  id: string
  platform: string
  authorName: string | null
  rating: string | null
  content: string | null
  likesCount: number | null
  verified: boolean | null
  publishedAt: Date | null
  scrapedAt: Date
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  )
}

export function ResultDetailDialog({
  item,
  open,
  onOpenChange,
  bookmarked,
  onToggleBookmark,
}: {
  item: SelectionPoolItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
  bookmarked: boolean
  onToggleBookmark: (id: string) => void
}) {
  const images = item?.images ?? []
  const [active, setActive] = React.useState(0)
  React.useEffect(() => {
    setActive(0)
  }, [item?.id])

  // 抓取评论（监控抓取的评论按 sourceUrl 关联；弹窗打开时拉取）
  const [reviews, setReviews] = React.useState<{
    loading: boolean
    total: number
    items: DialogReview[]
  }>({ loading: false, total: 0, items: [] })
  React.useEffect(() => {
    if (!open || !item?.id) return
    let cancelled = false
    setReviews({ loading: true, total: 0, items: [] })
    void (async () => {
      try {
        const res = await getResultReviewsAction(item.id)
        if (!cancelled) setReviews({ loading: false, total: res.total, items: res.items })
      } catch {
        if (!cancelled) setReviews({ loading: false, total: 0, items: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, item?.id])

  if (!item) return null

  const price = item.price != null ? Number(item.price) : null
  const originalPrice = item.originalPrice != null ? Number(item.originalPrice) : null
  const rating = item.rating != null ? Number(item.rating) : null
  const discounted = price != null && originalPrice != null && originalPrice > price

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-y-auto sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle className="line-clamp-2 pr-6 text-left text-base leading-snug">
            {item.title ?? item.content ?? "（无标题）"}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="flex items-center gap-1.5 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
              <PlatformInlineIcon platform={item.platform} size={13} />
              {platformLabel(item.platform)}
            </span>
            {item.country ? (
              <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                <CountryFlag code={item.country} size={12} />
                {countryLabel(item.country)}（{item.country}）
              </span>
            ) : null}
            {item.taskType ? (
              <span className="rounded bg-muted px-1.5 py-0.5">
                {item.taskType === "discover" ? "发现" : item.taskType === "monitor" ? "监控" : "市场"}
              </span>
            ) : null}
            {item.sellerName ? <span>卖家 {item.sellerName}</span> : null}
            {item.scrapedAt ? (
              <span>抓取于 {item.scrapedAt.toLocaleString("zh-CN", { hour12: false })}</span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
          {/* 图集 */}
          <div className="space-y-2">
            <div className="aspect-square overflow-hidden rounded-lg border bg-muted">
              {images[active] ? (
                <SmartImage
                  src={images[active]}
                  alt={item.title ?? ""}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                  无图
                </div>
              )}
            </div>
            {images.length > 1 ? (
              <div className="flex flex-wrap gap-1.5">
                {images.slice(0, 8).map((src, i) => (
                  <button
                    key={src + i}
                    type="button"
                    className={cn(
                      "size-11 overflow-hidden rounded-md border bg-muted",
                      i === active && "border-primary ring-1 ring-primary",
                    )}
                    onClick={() => setActive(i)}
                  >
                    <SmartImage src={src} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* 指标 */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-2">
              {price != null ? (
                <span className="text-xl font-bold tabular-nums">
                  {item.currency && item.currency !== "USD" ? `${item.currency} ` : "$"}
                  {price % 1 === 0 ? price.toFixed(0) : price.toFixed(2)}
                </span>
              ) : (
                <span className="text-xl text-muted-foreground">—</span>
              )}
              {discounted ? (
                <span className="text-sm text-muted-foreground line-through tabular-nums">
                  {originalPrice!.toFixed(2)}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => onToggleBookmark(item.id)}
                className={cn(
                  "ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors",
                  bookmarked
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Star className={cn("size-3.5", bookmarked && "fill-current")} />
                {bookmarked ? "已收藏" : "收藏"}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {rating != null ? <Metric label="评分" value={rating.toFixed(1)} /> : null}
              {item.reviewCount != null ? (
                <Metric label="评论数" value={compactNumber(item.reviewCount)} />
              ) : null}
              {item.salesCount != null ? (
                <Metric label="销量" value={compactNumber(item.salesCount)} />
              ) : null}
              {item.likesCount != null ? (
                <Metric label="点赞" value={compactNumber(item.likesCount)} />
              ) : null}
              {item.commentsCount != null ? (
                <Metric label="评论" value={compactNumber(item.commentsCount)} />
              ) : null}
              {item.sharesCount != null ? (
                <Metric label="转发" value={compactNumber(item.sharesCount)} />
              ) : null}
              {item.viewsCount != null ? (
                <Metric label="浏览" value={compactNumber(item.viewsCount)} />
              ) : null}
              {item.publishedAt ? (
                <Metric
                  label="发布时间"
                  value={item.publishedAt.toLocaleDateString("zh-CN")}
                />
              ) : null}
            </div>

            {item.categoryPath?.length ? (
              <p className="text-xs text-muted-foreground">
                类目：{item.categoryPath.join(" / ")}
              </p>
            ) : item.category ? (
              <p className="text-xs text-muted-foreground">类目：{item.category}</p>
            ) : null}

            {item.tags?.length || item.hashtags?.length ? (
              <div className="flex flex-wrap gap-1">
                {[...(item.tags ?? []), ...(item.hashtags ?? [])]
                  .slice(0, 12)
                  .map((t, i) => (
                    <span
                      key={t + i}
                      className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {item.sourceUrl ? (
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<a href={item.sourceUrl} target="_blank" rel="noreferrer" />}
                >
                  <ExternalLink className="size-3.5" />
                  查看来源
                </Button>
              ) : null}
              {item.taskId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  nativeButton={false}
                  render={
                    <Link
                      href={`/selection/discover?task=${item.taskId}${item.country ? `&country=${item.country}` : ""}`}
                    />
                  }
                >
                  来源任务：{item.taskKeyword || "查看"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {item.content && item.title ? (
          <div className="rounded-lg bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            {item.content}
          </div>
        ) : null}

        {/* 抓取评论（竞品监控抓取的评论，按来源链接关联） */}
        <div className="rounded-lg border">
          <p className="flex items-center gap-1.5 border-b px-3 py-2 text-xs font-medium">
            <MessageSquareQuote className="size-3.5 text-primary" />
            抓取评论{reviews.total > 0 ? `（${reviews.total}）` : ""}
            {reviews.loading ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
          </p>
          {reviews.loading && reviews.items.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">评论加载中…</p>
          ) : reviews.items.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              暂无抓取评论——在卡片上点准星按钮加入竞品监控，支持评论的平台会自动抓取评论并在此展示。
            </p>
          ) : (
            <div className="max-h-64 divide-y overflow-y-auto">
              {reviews.items.map((r) => (
                <div key={r.id} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1 font-medium text-foreground">
                      <PlatformInlineIcon platform={r.platform} size={12} />
                      {r.authorName ?? "匿名"}
                    </span>
                    {r.rating != null ? (
                      <span className="inline-flex items-center gap-0.5 text-amber-500">
                        <Star className="size-3 fill-current" />
                        {Number(r.rating).toFixed(1)}
                      </span>
                    ) : null}
                    {r.verified ? (
                      <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                        <BadgeCheck className="size-3" /> 已验证
                      </span>
                    ) : null}
                    {r.likesCount != null ? (
                      <span className="inline-flex items-center gap-0.5">
                        <ThumbsUp className="size-3" />
                        {compactNumber(r.likesCount)}
                      </span>
                    ) : null}
                    <span className="ml-auto">
                      {r.publishedAt ? formatDateTime(r.publishedAt) : `抓取 ${formatDateTime(r.scrapedAt)}`}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed">{r.content ?? "（无正文）"}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <details className="group rounded-lg border px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground select-none">
            原始数据（JSON，调试/溯源）
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted/50 p-2 text-[10px] leading-relaxed">
            {JSON.stringify(item.rawData ?? { note: "无原始数据" }, null, 2)}
          </pre>
        </details>
      </DialogContent>
    </Dialog>
  )
}
