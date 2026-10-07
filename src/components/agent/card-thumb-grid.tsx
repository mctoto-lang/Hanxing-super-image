"use client"

/* 生成图 URL 可能来自本地存储或 COS，使用原生 img 兼容两类地址。 */
/* eslint-disable @next/next/no-img-element */

/**
 * 卡牌正方形缩略图网格（经典看板「卡牌预览」与塔罗 art 阶段「卡面」共用）：
 * - 一行 6 个（移动端 3 / sm 4），不可折叠；
 * - 卡内 aspect-square 缩略图以完整比例显示（object-contain），
 *   空白区域随主题（bg-muted：浅色灰 / 深色深灰）；
 * - 状态环色 + 样/检角标 + 名称/状态行；点击打开逐轮回放弹窗。
 */
import { cn } from "@/lib/utils"
import { ITEM_STATUS_META } from "./canvas-shared"

/**
 * 卡片正方形预览统一样式：hover 无浮动位移，仅边框 + 柔光发光
 * （生图评审缩略、融合与交付成品卡/套件资产网格共用）。
 */
export const CARD_SQUARE_THUMB_CLASS =
  "rounded-lg border bg-card p-1 text-left transition-[border-color,box-shadow] duration-200 hover:border-violet-500/60 hover:shadow-[0_0_0_1px_rgba(139,92,246,0.35),0_0_18px_-4px_rgba(139,92,246,0.5)]"

export interface CardThumbItem {
  id: string
  index: number
  name: string | null
  status: string
  isSample?: boolean
  fallbackContentWarning?: boolean | null
  errorMessage?: string | null
  /** 最新轮成图（无图卡显示状态占位） */
  imageUrl: string | null
  roundNumber?: number | null
}

/** 缩略图卡 */
function CardThumb({ item, onOpen }: { item: CardThumbItem; onOpen: (id: string) => void }) {
  const meta = ITEM_STATUS_META[item.status] ?? ITEM_STATUS_META.pending!
  return (
    <button
      type="button"
      aria-label={`查看「${item.name ?? `第 ${item.index + 1} 张`}」生成轮次`}
      title={item.errorMessage ?? item.name ?? undefined}
      onClick={() => onOpen(item.id)}
      className={cn(
        "group overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60",
        CARD_SQUARE_THUMB_CLASS,
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-md bg-muted">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={item.name ?? `第 ${item.index + 1} 张`}
            className="size-full object-contain"
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-0.5 text-[10px] text-muted-foreground">
            <span className="tabular-nums">{item.index + 1}</span>
            <span>{meta.label}</span>
          </div>
        )}
        {item.roundNumber ? (
          <span className="absolute right-1 top-1 rounded bg-black/60 px-1 py-px text-[9px] font-medium tabular-nums text-white">
            R{item.roundNumber}
          </span>
        ) : null}
        {item.isSample && (
          <span className="absolute left-1 top-1 rounded bg-amber-500/90 px-1 py-px text-[9px] font-medium text-white shadow-sm">
            样
          </span>
        )}
        {item.fallbackContentWarning && (
          <span
            className="absolute bottom-1 left-1 rounded bg-red-600/90 px-1 py-px text-[9px] font-medium text-white shadow-sm"
            title="内容兜底，建议人工复核"
          >
            ⚠检
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 px-0.5 pb-0.5 pt-1">
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium">
          {item.name ?? `第 ${item.index + 1} 张`}
        </span>
        <span className={cn("shrink-0 rounded-full px-1 py-px text-[9px]", meta.badge)}>{meta.label}</span>
      </div>
    </button>
  )
}

/** 网格：一行 6 个（3 / sm 4 / lg 6） */
export function CardThumbGrid({
  items,
  onOpen,
  className,
}: {
  items: CardThumbItem[]
  onOpen: (id: string) => void
  className?: string
}) {
  return (
    <div className={cn("grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6", className)}>
      {items.map((item) => (
        <CardThumb key={item.id} item={item} onOpen={onOpen} />
      ))}
    </div>
  )
}
