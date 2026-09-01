"use client"

import { useState } from "react"
import Image from "next/image"
import {
  AlertTriangle,
  Glasses,
  Images,
  Palette,
  User,
  type LucideIcon,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { Skeleton } from "@/components/ui/skeleton"
import { cn, toImageSrc } from "@/lib/utils"
import { BatchView } from "@/components/product-v2/batch-view"
import type { WeartryBatchRow } from "@/lib/weartry/types"

const STATUS_LABELS: Record<WeartryBatchRow["status"], string> = {
  processing: "进行中",
  completed: "已完成",
  partial_failed: "部分失败",
}

const STATUS_CLASS: Record<WeartryBatchRow["status"], string> = {
  processing: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  completed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  partial_failed: "bg-destructive/10 text-destructive",
}

/** 批次任务 mode（templateInfo.mode）→ 展示名 */
const TASK_MODE_LABELS: Record<string, string> = {
  outfit: "服装组图",
  model_image: "模特形象",
  wear: "模特穿戴",
  accessory: "AI万戴",
  color: "AI换色",
}

/** 批次任务 mode → 图标（未命中兜底 Images） */
const TASK_MODE_ICONS: Record<string, LucideIcon> = {
  outfit: Images,
  model_image: User,
  wear: User,
  accessory: Glasses,
  color: Palette,
}

function modeLabel(mode: string): string {
  return TASK_MODE_LABELS[mode] ?? mode
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期（跨年含年份） */
function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMin = Math.floor((now.getTime() - date.getTime()) / 60000)
  if (diffMin < 1) return "刚刚"
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 小时前`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return "昨天"
  if (diffHour < 24 * 7) return `${Math.floor(diffHour / 24)} 天前`
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit",
  })
}

/** 历史 tab：批次封面卡片网格，点击卡片在 Dialog 中查看批次详情（筛选由顶栏控件负责） */
export function WeartryHistoryPanel({
  batches,
  onRetry,
  retryingId,
  loading,
  filterActive,
}: {
  batches: WeartryBatchRow[]
  onRetry: (taskId: string) => void
  retryingId?: string | null
  loading?: boolean
  /** 顶栏筛选（类型/日期范围）是否生效中，用于区分空态文案 */
  filterActive?: boolean
}) {
  const [selectedTag, setSelectedTag] = useState<string | null>(null)

  const selected = batches.find((b) => b.batchTag === selectedTag) ?? null

  return (
    <div className="space-y-4">
      {loading && batches.length === 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border">
              <Skeleton className="aspect-square w-full rounded-none" />
              <div className="space-y-2 p-3">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : batches.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {filterActive ? "没有符合筛选条件的记录" : "暂无生成记录"}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {batches.map((b) => {
            const cover = b.tasks.find(
              (t) => t.status === "completed" && t.imageUrl,
            )
            const ModeIcon = TASK_MODE_ICONS[b.mode] ?? Images
            return (
              <button
                key={b.batchTag}
                type="button"
                onClick={() => setSelectedTag(b.batchTag)}
                className="group overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-primary/40 hover:shadow-sm"
              >
                <div className="relative aspect-square w-full overflow-hidden bg-muted">
                  {cover?.imageUrl ? (
                    <Image
                      src={toImageSrc(cover.imageUrl)}
                      alt={modeLabel(b.mode)}
                      fill
                      sizes="(min-width: 1280px) 20vw, (min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
                      className="object-cover"
                      unoptimized
                    />
                  ) : b.status === "processing" ? (
                    <div className="flex h-full w-full items-center justify-center">
                      <MorphingInfinity className="size-8 text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                      <AlertTriangle className="size-7 text-destructive/70" />
                      <span className="text-xs">全部失败</span>
                    </div>
                  )}
                  <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
                    {b.status === "processing"
                      ? `${b.completed}/${b.total}`
                      : `${b.total} 张`}
                  </span>
                </div>
                <div className="p-3">
                  <div className="flex min-w-0 items-center gap-1 text-sm font-medium">
                    <ModeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{modeLabel(b.mode)}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-[3px] px-1.5 py-0.5 text-[10px]",
                        STATUS_CLASS[b.status],
                      )}
                    >
                      {STATUS_LABELS[b.status]}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] font-normal text-muted-foreground">
                      {formatRelativeTime(toDate(b.createdAt))}
                    </span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelectedTag(null)}
      >
        {/* 条件包在 DialogContent 外：关闭时整体卸载，避免退场动画结束后 Portal 残留幽灵关闭按钮 */}
        {selected && (
          <DialogContent className="sm:max-w-4xl">
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  {(() => {
                    const ModeIcon = TASK_MODE_ICONS[selected.mode] ?? Images
                    return <ModeIcon className="size-4 text-muted-foreground" />
                  })()}
                  {modeLabel(selected.mode)}
                  <span
                    className={cn(
                      "rounded-[3px] px-2 py-0.5 text-xs font-normal",
                      STATUS_CLASS[selected.status],
                    )}
                  >
                    {STATUS_LABELS[selected.status]}
                  </span>
                </DialogTitle>
                <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {[
                    toDate(selected.createdAt).toLocaleString("zh-CN", {
                      hour12: false,
                    }),
                    `成功 ${selected.completed} 张${
                      selected.failed > 0 ? ` · 失败 ${selected.failed} 张` : ""
                    }`,
                  ]
                    .filter(Boolean)
                    .map((part, i) => (
                      <span key={i} className="flex items-center gap-2">
                        {i > 0 && (
                          <span className="text-muted-foreground/40">·</span>
                        )}
                        {part}
                      </span>
                    ))}
                </DialogDescription>
              </DialogHeader>
              <BatchView
                tasks={selected.tasks}
                onRetry={onRetry}
                retryingId={retryingId}
                variant="dialog"
              />
            </>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
