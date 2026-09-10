"use client"

import * as React from "react"
import {
  AlertTriangle,
  Download,
  FileDown,
  LayoutGrid,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { SmartImage } from "@/components/ui/smart-image"
import { ImageGeneration } from "@/components/ui/image-generation"
import {
  downloadImageFile,
  ImageViewer,
} from "@/components/ui/image-viewer"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type {
  MockupBatchDetail,
  MockupBatchView,
  MockupCardHistoryView,
} from "@/lib/mockup/types"
import { cn, toImageSrc } from "@/lib/utils"
import {
  getMockupBatchStatusAction,
  retryBatchTaskAction,
} from "@/server/actions/mockup"

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期（跨年含年份） */
function formatRelativeTime(value: string): string {
  const date = new Date(value)
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

function batchStatusOf(b: MockupBatchView): "processing" | "completed" | "partial_failed" {
  if (b.processingCount > 0) return "processing"
  return b.failedCount > 0 ? "partial_failed" : "completed"
}

const STATUS_LABELS: Record<"processing" | "completed" | "partial_failed", string> = {
  processing: "进行中",
  completed: "已完成",
  partial_failed: "部分失败",
}

const STATUS_CLASS: Record<"processing" | "completed" | "partial_failed", string> = {
  processing: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  completed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  partial_failed: "bg-destructive/10 text-destructive",
}

/**
 * 生成历史：来源切换由顶栏控件负责，本组件按 source 渲染——
 * card = 按渲染卡片聚合（封面最新图），batch = 批量替换批次（进行中带进度条）。
 * 点击卡片查看详情：card → 全部图片平铺 + 下载全部 ZIP；batch → 批次任务明细。
 */
export function MockupHistoryPanel({
  source,
  cards,
  batches,
  loading,
  filterActive,
}: {
  source: "card" | "batch"
  cards: MockupCardHistoryView[]
  batches: MockupBatchView[]
  loading?: boolean
  filterActive?: boolean
}) {
  const [selectedCardId, setSelectedCardId] = React.useState<string | null>(null)
  const selected = cards.find((c) => c.cardId === selectedCardId) ?? null

  const empty = source === "card" ? cards.length === 0 : batches.length === 0

  return (
    <div className="space-y-4">
      {loading && empty ? (
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
      ) : empty ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {filterActive ? "没有符合筛选条件的记录" : "暂无生成记录"}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {source === "card"
            ? cards.map((c) => {
                const cover = c.images[0]!
                return (
                  <button
                    key={c.cardId}
                    type="button"
                    onClick={() => setSelectedCardId(c.cardId)}
                    className="group overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-primary/40 hover:shadow-sm"
                  >
                    <div className="relative aspect-square w-full overflow-hidden bg-muted">
                      <SmartImage
                        src={toImageSrc(cover.resultImage, { width: 480 })}
                        alt={cover.displayName}
                        className="size-full object-cover"
                      />
                      {c.processing ? (
                        <span className="absolute inset-0 flex items-center justify-center bg-background/50">
                          <Loader2 className="size-8 animate-spin text-foreground/70" />
                        </span>
                      ) : null}
                      <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
                        {c.images.length} 张
                      </span>
                    </div>
                    <div className="p-3">
                      <div className="flex min-w-0 items-center gap-1 text-sm font-medium">
                        <LayoutGrid className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{c.groupName || "样机渲染"}</span>
                        {c.processing ? (
                          <span className="shrink-0 rounded-[3px] bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
                            进行中
                          </span>
                        ) : null}
                        <span className="ml-auto shrink-0 text-[10px] font-normal text-muted-foreground">
                          {formatRelativeTime(c.latestAt)}
                        </span>
                      </div>
                    </div>
                  </button>
                )
              })
            : batches.map((b) => {
                const status = batchStatusOf(b)
                const pct =
                  b.totalCount > 0
                    ? Math.round((b.succeededCount / b.totalCount) * 100)
                    : 0
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setSelectedCardId(b.id)}
                    className="group overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-primary/40 hover:shadow-sm"
                  >
                    <div className="relative aspect-square w-full overflow-hidden bg-muted">
                      {b.coverImage ? (
                        <SmartImage
                          src={toImageSrc(b.coverImage, { width: 480 })}
                          alt={b.displayName}
                          className="size-full object-cover"
                        />
                      ) : (
                        <div className="flex size-full items-center justify-center text-muted-foreground">
                          <Loader2 className="size-8 animate-spin" />
                        </div>
                      )}
                      <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
                        {status === "processing"
                          ? `${b.succeededCount}/${b.totalCount}`
                          : `${b.succeededCount} 张`}
                      </span>
                      {status === "processing" ? (
                        <span className="absolute inset-x-0 bottom-0 h-1.5 bg-black/30">
                          <span
                            className="block h-full bg-primary transition-[width] duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                      ) : null}
                    </div>
                    <div className="p-3">
                      <div className="flex min-w-0 items-center gap-1 text-sm font-medium">
                        <LayoutGrid className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{b.displayName}</span>
                        <span
                          className={cn(
                            "shrink-0 rounded-[3px] px-1.5 py-0.5 text-[10px]",
                            STATUS_CLASS[status],
                          )}
                        >
                          {STATUS_LABELS[status]}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] font-normal text-muted-foreground">
                          {formatRelativeTime(b.createdAt)}
                        </span>
                      </div>
                    </div>
                  </button>
                )
              })}
        </div>
      )}

      {source === "card" ? (
        <CardDetailDialog
          record={selected}
          onClose={() => setSelectedCardId(null)}
        />
      ) : (
        <BatchDetailDialog
          batchId={selectedCardId}
          onClose={() => setSelectedCardId(null)}
        />
      )}
    </div>
  )
}

/** PSD 等非图片格式结果：浏览器无法直接预览，网格内显示文件占位并点击下载 */
function isPreviewableImage(url: string): boolean {
  return !/\.psd(?:$|[?#])/i.test(url)
}

function safeZipEntryName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)
}

/** 从结果 URL 推断下载扩展名（结果文件按实际格式存储：.png/.jpg/.psd） */
function extFromUrl(url: string): string {
  const m = /\.(png|jpe?g|psd)(?:$|[?#])/i.exec(url)
  return m ? `.${m[1]!.toLowerCase().replace("jpeg", "jpg")}` : ".png"
}

/** 将图片 URL 列表打包为单个 ZIP 下载（命名：序号-名称，扩展名取自实际文件） */
async function downloadImagesZip(
  items: Array<{ url: string; name: string }>,
  zipName: string,
): Promise<void> {
  if (items.length === 0) {
    toast.warning("暂无已完成的结果图")
    return
  }
  const { zipSync } = await import("fflate")
  const files: Record<string, Uint8Array> = {}
  for (const [i, it] of items.entries()) {
    const res = await fetch(it.url)
    if (!res.ok) continue
    files[`${String(i + 1).padStart(3, "0")}-${safeZipEntryName(it.name)}${extFromUrl(it.url)}`] =
      new Uint8Array(await res.arrayBuffer())
  }
  if (Object.keys(files).length === 0) {
    toast.error("结果图拉取失败，请逐张下载")
    return
  }
  const blob = new Blob([zipSync(files)], { type: "application/zip" })
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = objUrl
  a.download = zipName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objUrl)
}

/** 模板渲染记录详情（穿戴式）：4 列缩略图网格 + 大图查看器 + 下载全部 ZIP */
function CardDetailDialog({
  record,
  onClose,
}: {
  record: MockupCardHistoryView | null
  onClose: () => void
}) {
  const [zipping, setZipping] = React.useState(false)
  const [viewerOpen, setViewerOpen] = React.useState(false)
  const [viewerIndex, setViewerIndex] = React.useState(0)

  const previewable = React.useMemo(
    () =>
      (record?.images ?? []).filter((img) =>
        isPreviewableImage(img.resultImage),
      ),
    [record],
  )

  const handleZip = async () => {
    if (!record || zipping) return
    setZipping(true)
    try {
      await downloadImagesZip(
        record.images.map((img) => ({ url: img.resultImage, name: img.displayName })),
        `样机渲染-${record.groupName || "历史"}-${record.cardId.slice(0, 8)}.zip`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "打包失败")
    } finally {
      setZipping(false)
    }
  }

  return (
    <Dialog open={Boolean(record)} onOpenChange={(open) => !open && onClose()}>
      {/* 条件包在 DialogContent 外：关闭时整体卸载，避免退场动画结束后 Portal 残留幽灵关闭按钮 */}
      {record && (
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <LayoutGrid className="size-4 text-muted-foreground" />
              {record.groupName || "样机渲染"}
              <span className="text-sm font-normal text-muted-foreground">
                共 {record.images.length} 张
              </span>
            </DialogTitle>
            <DialogDescription>
              最近生成：
              {new Date(record.latestAt).toLocaleString("zh-CN", {
                hour12: false,
              })}
              （按生成时间倒序）
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium">
                图片 {previewable.length} 张
              </span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={zipping}
                onClick={() => void handleZip()}
              >
                {zipping ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1 size-3.5" />
                )}
                {zipping ? "下载中…" : "下载全部"}
              </Button>
            </div>

            <div className="@container">
              {/* 隐藏竖向滚动条本体（滚轮滚动保留） */}
              <ScrollArea className="max-h-[calc(50cqw+2.5rem)] [&_[data-slot=scroll-area-scrollbar]]:hidden">
                <div className="grid grid-cols-4 gap-3">
                  {record.images.map((img) => {
                    const viewerIdx = previewable.indexOf(img)
                    return (
                      <div key={img.taskId} className="space-y-1.5">
                        <div className="overflow-hidden rounded-lg border bg-muted">
                          {viewerIdx >= 0 ? (
                            <button
                              type="button"
                              className="relative block aspect-square w-full"
                              onClick={() => {
                                setViewerIndex(viewerIdx)
                                setViewerOpen(true)
                              }}
                            >
                              <SmartImage
                                src={toImageSrc(img.resultImage, { width: 480 })}
                                alt={img.displayName}
                                className="size-full object-cover"
                              />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                              title="下载 PSD 源文件"
                              onClick={() =>
                                downloadImageFile(
                                  toImageSrc(img.resultImage),
                                  img.displayName,
                                )
                              }
                            >
                              <FileDown className="size-6" />
                              <span className="text-[10px]">PSD · 点击下载</span>
                            </button>
                          )}
                        </div>
                        <p className="truncate text-center text-xs text-muted-foreground">
                          {img.displayName}
                        </p>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            </div>
          </div>

          <ImageViewer
            open={viewerOpen}
            onOpenChange={setViewerOpen}
            images={previewable.map((img) => toImageSrc(img.resultImage))}
            index={viewerIndex}
            onIndexChange={setViewerIndex}
          />
        </DialogContent>
      )}
    </Dialog>
  )
}

/** 批量替换记录详情（穿戴式）：懒加载批次明细，进行中 5s 轮询刷新；
 * 顶部进度行（进度 + 进度条 + 下载全部 ZIP）+ 4 列缩略图网格
 *  （完成=点击看大图；进行中=动画格；失败=错误悬停 + 重试） */
function BatchDetailDialog({
  batchId,
  onClose,
}: {
  batchId: string | null
  onClose: () => void
}) {
  const [detail, setDetail] = React.useState<MockupBatchDetail | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [viewerOpen, setViewerOpen] = React.useState(false)
  const [viewerIndex, setViewerIndex] = React.useState(0)
  const [busyTaskId, setBusyTaskId] = React.useState<string | null>(null)
  const [zipping, setZipping] = React.useState(false)

  const load = React.useCallback(async (id: string) => {
    setLoading(true)
    try {
      const res = await getMockupBatchStatusAction(id)
      setDetail(res.ok ? res.batch : null)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!batchId) {
      setDetail(null)
      return
    }
    void load(batchId)
  }, [batchId, load])

  const processing = (detail?.processingCount ?? 0) > 0
  React.useEffect(() => {
    if (!batchId || !processing) return
    const timer = setInterval(() => {
      if (document.hidden) return
      void getMockupBatchStatusAction(batchId).then((res) => {
        if (res.ok && res.batch) setDetail(res.batch)
      })
    }, 5000)
    return () => clearInterval(timer)
  }, [batchId, processing])

  const status = detail ? batchStatusOf(detail) : "processing"
  const total = detail?.totalCount ?? 0
  const completed = detail?.succeededCount ?? 0
  const inFlight = detail?.processingCount ?? 0
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0

  // 完成且可预览的图按序进入查看器
  const previewable = React.useMemo(
    () =>
      (detail?.tasks ?? []).filter(
        (t) =>
          t.status === "completed" && t.resultImage && isPreviewableImage(t.resultImage),
      ),
    [detail],
  )

  const handleRetry = async (taskId: string) => {
    if (!batchId || busyTaskId) return
    setBusyTaskId(taskId)
    try {
      const res = await retryBatchTaskAction(taskId)
      if (!res.ok) {
        toast.error(res.error ?? "重试失败")
        return
      }
      toast.success("已重新提交")
      void load(batchId)
    } finally {
      setBusyTaskId(null)
    }
  }

  const handleZip = async () => {
    if (!detail || zipping) return
    const items = detail.tasks
      .filter((t) => t.status === "completed" && t.resultImage)
      .map((t) => ({ url: t.resultImage!, name: t.label }))
    setZipping(true)
    try {
      await downloadImagesZip(
        items,
        `批量替换-${detail.displayName}-${detail.id.slice(0, 8)}.zip`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "打包失败")
    } finally {
      setZipping(false)
    }
  }

  return (
    <Dialog open={batchId !== null} onOpenChange={(open) => !open && onClose()}>
      {batchId && (
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <LayoutGrid className="size-4 text-muted-foreground" />
              {detail?.displayName ?? "批量替换"}
              <span
                className={cn(
                  "rounded-[3px] px-2 py-0.5 text-xs font-normal",
                  STATUS_CLASS[status],
                )}
              >
                {STATUS_LABELS[status]}
              </span>
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {detail
                ? [
                    new Date(detail.createdAt).toLocaleString("zh-CN", {
                      hour12: false,
                    }),
                    `成功 ${completed} 张${
                      (detail.failedCount ?? 0) > 0
                        ? ` · 失败 ${detail.failedCount} 张`
                        : ""
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
                    ))
                : "任务明细（进行中自动刷新）"}
            </DialogDescription>
          </DialogHeader>

          {loading && !detail ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 批次加载中…
            </div>
          ) : detail ? (
            <div className="flex flex-col gap-4">
              <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium">
                  进度 {completed}/{total}
                </span>
                {inFlight > 0 && (
                  <span className="text-muted-foreground">
                    生成中 {inFlight} 张
                  </span>
                )}
                <Progress
                  value={pct}
                  aria-label="生成进度"
                  className="min-w-28 flex-1"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  disabled={completed === 0 || zipping}
                  onClick={() => void handleZip()}
                >
                  {zipping ? (
                    <Loader2 className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <Download className="mr-1 size-3.5" />
                  )}
                  {zipping ? "下载中…" : "下载全部"}
                </Button>
              </div>

              <div className="@container">
                {/* 隐藏竖向滚动条本体（滚轮滚动保留） */}
                <ScrollArea className="max-h-[calc(50cqw+2.5rem)] [&_[data-slot=scroll-area-scrollbar]]:hidden">
                  <div className="grid grid-cols-4 gap-3">
                    {detail.tasks.map((t) => {
                      const label =
                        t.label ||
                        `#${String(t.batchIndex).padStart(3, "0")}`
                      const viewerIdx = previewable.indexOf(t)
                      return (
                        <div key={t.taskId} className="group space-y-1.5">
                          <div className="overflow-hidden rounded-lg border bg-muted">
                            {t.status === "completed" && t.resultImage ? (
                              viewerIdx >= 0 ? (
                                <button
                                  type="button"
                                  className="relative block aspect-square w-full"
                                  onClick={() => {
                                    setViewerIndex(viewerIdx)
                                    setViewerOpen(true)
                                  }}
                                >
                                  <SmartImage
                                    src={toImageSrc(t.resultImage, {
                                      width: 480,
                                    })}
                                    alt={label}
                                    className="size-full object-cover"
                                  />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                                  title="下载 PSD 源文件"
                                  onClick={() =>
                                    downloadImageFile(
                                      toImageSrc(t.resultImage!),
                                      label,
                                    )
                                  }
                                >
                                  <FileDown className="size-6" />
                                  <span className="text-[10px]">
                                    PSD · 点击下载
                                  </span>
                                </button>
                              )
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
                                  disabled={busyTaskId === t.taskId}
                                  onClick={() => void handleRetry(t.taskId)}
                                >
                                  {busyTaskId === t.taskId ? (
                                    <Loader2 className="mr-1 size-3 animate-spin" />
                                  ) : null}
                                  {busyTaskId === t.taskId ? "重试中…" : "重试"}
                                </Button>
                              </div>
                            ) : (
                              <div className="relative aspect-square w-full">
                                <ImageGeneration
                                  showMeta={false}
                                  className="absolute inset-0 [&_.igCanvas]:rounded-lg"
                                />
                              </div>
                            )}
                          </div>
                          <p className="truncate text-center text-xs text-muted-foreground">
                            {label}
                          </p>
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              </div>
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              批次不存在或已被清理
            </div>
          )}

          <ImageViewer
            open={viewerOpen}
            onOpenChange={setViewerOpen}
            images={previewable.map((t) => toImageSrc(t.resultImage!))}
            index={viewerIndex}
            onIndexChange={setViewerIndex}
          />
        </DialogContent>
      )}
    </Dialog>
  )
}
