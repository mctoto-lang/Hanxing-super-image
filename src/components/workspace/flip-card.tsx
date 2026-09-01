"use client"

import { memo, useEffect, useRef, useState } from "react"
import {
  AlertCircle,
  Check,
  ChevronLeft,
  GalleryHorizontalEnd,
  ImagePlus,
  Images,
  Languages,
  MoreHorizontal,
  RefreshCw,
  RotateCw,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  ZoomIn,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ImageViewer } from "@/components/ui/image-viewer"
import { BeamWrapper } from "@/components/create/beam-wrapper"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ImageGalleryDialog } from "@/components/workspace/image-gallery-dialog"
import { cn, toImageSrc } from "@/lib/utils"
import { SmartImage } from "@/components/ui/smart-image"
import { toast } from "sonner"
import { uploadReferenceImages } from "@/lib/workspace/upload"
import {
  getGenerationPrompt,
  getReferenceImageLimit,
  getTranslationStatus,
  normalizeReferenceImages,
  resolveCardDisplayImage,
  shouldAutoFlipToImage,
} from "@/lib/workspace/helpers"
import {
  addUploadedCardImageAction,
  deepenCardPromptAction,
  deleteCardAction,
  generateCardImageAction,
  regenerateCardImageAction,
  regenerateCardPromptAction,
  translateCardPromptAction,
  updateCardAction,
  updateCardReferenceImagesAction,
} from "@/server/actions/workspace"
import type {
  CardImageRow,
  ImageModelRow,
  PromptCardRow,
  TemplateRow,
} from "@/lib/workspace/types"

interface FlipCardProps {
  card: PromptCardRow
  images: CardImageRow[]
  batchMode: boolean
  isSelected: boolean
  flipAllToImage: boolean
  selectedDeepenTemplate: TemplateRow | null
  selectedRegenTemplate: TemplateRow | null
  selectedTranslateTemplate: TemplateRow | null
  selectedImageModel: ImageModelRow | null
  selectedSize: string | null
  onToggleSelect: (cardId: string) => void
  onCardUpdated: (card: PromptCardRow) => void
  onCardDeleted?: (cardId: string) => void
  onCardGeneratingImage?: (cardId: string, generating: boolean) => void
  batchDeepening?: boolean
  batchRegenerating?: boolean
  batchGeneratingImage?: boolean
  batchTranslating?: boolean
}

// 提示词面顶部迷你控件：与自由创作页任务卡片按钮同语言（主题 token，亮/暗色自适应）
const TOPBAR_MINI_BUTTON_CLASS =
  "flex h-6 w-6 items-center justify-center rounded-sm border border-border/60 bg-card/80 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
const REFERENCE_IMAGE_INDICATOR_IMAGE_CLASS =
  "flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-black/35 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/55"
const REFERENCE_IMAGE_INDICATOR_PROMPT_CLASS =
  "flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm border border-violet-600 bg-transparent text-violet-600 transition-colors hover:bg-violet-500/10 dark:border-violet-400 dark:text-violet-400"

export const FlipCard = memo(function FlipCard({
  card,
  images,
  batchMode,
  isSelected,
  flipAllToImage,
  selectedDeepenTemplate,
  selectedRegenTemplate,
  selectedTranslateTemplate,
  selectedImageModel,
  selectedSize,
  onToggleSelect,
  onCardUpdated,
  onCardDeleted,
  onCardGeneratingImage,
  batchDeepening = false,
  batchRegenerating = false,
  batchGeneratingImage = false,
  batchTranslating = false,
}: FlipCardProps) {
  // 初始翻面状态：有可展示图片（含未显式选中的已完成图，刷新/切换任务后
  // 仍默认图片面）则图片面，否则提示词面；生成中的卡片由生成开始效果统一翻面
  const displayImage = resolveCardDisplayImage(card, images)
  const initialHasImage = Boolean(card.selImgUrl || displayImage?.imageUrl)
  const [isFlipped, setIsFlipped] = useState(!initialHasImage)
  const [prompt, setPrompt] = useState(card.prompt)
  const [displayLanguage, setDisplayLanguage] = useState<"zh" | "en">(
    card.displayLanguage === "en" && card.translatedPrompt ? "en" : "zh",
  )
  const [generatingImage, setGeneratingImage] = useState(false)
  const [deepening, setDeepening] = useState(false)
  const [regeneratingPrompt, setRegeneratingPrompt] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [showGallery, setShowGallery] = useState(false)
  const [galleryInitialMode, setGalleryInitialMode] = useState<
    "selected" | "reference"
  >("selected")
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerIndex, setViewerIndex] = useState(0)
  const [refViewerOpen, setRefViewerOpen] = useState(false)
  const [refViewerIndex, setRefViewerIndex] = useState(0)
  const [errorDialogOpen, setErrorDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [uploadingRefImages, setUploadingRefImages] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const [previousPrompt, setPreviousPrompt] = useState<string | null>(null)
  const [referenceImages, setReferenceImages] = useState(() =>
    normalizeReferenceImages(card.referenceImages),
  )

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cardRef = useRef(card)
  const onCardUpdatedRef = useRef(onCardUpdated)
  const previousDisplayImageUrlRef = useRef<string | null>(null)
  const isEditingPromptRef = useRef(false)
  const manuallyFlippedToBackRef = useRef(!initialHasImage)

  const completedImages = images.filter((i) => i.status === "completed")
  const completedImageUrls = completedImages.map((i) => i.imageUrl)
  // 已生成计数不含用户上传图（source=uploaded 仅入图片库，不算生成结果）
  const generatedImageCount = completedImages.filter(
    (i) => i.source !== "uploaded",
  ).length
  const failedImages = images.filter((i) => i.status === "failed")
  const pendingImageCount = images.filter(
    (i) => i.status === "pending" || i.status === "generating",
  ).length
  // 展示图 = selImgUrl（选中图 JOIN）→ selectedImageId/isSelected/最新已完成
  // 的三级回退（resolveCardDisplayImage），与导出下载取图保持一致
  const displayImageUrl = card.selImgUrl || displayImage?.imageUrl || null
  const failedImageCount = failedImages.length
  const failedImageTooltip =
    failedImageCount > 0
      ? `${failedImageCount}张图片生成失败${failedImages[0]?.errorMessage ? `：${failedImages[0].errorMessage}` : ""}`
      : "生图失败"
  const referenceImageCount = referenceImages.length
  const referenceImageIndicator =
    referenceImageCount > 0
      ? {
          count: referenceImageCount,
          label: `此卡片带有 ${referenceImageCount} 张参考图片`,
        }
      : null

  useEffect(() => {
    cardRef.current = card
  }, [card])

  useEffect(() => {
    onCardUpdatedRef.current = onCardUpdated
  }, [onCardUpdated])

  useEffect(() => {
    setReferenceImages(normalizeReferenceImages(card.referenceImages))
  }, [card.referenceImages])

  useEffect(() => {
    // 用户正在编辑时不重置本地 prompt，避免轮询打断输入
    if (isEditingPromptRef.current) return
    setPrompt(card.prompt)
  }, [card.prompt])

  useEffect(() => {
    if (!card.translatedPrompt && displayLanguage === "en")
      setDisplayLanguage("zh")
  }, [card.translatedPrompt, displayLanguage])

  // 全部翻面指令：边沿触发（false→true 跳变时执行一次）。电平触发会在
  // flipAllToImage 悬置为 true 期间持续把卡片弹回图片面，导致手动翻面失效
  const prevFlipAllToImageRef = useRef(flipAllToImage)
  useEffect(() => {
    const activated = flipAllToImage && !prevFlipAllToImageRef.current
    prevFlipAllToImageRef.current = flipAllToImage
    if (activated && displayImageUrl && isFlipped) {
      manuallyFlippedToBackRef.current = false
      setIsFlipped(false)
    }
  }, [flipAllToImage, displayImageUrl, isFlipped])

  useEffect(() => {
    const previousDisplayImageUrl = previousDisplayImageUrlRef.current
    previousDisplayImageUrlRef.current = displayImageUrl

    if (
      shouldAutoFlipToImage({
        hasImage: !!displayImageUrl,
        previousImageUrl: previousDisplayImageUrl,
        currentImageUrl: displayImageUrl,
        isEditingPrompt: isEditingPromptRef.current,
        manuallyFlippedToBack: manuallyFlippedToBackRef.current,
      })
    ) {
      manuallyFlippedToBackRef.current = false
      setIsFlipped(false)
    }
  }, [displayImageUrl])

  // 提交生图后，pending 图片出现时清除本地 submitting 标记
  useEffect(() => {
    if (pendingImageCount > 0 && generatingImage) {
      setGeneratingImage(false)
    }
  }, [pendingImageCount, generatingImage])

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    }
  }, [])

  const handlePromptChange = (val: string) => {
    isEditingPromptRef.current = true
    setPrompt(val)
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => savePrompt(val), 800)
  }

  const handlePromptBlur = () => {
    isEditingPromptRef.current = false
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    void savePrompt(prompt)
  }

  const savePrompt = async (val: string) => {
    if (val === cardRef.current.prompt) return
    try {
      const res = await updateCardAction(cardRef.current.id, { prompt: val })
      if (!res.ok) throw new Error(res.error || "保存失败")
      onCardUpdatedRef.current({ ...cardRef.current, prompt: val })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    }
  }

  const updatePrompt = (nextPrompt: string) => {
    isEditingPromptRef.current = false
    setPrompt(nextPrompt)
    onCardUpdatedRef.current({ ...cardRef.current, prompt: nextPrompt })
  }

  const handleDeepen = async () => {
    if (!selectedDeepenTemplate) {
      toast.error("请先在生成配置中选择细化模板")
      return
    }
    setDeepening(true)
    try {
      const res = await deepenCardPromptAction(card.id, {
        prompt,
        templateId: selectedDeepenTemplate.id,
      })
      if (!res.ok || !res.newPrompt) throw new Error(res.error || "细化失败")
      setPreviousPrompt(prompt)
      updatePrompt(res.newPrompt)
      toast.success("提示词已细化")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "细化失败")
    } finally {
      setDeepening(false)
    }
  }

  const handleRegeneratePrompt = async () => {
    if (!selectedRegenTemplate) {
      toast.error("请先在操作栏选择重生成模板")
      return
    }
    setRegeneratingPrompt(true)
    try {
      const res = await regenerateCardPromptAction(card.id, {
        prompt,
        templateId: selectedRegenTemplate.id,
      })
      if (!res.ok || !res.newPrompt) throw new Error(res.error || "重新生成失败")
      setPreviousPrompt(prompt)
      updatePrompt(res.newPrompt)
      toast.success("提示词已重新生成")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重新生成失败")
    } finally {
      setRegeneratingPrompt(false)
    }
  }

  const handleTranslate = async () => {
    if (!selectedTranslateTemplate) {
      toast.error("请先在生成配置中选择翻译模板")
      return
    }
    setTranslating(true)
    try {
      const res = await translateCardPromptAction(card.id, {
        templateId: selectedTranslateTemplate.id,
      })
      if (!res.ok || !res.translatedPrompt)
        throw new Error(res.error || "翻译失败")
      onCardUpdated({
        ...card,
        translatedPrompt: res.translatedPrompt,
        translationSourcePrompt: card.prompt,
        translationStatus: "synced",
      })
      setDisplayLanguage("en")
      toast.success("提示词已翻译为英文")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "翻译失败")
    } finally {
      setTranslating(false)
    }
  }

  const handleGenerateImage = async () => {
    if (!selectedImageModel) {
      toast.error("请先在操作栏选择图片模型")
      return
    }
    if (!selectedSize) {
      toast.error("请先在操作栏选择尺寸")
      return
    }
    setGeneratingImage(true)
    onCardGeneratingImage?.(card.id, true)
    try {
      const generationPrompt = getGenerationPrompt({
        prompt,
        translatedPrompt: card.translatedPrompt,
        displayLanguage,
      })
      const action = hasImage
        ? regenerateCardImageAction
        : generateCardImageAction
      const res = await action(card.id, {
        prompt: generationPrompt,
        apiId: selectedImageModel.id,
        size: selectedSize,
      })
      if (!res.ok) throw new Error(res.error || "提交生图失败")
      toast.success("已提交生图任务")
      manuallyFlippedToBackRef.current = false
      setIsFlipped(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交生图失败")
      setGeneratingImage(false)
      onCardGeneratingImage?.(card.id, false)
    }
  }

  const handleLanguageChange = async (language: "zh" | "en") => {
    if (language === displayLanguage) return
    setDisplayLanguage(language)
    try {
      const res = await updateCardAction(card.id, {
        displayLanguage: language,
      })
      if (!res.ok) throw new Error(res.error || "切换失败")
      onCardUpdated({ ...card, displayLanguage: language })
    } catch {
      setDisplayLanguage(displayLanguage)
      toast.error("切换显示语言失败")
    }
  }

  const handleUndoPrompt = async () => {
    if (!previousPrompt) return
    try {
      const res = await updateCardAction(card.id, { prompt: previousPrompt })
      if (!res.ok) throw new Error(res.error || "撤回失败")
      updatePrompt(previousPrompt)
      setPreviousPrompt(null)
      toast.success("已撤回到上一次提示词")
    } catch {
      toast.error("撤回失败")
    }
  }

  const handleReferenceImagesChanged = (nextReferenceImages: string[]) => {
    const normalized = normalizeReferenceImages(nextReferenceImages)
    setReferenceImages(normalized)
    const updatedCard = { ...cardRef.current, referenceImages: normalized }
    cardRef.current = updatedCard
    onCardUpdatedRef.current(updatedCard)
  }

  const handleImageSelected = (image: CardImageRow) => {
    // 图片库已通过 selectCardImageAction 更新 DB；这里同步选中图冗余字段，
    // 让卡片展示立即切换，无需等待下一次轮询
    const updated: PromptCardRow = {
      ...cardRef.current,
      selectedImageId: image.id,
      selImgId: image.id,
      selImgUrl: image.imageUrl,
      selImgModelName: image.modelName,
      selImgSize: image.size,
      selImgStartedAt: image.generationStartedAt,
      selImgCompletedAt: image.generationCompletedAt,
      selImgCreatedAt: image.createdAt,
    }
    cardRef.current = updated
    onCardUpdatedRef.current(updated)
  }

  const openImagePreview = () => {
    if (!displayImageUrl) return
    const index = completedImageUrls.indexOf(displayImageUrl)
    setViewerIndex(index >= 0 ? index : 0)
    setViewerOpen(true)
  }

  const openReferencePreview = () => {
    if (referenceImageCount === 0) return
    setRefViewerIndex(0)
    setRefViewerOpen(true)
  }

  const handleUploadReference = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ""
    if (!files.length) return
    const model = selectedImageModel
    if (!model || getReferenceImageLimit(model) === 0) {
      toast.error("请先在操作栏选择支持参考图的图片模型")
      return
    }
    const limit = getReferenceImageLimit(model)
    if (referenceImages.length + files.length > limit) {
      toast.error(`当前模型最多支持 ${limit} 张参考图`)
      return
    }
    setUploadingRefImages(true)
    try {
      const uploaded = await uploadReferenceImages(files)
      if (!uploaded.length) throw new Error("没有可上传的图片（请检查格式与大小）")
      for (const item of uploaded) {
        const res = await addUploadedCardImageAction(card.id, {
          imageUrl: item.url,
        })
        if (!res.ok) throw new Error(res.error || "保存上传图片失败")
      }
      const res = await updateCardReferenceImagesAction(card.id, {
        apiId: model.id,
        referenceImages: [...referenceImages, ...uploaded.map((u) => u.url)],
      })
      if (!res.ok) throw new Error(res.error || "保存参考图失败")
      const saved = normalizeReferenceImages(res.referenceImages)
      setReferenceImages(saved)
      const updated = { ...cardRef.current, referenceImages: saved }
      cardRef.current = updated
      onCardUpdatedRef.current(updated)
      toast.success(`已上传 ${uploaded.length} 张参考图`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "参考图上传失败")
    } finally {
      setUploadingRefImages(false)
    }
  }

  const handleDeleteCard = async () => {
    setDeleting(true)
    try {
      const res = await deleteCardAction(card.id)
      if (!res.ok) throw new Error(res.error || "删除失败")
      setDeleteDialogOpen(false)
      onCardDeleted?.(card.id)
      toast.success("卡片已删除")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setDeleting(false)
    }
  }

  const openErrorDialog = () => {
    if (failedImageCount === 0) return
    setErrorDialogOpen(true)
  }

  const handleCardClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (batchMode) {
      onToggleSelect(card.id)
    }
  }

  const flipToBack = (e: React.MouseEvent) => {
    e.stopPropagation()
    manuallyFlippedToBackRef.current = true
    isEditingPromptRef.current = false
    setIsFlipped(true)
  }

  const flipToFront = (e: React.MouseEvent) => {
    e.stopPropagation()
    manuallyFlippedToBackRef.current = false
    isEditingPromptRef.current = false
    setIsFlipped(false)
  }

  const hasImage = !!displayImageUrl
  const hasFailedImage =
    !hasImage && pendingImageCount === 0 && failedImages.length > 0
  const hasGeneratingImage =
    generatingImage || pendingImageCount > 0 || batchGeneratingImage
  const isLoading =
    deepening ||
    regeneratingPrompt ||
    translating ||
    generatingImage ||
    pendingImageCount > 0 ||
    batchDeepening ||
    batchRegenerating ||
    batchTranslating ||
    batchGeneratingImage
  // 图片生成中用流光边框（BeamWrapper）高亮；提示词类操作保留 ring
  const isPromptLoading =
    deepening ||
    regeneratingPrompt ||
    translating ||
    batchDeepening ||
    batchRegenerating ||
    batchTranslating
  const translationStatus = getTranslationStatus(card)
  const displayedPrompt =
    displayLanguage === "en" ? card.translatedPrompt || "" : prompt
  // 放大查看器详情按图片实际数据显示：上传图（source=uploaded）无生成模型/提示词
  const viewerImage = completedImages[viewerIndex]
  const viewerInfo = viewerImage
    ? viewerImage.source === "uploaded"
      ? { createdAt: viewerImage.createdAt }
      : {
          model: viewerImage.modelName ?? undefined,
          prompt: viewerImage.generationPrompt || card.prompt,
          createdAt: viewerImage.createdAt,
        }
    : undefined
  const refViewerUrl = referenceImages[refViewerIndex]
  const refViewerMatch = refViewerUrl
    ? images.find((i) => i.imageUrl === refViewerUrl)
    : undefined
  const refViewerInfo = refViewerMatch
    ? refViewerMatch.source === "uploaded"
      ? { createdAt: refViewerMatch.createdAt }
      : {
          model: refViewerMatch.modelName ?? undefined,
          prompt: refViewerMatch.generationPrompt || card.prompt,
          createdAt: refViewerMatch.createdAt,
        }
    : undefined

  // 生成开始（单张提交或批量提交波及本卡，含挂载时已在生成中）默认翻到图片面
  // 展示「生成中」+ 流光边框；期间手动翻回背面则尊重（flipToBack 置手动标记）
  const wasGeneratingImageRef = useRef(false)
  useEffect(() => {
    const started = hasGeneratingImage && !wasGeneratingImageRef.current
    wasGeneratingImageRef.current = hasGeneratingImage
    if (started) {
      manuallyFlippedToBackRef.current = false
      setIsFlipped(false)
    }
  }, [hasGeneratingImage])

  return (
    <>
      {/* 流光边框常开（生成中）；屏外动画暂停由 border-beam 包内置的
          IntersectionObserver（data-paused）+ 卡片 content-visibility 处理 */}
      <BeamWrapper
        active={hasGeneratingImage}
        colorVariant="colorful"
        size="md"
        borderRadius={18}
      >
        <div
          onClick={handleCardClick}
          style={{ aspectRatio: "3 / 5" }}
          className={cn(
            "relative overflow-hidden rounded-2xl border transition-all duration-200 [content-visibility:auto] [contain-intrinsic-size:auto_300px]",
            batchMode && "cursor-pointer",
            isSelected && batchMode
              ? "border-blue-600 bg-blue-50/20 ring-2 ring-blue-600"
              : "border-border bg-card",
            isPromptLoading && "ring-2 ring-primary/40",
          )}
        >
          {batchMode && isSelected && (
            <div className="absolute right-2.5 top-2.5 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm">
              <Check className="h-4 w-4" />
            </div>
          )}
          <div
            className="absolute inset-0"
            style={{ perspective: "1000px" }}
          >
            <div
              className="relative h-full w-full transition-transform duration-500"
              style={{
                transformStyle: "preserve-3d",
                transform: isFlipped ? "rotateY(180deg)" : "rotateY(0deg)",
              }}
            >
              {/* 正面 - 图片 */}
              <div
                className="group absolute inset-0 bg-muted/30"
                style={{
                  backfaceVisibility: "hidden",
                  pointerEvents: isFlipped ? "none" : "auto",
                }}
                aria-hidden={isFlipped}
              >
                {hasGeneratingImage ? (
                  <div className="flex h-full items-center justify-center">
                    <span className="animate-pulse bg-gradient-to-r from-muted-foreground to-foreground bg-clip-text text-sm font-medium text-transparent">
                      生成中
                    </span>
                  </div>
                ) : hasFailedImage ? (
                  <div className="flex h-full flex-col cursor-pointer items-center justify-center gap-3 px-4 text-center">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger
                          className="flex h-16 w-16 items-center justify-center bg-destructive/12 text-destructive shadow-sm"
                          style={{
                            clipPath: "polygon(50% 8%, 95% 92%, 5% 92%)",
                          }}
                        >
                          <AlertCircle className="h-6 w-6" />
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {failedImageTooltip}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <span className="text-xs leading-relaxed text-destructive/90">
                      {!batchMode && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            openErrorDialog()
                          }}
                          className="font-medium underline underline-offset-2 decoration-destructive/60 hover:text-destructive"
                        >
                          图片生成失败
                        </button>
                      )}
                      {batchMode && (
                        <span className="font-medium">图片生成失败</span>
                      )}
                      {!batchMode && (
                        <>
                          <br />
                          点击翻转编辑或重试
                        </>
                      )}
                    </span>
                  </div>
                ) : hasImage ? (
                  <div
                    className="group relative h-full w-full cursor-pointer"
                    onClick={(e) => {
                      if (!batchMode) {
                        e.stopPropagation()
                        setGalleryInitialMode("selected")
                        setShowGallery(true)
                      }
                    }}
                  >
                    {/* COS/远程图片，直连或经代理加载；SmartImage 自动显示失效占位 */}
                    <SmartImage
                      src={toImageSrc(displayImageUrl!, {
                        width: 400,
                        height: 600,
                      })}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    {generatedImageCount > 1 && (
                      <div className="absolute bottom-2.5 right-2.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">
                        {generatedImageCount} 张
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
                  </div>
                ) : (
                  <div className="flex h-full cursor-pointer flex-col items-center justify-center gap-2">
                    <ImagePlus className="h-8 w-8 text-muted-foreground/40" />
                    <span className="px-4 text-center text-xs text-muted-foreground">
                      暂无图片
                      {!batchMode && (
                        <>
                          <br />
                          点击翻转编辑
                        </>
                      )}
                    </span>
                  </div>
                )}

                {/* 操作按钮 */}
                {!batchMode && !hasGeneratingImage && (
                  <div className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1.5 opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-100">
                    {hasImage && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void handleGenerateImage()
                                }}
                                disabled={isLoading}
                                className="flex h-7 w-7 items-center justify-center rounded-md bg-black/45 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/65 disabled:cursor-not-allowed disabled:opacity-50"
                              />
                            }
                          >
                            {generatingImage ? (
                              <MorphingInfinity className="h-3.5 w-3.5" />
                            ) : (
                              <RotateCw className="h-3.5 w-3.5" />
                            )}
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            重新生成图片
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {hasImage && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openImagePreview()
                                }}
                                className="flex h-7 items-center justify-center rounded-md bg-black/45 px-2 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/65"
                              />
                            }
                          >
                            <ZoomIn className="h-3.5 w-3.5" />
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            查看图片
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={flipToBack}
                              className="flex h-7 items-center justify-center rounded-md bg-black/45 px-2 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/65"
                              aria-label="翻转卡片"
                            />
                          }
                        >
                          <ChevronLeft className="h-3.5 w-3.5 rotate-180" />
                        </TooltipTrigger>
                        <TooltipContent side="left">翻转卡片</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                )}

                {/* 卡片编号 + 参考图指示 */}
                <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1">
                  <span className="rounded-full bg-black/35 px-2 py-0.5 text-[10px] text-white/70">
                    #{card.cardIndex}
                  </span>
                  {referenceImageIndicator && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                openReferencePreview()
                              }}
                              className={REFERENCE_IMAGE_INDICATOR_IMAGE_CLASS}
                              aria-label={`${referenceImageIndicator.label}，点击放大查看`}
                            />
                          }
                        >
                          <GalleryHorizontalEnd className="h-3 w-3" />
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {referenceImageIndicator.label}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>

                {/* 无图时生成按钮 */}
                {!batchMode && !hasImage && !hasGeneratingImage && !hasFailedImage && (
                  <div className="absolute bottom-2.5 right-2.5 z-10">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleGenerateImage()
                              }}
                              disabled={isLoading}
                              className="flex h-7 w-7 items-center justify-center rounded-md bg-black/45 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/65 disabled:cursor-not-allowed disabled:opacity-50"
                            />
                          }
                        >
                          <ImagePlus className="h-3.5 w-3.5" />
                        </TooltipTrigger>
                        <TooltipContent side="left">生成图片</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                )}
              </div>

              {/* 背面 - 提示词编辑 */}
              <div
                className={cn(
                  "absolute inset-0 flex flex-col gap-2 bg-background p-3",
                  batchMode && "cursor-pointer",
                )}
                style={{
                  backfaceVisibility: "hidden",
                  transform: "rotateY(180deg)",
                  pointerEvents: isFlipped ? "auto" : "none",
                }}
                aria-hidden={!isFlipped}
              >
                {/* 批量模式下的透明遮罩层 */}
                {batchMode && (
                  <div
                    className="absolute inset-0 z-10 cursor-pointer"
                    onClick={handleCardClick}
                  />
                )}
                <div className="flex shrink-0 items-start justify-between gap-2">
                  <span className="pt-1 text-[10px] font-medium text-muted-foreground">
                    #{card.cardIndex} 提示词
                  </span>
                  <div className="flex items-center gap-1.5">
                    {failedImages.length > 0 && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openErrorDialog()
                                }}
                                className={cn(
                                  TOPBAR_MINI_BUTTON_CLASS,
                                  "border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive",
                                )}
                                aria-label="图片生成失败"
                              />
                            }
                          >
                            <AlertCircle className="h-3 w-3" />
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            {failedImageTooltip}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {!hasFailedImage &&
                      !hasGeneratingImage &&
                      completedImages.length > 0 && (
                        <>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void handleGenerateImage()
                                    }}
                                    disabled={isLoading}
                                    className={TOPBAR_MINI_BUTTON_CLASS}
                                    aria-label="重新生成图片"
                                  />
                                }
                              >
                                {generatingImage ? (
                                  <MorphingInfinity className="h-3 w-3" />
                                ) : (
                                  <RotateCw className="h-3 w-3" />
                                )}
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                重新生成图片
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          {referenceImageIndicator && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setGalleryInitialMode("reference")
                                        setShowGallery(true)
                                      }}
                                      className={REFERENCE_IMAGE_INDICATOR_PROMPT_CLASS}
                                      aria-label={`${referenceImageIndicator.label}，打开参考图片库`}
                                    />
                                  }
                                >
                                  <GalleryHorizontalEnd className="h-3 w-3" />
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  {referenceImageIndicator.label}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          {generatedImageCount > 0 && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger className="inline-flex h-6 min-w-6 cursor-default items-center justify-center gap-0.5 rounded-sm border border-border/60 bg-card/80 px-1 text-[10px] font-medium text-muted-foreground shadow-sm">
                                  <Images className="h-3 w-3" />
                                  {generatedImageCount}
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  已生成 {generatedImageCount} 张
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </>
                      )}
                    {referenceImageIndicator &&
                      (hasFailedImage ||
                        hasGeneratingImage ||
                        completedImages.length === 0) && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setGalleryInitialMode("reference")
                                    setShowGallery(true)
                                  }}
                                  className={REFERENCE_IMAGE_INDICATOR_PROMPT_CLASS}
                                  aria-label={`${referenceImageIndicator.label}，打开参考图片库`}
                                />
                              }
                            >
                              <GalleryHorizontalEnd className="h-3 w-3" />
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              {referenceImageIndicator.label}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    {!batchMode && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                              onClick={flipToFront}
                              className={TOPBAR_MINI_BUTTON_CLASS}
                              aria-label="返回图片面"
                              />
                            }
                          >
                            <ChevronLeft className="h-3 w-3" />
                          </TooltipTrigger>
                          <TooltipContent side="left">返回图片面</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </div>
                </div>

                <Textarea
                  value={displayedPrompt}
                  onChange={(e) => handlePromptChange(e.target.value)}
                  onBlur={handlePromptBlur}
                  className="min-h-0 flex-1 resize-none text-xs leading-relaxed"
                  placeholder="提示词..."
                  disabled={isLoading || batchMode || displayLanguage === "en"}
                />

                {!batchMode && (
                  <div className="flex shrink-0 items-center justify-end gap-1.5">
                    <Button
                      size="sm"
                      className="h-8 gap-1.5 rounded-md bg-primary px-3 text-[11px] text-primary-foreground shadow-sm hover:bg-primary/90"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleGenerateImage()
                      }}
                      disabled={isLoading || generatingImage}
                    >
                      {generatingImage ? (
                        <MorphingInfinity className="h-3.5 w-3.5" />
                      ) : (
                        <ImagePlus className="h-3.5 w-3.5" />
                      )}
                      {hasImage ? "重新生成图片" : "生成图片"}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className="inline-flex size-8 items-center justify-center rounded-md border border-border/60 bg-card/80 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
                        title="更多操作"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        side="top"
                        align="end"
                        className="w-44"
                        positionerClassName="z-40"
                      >
                        {card.translatedPrompt && (
                          <DropdownMenuCheckboxItem
                            checked={displayLanguage === "en"}
                            onCheckedChange={() =>
                              void handleLanguageChange(
                                displayLanguage === "en" ? "zh" : "en",
                              )
                            }
                            className="h-8"
                          >
                            显示英文译文
                          </DropdownMenuCheckboxItem>
                        )}
                        {card.translatedPrompt &&
                          translationStatus === "outdated" && (
                            <div className="flex items-center gap-1.5 px-1.5 py-1 text-xs text-amber-600 dark:text-amber-400">
                              <AlertCircle className="size-3.5 shrink-0" />
                              中文已修改，译文未同步
                            </div>
                          )}
                        {card.translatedPrompt && <DropdownMenuSeparator />}
                        {previousPrompt && (
                          <DropdownMenuItem
                            className="h-8"
                            disabled={isLoading}
                            onClick={() => void handleUndoPrompt()}
                          >
                            <Undo2 className="size-3.5" />
                            撤回修改
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          className="h-8"
                          disabled={isLoading || regeneratingPrompt}
                          onClick={() => void handleRegeneratePrompt()}
                        >
                          {regeneratingPrompt ? (
                            <MorphingInfinity className="size-3.5" />
                          ) : (
                            <RefreshCw className="size-3.5" />
                          )}
                          重新生成提示词
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="h-8"
                          disabled={isLoading || deepening}
                          onClick={() => void handleDeepen()}
                        >
                          {deepening ? (
                            <MorphingInfinity className="size-3.5" />
                          ) : (
                            <Sparkles className="size-3.5" />
                          )}
                          细化提示词
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="h-8"
                          disabled={isLoading || translating}
                          onClick={() => void handleTranslate()}
                        >
                          {translating ? (
                            <MorphingInfinity className="size-3.5" />
                          ) : (
                            <Languages className="size-3.5" />
                          )}
                          翻译提示词
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="h-8"
                          disabled={uploadingRefImages}
                          onClick={() => uploadInputRef.current?.click()}
                        >
                          {uploadingRefImages ? (
                            <MorphingInfinity className="size-3.5" />
                          ) : (
                            <Upload className="size-3.5" />
                          )}
                          上传参考图
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          className="h-8"
                          onClick={() => setDeleteDialogOpen(true)}
                        >
                          <Trash2 className="size-3.5" />
                          删除卡片
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </BeamWrapper>

      <ImageGalleryDialog
        open={showGallery}
        onOpenChange={setShowGallery}
        cardId={card.id}
        selectedImageModel={selectedImageModel}
        initialMode={galleryInitialMode}
        onImageSelected={handleImageSelected}
        onReferenceImagesChanged={handleReferenceImagesChanged}
      />

      {/* 已生成图放大查看器（缩放/旋转/多图切换/下载） */}
      <ImageViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        images={completedImageUrls}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        info={viewerInfo}
      />

      {/* 参考图放大查看器（图片面左下角指示器打开，仅查看） */}
      <ImageViewer
        open={refViewerOpen}
        onOpenChange={setRefViewerOpen}
        images={referenceImages}
        index={refViewerIndex}
        onIndexChange={setRefViewerIndex}
        info={refViewerInfo}
      />

      <input
        ref={uploadInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => void handleUploadReference(e)}
      />

      {/* 错误提示弹窗 */}
      <Dialog open={errorDialogOpen} onOpenChange={setErrorDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-destructive" />
              图片生成失败
            </DialogTitle>
          </DialogHeader>
          <div className="whitespace-pre-wrap py-2 text-sm text-muted-foreground">
            {failedImageTooltip}
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除卡片确认弹窗 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              删除卡片 #{card.cardIndex}？
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 text-sm text-muted-foreground">
            将永久删除该卡片及其全部图片与参考图，此操作不可撤销。
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDeleteCard()}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <MorphingInfinity className="h-3.5 w-3.5" />
                  删除中
                </>
              ) : (
                "确认删除"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})
