"use client"

import * as React from "react"
import { Check, ListChecks, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SmartImage } from "@/components/ui/smart-image"
import { UploadButton } from "@/components/ui/button-upload"
import { HistoryDateRangePicker } from "@/components/product-v2/history-date-range-picker"
import { uploadImage } from "@/lib/upload/upload-image"
import {
  addMockupDesignAssetAction,
  listGeneratedAssetsAction,
  prewarmMockupAssetsAction,
} from "@/server/actions/mockup"
import type { MockupLibraryImage } from "@/lib/mockup/types"
import type { DateRange } from "react-day-picker"
import { cn, randomId, toImageSrc } from "@/lib/utils"

/** 多选上限与服务端单批次任务上限一致 */
const MAX_SELECT = 100
/** 悬停预览面板宽度（px）：贴弹窗右侧展示，空间不足时回退弹窗内右缘 */
const PREVIEW_W = 320

/**
 * 图片库弹窗
 *
 * 单选模式（图层替换固定图，无 onSelectMany/multiple）：点击图片即选中并关闭。
 * 批量能力（multiple=true 或提供 onSelectMany）：以浏览态打开，点击任一图片
 * 即激活批量选择并勾选该图；勾选模式下单击勾选（序号即轮换顺序）、拖动
 * 框选多张、全选/清空（不可用时置灰）、「确认」按勾选顺序返回。
 *
 * 工具栏：批量选择 / 日期范围（两个 Tab 按上传·生成时间过滤）/
 * 上传（带进度动画；支持一次多选文件，勾选模式下成功后自动按顺序追加勾选）。
 * 缩略图悬停在弹窗左侧浮出完整比例预览（仅图片）。上传成功后均后台
 * 预导入外部素材（失败静默，提交路径有懒导入兜底）。
 */

interface ImageLibraryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 我的上传（父级持有，上传成功后回传追加） */
  assets: MockupLibraryImage[]
  onUploaded: (image: MockupLibraryImage) => void
  /** 单选模式：点击图片回调（批量模式下不触发） */
  onSelect: (imageUrl: string) => void
  /** 初始即批量选择模式（批量替换素材图片入口） */
  multiple?: boolean
  /** 批量模式初始勾选（url 列表，顺序即轮换顺序） */
  selectedUrls?: string[]
  /** 批量确认回调（按勾选顺序）；提供后才显示「批量选择」按钮 */
  onSelectMany?: (images: MockupLibraryImage[]) => void
  /** 多选上限（默认 50） */
  maxSelect?: number
}

export function ImageLibraryDialog({
  open,
  onOpenChange,
  assets,
  onUploaded,
  onSelect,
  multiple = false,
  selectedUrls,
  onSelectMany,
  maxSelect = MAX_SELECT,
}: ImageLibraryDialogProps) {
  const [tab, setTab] = React.useState<"upload" | "generated">("upload")
  const [generated, setGenerated] = React.useState<MockupLibraryImage[]>([])
  const [generatedLoading, setGeneratedLoading] = React.useState(false)
  /** 批量选择模式（multiple=true 时打开即为 true） */
  const [batchMode, setBatchMode] = React.useState(false)
  /** 多选：已勾选 url（顺序即轮换顺序） */
  const [selection, setSelection] = React.useState<string[]>([])
  /** 日期范围筛选（两个 Tab 共用） */
  const [dateRange, setDateRange] = React.useState<DateRange | undefined>(undefined)
  /** 悬停预览：图片信息 + 面板定位（贴弹窗右侧，空间不足回退内缘） */
  const [hoverPreview, setHoverPreview] = React.useState<{
    url: string
    name: string | null
    style: React.CSSProperties
  } | null>(null)
  /** 上传动画状态机：idle → uploading（真实进度）→ done（短暂停留）→ idle */
  const [uploadPhase, setUploadPhase] = React.useState<"idle" | "uploading" | "done">("idle")
  const [uploadPct, setUploadPct] = React.useState(0)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (open) {
      setSelection(selectedUrls ?? [])
      // 统一以浏览态打开：批量场景需点「批量选择」进入勾选（浏览态点击不生效）
      setBatchMode(false)
    }
    // 仅在打开时播种，避免父级渲染重置会话中的状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const loadGenerated = React.useCallback(async () => {
    setGeneratedLoading(true)
    try {
      const res = await listGeneratedAssetsAction(200)
      setGenerated(res.images)
    } catch {
      toast.error("生成图加载失败")
    } finally {
      setGeneratedLoading(false)
    }
  }, [])

  // 打开弹窗或切到「生成图资产」Tab 时自动重拉（5s 节流防频繁切换抖动）：
  // 若只在列表为空时加载，渲染出新图后重开弹窗看到的仍是旧列表
  const generatedLoadedAtRef = React.useRef(0)
  React.useEffect(() => {
    if (!open || tab !== "generated" || generatedLoading) return
    if (Date.now() - generatedLoadedAtRef.current < 5_000) return
    generatedLoadedAtRef.current = Date.now()
    void loadGenerated()
  }, [open, tab, generatedLoading, loadGenerated])

  /** 上传成功后后台预导入外部素材（fire-and-forget，失败静默） */
  const prewarm = (url: string) => {
    void prewarmMockupAssetsAction({ imageUrls: [url] }).catch(() => {})
  }

  /** 上传完成：短暂展示「已上传」后回落 idle */
  const finishUpload = () => {
    setUploadPhase("done")
    window.setTimeout(() => {
      setUploadPhase("idle")
      setUploadPct(0)
    }, 1200)
  }

  const handleUpload = async (file: File | undefined) => {
    if (!file) return
    setUploadPhase("uploading")
    setUploadPct(0)
    try {
      const url = await uploadImage(file)
      setUploadPct(100)
      const res = await addMockupDesignAssetAction({
        imageUrl: url,
        fileName: file.name,
      })
      if (!res.ok) {
        toast.error(res.error ?? "入库失败")
        return
      }
      const image: MockupLibraryImage = {
        id: randomId(),
        imageUrl: url,
        fileName: file.name,
        createdAt: new Date().toISOString(),
      }
      onUploaded(image)
      prewarm(url)
      setTab("upload")
      toast.success("上传成功")
      finishUpload()
    } catch (err) {
      setUploadPhase("idle")
      setUploadPct(0)
      toast.error(err instanceof Error ? err.message : "上传失败")
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  /** 多图上传（并发）：勾选模式按顺序追加勾选；普通模式仅入库追加「我的上传」 */
  const handleUploadMany = async (files: File[]) => {
    const images = files.filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type))
    if (images.length === 0) {
      toast.error("所选内容中没有图片文件（支持 jpg/png/webp）")
      return
    }
    // 批量勾选模式受多选上限余量截取；普通模式全量上传
    const room = batchMode ? maxSelect - selection.length : images.length
    if (room <= 0) {
      toast.warning(`最多选择 ${maxSelect} 张`)
      return
    }
    const batch = images.slice(0, room)
    if (images.length > room) {
      toast.warning(`最多 ${room} 张，已截取前 ${room} 张`)
    }
    setUploadPhase("uploading")
    setUploadPct(0)
    const uploaded: Array<MockupLibraryImage | undefined> = new Array(batch.length)
    let fail = 0
    await Promise.all(
      batch.map(async (file, i) => {
        try {
          const url = await uploadImage(file)
          const res = await addMockupDesignAssetAction({ imageUrl: url, fileName: file.name })
          if (!res.ok) throw new Error(res.error ?? "入库失败")
          const image: MockupLibraryImage = {
            id: randomId(),
            imageUrl: url,
            fileName: file.name,
            createdAt: new Date().toISOString(),
          }
          uploaded[i] = image
          onUploaded(image)
          prewarm(url)
        } catch (err) {
          fail++
          toast.error(`${file.name}：${err instanceof Error ? err.message : "上传失败"}`)
        } finally {
          const doneCount = uploaded.filter((m) => m != null).length + fail
          setUploadPct(Math.round((doneCount / batch.length) * 100))
        }
      }),
    )
    const ok = uploaded.filter((m): m is MockupLibraryImage => m != null)
    if (ok.length > 0) {
      // 勾选模式按上传顺序追加勾选；普通模式不动勾选状态
      if (batchMode) {
        setSelection((prev) => [...prev, ...ok.map((m) => m.imageUrl)])
      }
      setTab("upload")
      toast.success(`上传成功 ${ok.length} 张${fail > 0 ? `，失败 ${fail} 张` : ""}`)
      finishUpload()
    } else {
      setUploadPhase("idle")
      setUploadPct(0)
    }
  }

  const handleSelect = (imageUrl: string) => {
    onSelect(imageUrl)
    onOpenChange(false)
  }

  const toggleSelect = (imageUrl: string) => {
    setSelection((prev) => {
      const idx = prev.indexOf(imageUrl)
      if (idx >= 0) {
        const next = [...prev]
        next.splice(idx, 1)
        return next
      }
      if (prev.length >= maxSelect) {
        toast.warning(`最多选择 ${maxSelect} 张`)
        return prev
      }
      return [...prev, imageUrl]
    })
  }

  const selectAllVisible = (visible: MockupLibraryImage[]) => {
    setSelection((prev) => {
      const next = [...prev]
      let skipped = 0
      for (const img of visible) {
        if (next.includes(img.imageUrl)) continue
        if (next.length >= maxSelect) {
          skipped++
          continue
        }
        next.push(img.imageUrl)
      }
      if (skipped > 0) toast.warning(`已达上限 ${maxSelect} 张，${skipped} 张未勾选`)
      return next
    })
  }

  /* ── 批量模式拖动框选（marquee）── */
  const gridRef = React.useRef<HTMLDivElement>(null)
  const tileEls = React.useRef(new Map<string, HTMLElement>())
  const marqueeStartRef = React.useRef<{ x: number; y: number } | null>(null)
  const dragMovedRef = React.useRef(false)
  const marqueeUrlsRef = React.useRef<Set<string>>(new Set())
  const [marquee, setMarquee] = React.useState<{
    x1: number
    y1: number
    x2: number
    y2: number
  } | null>(null)
  const [marqueeUrls, setMarqueeUrls] = React.useState<Set<string>>(new Set())

  /** 与选框相交的缩略图 url 集合（以视口坐标判定） */
  const computeMarqueeHits = (m: {
    x1: number
    y1: number
    x2: number
    y2: number
  }): Set<string> => {
    const grid = gridRef.current
    if (!grid) return new Set()
    const rect = grid.getBoundingClientRect()
    const left = Math.min(m.x1, m.x2) + rect.left
    const top = Math.min(m.y1, m.y2) + rect.top
    const right = Math.max(m.x1, m.x2) + rect.left
    const bottom = Math.max(m.y1, m.y2) + rect.top
    const hits = new Set<string>()
    for (const [url, el] of tileEls.current) {
      const r = el.getBoundingClientRect()
      if (r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom) {
        hits.add(url)
      }
    }
    return hits
  }

  const startMarquee = (e: React.MouseEvent) => {
    if (!batchMode || e.button !== 0) return
    const grid = gridRef.current
    if (!grid) return
    const rect = grid.getBoundingClientRect()
    marqueeStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    dragMovedRef.current = false
    marqueeUrlsRef.current = new Set()
    setMarqueeUrls(new Set())
    setMarquee({
      x1: marqueeStartRef.current.x,
      y1: marqueeStartRef.current.y,
      x2: marqueeStartRef.current.x,
      y2: marqueeStartRef.current.y,
    })
  }

  const dragging = marquee != null
  React.useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const grid = gridRef.current
      const start = marqueeStartRef.current
      if (!grid || !start) return
      const rect = grid.getBoundingClientRect()
      const x2 = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
      const y2 = Math.max(0, Math.min(e.clientY - rect.top, rect.height))
      if (Math.abs(x2 - start.x) > 4 || Math.abs(y2 - start.y) > 4) {
        dragMovedRef.current = true
      }
      const next = { x1: start.x, y1: start.y, x2, y2 }
      setMarquee(next)
      const hits = computeMarqueeHits(next)
      marqueeUrlsRef.current = hits
      setMarqueeUrls(hits)
    }
    const onUp = () => {
      const hits = marqueeUrlsRef.current
      if (hits.size > 0) {
        setSelection((prev) => {
          let skipped = 0
          const next = [...prev]
          for (const url of hits) {
            if (next.includes(url)) continue
            if (next.length >= maxSelect) {
              skipped++
              continue
            }
            next.push(url)
          }
          if (skipped > 0) toast.warning(`已达上限 ${maxSelect} 张，${skipped} 张未勾选`)
          return next
        })
      }
      marqueeStartRef.current = null
      marqueeUrlsRef.current = new Set()
      setMarquee(null)
      setMarqueeUrls(new Set())
      // mouseup 后浏览器还会派发 click：延迟复位拖拽标记以吞掉该次 click
      window.setTimeout(() => {
        dragMovedRef.current = false
      }, 0)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
  }, [dragging, maxSelect])

  /** 缩略图点击：批量模式=勾选；批量场景浏览态=激活批量选择并选上该图；单选场景选中即关 */
  const handleTileClick = (img: MockupLibraryImage) => {
    if (dragMovedRef.current) return
    if (batchMode) {
      toggleSelect(img.imageUrl)
      return
    }
    if (onSelectMany || multiple) {
      setBatchMode(true)
      toggleSelect(img.imageUrl)
      return
    }
    handleSelect(img.imageUrl)
  }

  const handleConfirmMany = () => {
    if (!onSelectMany) return
    const byUrl = new Map<string, MockupLibraryImage>()
    for (const m of [...assets, ...generated]) {
      if (!byUrl.has(m.imageUrl)) byUrl.set(m.imageUrl, m)
    }
    onSelectMany(
      selection.map(
        (url) => byUrl.get(url) ?? { id: url, imageUrl: url, fileName: null },
      ),
    )
    onOpenChange(false)
  }

  /** 日期范围过滤（to 含当天全天；无日期条目不隐藏） */
  const inDateRange = (img: MockupLibraryImage): boolean => {
    if (!dateRange?.from) return true
    if (!img.createdAt) return true
    const t = new Date(img.createdAt).getTime()
    const from = new Date(
      dateRange.from.getFullYear(),
      dateRange.from.getMonth(),
      dateRange.from.getDate(),
    ).getTime()
    const to = dateRange.to
      ? new Date(
          dateRange.to.getFullYear(),
          dateRange.to.getMonth(),
          dateRange.to.getDate(),
          23,
          59,
          59,
          999,
        ).getTime()
      : Number.POSITIVE_INFINITY
    return t >= from && t <= to
  }

  /** 悬停预览定位：优先弹窗左外侧，空间不足时回退弹窗内左缘 */
  const openPreview = (img: MockupLibraryImage) => {
    const vw = window.innerWidth
    // DialogContent 宽度 = min(1024, vw - 32)，居中
    const half = Math.min(1024, vw - 32) / 2
    const room = vw / 2 - half - 16
    const style: React.CSSProperties =
      room >= PREVIEW_W + 16
        ? { right: `calc(50% + ${half + 16}px)`, width: PREVIEW_W }
        : { left: `calc(50% - ${half}px + 8px)`, width: PREVIEW_W }
    setHoverPreview({ url: img.imageUrl, name: img.fileName, style })
  }

  const baseList = tab === "upload" ? assets : generated
  const list = baseList.filter(inDateRange)
  /** 是否支持批量选择（multiple 调用方或提供 onSelectMany） */
  const batchCapable = multiple || Boolean(onSelectMany)
  const hasAddable = list.some((img) => !selection.includes(img.imageUrl))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[1024px]">
        <DialogHeader>
          <DialogTitle>图片库</DialogTitle>
          <DialogDescription>
            {batchMode
              ? "勾选素材图片（序号即轮换顺序，支持拖动框选），或当场上传"
              : batchCapable
                ? "点击图片进入批量选择（可拖动框选多张），或当场上传"
                : "选择要替换的图片，或当场上传设计稿"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "upload" | "generated")}
          >
            <TabsList>
              <TabsTrigger value="upload">我的上传</TabsTrigger>
              <TabsTrigger value="generated">生成图资产</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-1.5">
            {tab === "generated" ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void loadGenerated()}
                disabled={generatedLoading}
              >
                <RefreshCw className="size-4" />
              </Button>
            ) : null}
            {batchCapable ? (
              <Button
                variant={batchMode ? "default" : "outline"}
                onClick={() => setBatchMode((v) => !v)}
              >
                <ListChecks className="size-3.5" />
                批量选择
              </Button>
            ) : null}
            <HistoryDateRangePicker value={dateRange} onChange={setDateRange} />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                if (files.length > 1) void handleUploadMany(files)
                else void handleUpload(files[0])
                if (fileInputRef.current) fileInputRef.current.value = ""
              }}
            />
            <UploadButton
              status={uploadPhase}
              progress={uploadPct}
              onClick={() => fileInputRef.current?.click()}
            />
          </div>
        </div>

        <div className="max-h-[50vh] overflow-y-auto scrollbar-hide">
          {tab === "generated" && generatedLoading ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
            </div>
          ) : baseList.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              {tab === "upload" ? "还没有上传过设计稿" : "暂无生成图"}
            </div>
          ) : list.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              该日期范围内没有图片
            </div>
          ) : (
            <div
              ref={gridRef}
              className={cn("relative select-none", batchMode && "cursor-crosshair")}
              onMouseDown={startMarquee}
              onDragStart={(e) => e.preventDefault()}
            >
              <div className="grid grid-cols-8 gap-2">
                {list.map((img) => {
                  const selIdx = batchMode ? selection.indexOf(img.imageUrl) : -1
                  const selected = selIdx >= 0
                  const marqueeHit = batchMode && marqueeUrls.has(img.imageUrl)
                  return (
                    <button
                      key={img.id}
                      type="button"
                      ref={(el) => {
                        if (el) tileEls.current.set(img.imageUrl, el)
                        else tileEls.current.delete(img.imageUrl)
                      }}
                      className={cn(
                        "group relative aspect-square overflow-hidden rounded-md border bg-muted transition hover:border-primary",
                        selected && "border-primary ring-1 ring-primary",
                        marqueeHit && "ring-2 ring-primary",
                      )}
                      title={img.fileName ?? ""}
                      onClick={() => handleTileClick(img)}
                      onMouseEnter={() => openPreview(img)}
                      onMouseLeave={() => setHoverPreview(null)}
                    >
                      <SmartImage
                        src={toImageSrc(img.imageUrl, { width: 200 })}
                        alt={img.fileName ?? "图片"}
                        className="size-full object-cover"
                      />
                      {selected ? (
                        <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
                          {selIdx + 1}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
              {marquee ? (
                <div
                  className="pointer-events-none absolute z-10 border border-primary bg-primary/10"
                  style={{
                    left: Math.min(marquee.x1, marquee.x2),
                    top: Math.min(marquee.y1, marquee.y2),
                    width: Math.abs(marquee.x2 - marquee.x1),
                    height: Math.abs(marquee.y2 - marquee.y1),
                  }}
                />
              ) : null}
            </div>
          )}
        </div>

        {batchMode && batchCapable ? (
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-1.5">
              <span className="mr-1 text-xs text-muted-foreground">
                已选 {selection.length}/{maxSelect} 张（序号即轮换顺序）
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!hasAddable}
                onClick={() => selectAllVisible(list)}
              >
                全选
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={selection.length === 0}
                onClick={() => setSelection([])}
              >
                清空
              </Button>
            </div>
            <Button
              size="sm"
              disabled={selection.length === 0}
              onClick={handleConfirmMany}
            >
              <Check className="size-4" />
              确认{selection.length > 0 ? `（${selection.length} 张）` : ""}
            </Button>
          </div>
        ) : null}
      </DialogContent>

      {/* 悬停预览：Portal 兄弟节点避免被 DialogContent 裁剪（优先弹窗左侧，只显示图片） */}
      <DialogPortal>
        {hoverPreview ? (
          <div
            className="pointer-events-none fixed top-1/2 z-50 -translate-y-1/2"
            style={hoverPreview.style}
          >
            <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10 shadow-xl">
              <SmartImage
                src={toImageSrc(hoverPreview.url, { width: 640 })}
                alt={hoverPreview.name ?? "预览"}
                className="max-h-[60vh] w-full object-contain"
              />
            </div>
          </div>
        ) : null}
      </DialogPortal>
    </Dialog>
  )
}
