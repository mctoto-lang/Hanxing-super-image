"use client"

import * as React from "react"
import { motion } from "motion/react"
import { Crosshair, Eye, MessageCircle, Star, ThumbsUp } from "lucide-react"
import { SmartImage } from "@/components/ui/smart-image"
import { compactNumber } from "@/components/selection/labels"
import { PlatformCountryBadge } from "@/components/selection/platform-badges"
import { resultKindFor, type SelectionPoolItem } from "@/lib/selection/pool-types"
import {
  SELECTION_PLATFORM_CONFIGS,
  isMonitorablePlatform,
  isSelectionPlatform,
} from "@/lib/selection/platforms"
import { cn } from "@/lib/utils"

/**
 * 数据池结果卡片（2026-11-21 二次设计，用户拍板双形态）：
 *   电商 = 方案 A「情报浮层卡」：图满格 + 底部渐变遮罩叠价格/评分，hover
 *          展开第二行指标（销量/评论/标签），操作按钮浮现
 *   社媒 = 方案 C「大图 Bento 卡」：4:5 大图 + 底部磨砂玻璃数据条（作者/
 *          文案/互动），motion 入场渐显 + hover 轻缩放
 * 点击卡片主体打开详情弹窗（父级持有弹窗状态）。
 */

export function ResultCard({
  item,
  bookmarked,
  monitored,
  onToggleBookmark,
  onAddMonitor,
  onOpen,
}: {
  item: SelectionPoolItem
  bookmarked: boolean
  /** 该目标已在竞品监控中（按钮常显高亮） */
  monitored?: boolean
  onToggleBookmark: (id: string) => void
  /** 加入竞品监控（平台不支持/缺链接时按钮隐藏） */
  onAddMonitor?: (item: SelectionPoolItem) => void
  onOpen: (item: SelectionPoolItem) => void
}) {
  const isSocial =
    isSelectionPlatform(item.platform) &&
    SELECTION_PLATFORM_CONFIGS[item.platform].category === "social"
  const price = item.price != null ? Number(item.price) : null
  const originalPrice = item.originalPrice != null ? Number(item.originalPrice) : null
  const rating = item.rating != null ? Number(item.rating) : null
  const monitorable =
    onAddMonitor != null &&
    item.sourceUrl != null &&
    isSelectionPlatform(item.platform) &&
    isMonitorablePlatform(item.platform)

  const actions = (
    <div className="absolute right-2 top-2 flex items-center gap-1">
      {monitorable ? (
        <button
          type="button"
          aria-label={monitored ? "已在竞品监控中" : "加入竞品监控"}
          title={monitored ? "已在竞品监控中（到监控页管理）" : "加入竞品监控（周期重抓+评论追踪）"}
          className={cn(
            "rounded-md p-1.5 backdrop-blur-md transition-all",
            monitored
              ? "bg-sky-500/85 text-white"
              : "bg-black/40 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation()
            onAddMonitor!(item)
          }}
        >
          <Crosshair className="size-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={bookmarked ? "取消收藏" : "收藏"}
        className={cn(
          "rounded-md p-1.5 backdrop-blur-md transition-all",
          bookmarked
            ? "bg-amber-500/85 text-white"
            : "bg-black/40 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
        onClick={(e) => {
          e.stopPropagation()
          onToggleBookmark(item.id)
        }}
      >
        <Star className={cn("size-3.5", bookmarked && "fill-current")} />
      </button>
    </div>
  )

  // ── 社媒卡（方案 C：大图 Bento） ──
  if (isSocial) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "0px 0px -40px 0px" }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="group relative cursor-pointer overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40"
        role="button"
        tabIndex={0}
        onClick={() => onOpen(item)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onOpen(item)
          }
        }}
      >
        <div className="relative aspect-[4/5] bg-muted">
          {item.images?.[0] || item.videos?.[0] ? (
            <SmartImage
              src={item.images?.[0] ?? item.videos![0]}
              alt={item.content ?? ""}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center bg-gradient-to-br from-primary/15 via-muted to-muted p-3">
              <p className="line-clamp-6 text-xs leading-relaxed text-muted-foreground">
                {item.content ?? item.title ?? "（无内容）"}
              </p>
            </div>
          )}
          <div className="absolute left-2 top-2">
            <PlatformCountryBadge platform={item.platform} country={item.country} />
          </div>
          {actions}
          {/* 磨砂玻璃数据条（底部悬浮） */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/35 to-transparent p-2.5 pt-10">
            <div className="rounded-lg bg-black/30 p-2 backdrop-blur-md">
              <p className="truncate text-xs font-medium text-white">
                {item.sellerName ? `@${item.sellerName}` : item.title ?? "（无标题）"}
              </p>
              {item.content && item.sellerName ? (
                <p className="mt-0.5 line-clamp-1 text-[11px] text-white/75">{item.content}</p>
              ) : null}
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-white/90">
                {item.likesCount != null ? (
                  <span className="inline-flex items-center gap-0.5">
                    <ThumbsUp className="size-3" />
                    {compactNumber(item.likesCount)}
                  </span>
                ) : null}
                {item.commentsCount != null ? (
                  <span className="inline-flex items-center gap-0.5">
                    <MessageCircle className="size-3" />
                    {compactNumber(item.commentsCount)}
                  </span>
                ) : null}
                {item.viewsCount != null ? (
                  <span className="inline-flex items-center gap-0.5">
                    <Eye className="size-3" />
                    {compactNumber(item.viewsCount)}
                  </span>
                ) : null}
                {item.sharesCount != null ? (
                  <span className="text-white/70">转发 {compactNumber(item.sharesCount)}</span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    )
  }

  // ── 电商卡（方案 A：情报浮层） ──
  const kind = resultKindFor(item.platform, item.taskType)
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -40px 0px" }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="group relative cursor-pointer overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen(item)
        }
      }}
    >
      <div className="relative aspect-square bg-muted">
        {item.images?.[0] ? (
          <SmartImage
            src={item.images[0]}
            alt={item.title ?? ""}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            loading="lazy"
          />
        ) : kind === "store" ? (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-sky-500/15 via-muted to-muted text-2xl font-semibold text-muted-foreground/60">
            店铺
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            无图
          </div>
        )}
        <div className="absolute left-2 top-2">
          <PlatformCountryBadge platform={item.platform} country={item.country} />
        </div>
        {actions}
        {/* 底部渐变情报浮层：标题 + 价格/评分 常显，hover 展开指标行 */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2.5 pb-2 pt-10">
          <p className="truncate text-[11px] leading-4 font-medium text-white/90">
            {item.title ?? item.content ?? "（无标题）"}
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
            {price != null ? (
              <span className="text-sm font-bold tabular-nums text-white">
                {item.currency && item.currency !== "USD" ? `${item.currency} ` : "$"}
                {price % 1 === 0 ? price.toFixed(0) : price.toFixed(2)}
              </span>
            ) : (
              <span className="text-sm font-semibold text-white/60">—</span>
            )}
            {originalPrice != null && price != null && originalPrice > price ? (
              <span className="text-[11px] text-white/55 line-through tabular-nums">
                {originalPrice.toFixed(2)}
              </span>
            ) : null}
            {rating != null ? (
              <span className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-medium text-white">
                <span className="text-amber-400">★</span>
                {rating.toFixed(1)}
                {item.reviewCount != null ? (
                  <span className="text-white/65">({compactNumber(item.reviewCount)})</span>
                ) : null}
              </span>
            ) : null}
          </div>
          {/* hover 展开第二行：销量/评论/标签 */}
          <div className="grid grid-rows-[0fr] overflow-hidden transition-all duration-300 group-hover:grid-rows-[1fr]">
            <div className="min-h-0">
              <div className="flex flex-wrap items-center gap-1.5 pt-1.5 text-[10px] text-white/85">
                {item.salesCount != null ? (
                  <span className="rounded bg-white/15 px-1.5 py-px backdrop-blur-sm">
                    销量 {compactNumber(item.salesCount)}
                  </span>
                ) : null}
                {item.likesCount != null && rating == null ? (
                  <span className="rounded bg-white/15 px-1.5 py-px">
                    赞 {compactNumber(item.likesCount)}
                  </span>
                ) : null}
                {item.tags?.slice(0, 2).map((t) => (
                  <span key={t} className="rounded bg-emerald-400/25 px-1.5 py-px text-emerald-100">
                    {t}
                  </span>
                ))}
                {item.sellerName ? (
                  <span className="ml-auto max-w-24 truncate text-white/60">{item.sellerName}</span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
