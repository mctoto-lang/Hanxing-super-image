"use client"

import * as React from "react"
import { Check, CheckSquare, Download, Heart, Search } from "lucide-react"
import type { DateRange } from "react-day-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ImageViewer, downloadImageFile } from "@/components/ui/image-viewer"
import { Input } from "@/components/ui/input"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PsdPlaceholder } from "@/components/ui/psd-placeholder"
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
import { cn, isPsdUrl, toImageSrc } from "@/lib/utils"
import {
  fetchAssetsPageAction,
  pinTaskAction,
  unpinTaskAction,
} from "@/server/actions/assets"
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
  initialHasMore = false,
}: {
  items: GalleryItem[]
  pinnedTasks: PinnedTaskRef[]
  /** 服务端还有更多任务（首屏多取 1 条探测）；为 false 时不再分页拉取 */
  initialHasMore?: boolean
}) {
  const router = useRouter()

  const [sourceFilter, setSourceFilter] = React.useState<SourceFilter>("all")
  const [search, setSearch] = React.useState("")
  const [dateRange, setDateRange] = React.useState<DateRange | undefined>()

  // —— 服务端分页追加（P1-2：突破原先一次性 200 条上限）——
  // items 是服务端首屏快照（router.refresh 时整体替换），extraItems 是
  // 客户端追加页；两者按 taskId 去重合并。筛选仍为客户端过滤（作用于已
  // 加载部分，滚动到底继续加载）
  const ASSETS_PAGE_SIZE = 60
  const [extraItems, setExtraItems] = React.useState<GalleryItem[]>([])
  const [serverHasMore, setServerHasMore] = React.useState(initialHasMore)
  const [loadingMoreTasks, setLoadingMoreTasks] = React.useState(false)
  const loadingMoreRef = React.useRef(false)
  // 已加载任务总数（分页 offset）与服务端 hasMore 的 ref 镜像：
  // 避免零依赖 loadMoreTasks 闭包读到过期值
  const loadedCountRef = React.useRef(0)
  const serverHasMoreRef = React.useRef(serverHasMore)

  const allItems = React.useMemo(() => {
    const seen = new Set<string>()
    const merged: GalleryItem[] = []
    for (const it of [...items, ...extraItems]) {
      if (seen.has(it.taskId)) continue
      seen.add(it.taskId)
      merged.push(it)
    }
    return merged
  }, [items, extraItems])

  React.useEffect(() => {
    loadedCountRef.current = allItems.length
    serverHasMoreRef.current = serverHasMore
  }, [allItems.length, serverHasMore])

  const loadMoreTasks = React.useCallback(async () => {
    if (loadingMoreRef.current || !serverHasMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMoreTasks(true)
    try {
      const res = await fetchAssetsPageAction({
        offset: loadedCountRef.current,
        limit: ASSETS_PAGE_SIZE,
      })
      setExtraItems((prev) => [...prev, ...res.items])
      setServerHasMore(res.hasMore)
    } catch {
      toast.error("加载更多失败，请稍后重试")
    } finally {
      loadingMoreRef.current = false
      setLoadingMoreTasks(false)
    }
  }, [])

  // —— 多选批量模式（P1-2）——
  const [selectMode, setSelectMode] = React.useState(false)
  const [selectedKeys, setSelectedKeys] = React.useState<ReadonlySet<string>>(
    new Set(),
  )
  const [batchDownloading, setBatchDownloading] = React.useState(false)

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

  // 切回标签页/窗口时刷新列表（30s 节流）：本页数据是服务端首屏快照，
  // 其他页面（样机渲染等）新完成的图不刷新就一直看不到
  const lastFocusRefreshRef = React.useRef(0)
  React.useEffect(() => {
    // 节流起点 = 挂载时刻（effect 内赋值，渲染期保持纯净）
    lastFocusRefreshRef.current = Date.now()
    const maybeRefresh = () => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - lastFocusRefreshRef.current < 30_000) return
      lastFocusRefreshRef.current = Date.now()
      router.refresh()
    }
    window.addEventListener("focus", maybeRefresh)
    document.addEventListener("visibilitychange", maybeRefresh)
    return () => {
      window.removeEventListener("focus", maybeRefresh)
      document.removeEventListener("visibilitychange", maybeRefresh)
    }
  }, [router])

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
      filterGalleryItems(allItems, {
        sourceFilter,
        keyword: search,
        range: dateRange,
        pinnedMap,
      }),
    [allItems, sourceFilter, search, dateRange, pinnedMap],
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

  // 渐进渲染：首屏只渲染前 N 张卡片，滚动到底部哨兵再逐批露出（200 任务 ×
  // 多图可展开出上千卡片，全量渲染 DOM 与图片请求都会拖垮首屏）。
  // 卡片按键序追加，flatIndex 与查看器索引保持稳定
  const CARD_STEP = 60
  const [visibleCards, setVisibleCards] = React.useState(CARD_STEP)
  const hasMoreCards = flatCards.length > visibleCards
  const visibleFlatCards = React.useMemo(
    () => flatCards.slice(0, visibleCards),
    [flatCards, visibleCards],
  )
  // 筛选条件变化回到首屏数量；数据刷新/追加下一页不触发——
  // 否则收藏刷新、焦点节流刷新、滚动加载都会把已展开的列表塌回 60 张
  React.useEffect(() => {
    setVisibleCards(CARD_STEP)
  }, [sourceFilter, search, dateRange])

  const loadMoreCards = React.useCallback(() => {
    setVisibleCards((prev) => Math.min(prev + CARD_STEP, flatCards.length))
  }, [flatCards.length])

  // 渐进渲染哨兵：root 指向瀑布流滚动容器（视口 root 的预取余量会被嵌套容器裁剪）。
  // 已加载卡片露完但服务端还有更多任务时，继续拉下一页（P1-2 服务端分页）
  const sentinelRef = React.useRef<HTMLDivElement | null>(null)
  const masonryScrollRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!hasMoreCards && !serverHasMore) return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        if (hasMoreCards) loadMoreCards()
        else void loadMoreTasks()
      },
      {
        root: masonryScrollRef.current ?? null,
        rootMargin: "600px 0px",
      },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMoreCards, serverHasMore, loadMoreCards, loadMoreTasks])

  // 瀑布流列数跟随容器宽度（SSR 先按 2 列，挂载后立即修正）。
  // 容器随空状态条件卸载/重挂载，effect 必须跟着 hasCards 重跑，
  // 否则重挂载的新节点无人测量、旧 observer 盯着已移除节点，列数卡死
  const hasCards = flatCards.length > 0
  const masonryRef = React.useRef<HTMLDivElement | null>(null)
  const [columnCount, setColumnCount] = React.useState(2)
  React.useEffect(() => {
    if (!hasCards) return
    const el = masonryRef.current
    if (!el) return
    const compute = () => {
      const width = el.clientWidth
      if (width > 0) setColumnCount(columnsForWidth(width))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasCards])

  // 按索引轮询分列：卡片保持时间倒序，最新的横向排在第一行（只分已露出的卡片）
  const columnLists = React.useMemo(() => {
    const cols: GalleryCard[][] = Array.from({ length: columnCount }, () => [])
    visibleFlatCards.forEach((card, i) => cols[i % columnCount]!.push(card))
    return cols
  }, [visibleFlatCards, columnCount])

  // 放大查看器翻页序列：排除 PSD（浏览器无法渲染，卡片点击直接下载）
  const previewableCards = React.useMemo(
    () => flatCards.filter((c) => !isPsdUrl(c.url)),
    [flatCards],
  )

  const viewerCard = previewableCards.length
    ? previewableCards[
        Math.min(viewerIndex, previewableCards.length - 1)
      ]
    : undefined

  if (allItems.length === 0) {
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

  function handleDownload(url: string, idx: number, stamp: number) {
    // 统一下载器：代理 XHR + 进度 toast + 失败自动重试（与创作页/查看器一致）
    void downloadImageFile(url, `hanxing-${stamp}-${idx}`)
  }

  /** 多选：单击卡片切换选中（批量模式下点击不再打开查看器） */
  function toggleSelected(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 全选/取消已加载的全部卡片（仅当前已渲染批次，滚动可继续加载） */
  function toggleSelectAllVisible() {
    setSelectedKeys((prev) => {
      const allSelected = visibleFlatCards.every((c) => prev.has(c.key))
      if (allSelected) return new Set()
      return new Set(visibleFlatCards.map((c) => c.key))
    })
  }

  /** 批量下载所选：顺序走统一下载器（静默），单个 loading toast + 汇总 */
  async function handleBatchDownload(stamp: number) {
    const targets = flatCards.filter((c) => selectedKeys.has(c.key))
    if (targets.length === 0 || batchDownloading) return
    setBatchDownloading(true)
    const toastId = toast.loading(`正在下载 ${targets.length} 张图片…`)
    let ok = 0
    for (let i = 0; i < targets.length; i++) {
      try {
        await downloadImageFile(targets[i].url, `hanxing-${stamp}-${i + 1}`, {
          silent: true,
        })
        ok++
      } catch {
        // 单张失败继续其余，结束后汇总提示
      }
    }
    setBatchDownloading(false)
    if (ok === targets.length) {
      toast.success(`已下载全部 ${ok} 张`, { id: toastId })
    } else {
      toast.error(`已下载 ${ok}/${targets.length} 张，请重试失败项`, {
        id: toastId,
      })
    }
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
        {/* 批量选择（P1-2：多选 + 浮动操作栏批量下载） */}
        <Button
          variant={selectMode ? "default" : "outline"}
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            setSelectMode((v) => !v)
            setSelectedKeys(new Set())
          }}
        >
          <CheckSquare className="size-3.5" />
          {selectMode ? "取消选择" : "批量选择"}
        </Button>
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
        <div ref={masonryScrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div ref={masonryRef} className="flex items-start gap-3">
          {columnLists.map((column, colIdx) => (
            <div
              key={colIdx}
              className="flex min-w-0 flex-1 flex-col gap-3"
            >
              {column.map((card) => {
                const isPinned = Boolean(pinnedMap[card.item.taskId])
                const pop = popCount[card.item.taskId] ?? 0
                // PSD 源文件无法预览：卡片显示文件占位，点击直接下载
                const psd = isPsdUrl(card.url)
                const selected = selectMode && selectedKeys.has(card.key)
                return (
                  <div
                    key={card.key}
                    className={cn(
                      "group relative overflow-hidden rounded-lg border bg-card",
                      psd ? "cursor-pointer" : "cursor-zoom-in",
                      selectMode && "cursor-pointer",
                      selected && "ring-2 ring-primary",
                    )}
                    onClick={() => {
                      // 批量选择模式：点击切换选中，不打开查看器
                      if (selectMode) {
                        toggleSelected(card.key)
                        return
                      }
                      if (psd) {
                        downloadImageFile(
                          card.url,
                          `hanxing-${Date.now()}-${card.flatIndex}`,
                        )
                        return
                      }
                      setViewerIndex(previewableCards.indexOf(card))
                      setViewerOpen(true)
                    }}
                  >
                    {psd ? (
                      <div className="aspect-square w-full bg-muted/40">
                        <PsdPlaceholder iconClassName="size-10" />
                      </div>
                    ) : (
                      /* COS 直连（toImageSrc 带缩略参数），不经应用服务器中转；
                          过期对象由 SmartImage 显示占位 */
                      <CardImage
                        src={toImageSrc(card.url, { width: 480 })}
                        alt={card.item.prompt.slice(0, 50)}
                      />
                    )}
                    {/* 批量选择模式：左上角常显选中圈 */}
                    {selectMode && (
                      <div
                        className={cn(
                          "absolute left-2 top-2 z-10 flex size-5 items-center justify-center rounded-full border-2 shadow-sm",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-white/80 bg-black/40",
                        )}
                        aria-hidden
                      >
                        {selected ? <Check className="size-3" /> : null}
                      </div>
                    )}
                    {/* 触屏设备（无 hover）常显操作层，保证下载/收藏可达 */}
                    <div className="absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/80 via-transparent to-black/40 p-2 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
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
          {/* 渐进渲染/分页哨兵：滚到底部先露下一批已加载卡片，
              露完且服务端还有更多任务时拉下一页（P1-2） */}
          {(hasMoreCards || serverHasMore) && (
            <div ref={sentinelRef} className="py-6 text-center text-xs text-muted-foreground">
              {loadingMoreTasks ? "正在加载更多…" : "加载更多…"}
            </div>
          )}
        </div>
      )}

      {/* 批量选择浮动操作栏（选中 > 0 时出现，底部居中悬浮） */}
      {selectMode && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-full border bg-background/95 py-1.5 pl-4 pr-2 shadow-lg backdrop-blur">
            <span className="text-sm tabular-nums">
              已选 {selectedKeys.size} 张
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={visibleFlatCards.length === 0}
              onClick={toggleSelectAllVisible}
            >
              {visibleFlatCards.every((c) => selectedKeys.has(c.key))
                ? "取消全选"
                : "全选已载"}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={selectedKeys.size === 0 || batchDownloading}
              onClick={() => void handleBatchDownload(Date.now())}
            >
              {batchDownloading ? (
                <MorphingInfinity className="size-3.5" />
              ) : (
                <Download className="size-3.5" />
              )}
              {batchDownloading ? "下载中…" : "下载所选"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => {
                setSelectMode(false)
                setSelectedKeys(new Set())
              }}
            >
              退出
            </Button>
          </div>
        </div>
      )}

      <ImageViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        images={previewableCards.map((c) => c.url)}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        info={
          viewerCard
            ? {
                model: viewerCard.item.modelDisplayName,
                prompt: viewerCard.item.prompt,
                createdAt: viewerCard.item.createdAt,
                durationMs: viewerCard.item.durationMs ?? undefined,
              }
            : undefined
        }
      />
    </div>
  )
}
