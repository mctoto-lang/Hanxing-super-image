"use client"

import * as React from "react"
import { Download, Heart, Search } from "lucide-react"
import type { DateRange } from "react-day-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ImageViewer } from "@/components/ui/image-viewer"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { SmartImage } from "@/components/ui/smart-image"
import { HistoryDateRangePicker } from "@/components/product-v2/history-date-range-picker"
import {
  filterGalleryItems,
  isFilterActive,
  type GalleryCard,
  type GalleryItem,
  type PinnedTaskRef,
  type SourceFilter,
  SOURCE_FILTERS,
  SOURCE_LABELS,
  sourceFilterLabel,
} from "@/lib/assets/gallery-filter"
import { cn, toImageSrc } from "@/lib/utils"
import { getStorageProxyUrl } from "@/lib/storage/proxy"
import { pinTaskAction, unpinTaskAction } from "@/server/actions/assets"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

/** pinnedMap 的乐观占位值：收藏请求落地前没有真实 pinnedId */
const PIN_PENDING = "__pending__"

/** 光环动画时长（与 globals.css 中 assets-heart-ring 保持一致） */
const RING_DURATION_MS = 600

/** 容器宽度 → 瀑布流列数（对齐 Tailwind sm/md/lg 断点） */
function columnsForWidth(width: number): number {
  if (width >= 1024) return 5
  if (width >= 768) return 4
  if (width >= 640) return 3
  return 2
}

/** 瀑布流卡片图片：加载前以方形骨架占位，加载完成按自然比例淡入 */
function CardImage({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => setLoaded(false), [src])

  return (
    <div className="relative w-full">
      <SmartImage
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        onFallback={() => setLoaded(true)}
        className={cn(
          "w-full object-cover transition-opacity duration-500",
          loaded ? "opacity-100" : "aspect-square opacity-0",
        )}
      />
      {!loaded ? (
        <Skeleton className="absolute inset-0 rounded-none" aria-hidden />
      ) : null}
    </div>
  )
}

/**
 * 跨来源图片画廊（瀑布流）。
 *
 * - 顶部工具栏：分类下拉（含「仅收藏」）+ 提示词/模型搜索 + 日期范围，
 *   均为客户端过滤，行右侧显示当前筛选下的图片数量
 * - 瀑布流：按容器宽度分列、卡片按自然宽高比排布；数据本身按生成时间
 *   倒序、按索引轮询分列，最近生成的图片横向排在最上方
 * - 图片懒加载 + 骨架占位；点击卡片复用 ImageViewer 全屏放大；
 *   收藏一键切换（乐观更新 + 心形动画）
 */
export function ImageGallery({
  items,
  pinnedTasks,
}: {
  items: GalleryItem[]
  pinnedTasks: PinnedTaskRef[]
}) {
  const router = useRouter()

  const [sourceFilter, setSourceFilter] = React.useState<SourceFilter>("all")
  const [search, setSearch] = React.useState("")
  const [dateRange, setDateRange] = React.useState<DateRange | undefined>()

  // taskId → pinnedId；乐观更新（收藏请求落地前用 PIN_PENDING 占位），
  // router.refresh() 后由 useEffect 与服务端数据重新对齐
  const [pinnedMap, setPinnedMap] = React.useState<
    Record<string, string | undefined>
  >(() => Object.fromEntries(pinnedTasks.map((p) => [p.taskId, p.pinnedId])))
  React.useEffect(() => {
    setPinnedMap(
      Object.fromEntries(pinnedTasks.map((p) => [p.taskId, p.pinnedId])),
    )
  }, [pinnedTasks])

  // 收藏动画：popCount 作 Heart 重挂载 key（重放弹跳），
  // ringIds 控制光环类并在动画结束后移除（下次点击才能重放）
  const [popCount, setPopCount] = React.useState<Record<string, number>>({})
  const [ringIds, setRingIds] = React.useState<ReadonlySet<string>>(new Set())

  const [viewerOpen, setViewerOpen] = React.useState(false)
  const [viewerIndex, setViewerIndex] = React.useState(0)

  const filterActive = isFilterActive({
    sourceFilter,
    keyword: search,
    range: dateRange,
  })

  const filteredItems = React.useMemo(
    () =>
      filterGalleryItems(items, {
        sourceFilter,
        keyword: search,
        range: dateRange,
        pinnedMap,
      }),
    [items, sourceFilter, search, dateRange, pinnedMap],
  )

  // 任务 × 图片展开为扁平卡片（同时是放大查看器的翻页序列）
  const flatCards = React.useMemo<GalleryCard[]>(() => {
    const cards: GalleryCard[] = []
    for (const item of filteredItems) {
      item.images.forEach((url, imgIdx) => {
        cards.push({
          key: `${item.taskId}-${imgIdx}`,
          flatIndex: cards.length,
          url,
          item,
        })
      })
    }
    return cards
  }, [filteredItems])

  // 瀑布流列数跟随容器宽度（SSR 先按 2 列，挂载后立即修正）
  const masonryRef = React.useRef<HTMLDivElement | null>(null)
  const [columnCount, setColumnCount] = React.useState(2)
  React.useEffect(() => {
    const el = masonryRef.current
    if (!el) return
    const compute = () => setColumnCount(columnsForWidth(el.clientWidth))
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 按索引轮询分列：卡片保持时间倒序，最新的横向排在第一行
  const columnLists = React.useMemo(() => {
    const cols: GalleryCard[][] = Array.from({ length: columnCount }, () => [])
    flatCards.forEach((card, i) => cols[i % columnCount]!.push(card))
    return cols
  }, [flatCards, columnCount])

  const viewerCard = flatCards.length
    ? flatCards[Math.min(viewerIndex, flatCards.length - 1)]
    : undefined

  if (items.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed text-muted-foreground">
        暂无生成图片，去创作页生成吧
      </div>
    )
  }

  function bumpPinAnim(taskId: string, ring: boolean) {
    setPopCount((prev) => ({ ...prev, [taskId]: (prev[taskId] ?? 0) + 1 }))
    if (ring) {
      setRingIds((prev) => new Set(prev).add(taskId))
      window.setTimeout(() => {
        setRingIds((prev) => {
          if (!prev.has(taskId)) return prev
          const next = new Set(prev)
          next.delete(taskId)
          return next
        })
      }, RING_DURATION_MS)
    }
  }

  async function togglePin(taskId: string) {
    const pinnedId = pinnedMap[taskId]
    if (pinnedId === PIN_PENDING) return
    bumpPinAnim(taskId, !pinnedId)
    // 乐观翻转，失败回滚
    setPinnedMap((prev) => {
      const next = { ...prev }
      if (pinnedId) delete next[taskId]
      else next[taskId] = PIN_PENDING
      return next
    })
    const res = pinnedId
      ? await unpinTaskAction(pinnedId)
      : await pinTaskAction({ taskId })
    if (res.ok) {
      toast.success(pinnedId ? "已取消收藏" : "已收藏")
      router.refresh() // 取回真实 pinnedId，替换 PIN_PENDING 占位
    } else {
      setPinnedMap((prev) => {
        const next = { ...prev }
        if (pinnedId) next[taskId] = pinnedId
        else delete next[taskId]
        return next
      })
      toast.error(res.error ?? (pinnedId ? "取消收藏失败" : "收藏失败"))
    }
  }

  /** 从 URL 取真实图片扩展名（下载文件名不再固定 .png） */
  function extFromImageUrl(url: string): string {
    const m = url.match(/\.(jpe?g|png|webp|gif)(?:\?|#|$)/i)
    return m ? m[1]!.toLowerCase().replace("jpeg", "jpg") : "png"
  }

  function handleDownload(url: string, idx: number, stamp: number) {
    // 通过代理 URL 下载（防 SSRF）
    const a = document.createElement("a")
    a.href = getStorageProxyUrl(url)
    a.download = `hanxing-${stamp}-${idx}.${extFromImageUrl(url)}`
    a.target = "_blank"
    a.click()
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* 筛选工具栏：分类 + 搜索 + 日期范围，右侧显示当前筛选数量（固定不随内容滚动） */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Select
          value={sourceFilter}
          onValueChange={(v) => setSourceFilter((v as SourceFilter) ?? "all")}
        >
          <SelectTrigger
            size="sm"
            className="w-[124px]"
            aria-label="筛选图片分类"
          >
            <SelectValue>{sourceFilterLabel(sourceFilter)}</SelectValue>
          </SelectTrigger>
          <SelectContent className="min-w-32">
            <SelectItem value="all">全部</SelectItem>
            {SOURCE_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value="pinned">仅收藏</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative w-[220px] max-w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索提示词或模型名称"
            className="h-7 pl-8 text-xs"
          />
        </div>
        <HistoryDateRangePicker
          value={dateRange}
          onChange={setDateRange}
          size="sm"
        />
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          共 {flatCards.length} 张
        </span>
      </div>

      {flatCards.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground">
          <p className="text-sm">没有符合筛选条件的图片</p>
          {filterActive ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSourceFilter("all")
                setSearch("")
                setDateRange(undefined)
              }}
            >
              清除筛选
            </Button>
          ) : null}
        </div>
      ) : (
        /* 仅瀑布流区域滚动：外层滚动容器，内层 JS 分列瀑布流
           （按容器宽度分列、轮询分配，最新图片排在最上方） */
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div ref={masonryRef} className="flex items-start gap-3">
          {columnLists.map((column, colIdx) => (
            <div
              key={colIdx}
              className="flex min-w-0 flex-1 flex-col gap-3"
            >
              {column.map((card) => {
                const isPinned = Boolean(pinnedMap[card.item.taskId])
                const pop = popCount[card.item.taskId] ?? 0
                return (
                  <div
                    key={card.key}
                    className="group relative cursor-zoom-in overflow-hidden rounded-lg border bg-card"
                    onClick={() => {
                      setViewerIndex(card.flatIndex)
                      setViewerOpen(true)
                    }}
                  >
                    {/* COS 直连（toImageSrc 带缩略参数），不经应用服务器中转；
                        过期对象由 SmartImage 显示占位 */}
                    <CardImage
                      src={toImageSrc(card.url, { width: 480 })}
                      alt={card.item.prompt.slice(0, 50)}
                    />
                    <div className="absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/80 via-transparent to-black/40 p-2 opacity-0 transition-opacity group-hover:opacity-100">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="secondary"
                          className={cn(
                            "size-7",
                            ringIds.has(card.item.taskId) &&
                              "assets-heart-ring",
                          )}
                          onClick={(e) => {
                            e.stopPropagation()
                            void togglePin(card.item.taskId)
                          }}
                          aria-label={isPinned ? "取消收藏" : "收藏"}
                        >
                          <Heart
                            key={pop}
                            className={cn(
                              "size-3.5",
                              isPinned && "fill-current text-rose-500",
                              pop > 0 && "assets-heart-pop",
                            )}
                          />
                        </Button>
                        <Button
                          size="icon"
                          variant="secondary"
                          className="size-7"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDownload(card.url, card.flatIndex, Date.now())
                          }}
                          aria-label="下载图片"
                        >
                          <Download className="size-3.5" />
                        </Button>
                      </div>
                      <div className="space-y-1">
                        <p className="line-clamp-2 text-xs text-white">
                          {card.item.prompt}
                        </p>
                        <div className="flex items-center gap-1">
                          <Badge variant="secondary" className="text-[10px]">
                            {SOURCE_LABELS[card.item.source] ??
                              card.item.source}
                          </Badge>
                          {card.item.modelDisplayName ? (
                            <span className="text-[10px] text-white/70">
                              {card.item.modelDisplayName}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
          </div>
        </div>
      )}

      <ImageViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        images={flatCards.map((c) => c.url)}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        info={
          viewerCard
            ? {
                model: viewerCard.item.modelDisplayName,
                prompt: viewerCard.item.prompt,
                createdAt: viewerCard.item.createdAt,
              }
            : undefined
        }
      />
    </div>
  )
}
