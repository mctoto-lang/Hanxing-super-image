"use client"

import * as React from "react"
import { Heart, Trash2, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { getStorageProxyUrl } from "@/lib/storage/proxy"
import { toast } from "sonner"
import { pinTaskAction, unpinTaskAction, deleteTaskAction } from "@/server/actions/assets"
import { useRouter } from "next/navigation"

export interface GalleryItem {
  taskId: string
  pinnedId?: string
  prompt: string
  images: string[]
  modelDisplayName: string
  source: string
  createdAt: Date
}

const SOURCE_LABELS: Record<string, string> = {
  create: "创作",
  workspace: "工作台",
  product: "商品主图",
}

function groupByDate(items: GalleryItem[]): Map<string, GalleryItem[]> {
  const groups = new Map<string, GalleryItem[]>()
  for (const item of items) {
    const d = new Date(item.createdAt)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }
  return groups
}

export function ImageGallery({
  items,
  emptyHint,
  isPinnedView,
}: {
  items: GalleryItem[]
  emptyHint: string
  isPinnedView?: boolean
}) {
  const router = useRouter()
  const groups = groupByDate(items)

  if (items.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed text-muted-foreground">
        {emptyHint}
      </div>
    )
  }

  async function handlePin(taskId: string) {
    const res = await pinTaskAction({ taskId })
    if (res.ok) {
      toast.success("已收藏")
      router.refresh()
    } else {
      toast.error(res.error ?? "收藏失败")
    }
  }

  async function handleUnpin(pinnedId: string) {
    const res = await unpinTaskAction(pinnedId)
    if (res.ok) {
      toast.success("已取消收藏")
      router.refresh()
    }
  }

  async function handleDelete(taskId: string) {
    if (!confirm("确认删除？该图片将从画廊移除（任务记录保留审计）")) return
    const res = await deleteTaskAction(taskId)
    if (res.ok) {
      toast.success("已删除")
      router.refresh()
    } else {
      toast.error(res.error ?? "删除失败")
    }
  }

  function handleDownload(url: string, idx: number) {
    // 通过代理 URL 下载（防 SSRF）
    const a = document.createElement("a")
    a.href = getStorageProxyUrl(url)
    a.download = `hanxing-${Date.now()}-${idx}.png`
    a.target = "_blank"
    a.click()
  }

  return (
    <div className="space-y-6">
      {[...groups.entries()].map(([date, dayItems]) => (
        <div key={date} className="space-y-2">
          <div className="sticky top-0 z-10 bg-background/80 py-1 text-sm font-medium text-muted-foreground backdrop-blur">
            {date}（{dayItems.length} 个任务）
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {dayItems.map((item) =>
              item.images.map((url, imgIdx) => (
                <div
                  key={`${item.taskId}-${imgIdx}`}
                  className="group relative overflow-hidden rounded-lg border bg-card"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={getStorageProxyUrl(url)}
                    alt={item.prompt.slice(0, 50)}
                    className="aspect-square w-full object-cover transition-transform group-hover:scale-105"
                    loading="lazy"
                  />
                  <div className="absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/80 via-transparent to-black/40 p-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <div className="flex justify-end gap-1">
                      {isPinnedView && item.pinnedId ? (
                        <Button
                          size="icon"
                          variant="secondary"
                          className="size-7"
                          onClick={() => handleUnpin(item.pinnedId!)}
                          title="取消收藏"
                        >
                          <Heart className="size-3.5 fill-current" />
                        </Button>
                      ) : (
                        <Button
                          size="icon"
                          variant="secondary"
                          className="size-7"
                          onClick={() => handlePin(item.taskId)}
                          title="收藏"
                        >
                          <Heart className="size-3.5" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="secondary"
                        className="size-7"
                        onClick={() => handleDownload(url, imgIdx)}
                        title="下载"
                      >
                        <Download className="size-3.5" />
                      </Button>
                      {!isPinnedView ? (
                        <Button
                          size="icon"
                          variant="secondary"
                          className="size-7 text-destructive"
                          onClick={() => handleDelete(item.taskId)}
                          title="删除"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                    <div className="space-y-1">
                      <p className="line-clamp-2 text-xs text-white">
                        {item.prompt}
                      </p>
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary" className="text-[10px]">
                          {SOURCE_LABELS[item.source] ?? item.source}
                        </Badge>
                        {item.modelDisplayName ? (
                          <span className="text-[10px] text-white/70">
                            {item.modelDisplayName}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              )),
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
