"use client"

import * as React from "react"
import { Crosshair, Star } from "lucide-react"
import type { SelectionPoolItem } from "@/lib/selection/pool-types"
import {
  SELECTION_PLATFORM_CONFIGS,
  isMonitorablePlatform,
  isSelectionPlatform,
} from "@/lib/selection/platforms"
import { EcommerceCard } from "@/components/selection/ecommerce-card"
import { SocialCard } from "@/components/selection/social-card"
import { cn } from "@/lib/utils"

/**
 * 数据池结果卡片入口（2026-11-21 二次设计，用户拍板双形态；0108 按平台定制指标）：
 *   电商 = 方案 A「情报浮层卡」（ecommerce-card）：图满格 + 底部渐变叠价格/评分，
 *          hover 展开第二行平台指标（Amazon BSR/月购买、TEMU 销量/降幅…）
 *   社媒 = 方案 C「大图 Bento 卡」（social-card）：4:5 大图 + 磨砂数据条，
 *          各平台展示自己的互动指标与视频角标
 * 点击卡片主体打开详情弹窗（父级持有弹窗状态）。
 */

export interface ResultCardProps {
  item: SelectionPoolItem
  bookmarked: boolean
  /** 该目标已在竞品监控中（按钮常显高亮） */
  monitored?: boolean
  onToggleBookmark: (id: string) => void
  /** 加入竞品监控（平台不支持 / 缺链接时按钮隐藏） */
  onAddMonitor?: (item: SelectionPoolItem) => void
  onOpen: (item: SelectionPoolItem) => void
  /** 多选模式（我的选品批量操作） */
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: (id: string) => void
  /** 卡片下方的附加信息（收藏的集合 / 优先级 / 笔记） */
  footnote?: React.ReactNode
  /** 外层容器（我的选品需要 footnote 时由调用方包裹） */
  className?: string
}

export function isSocialPlatform(platform: string): boolean {
  return (
    isSelectionPlatform(platform) &&
    SELECTION_PLATFORM_CONFIGS[platform].category === "social"
  )
}

/** 卡片可否加入竞品监控（平台有直抓入口且有来源链接） */
export function canMonitorItem(item: SelectionPoolItem): boolean {
  return Boolean(
    item.sourceUrl != null &&
      isSelectionPlatform(item.platform) &&
      isMonitorablePlatform(item.platform),
  )
}

/** 卡片右上角操作：加入监控（准星）+ 收藏（星标）；多选模式左上角叠加勾选框 */
export function CardActions({
  item,
  bookmarked,
  monitored,
  selectable,
  selected,
  onToggleBookmark,
  onAddMonitor,
  onToggleSelect,
}: Pick<
  ResultCardProps,
  "item" | "bookmarked" | "monitored" | "selectable" | "selected" | "onToggleBookmark" | "onAddMonitor" | "onToggleSelect"
>) {
  const monitorable = onAddMonitor != null && canMonitorItem(item)
  return (
    <>
      {selectable ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={Boolean(selected)}
          aria-label={selected ? "取消选择" : "选择"}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect?.(item.id)
          }}
          className={cn(
            "absolute left-2 top-2 z-10 flex size-5 items-center justify-center rounded-[4px] border-2 backdrop-blur-md transition-colors",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-white/90 bg-black/40 text-transparent hover:bg-black/60",
          )}
        >
          <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
            <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
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
    </>
  )
}

/** 键盘可达的卡片外壳（点击 / Enter / 空格打开详情） */
export function useCardOpen(onOpen: (item: SelectionPoolItem) => void, item: SelectionPoolItem) {
  const open = React.useCallback(() => onOpen(item), [onOpen, item])
  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      // 焦点在内嵌按钮（收藏星 / 监控准星 / 多选勾选框）上时不拦截：preventDefault
      // 会取消按钮的 Enter/Space 默认激活，键盘将无法操作这些按钮（按钮 onClick
      // 里的 stopPropagation 已阻止冒泡开弹窗）
      if (e.target !== e.currentTarget) return
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        open()
      }
    },
    [open],
  )
  return { open, onKeyDown }
}

export function ResultCard({
  item,
  footnote,
  className,
  ...rest
}: ResultCardProps) {
  const card = isSocialPlatform(item.platform) ? (
    <SocialCard item={item} {...rest} />
  ) : (
    <EcommerceCard item={item} {...rest} />
  )
  if (!footnote) return card
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {card}
      {footnote}
    </div>
  )
}
