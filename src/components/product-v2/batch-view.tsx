"use client"

import { useState } from "react"
import { AlertTriangle, Download, RotateCcw } from "lucide-react"
import { SmartImage } from "@/components/ui/smart-image"
import { Button } from "@/components/ui/button"
import { ImageGeneration } from "@/components/ui/image-generation"
import { downloadImageFile, ImageViewer } from "@/components/ui/image-viewer"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { toImageSrc } from "@/lib/utils"
import type { ProductBatchTaskRow } from "@/lib/product/types"

/**
 * 批次进度/结果视图
 * variant=panel：提交后右列内容区（响应式网格，容器内滚动）
 * variant=dialog：历史详情弹窗（固定 4 列正方形缩略图，视窗最多 2 行，超出滑动查看）
 */
export function BatchView({
  tasks,
  onRetry,
  retryingId,
  variant = "panel",
}: {
  tasks: ProductBatchTaskRow[]
  onRetry: (taskId: string) => void
  retryingId?: string | null
  variant?: "panel" | "dialog"
}) {
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerIndex, setViewerIndex] = useState(0)
  const [downloading, setDownloading] = useState(false)
  // 完成图按序进入查看器；taskImageIndex 记录任务 → 查看器索引
  const completedImages: string[] = []
  const completedTasks: ProductBatchTaskRow[] = []
  const taskImageIndex = new Map<string, number>()
  for (const t of tasks) {
    if (t.status === "completed" && t.imageUrl) {
      taskImageIndex.set(t.id, completedImages.length)
      completedImages.push(t.imageUrl)
      completedTasks.push(t)
    }
  }
  const total = tasks.length
  const completed = tasks.filter((t) => t.status === "completed").length
  const inFlight = tasks.filter(
    (t) => t.status === "queued" || t.status === "processing",
  ).length
  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0

  const downloadAll = async () => {
    if (downloading || completedImages.length === 0) return
    setDownloading(true)
    try {
      for (const [i, t] of tasks.entries()) {
        if (t.status !== "completed" || !t.imageUrl) continue
        downloadImageFile(
          t.imageUrl,
          `${String(i + 1).padStart(2, "0")}-${t.directionName || t.id}`,
          { silent: true },
        )
        // 逐张间隔触发，避免浏览器拦截批量下载
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    } finally {
      setDownloading(false)
    }
  }

  const cells = tasks.map((t) => {
    const label =
      t.directionName ??
      (t.replicateLevel === "style"
        ? "参考风格"
        : t.replicateLevel === "strict"
          ? "高度复刻"
          : "生成中")
    return (
      <div key={t.id} className="space-y-1.5">
        <div className="overflow-hidden rounded-lg border bg-muted">
          {t.status === "completed" && t.imageUrl ? (
            <button
              type="button"
              className="relative block aspect-square w-full"
              onClick={() => {
                const idx = taskImageIndex.get(t.id)
                if (idx !== undefined) {
                  setViewerIndex(idx)
                  setViewerOpen(true)
                }
              }}
            >
              <SmartImage
                src={toImageSrc(t.imageUrl)}
                alt={label}
                className="h-full w-full object-cover"
              />
            </button>
          ) : t.status === "failed" ? (
            <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 p-3 text-center">
              <AlertTriangle className="size-6 text-destructive" />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <p className="line-clamp-2 text-xs text-muted-foreground" />
                  }
                >
                  {t.errorMessage || "生成失败"}
                </TooltipTrigger>
                <TooltipContent className="max-w-sm whitespace-pre-wrap break-words text-left">
                  {t.errorMessage || "生成失败"}
                </TooltipContent>
              </Tooltip>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={retryingId === t.id}
                onClick={() => onRetry(t.id)}
              >
                <RotateCcw className="mr-1 size-3" />
                {retryingId === t.id ? "重试中…" : "重试"}
              </Button>
            </div>
          ) : (
            <ImageGeneration showMeta={false} className="[&_.igCanvas]:rounded-lg" />
          )}
        </div>
        <p className="truncate text-center text-xs text-muted-foreground">
          {label}
        </p>
      </div>
    )
  })

  const viewerTask = completedTasks[viewerIndex]

  return (
    <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">
          进度 {completed}/{total}
        </span>
        {inFlight > 0 && (
          <span className="text-muted-foreground">生成中 {inFlight} 张</span>
        )}
        <Progress
          value={progressPct}
          aria-label="生成进度"
          className="min-w-28 flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={completed === 0 || downloading}
          onClick={() => void downloadAll()}
        >
          <Download className="mr-1 size-3.5" />
          {downloading ? "下载中…" : "下载全部"}
        </Button>
      </div>

      {variant === "dialog" ? (
        /* 容器查询限高 ≈ 2 行（每行 25cqw + 说明文字），超出部分在 ScrollArea 内滑动 */
        <div className="@container">
          <ScrollArea className="max-h-[calc(50cqw+2.5rem)]">
            <div className="grid grid-cols-4 gap-3">{cells}</div>
          </ScrollArea>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1 scrollbar-hide">
          {cells}
        </div>
      )}

      <ImageViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        images={completedImages}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        info={
          viewerTask
            ? {
                model: viewerTask.model ?? undefined,
                prompt: viewerTask.prompt ?? undefined,
                createdAt: viewerTask.createdAt,
                durationMs: viewerTask.durationMs ?? undefined,
              }
            : undefined
        }
      />
    </div>
  )
}
