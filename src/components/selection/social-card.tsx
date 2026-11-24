"use client"

import * as React from "react"
import { motion } from "motion/react"
import {
  BadgeCheck,
  Bookmark,
  Eye,
  MessageCircle,
  Play,
  Quote,
  Share2,
  ThumbsUp,
  type LucideIcon,
} from "lucide-react"
import { SmartImage } from "@/components/ui/smart-image"
import { compactNumber, formatDuration } from "@/components/selection/labels"
import { CardActions, useCardOpen, type ResultCardProps } from "@/components/selection/result-card"
import { resolveVideo } from "@/lib/selection/extras"
import type { SelectionPoolItem } from "@/lib/selection/pool-types"
import { cn } from "@/lib/utils"

/**
 * 社媒大图 Bento 卡（市场分析各平台标签共用）
 *
 * 4:5 大图 + 底部磨砂玻璃数据条。平台标签视图里每个平台只展示自己的互动指标
 * （TikTok 播放/点赞/评论/收藏/分享、X 浏览/点赞/转发/引用、Reddit 获赞/评论…）
 * 与专属徽标（带货 / 广告 / 认证 / 版块 / Reels…），带视频的显示播放角标。
 * 无图的帖子（纯文字推文）退化为文字卡。
 */

interface Metric {
  icon: LucideIcon
  value: number | null
  label: string
}

/** 各平台的互动指标（只列该平台有的） */
function metricsFor(item: SelectionPoolItem): Metric[] {
  const ex = item.extras ?? {}
  switch (item.platform) {
    case "tiktok":
      return [
        { icon: Eye, value: item.viewsCount, label: "播放" },
        { icon: ThumbsUp, value: item.likesCount, label: "点赞" },
        { icon: MessageCircle, value: item.commentsCount, label: "评论" },
        { icon: Bookmark, value: ex.tiktok?.collectCount ?? null, label: "收藏" },
        { icon: Share2, value: item.sharesCount, label: "分享" },
      ]
    case "instagram":
      return [
        { icon: ThumbsUp, value: item.likesCount, label: "点赞" },
        { icon: MessageCircle, value: item.commentsCount, label: "评论" },
        { icon: Eye, value: item.viewsCount, label: "播放" },
      ]
    case "pinterest":
      return [
        { icon: Bookmark, value: item.likesCount, label: "保存" },
        { icon: MessageCircle, value: item.commentsCount, label: "评论" },
      ]
    case "reddit":
      return [
        { icon: ThumbsUp, value: item.likesCount, label: "获赞" },
        { icon: MessageCircle, value: item.commentsCount, label: "评论" },
      ]
    case "x":
      return [
        { icon: Eye, value: item.viewsCount, label: "浏览" },
        { icon: ThumbsUp, value: item.likesCount, label: "点赞" },
        { icon: Share2, value: item.sharesCount, label: "转发" },
        { icon: Quote, value: ex.x?.quoteCount ?? item.commentsCount, label: "引用" },
      ]
    default:
      return [
        { icon: ThumbsUp, value: item.likesCount, label: "互动" },
        { icon: MessageCircle, value: item.commentsCount, label: "评论" },
        { icon: Share2, value: item.sharesCount, label: "转发" },
      ]
  }
}

/** 平台专属徽标（左上角） */
function badgesFor(item: SelectionPoolItem): Array<{ text: string; tone?: "amber" }> {
  const ex = item.extras ?? {}
  const out: Array<{ text: string; tone?: "amber" }> = []
  switch (item.platform) {
    case "tiktok":
      if (ex.tiktok?.hasShopProduct) out.push({ text: "带货", tone: "amber" })
      if (ex.tiktok?.isAd) out.push({ text: "广告" })
      if (ex.tiktok?.isPinned) out.push({ text: "置顶" })
      break
    case "instagram":
      if (ex.instagram?.isReel) out.push({ text: "Reels" })
      if (ex.instagram?.type === "Sidecar") out.push({ text: "轮播" })
      if (ex.instagram?.paidPartnership) out.push({ text: "商务合作" })
      break
    case "reddit":
      if (item.category) out.push({ text: `r/${item.category}` })
      if (ex.reddit?.flair) out.push({ text: ex.reddit.flair })
      if (ex.reddit?.isNsfw) out.push({ text: "NSFW", tone: "amber" })
      break
    case "x":
      if (ex.x?.author?.verified) out.push({ text: "认证" })
      if (ex.x?.isReply) out.push({ text: "回复" })
      break
    case "pinterest":
      if (ex.pinterest?.isVideo) out.push({ text: "视频 Pin" })
      break
    default:
      break
  }
  return out
}

/** 作者头像（有则显示小圆头像）与认证标记 */
function authorOf(item: SelectionPoolItem): { name: string; avatar: string | null; verified: boolean; prefix: string } {
  const ex = item.extras ?? {}
  if (item.platform === "tiktok" && ex.tiktok?.author) {
    return {
      name: ex.tiktok.author.nickname || ex.tiktok.author.username,
      avatar: ex.tiktok.author.avatar,
      verified: ex.tiktok.author.verified,
      prefix: "@",
    }
  }
  if (item.platform === "x" && ex.x?.author) {
    return { name: ex.x.author.name || ex.x.author.username, avatar: ex.x.author.avatar, verified: ex.x.author.verified, prefix: "@" }
  }
  if (item.platform === "reddit") {
    return { name: item.sellerName ?? "", avatar: null, verified: false, prefix: "u/" }
  }
  return { name: item.sellerName ?? "", avatar: null, verified: false, prefix: "@" }
}

export function SocialCard({
  item,
  onOpen,
  ...rest
}: Omit<ResultCardProps, "footnote" | "className">) {
  const { open, onKeyDown } = useCardOpen(onOpen, item)
  const ex = item.extras ?? {}
  const video = resolveVideo(item.platform, item)
  const slides = ex.tiktok?.isSlideshow ? (ex.tiktok.slideshowImages ?? []) : []
  const image = item.images?.[0] ?? slides[0] ?? null
  const imageCount = Math.max(item.images?.length ?? 0, slides.length)
  const badges = badgesFor(item)
  const metrics = metricsFor(item)
  const author = authorOf(item)
  // 纯文字帖（无图无视频）：文字卡而非占位图
  const textOnly = !image && video.kind === "none"
  // 封面失效（TikTok / IG 封面是带时效的签名地址）：视频帖改显示播放占位而非通用失效方块
  const [coverFailed, setCoverFailed] = React.useState(false)
  React.useEffect(() => setCoverFailed(false), [item.id])
  const showVideoPlaceholder = coverFailed && video.kind !== "none"

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -40px 0px" }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40",
        textOnly ? "min-h-[15rem]" : "",
      )}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKeyDown}
    >
      {image ? (
        <div className="relative aspect-[4/5] bg-muted">
          {showVideoPlaceholder ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900 p-4 pb-28 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-white/15 text-white">
                <Play className="size-5 fill-current" />
              </span>
              <p className="text-xs text-white/85">封面已过期</p>
              <p className="text-[11px] text-white/60">点击打开详情可直接播放</p>
            </div>
          ) : (
            <SmartImage
              src={image}
              alt={item.content ?? ""}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              loading="lazy"
              onFallback={() => setCoverFailed(true)}
            />
          )}
          {/* 视频角标（右下角媒体层内）：时长 + 播放符号 */}
          {video.kind !== "none" ? (
            <span className="absolute right-2 top-11 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
              <Play className="size-2.5 fill-current" />
              {video.durationSec != null ? formatDuration(video.durationSec) : "视频"}
            </span>
          ) : null}
          {imageCount > 1 ? (
            <span className="absolute left-2 top-11 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
              图 {imageCount} 张
            </span>
          ) : null}
          {/* 磨砂玻璃数据条（底部悬浮） */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/40 to-transparent p-2 pt-10">
            <div className="rounded-lg bg-black/35 p-2 backdrop-blur-md">
              <AuthorLine author={author} fallback={item.title} />
              {item.content ? (
                <p className="mt-0.5 line-clamp-1 text-[11px] text-white/80">{item.content}</p>
              ) : null}
              <MetricLine metrics={metrics} />
            </div>
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "flex aspect-[4/5] flex-col justify-between bg-gradient-to-br from-primary/15 via-muted to-muted p-3",
            textOnly ? "aspect-auto min-h-[15rem]" : "",
          )}
        >
          <p className="line-clamp-[9] text-xs leading-relaxed text-foreground/90">
            {item.content ?? item.title ?? "（无内容）"}
          </p>
          <div className="space-y-1">
            <AuthorLine author={author} fallback={item.title} tone="light" />
            <MetricLine metrics={metrics} tone="light" />
          </div>
        </div>
      )}
      <div className="absolute left-2 top-2 flex flex-wrap gap-1">
        {badges.slice(0, 3).map((b) => (
          <span
            key={b.text}
            className={cn(
              "rounded-sm px-1.5 py-0.5 text-[10px] font-medium backdrop-blur-sm",
              b.tone === "amber" ? "bg-amber-400/90 text-amber-950" : "bg-black/70 text-white",
            )}
          >
            {b.text}
          </span>
        ))}
      </div>
      <CardActions item={item} {...rest} />
    </motion.div>
  )
}

function AuthorLine({
  author,
  fallback,
  tone = "glass",
}: {
  author: { name: string; avatar: string | null; verified: boolean; prefix: string }
  fallback: string | null
  tone?: "glass" | "light"
}) {
  const name = author.name || fallback || "（无作者）"
  return (
    // SmartImage 的失效占位是 <div>，容器不能用 <p>（HTML 不允许 div 嵌在 p 里）
    <div className={cn("flex items-center gap-1 text-xs font-medium", tone === "glass" ? "text-white" : "text-foreground")}>
      {author.avatar ? (
        <SmartImage src={author.avatar} alt="" className="size-4 shrink-0 rounded-full border border-white/40 object-cover" />
      ) : null}
      <span className="truncate">
        {author.name ? `${author.prefix}${author.name}` : name}
      </span>
      {author.verified ? <BadgeCheck className="size-3.5 shrink-0 text-sky-400" aria-label="认证作者" /> : null}
    </div>
  )
}

function MetricLine({
  metrics,
  tone = "glass",
}: {
  metrics: Metric[]
  tone?: "glass" | "light"
}) {
  const shown = metrics.filter((m) => m.value != null)
  if (shown.length === 0) return null
  return (
    <div
      className={cn(
        "mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]",
        tone === "glass" ? "text-white/90" : "text-muted-foreground",
      )}
    >
      {shown.map((m) => (
        <span key={m.label} className="inline-flex items-center gap-0.5 tabular-nums" aria-label={`${m.label} ${m.value}`}>
          <m.icon className="size-3" />
          {compactNumber(m.value)}
        </span>
      ))}
    </div>
  )
}
