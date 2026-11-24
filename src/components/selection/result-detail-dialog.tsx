"use client"

import * as React from "react"
import Link from "next/link"
import { Crosshair, ExternalLink, Star } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { DashRing } from "@/components/ui/dash-ring"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CountryFlag, PlatformInlineIcon } from "@/components/selection/platform-badges"
import { MediaGallery } from "@/components/selection/detail/media-gallery"
import { EcommerceSections } from "@/components/selection/detail/ecommerce-sections"
import { SocialSections } from "@/components/selection/detail/social-sections"
import { ReviewSection } from "@/components/selection/detail/review-section"
import { Metric, Section } from "@/components/selection/detail/detail-shared"
import { canMonitorItem, isSocialPlatform } from "@/components/selection/result-card"
import { compactNumber, formatPrice, platformLabel } from "@/components/selection/labels"
import { getResultRawDataAction } from "@/server/actions/selection"
import { formatDateTime } from "@/lib/datetime"
import { countryLabel } from "@/lib/selection/platforms"
import type { SelectionPoolItem } from "@/lib/selection/pool-types"
import { cn } from "@/lib/utils"

/**
 * 数据池结果详情弹窗：媒体区（视频 + 图集）+ 平台专属分区 + 来源 / 收藏 / 监控操作 +
 * 评论洞察（含一次性抓评论）+ 按需加载的原始 JSON。
 * 电商与社媒走各自的分区组件；社媒正文全文在社媒分区里展示（修复：此前社媒帖子
 * 因无标题导致正文不渲染）。
 */
export function ResultDetailDialog({
  item,
  open,
  onOpenChange,
  bookmarked,
  onToggleBookmark,
  monitored,
  onAddMonitor,
}: {
  item: SelectionPoolItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
  bookmarked: boolean
  onToggleBookmark: (id: string) => void
  /** 该目标是否已在竞品监控中 */
  monitored?: boolean
  /** 加入竞品监控（传了才显示按钮） */
  onAddMonitor?: (item: SelectionPoolItem) => void
}) {
  // 列表项不带 rawData；「原始数据」展开时按需拉取。state 带 id：A 的请求未返回就
  // 关掉弹窗点开 B 时，晚到的 A 响应按 id 比对丢弃，不会把 A 的数据写进 B 的弹窗
  const [raw, setRaw] = React.useState<{
    id: string | null
    loading: boolean
    /** 本次拉取已完成（区分「未拉取」与「拉到 jsonb null」） */
    fetched: boolean
    data: Record<string, unknown> | null
    error: string | null
  }>({ id: null, loading: false, fetched: false, data: null, error: null })
  React.useEffect(() => {
    setRaw({ id: item?.id ?? null, loading: false, fetched: false, data: null, error: null })
  }, [item?.id])

  const loadRaw = async (force = false) => {
    if (!item) return
    if (!force && raw.id === item.id && (raw.fetched || raw.loading)) return
    const id = item.id
    setRaw({ id, loading: true, fetched: false, data: null, error: null })
    try {
      const res = await getResultRawDataAction(id)
      // 拉取期间弹窗已切到另一条（或关闭）：丢弃过期响应
      setRaw((s) =>
        s.id === id
          ? {
              id,
              loading: false,
              fetched: true,
              // 失败返回不再把 {error} 塞进 data（会被缓存且展示成 JSON 串）
              data: res.ok ? res.rawData : null,
              error: res.ok ? null : res.error,
            }
          : s,
      )
    } catch {
      setRaw((s) =>
        s.id === id ? { id, loading: false, fetched: true, data: null, error: "加载失败" } : s,
      )
    }
  }

  if (!item) return null
  const isSocial = isSocialPlatform(item.platform)
  const ex = item.extras ?? {}
  const price = item.price != null ? Number(item.price) : null
  const originalPrice = item.originalPrice != null ? Number(item.originalPrice) : null
  const rating = item.rating != null ? Number(item.rating) : null
  const taskTypeName =
    item.taskType === "discover" ? "发现" : item.taskType === "monitor" ? "监控" : item.taskType === "market" ? "市场" : ""
  const poolBase = isSocial ? "/selection/market" : "/selection/discover"

  /** 指标格（按平台口径） */
  const metrics: Array<{ label: string; value: React.ReactNode }> = []
  if (rating != null) metrics.push({ label: "评分", value: rating.toFixed(1) })
  if (item.reviewCount != null) metrics.push({ label: "评论数", value: compactNumber(item.reviewCount) })
  if (!isSocial && item.salesCount != null) {
    metrics.push({ label: item.platform === "amazon" ? "月购买" : "销量", value: compactNumber(item.salesCount) })
  }
  if (!isSocial && item.rank != null) {
    metrics.push({
      label: item.platform === "amazon" ? "BSR / 名次" : "名次",
      value: `#${item.rank}`,
    })
  }
  if (!isSocial && item.likesCount != null && rating == null) {
    metrics.push({ label: item.platform === "etsy" ? "收藏" : "赞", value: compactNumber(item.likesCount) })
  }
  if (isSocial) {
    if (item.viewsCount != null) metrics.push({ label: "浏览", value: compactNumber(item.viewsCount) })
    if (item.likesCount != null) {
      metrics.push({ label: item.platform === "pinterest" ? "保存" : item.platform === "reddit" ? "获赞" : "点赞", value: compactNumber(item.likesCount) })
    }
    if (item.commentsCount != null) metrics.push({ label: "评论", value: compactNumber(item.commentsCount) })
    if (item.sharesCount != null) metrics.push({ label: "转发", value: compactNumber(item.sharesCount) })
    if (ex.tiktok?.collectCount != null) metrics.push({ label: "收藏", value: compactNumber(ex.tiktok.collectCount) })
    if (ex.x?.quoteCount != null) metrics.push({ label: "引用", value: compactNumber(ex.x.quoteCount) })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="result-detail-dialog"
        className="flex max-h-[88vh] flex-col overflow-y-auto sm:max-w-[780px]"
      >
        <DialogHeader>
          <DialogTitle className="line-clamp-2 pr-6 text-left text-base leading-snug">
            {item.title ?? (isSocial ? "社媒帖子详情" : "（无标题）")}
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
            {taskTypeName ? <span className="rounded bg-muted px-1.5 py-0.5">{taskTypeName}</span> : null}
            {item.sellerName && !isSocial ? <span>卖家 {item.sellerName}</span> : null}
            {item.scrapedAt ? <span>抓取于 {formatDateTime(item.scrapedAt)}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn(
            "grid gap-4",
            isSocial ? "grid-cols-1 sm:grid-cols-[minmax(0,300px)_minmax(0,1fr)]" : "sm:grid-cols-[220px_minmax(0,1fr)]",
          )}
        >
          <MediaGallery item={item} />

          <div className="min-w-0 space-y-3">
            {/* 价格行 + 操作 */}
            <div className="flex flex-wrap items-baseline gap-2">
              {!isSocial ? (
                <>
                  <span className="text-xl font-bold tabular-nums">
                    {formatPrice(price, item.currency)}
                  </span>
                  {originalPrice != null && price != null && originalPrice > price ? (
                    <span className="text-sm text-muted-foreground line-through tabular-nums">
                      {originalPrice.toFixed(2)}
                    </span>
                  ) : null}
                </>
              ) : null}
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {onAddMonitor && canMonitorItem(item) ? (
                  <Tooltip>
                    {/* Trigger 挂 span：禁用态 Button 带 pointer-events-none，title/悬浮事件挂按钮上永不触发 */}
                    <TooltipTrigger render={<span className="inline-flex" />}>
                      <Button
                        variant={monitored ? "secondary" : "outline"}
                        size="sm"
                        className="h-7 text-xs"
                        disabled={monitored}
                        onClick={() => onAddMonitor(item)}
                      >
                        <Crosshair className="size-3.5" />
                        {monitored ? "监控中" : "加入监控"}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {monitored ? "已在竞品监控中（到监控页管理）" : "加入竞品监控（周期重抓+评论追踪）"}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("h-7 text-xs", bookmarked && "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400")}
                  onClick={() => onToggleBookmark(item.id)}
                >
                  <Star className={cn("size-3.5", bookmarked && "fill-current")} />
                  {bookmarked ? "已收藏" : "收藏"}
                </Button>
                {item.sourceUrl ? (
                  <Button variant="outline" size="sm" className="h-7 text-xs" nativeButton={false} render={<a href={item.sourceUrl} target="_blank" rel="noreferrer" />}>
                    <ExternalLink className="size-3.5" />
                    查看来源
                  </Button>
                ) : null}
              </div>
            </div>

            {metrics.length > 0 ? (
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {metrics.map((m) => (
                  <Metric key={m.label} label={m.label} value={m.value} />
                ))}
              </div>
            ) : null}

            {!isSocial && item.categoryPath?.length ? (
              <p className="text-xs text-muted-foreground">类目：{item.categoryPath.join(" / ")}</p>
            ) : null}
            {!isSocial && item.category && !item.categoryPath?.length ? (
              <p className="text-xs text-muted-foreground">类目：{item.category}</p>
            ) : null}

            {isSocial ? <SocialSections item={item} /> : <EcommerceSections item={item} />}

            {!isSocial && item.tags?.length ? (
              <div className="flex flex-wrap gap-1">
                {item.tags.slice(0, 12).map((t, i) => (
                  <span key={t + i} className={cn("rounded px-1.5 py-0.5 text-[10px]", t === "广告" ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400")}>
                    {t}
                  </span>
                ))}
              </div>
            ) : null}

            {/* 来源任务：按平台类别跳到对应的平台标签视图 */}
            {item.taskId ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  nativeButton={false}
                  render={
                    <Link
                      href={`${poolBase}?platform=${item.platform}&task=${item.taskId}`}
                    />
                  }
                >
                  来源任务：{item.taskKeyword || "查看"}
                </Button>
              </div>
            ) : null}
          </div>
        </div>

        {/* 电商正文（商品描述）；社媒正文在上方社媒分区 */}
        {!isSocial && item.content ? (
          <Section title="描述">
            <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{item.content}</p>
          </Section>
        ) : null}

        <ReviewSection item={item} />

        <details
          className="group rounded-lg border px-3 py-2"
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) void loadRaw()
          }}
        >
          <summary className="cursor-pointer text-xs text-muted-foreground select-none">
            原始数据（JSON，调试/溯源）
          </summary>
          {raw.loading ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <DashRing className="size-3.5" /> 加载中…
            </p>
          ) : raw.data ? (
            <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted/50 p-2 text-[10px] leading-relaxed">
              {JSON.stringify(raw.data, null, 2)}
            </pre>
          ) : raw.error ? (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="text-destructive">
                原始数据加载失败{raw.error !== "加载失败" ? `（${raw.error}）` : ""}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => void loadRaw(true)}
              >
                重试
              </Button>
            </div>
          ) : raw.fetched ? (
            <p className="mt-2 text-xs text-muted-foreground">（该行无原始数据）</p>
          ) : null}
        </details>
      </DialogContent>
    </Dialog>
  )
}
