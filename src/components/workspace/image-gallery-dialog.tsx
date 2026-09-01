"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Search,
  Upload,
  X,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { Spinner } from "@/components/workspace/spinner"
import { cn, toImageSrc } from "@/lib/utils"
import { toast } from "sonner"
import { uploadReferenceImages } from "@/lib/workspace/upload"
import {
  getGalleryModeLabel,
  getGalleryModeOptions,
  getInitialGalleryMode,
  getReferenceImageLimit,
  normalizeReferenceImages,
  shouldShowReferenceFooter,
  type GalleryMode,
} from "@/lib/workspace/helpers"
import {
  addUploadedCardImageAction,
  getCardImagesAction,
  selectCardImageAction,
  updateCardReferenceImagesAction,
} from "@/server/actions/workspace"
import type { CardImageRow, ImageModelRow } from "@/lib/workspace/types"

const PAGE_SIZE = 15

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  cardId: string | null
  selectedImageModel: ImageModelRow | null
  initialMode?: GalleryMode
  onImageSelected: (image: CardImageRow) => void
  onReferenceImagesChanged?: (images: string[]) => void
}

export function ImageGalleryDialog({
  open,
  onOpenChange,
  cardId,
  selectedImageModel,
  initialMode = "selected",
  onImageSelected,
  onReferenceImagesChanged,
}: Props) {
  const [images, setImages] = useState<CardImageRow[]>([])
  const [referenceImages, setReferenceImages] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [selecting, setSelecting] = useState<string | null>(null)
  const [mode, setMode] = useState<GalleryMode>("selected")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const referenceLimit = getReferenceImageLimit(selectedImageModel)

  const fetchImages = useCallback(async () => {
    if (!cardId) return
    setLoading(true)
    try {
      const data = await getCardImagesAction(cardId)
      setImages(data.images || [])
      const saved = normalizeReferenceImages(data.referenceImages)
      setReferenceImages(saved)
      onReferenceImagesChanged?.(saved)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "获取图片列表失败",
      )
    } finally {
      setLoading(false)
    }
    // onReferenceImagesChanged 为父组件「通知」回调（非 memoized），故意不纳入依赖，
    // 否则每次渲染都会改变 fetchImages 进而触发 effect 重取。此处仅透传最新值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId])

  useEffect(() => {
    if (open && cardId) {
      setMode(getInitialGalleryMode(initialMode, referenceLimit))
      void fetchImages()
    }
     
  }, [open, cardId, initialMode, referenceLimit, fetchImages])

  useEffect(() => {
    setPage(1)
  }, [search, mode, open])

  useEffect(() => {
    if (referenceLimit === 0 && mode === "reference") setMode("selected")
  }, [mode, referenceLimit])

  const completedImages = useMemo(
    () =>
      images.filter(
        (image) => image.status === "completed" && image.imageUrl,
      ),
    [images],
  )
  const filteredImages = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return completedImages
    return completedImages.filter(
      (image) =>
        image.generationPrompt?.toLowerCase().includes(keyword) ||
        image.modelName?.toLowerCase().includes(keyword),
    )
  }, [completedImages, search])
  const totalPages = Math.max(1, Math.ceil(filteredImages.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageImages = filteredImages.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  )
  const modeOptions = useMemo(
    () => getGalleryModeOptions(referenceLimit),
    [referenceLimit],
  )
  const showReferenceFooter = shouldShowReferenceFooter(referenceLimit)
  const busy = uploading || selecting !== null

  const handleSelect = async (image: CardImageRow) => {
    if (image.isSelected) return
    setSelecting(image.id)
    try {
      const res = await selectCardImageAction(image.id)
      if (!res.ok) throw new Error(res.error || "选定图片失败")
      setImages((previous) =>
        previous.map((item) => ({
          ...item,
          isSelected: item.id === image.id,
        })),
      )
      onImageSelected(image)
      toast.success("已设为选中图片")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "选定图片失败")
    } finally {
      setSelecting(null)
    }
  }

  const saveReferenceImages = async (
    nextImages: string[],
  ): Promise<boolean> => {
    if (!selectedImageModel || referenceLimit === 0) {
      toast.error("当前模型不支持参考图")
      return false
    }
    if (!cardId) return false
    const normalized = normalizeReferenceImages(nextImages)
    if (normalized.length > referenceLimit) {
      toast.error(`当前模型最多支持 ${referenceLimit} 张参考图`)
      return false
    }
    setSelecting("__reference_save__")
    try {
      const res = await updateCardReferenceImagesAction(cardId, {
        apiId: selectedImageModel.id,
        referenceImages: normalized,
      })
      if (!res.ok) throw new Error(res.error || "保存参考图失败")
      const saved = normalizeReferenceImages(res.referenceImages)
      setReferenceImages(saved)
      onReferenceImagesChanged?.(saved)
      return true
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "保存参考图失败",
      )
      return false
    } finally {
      setSelecting(null)
    }
  }

  const handleReferenceSelect = (image: CardImageRow) => {
    const selected = referenceImages.includes(image.imageUrl)
    void saveReferenceImages(
      selected
        ? referenceImages.filter((url) => url !== image.imageUrl)
        : [...referenceImages, image.imageUrl],
    )
  }

  const handleClearReferenceImages = async () => {
    if (!referenceImages.length) return
    if (await saveReferenceImages([])) toast.success("已清除参考图片")
  }

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ""
    if (!files.length || !cardId) return
    setUploading(true)
    try {
      const uploaded = await uploadReferenceImages(files)
      if (!uploaded.length) {
        throw new Error("没有可上传的图片")
      }
      for (const item of uploaded) {
        const res = await addUploadedCardImageAction(cardId, {
          imageUrl: item.url,
        })
        if (!res.ok) throw new Error(res.error || "保存上传图片失败")
      }
      if (mode === "reference" && selectedImageModel) {
        const newUrls = uploaded.map((u) => u.url)
        const res = await updateCardReferenceImagesAction(cardId, {
          apiId: selectedImageModel.id,
          referenceImages: [...referenceImages, ...newUrls],
        })
        if (!res.ok) throw new Error(res.error || "更新参考图失败")
        const saved = normalizeReferenceImages(res.referenceImages)
        setReferenceImages(saved)
        onReferenceImagesChanged?.(saved)
      }
      await fetchImages()
      toast.success(`已上传 ${uploaded.length} 张图片`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片上传失败")
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && busy) return
        onOpenChange(v)
      }}
    >
      <DialogContent
        className="flex h-[min(52vh,492px)] w-[min(90vw,768px)] max-w-none flex-col gap-2 overflow-hidden sm:max-w-[min(90vw,768px)]"
        showCloseButton={!busy}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>
            图片库{" "}
            <span className="text-muted-foreground">
              ({completedImages.length} 张)
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索提示词或模型名称"
                className="pl-9"
              />
            </div>
            <Select
              value={mode}
              onValueChange={(v) => {
                if (v === "selected" || v === "reference") setMode(v)
              }}
            >
              <SelectTrigger className="w-28">
                <SelectValue>{getGalleryModeLabel(mode)}</SelectValue>
              </SelectTrigger>
              <SelectContent
                side="bottom"
                sideOffset={6}
                align="start"
                alignItemWithTrigger={false}
              >
                {modeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => inputRef.current?.click()}
              disabled={uploading || !cardId}
            >
              {uploading ? (
                <MorphingInfinity className="h-4 w-4" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              上传图片
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={handleUpload}
            />
          </div>
          {loading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : pageImages.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <ImageIcon className="h-8 w-8 opacity-40" />
              <span>
                {search ? "未找到匹配的图片" : "暂无已完成的图片"}
              </span>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="grid grid-cols-5 gap-4">
                {pageImages.map((image) => {
                  const isReference = referenceImages.includes(
                    image.imageUrl,
                  )
                  const isSelected =
                    mode === "reference" ? isReference : image.isSelected
                  const disabled =
                    mode === "reference" &&
                    !isReference &&
                    referenceImages.length >= referenceLimit
                  return (
                    <button
                      key={image.id}
                      type="button"
                      disabled={disabled || selecting !== null}
                      onClick={() =>
                        mode === "reference"
                          ? handleReferenceSelect(image)
                          : void handleSelect(image)
                      }
                      className={cn(
                        "group relative aspect-square overflow-hidden rounded-md border-2 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45",
                        mode === "reference"
                          ? isSelected
                            ? "border-violet-600 ring-2 ring-violet-500/30"
                            : "border-transparent hover:border-violet-400/60"
                          : isSelected
                            ? "border-primary ring-2 ring-primary/30"
                            : "border-transparent hover:border-primary/50",
                      )}
                    >
                      {/* 远程动态图片，经存储代理加载；沿用 <img> */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={toImageSrc(image.imageUrl, {
                          width: 360,
                          height: 360,
                        })}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                      {isSelected && (
                        <span
                          className={cn(
                            "absolute right-2 top-2 rounded-full p-1 text-white",
                            mode === "reference"
                              ? "bg-violet-600"
                              : "bg-primary",
                          )}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </span>
                      )}
                      {selecting === image.id && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/40">
                          <MorphingInfinity className="h-6 w-6 text-white" />
                        </span>
                      )}
                      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-7 text-[10px] text-white/85">
                        {image.source === "uploaded"
                          ? "上传图片"
                          : image.size || "未知尺寸"}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        {(showReferenceFooter || totalPages > 1) && (
          <DialogFooter className="flex-col sm:flex-row sm:justify-between">
            {showReferenceFooter ? (
              <div className="flex items-center gap-2">
                <span className="flex h-7 items-center rounded-md bg-violet-100 px-2.5 text-xs font-medium text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
                  {referenceImages.length}/{referenceLimit} 参考图
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  disabled={!referenceImages.length || selecting !== null}
                  onClick={() => void handleClearReferenceImages()}
                >
                  <X className="h-3.5 w-3.5" />
                  清除参考图片
                </Button>
              </div>
            ) : (
              <span />
            )}
            {totalPages > 1 && (
              <nav
                aria-label="图片库分页"
                className="flex flex-wrap items-center justify-center gap-1.5"
              >
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="上一页"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((current) => current - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {Array.from(
                  { length: totalPages },
                  (_, index) => index + 1,
                ).map((pageNumber) => (
                  <Button
                    key={pageNumber}
                    variant={
                      pageNumber === currentPage ? "default" : "outline"
                    }
                    size="sm"
                    className="h-8 min-w-8 px-2"
                    aria-current={
                      pageNumber === currentPage ? "page" : undefined
                    }
                    onClick={() => setPage(pageNumber)}
                  >
                    {pageNumber}
                  </Button>
                ))}
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="下一页"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </nav>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
