"use client"

import * as React from "react"
import { motion } from "motion/react"
import { Play } from "lucide-react"
import { SmartImage } from "@/components/ui/smart-image"
import { CountryFlag } from "@/components/selection/platform-badges"
import { compactNumber, formatDuration, moneyPrefix } from "@/components/selection/labels"
import { CardActions, useCardOpen, type ResultCardProps } from "@/components/selection/result-card"
import { resolveVideo } from "@/lib/selection/extras"
import { resultKindFor, type SelectionPoolItem } from "@/lib/selection/pool-types"
import { cn } from "@/lib/utils"

/**
 * 电商情报浮层卡（选品发现各平台标签共用）
 *
 * 图满格 + 底部渐变遮罩：标题 / 价格 / 评分常显，hover 展开第二行平台指标。
 * 平台标签视图里不再重复显示平台名，左上角改为「国家 + 该平台的头牌指标」
 * （Amazon 榜单名次 / BSR、TEMU 销量或降幅、Etsy 收藏）。
 */

/** 平台头牌指标（左上角常显徽标） */
function headlineOf(item: SelectionPoolItem): { text: string; tone?: "amber" } | null {
  const ex = item.extras ?? {}
  switch (item.platform) {
    case "amazon": {
      if (ex.amazon?.listPosition != null) return { text: `榜 #${ex.amazon.listPosition}`, tone: "amber" }
      if (ex.amazon?.bsrRank != null) return { text: `BSR #${ex.amazon.bsrRank}`, tone: "amber" }
      if (item.rank != null) return { text: `#${item.rank}`, tone: "amber" }
      if (item.salesCount != null) return { text: `月购 ${compactNumber(item.salesCount)}` }
      return null
    }
    case "temu":
      if (item.salesCount != null) return { text: `销量 ${compactNumber(item.salesCount)}`, tone: "amber" }
      if (ex.temu?.discountPct != null) return { text: `降${ex.temu.discountPct}%` }
      return null
    case "etsy":
      if (item.likesCount != null) return { text: `收藏 ${compactNumber(item.likesCount)}`, tone: "amber" }
      return null
    default:
      return null
  }
}

/** hover 展开的第二行：各平台自己有意义的指标 */
function detailChips(item: SelectionPoolItem): React.ReactNode {
  const ex = item.extras ?? {}
  const chip = (key: string, node: React.ReactNode, tone: "plain" | "green" = "plain") => (
    <span
      key={key}
      className={cn(
        "rounded px-1.5 py-px backdrop-blur-sm",
        tone === "green" ? "bg-emerald-400/25 text-emerald-100" : "bg-white/15 text-white/85",
      )}
    >
      {node}
    </span>
  )
  switch (item.platform) {
    case "amazon":
      return (
        <>
          {ex.amazon?.monthlyPurchases
            ? chip("buy", `月购买 ${compactNumber(item.salesCount)}`, "green")
            : null}
          {ex.amazon?.listPosition != null && ex.amazon.bsrRank != null
            ? chip("bsr", `BSR #${ex.amazon.bsrRank}`)
            : null}
          {ex.amazon?.isChoice ? chip("choice", "Amazon's Choice", "green") : null}
          {ex.amazon?.isBestSeller ? chip("best", "Best Seller", "green") : null}
          {ex.amazon?.isSponsored ? chip("ad", "广告") : null}
          {ex.amazon?.inStock === false ? chip("oos", "缺货") : null}
        </>
      )
    case "temu":
      return (
        <>
          {item.salesCount != null ? chip("sales", `销量 ${compactNumber(item.salesCount)}`, "green") : null}
          {ex.temu?.discountPct != null ? chip("off", `降${ex.temu.discountPct}%`) : null}
          {ex.temu?.inStock === false ? chip("oos", "缺货") : null}
          {item.tags?.filter((t) => t !== "有视频").slice(0, 2).map((t) => chip(t, t))}
        </>
      )
    case "etsy":
      return (
        <>
          {item.likesCount != null ? chip("fav", `收藏 ${compactNumber(item.likesCount)}`, "green") : null}
          {item.tags?.slice(0, 2).map((t) => chip(t, t, t === "广告" ? "plain" : "green"))}
        </>
      )
    case "shopify":
      return (
        <>
          {item.categoryPath?.length ? chip("cat", item.categoryPath[item.categoryPath.length - 1]) : null}
          {item.tags?.slice(0, 2).map((t) => chip(t, t))}
        </>
      )
    default:
      return item.tags?.slice(0, 3).map((t) => chip(t, t))
  }
}

export function EcommerceCard({
  item,
  onOpen,
  ...rest
}: Omit<ResultCardProps, "footnote" | "className">) {
  const { open, onKeyDown } = useCardOpen(onOpen, item)
  const price = item.price != null ? Number(item.price) : null
  const originalPrice = item.originalPrice != null ? Number(item.originalPrice) : null
  const rating = item.rating != null ? Number(item.rating) : null
  const kind = resultKindFor(item.platform, item.taskType)
  const video = resolveVideo(item.platform, item)
  const headline = headlineOf(item)
  const prefix = moneyPrefix(item.currency)

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -40px 0px" }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="group relative cursor-pointer overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKeyDown}
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
          <div className="flex h-full w-full items-center justify-center p-3">
            <p className="line-clamp-5 text-xs leading-relaxed text-muted-foreground">
              {item.title ?? "无图"}
            </p>
          </div>
        )}
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          {item.country ? (
            <span className="flex items-center gap-1 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
              <CountryFlag code={item.country} size={10} />
              {item.country}
            </span>
          ) : null}
          {headline ? (
            <span
              className={cn(
                "rounded-sm px-1.5 py-0.5 text-[10px] font-semibold tabular-nums backdrop-blur-sm",
                headline.tone === "amber"
                  ? "bg-amber-400/90 text-amber-950"
                  : "bg-black/70 text-white",
              )}
            >
              {headline.text}
            </span>
          ) : null}
        </div>
        <CardActions item={item} {...rest} />
        {/* 底部渐变情报浮层：标题 + 价格/评分常显，hover 展开平台指标行 */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2.5 pb-2 pt-10">
          <p className="truncate text-[11px] leading-4 font-medium text-white/90">
            {item.title ?? item.content ?? "（无标题）"}
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-1.5">
            {price != null ? (
              <span className="text-sm font-bold tabular-nums text-white">
                {prefix}
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
            {video.kind !== "none" ? (
              <span className="inline-flex items-center gap-0.5 rounded bg-white/20 px-1 py-px text-[10px] font-medium text-white">
                <Play className="size-2.5 fill-current" />
                {video.durationSec != null ? formatDuration(video.durationSec) : "视频"}
              </span>
            ) : null}
          </div>
          <div className="grid grid-rows-[0fr] overflow-hidden transition-all duration-300 group-hover:grid-rows-[1fr]">
            <div className="min-h-0">
              <div className="flex flex-wrap items-center gap-1.5 pt-1.5 text-[10px] text-white/85">
                {detailChips(item)}
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
