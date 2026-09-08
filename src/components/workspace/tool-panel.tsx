"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  ImagePlus,
  Images,
  Languages,
  Maximize2,
  Minus,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ImageViewer } from "@/components/ui/image-viewer"
import { ImageGalleryDialog } from "@/components/workspace/image-gallery-dialog"
import { cn, toImageSrc } from "@/lib/utils"
import { SmartImage } from "@/components/ui/smart-image"
import { toast } from "sonner"
import { uploadReferenceImages } from "@/lib/workspace/upload"
import {
  getGenerationPrompt,
  getReferenceImageLimit,
  normalizeReferenceImages,
  resolveCardDisplayImage,
} from "@/lib/workspace/helpers"
import {
  addUploadedCardImageAction,
  deepenCardPromptAction,
  deleteCardAction,
  generateCardImageAction,
  regenerateCardImageAction,
  regenerateCardPromptAction,
  selectCardImageAction,
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

// ─── 常量 ───

const PANEL_WIDTH = 380
/** 拖动/悬浮触发的位移阈值与防抖 */
const DRAG_THRESHOLD = 4
const PREVIEW_HOVER_DELAY = 150
/** 悬浮预览与面板的间距 / 预览侧判定所需的最小剩余空间 */
const PREVIEW_GAP = 12
const PREVIEW_MIN_SPACE = 400
/** 拖动视口钳制边距 / 至少保留可见的标题栏高度 */
const EDGE_MARGIN = 8
const HEADER_KEEP_VISIBLE = 48
/** 无记忆位置时的默认落位高度估算（挂载后用实测高度校正垂直居中） */
const ESTIMATED_PANEL_HEIGHT = 480
// v2：初版存在"打开后跳到左上角"的 bug，可能残留左侧记忆位置，升 key 让默认右侧居中生效
const POS_STORAGE_KEY = "workspace:tool-panel-pos:v2"
/** 图片库分页：2 行 × 4 列 */
const PAGE_SIZE = 8

type PanelPos = { x: number; y: number }

interface StoredPos {
  x: number
  y: number
}

function readStoredPos(): StoredPos | null {
  try {
    const raw = localStorage.getItem(POS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredPos
    if (
      typeof parsed?.x !== "number" ||
      typeof parsed?.y !== "number" ||
      !Number.isFinite(parsed.x) ||
      !Number.isFinite(parsed.y)
    ) {
      return null
    }
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}

function writeStoredPos(pos: PanelPos) {
  try {
    localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(pos))
  } catch {
    // 存储不可用（隐私模式等）时静默降级为不记忆
  }
}

/** 初始位置：记忆位置（钳制到视口）优先，否则停靠视口右侧、按估算高度垂直居中 */
function computeInitialPos(): PanelPos {
  const width = window.innerWidth
  const height = window.innerHeight
  const saved = readStoredPos()
  if (saved) {
    return {
      x: Math.min(
        Math.max(saved.x, EDGE_MARGIN),
        Math.max(EDGE_MARGIN, width - PANEL_WIDTH - EDGE_MARGIN),
      ),
      y: Math.min(
        Math.max(saved.y, EDGE_MARGIN),
        Math.max(EDGE_MARGIN, height - HEADER_KEEP_VISIBLE),
      ),
    }
  }
  return {
    x: Math.max(EDGE_MARGIN, width - PANEL_WIDTH - 24),
    y: Math.max(EDGE_MARGIN, Math.round((height - ESTIMATED_PANEL_HEIGHT) / 2)),
  }
}

type LibraryTab = "generated" | "uploaded"

interface ToolPanelProps {
  cards: PromptCardRow[]
  activeCardId: string | null
  onClose: () => void
  /** 活动卡片的图片行（父级 cardImagesMap 取出） */
  cardImages: CardImageRow[]
  selectedDeepenTemplate: TemplateRow | null
  selectedRegenTemplate: TemplateRow | null
  selectedTranslateTemplate: TemplateRow | null
  selectedImageModel: ImageModelRow | null
  selectedSize: string | null
  onCardUpdated: (card: PromptCardRow) => void
  onCardDeleted: (cardId: string) => void
  onCardGeneratingImage: (cardId: string, generating: boolean) => void
}

const HEADER_ICON_BUTTON_CLASS =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"

export function ToolPanel({
  cards,
  activeCardId,
  onClose,
  cardImages,
  selectedDeepenTemplate,
  selectedRegenTemplate,
  selectedTranslateTemplate,
  selectedImageModel,
  selectedSize,
  onCardUpdated,
  onCardDeleted,
  onCardGeneratingImage,
}: ToolPanelProps) {
  const cardIndex = cards.findIndex((c) => c.id === activeCardId)
  const card = cardIndex >= 0 ? cards[cardIndex] : null

  // ─── 浮动壳：位置 / 拖动 / 收起 ───
  // 仅在用户点击「工具面板」后由父级条件渲染，必为客户端环境
  const panelRef = useRef<HTMLDivElement | null>(null)
  const posRef = useRef<PanelPos>({ x: 0, y: 0 })
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    posStart: PanelPos
    moved: boolean
  } | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  // 初始位置是否来自记忆（否则首帧后按实测高度做垂直居中校正）
  const [initialFromStorage] = useState(() => readStoredPos() !== null)
  const [pos, setPos] = useState<PanelPos>(computeInitialPos)

  const applyPos = useCallback((next: PanelPos) => {
    posRef.current = next
    setPos(next)
  }, [])

  const clampPos = useCallback((p: PanelPos): PanelPos => {
    const panelWidth = panelRef.current?.offsetWidth ?? PANEL_WIDTH
    const maxX = Math.max(EDGE_MARGIN, window.innerWidth - panelWidth - EDGE_MARGIN)
    const maxY = Math.max(EDGE_MARGIN, window.innerHeight - HEADER_KEEP_VISIBLE)
    return {
      x: Math.min(Math.max(p.x, EDGE_MARGIN), maxX),
      y: Math.min(Math.max(p.y, EDGE_MARGIN), maxY),
    }
  }, [])

  // 挂载时钳制初始位置；无记忆位置（首次使用）时按实测面板高度做右侧垂直居中校正。
  // pos 读取首帧渲染闭包里的初始值，故意不列入依赖（避免拖动更新触发重跑重置）
  useEffect(() => {
    const measured = panelRef.current?.offsetHeight
    const base = initialFromStorage
      ? pos
      : {
          x: pos.x,
          y: measured
            ? Math.round((window.innerHeight - measured) / 2)
            : pos.y,
        }
    applyPos(clampPos(base))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyPos, clampPos, initialFromStorage])

  useEffect(() => {
    const onResize = () => applyPos(clampPos(posRef.current))
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [applyPos, clampPos])

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // 头部按钮（切卡/收起/关闭）自带点击语义，不进入拖动
    if ((e.target as HTMLElement).closest("button")) return
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      posStart: posRef.current,
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handleHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    applyPos(clampPos({ x: drag.posStart.x + dx, y: drag.posStart.y + dy }))
  }

  const endHeaderDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 指针已释放时 release 会抛错，忽略
    }
    if (drag.moved) writeStoredPos(posRef.current)
  }

  // ─── 图片库 ───
  const [tab, setTab] = useState<LibraryTab>("generated")
  const [page, setPage] = useState(0)
  const [selectingImageId, setSelectingImageId] = useState<string | null>(null)
  // 设为展示图后、轮询对账前的本地覆盖（isSelected 标记来自父级 images，有延迟）
  const [selectedOverrideId, setSelectedOverrideId] = useState<string | null>(null)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [galleryInitialMode, setGalleryInitialMode] = useState<"selected" | "reference">("selected")

  const images = cardImages
  const completedImages = useMemo(
    () => images.filter((i) => i.status === "completed" && i.imageUrl),
    [images],
  )
  const completedImageUrls = completedImages.map((i) => i.imageUrl)
  const generatedImages = useMemo(
    () => images.filter((i) => i.source === "generated"),
    [images],
  )
  const uploadedImages = useMemo(
    () => images.filter((i) => i.source === "uploaded"),
    [images],
  )
  const tabImages = tab === "generated" ? generatedImages : uploadedImages
  const totalPages = Math.max(1, Math.ceil(tabImages.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages - 1)
  const pageImages = tabImages.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const pendingImageCount = images.filter(
    (i) => i.status === "pending" || i.status === "generating",
  ).length
  const displayImage = card ? resolveCardDisplayImage(card, images) : null
  const hasImage = Boolean(card?.selImgUrl || displayImage?.imageUrl)

  // 切卡 / 数据变化时重置分页与本地覆盖
  useEffect(() => {
    setPage(0)
    setSelectedOverrideId(null)
  }, [activeCardId, tab])

  // ─── 悬浮预览（面板旁浮动，贴边翻转） ───
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [preview, setPreview] = useState<{
    url: string
    side: "left" | "right"
  } | null>(null)

  const showPreview = useCallback((url: string) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => {
      const panelWidth = panelRef.current?.offsetWidth ?? PANEL_WIDTH
      const spaceRight = window.innerWidth - (posRef.current.x + panelWidth)
      setPreview({
        url,
        side: spaceRight > PREVIEW_MIN_SPACE ? "right" : "left",
      })
    }, PREVIEW_HOVER_DELAY)
  }, [])

  const hidePreview = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setPreview(null)
  }, [])

  useEffect(
    () => () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    },
    [],
  )

  // ─── 提示词编辑（与卡片背面一致：本地 state + 800ms 防抖 + focus 守卫） ───
  const [prompt, setPrompt] = useState(card?.prompt ?? "")
  const [previousPrompt, setPreviousPrompt] = useState<string | null>(null)
  const isEditingPromptRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<{ cardId: string; value: string } | null>(null)
  const cardsRef = useRef(cards)

  useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  useEffect(() => {
    // 用户正在编辑时不重置本地 prompt，避免轮询打断输入
    if (isEditingPromptRef.current) return
    setPrompt(card?.prompt ?? "")
  }, [card?.prompt, card?.id])

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    },
    [],
  )

  const savePrompt = useCallback(
    async (cardId: string, value: string) => {
      pendingSaveRef.current = null
      // 经 ref 读取最新卡片，避免防抖闭包里的 cards 过期
      const latest = cardsRef.current.find((c) => c.id === cardId)
      if (!latest || latest.prompt === value) return
      try {
        const res = await updateCardAction(cardId, { prompt: value })
        if (!res.ok) throw new Error(res.error || "保存失败")
        onCardUpdated({ ...latest, prompt: value })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "保存失败")
      }
    },
    [onCardUpdated],
  )

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingSaveRef.current
    if (pending) void savePrompt(pending.cardId, pending.value)
  }, [savePrompt])

  // 切卡/卸载前落盘未保存的编辑（按旧卡 id 保存，避免写入新卡）
  useEffect(() => {
    return () => {
      flushPendingSave()
    }
  }, [activeCardId, flushPendingSave])

  const handlePromptChange = (value: string) => {
    if (!card) return
    isEditingPromptRef.current = true
    setPrompt(value)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    pendingSaveRef.current = { cardId: card.id, value }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const pending = pendingSaveRef.current
      if (pending) void savePrompt(pending.cardId, pending.value)
    }, 800)
  }

  const handlePromptBlur = () => {
    isEditingPromptRef.current = false
    flushPendingSave()
  }

  /** 提示词类操作成功后的本地同步（等同卡片背面 updatePrompt） */
  const applyPromptResult = (nextPrompt: string) => {
    if (!card) return
    isEditingPromptRef.current = false
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    pendingSaveRef.current = null
    setPrompt(nextPrompt)
    onCardUpdated({ ...card, prompt: nextPrompt })
  }

  // ─── 操作加载态 ───
  const [generatingImage, setGeneratingImage] = useState(false)
  const [deepening, setDeepening] = useState(false)
  const [regeneratingPrompt, setRegeneratingPrompt] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [uploadingRefImages, setUploadingRefImages] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)

  // 提交生图后，pending 图片出现时清除本地提交中标记（状态交给轮询）
  useEffect(() => {
    if (pendingImageCount > 0 && generatingImage) {
      setGeneratingImage(false)
    }
  }, [pendingImageCount, generatingImage])

  const isLoading =
    !card ||
    deepening ||
    regeneratingPrompt ||
    translating ||
    generatingImage ||
    uploadingRefImages ||
    pendingImageCount > 0

  // ─── 卡片操作（与卡片背面对齐，复用同一组 server actions） ───

  const handleDeepen = async () => {
    if (!card) return
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
      applyPromptResult(res.newPrompt)
      toast.success("提示词已细化")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "细化失败")
    } finally {
      setDeepening(false)
    }
  }

  const handleRegeneratePrompt = async () => {
    if (!card) return
    if (!selectedRegenTemplate) {
      toast.error("请先在生成配置中选择重生成模板")
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
      applyPromptResult(res.newPrompt)
      toast.success("提示词已重新生成")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重新生成失败")
    } finally {
      setRegeneratingPrompt(false)
    }
  }

  const handleTranslate = async () => {
    if (!card) return
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
      toast.success("提示词已翻译为英文")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "翻译失败")
    } finally {
      setTranslating(false)
    }
  }

  const handleUndoPrompt = async () => {
    if (!card || !previousPrompt) return
    try {
      const res = await updateCardAction(card.id, { prompt: previousPrompt })
      if (!res.ok) throw new Error(res.error || "撤回失败")
      applyPromptResult(previousPrompt)
      setPreviousPrompt(null)
      toast.success("已撤回到上一次提示词")
    } catch {
      toast.error("撤回失败")
    }
  }

  const handleGenerateImage = async () => {
    if (!card) return
    if (!selectedImageModel) {
      toast.error("请先在生成配置中选择图片模型")
      return
    }
    if (!selectedSize) {
      toast.error("请先在生成配置中选择尺寸")
      return
    }
    setGeneratingImage(true)
    onCardGeneratingImage(card.id, true)
    try {
      const generationPrompt = getGenerationPrompt({
        prompt,
        translatedPrompt: card.translatedPrompt,
        displayLanguage: card.displayLanguage,
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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交生图失败")
      setGeneratingImage(false)
      onCardGeneratingImage(card.id, false)
    }
  }

  const handleDeleteCard = async () => {
    if (!card) return
    setDeleting(true)
    try {
      const res = await deleteCardAction(card.id)
      if (!res.ok) throw new Error(res.error || "删除失败")
      setDeleteDialogOpen(false)
      onCardDeleted(card.id)
      toast.success("卡片已删除")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setDeleting(false)
    }
  }

  // ─── 展示图 / 参考图 ───
  const referenceImages = useMemo(
    () => normalizeReferenceImages(card?.referenceImages),
    [card?.referenceImages],
  )
  const referenceLimit = getReferenceImageLimit(selectedImageModel)

  const handleSelectImage = async (image: CardImageRow) => {
    if (!card || image.status !== "completed" || !image.imageUrl) return
    if (image.isSelected || card.selectedImageId === image.id) return
    setSelectingImageId(image.id)
    try {
      const res = await selectCardImageAction(image.id)
      if (!res.ok) throw new Error(res.error || "选定图片失败")
      setSelectedOverrideId(image.id)
      // 同步选中图冗余字段，卡片正面立即切换，无需等待轮询
      onCardUpdated({
        ...card,
        selectedImageId: image.id,
        selImgId: image.id,
        selImgUrl: image.imageUrl,
        selImgModelName: image.modelName,
        selImgSize: image.size,
        selImgStartedAt: image.generationStartedAt,
        selImgCompletedAt: image.generationCompletedAt,
        selImgCreatedAt: image.createdAt,
      })
      toast.success("已设为展示图")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "选定图片失败")
    } finally {
      setSelectingImageId(null)
    }
  }

  const handleReferenceImagesChanged = (next: string[]) => {
    if (!card) return
    onCardUpdated({
      ...card,
      referenceImages: normalizeReferenceImages(next),
    })
  }

  const handleUploadReference = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ""
    if (!files.length || !card) return
    if (!selectedImageModel || referenceLimit === 0) {
      toast.error("请先在生成配置中选择支持参考图的图片模型")
      return
    }
    if (referenceImages.length + files.length > referenceLimit) {
      toast.error(`当前模型最多支持 ${referenceLimit} 张参考图`)
      return
    }
    setUploadingRefImages(true)
    try {
      const uploaded = await uploadReferenceImages(files)
      if (!uploaded.length)
        throw new Error("没有可上传的图片（请检查格式与大小）")
      for (const item of uploaded) {
        const res = await addUploadedCardImageAction(card.id, {
          imageUrl: item.url,
        })
        if (!res.ok) throw new Error(res.error || "保存上传图片失败")
      }
      const res = await updateCardReferenceImagesAction(card.id, {
        apiId: selectedImageModel.id,
        referenceImages: [...referenceImages, ...uploaded.map((u) => u.url)],
      })
      if (!res.ok) throw new Error(res.error || "保存参考图失败")
      handleReferenceImagesChanged(
        normalizeReferenceImages(res.referenceImages),
      )
      toast.success(`已上传 ${uploaded.length} 张参考图`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "参考图上传失败")
    } finally {
      setUploadingRefImages(false)
    }
  }

  // ─── 大图查看器 ───
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerIndex, setViewerIndex] = useState(0)
  const [refViewerOpen, setRefViewerOpen] = useState(false)
  const [refViewerIndex, setRefViewerIndex] = useState(0)

  const openViewerAt = (image: CardImageRow) => {
    const index = completedImages.findIndex((i) => i.id === image.id)
    setViewerIndex(index >= 0 ? index : 0)
    setViewerOpen(true)
  }

  // 放大查看器详情：上传图无生成模型/提示词
  const viewerImage = completedImages[viewerIndex]
  const viewerInfo = viewerImage
    ? viewerImage.source === "uploaded"
      ? { createdAt: viewerImage.createdAt }
      : {
          model: viewerImage.modelName ?? undefined,
          prompt: viewerImage.generationPrompt || card?.prompt || "",
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
          prompt: refViewerMatch.generationPrompt || card?.prompt || "",
          createdAt: refViewerMatch.createdAt,
        }
    : undefined

  // Escape 关闭面板（内部弹窗打开时让给弹窗）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !galleryOpen &&
        !viewerOpen &&
        !refViewerOpen &&
        !deleteDialogOpen
      ) {
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [galleryOpen, viewerOpen, refViewerOpen, deleteDialogOpen, onClose])

  // ─── 渲染 ───

  const panelWidth = PANEL_WIDTH
  const previewTop = Math.max(pos.y + 44, EDGE_MARGIN)
  const previewStyle: React.CSSProperties =
    preview?.side === "right"
      ? { left: pos.x + panelWidth + PREVIEW_GAP, top: previewTop }
      : { right: window.innerWidth - pos.x + PREVIEW_GAP, top: previewTop }

  const thumbnailLabel = (image: CardImageRow) =>
    image.source === "uploaded"
      ? "上传图片"
      : image.size || "未知尺寸"

  const renderThumbnail = (image: CardImageRow) => {
    const isGenerating =
      image.status === "pending" || image.status === "generating"
    const isFailed = image.status === "failed"
    const isSelected =
      image.isSelected ||
      card?.selectedImageId === image.id ||
      selectedOverrideId === image.id
    return (
      <div
        key={image.id}
        className="group relative aspect-square overflow-hidden rounded-md border text-left shadow-sm transition-shadow hover:shadow-md"
        onMouseEnter={() => {
          if (image.imageUrl) showPreview(image.imageUrl)
        }}
        onMouseLeave={hidePreview}
      >
        <button
          type="button"
          className="absolute inset-0"
          aria-label={isSelected ? "当前展示图" : "设为展示图"}
          disabled={selectingImageId !== null || (!image.imageUrl && !isFailed)}
          onClick={() => void handleSelectImage(image)}
          onDoubleClick={() => image.imageUrl && openViewerAt(image)}
        />
        {image.imageUrl ? (
          <SmartImage
            src={toImageSrc(image.imageUrl, { width: 200, height: 200 })}
            alt=""
            className={cn(
              "pointer-events-none h-full w-full object-cover",
              isSelected && "brightness-[.92]",
            )}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-muted/60">
            {isFailed ? (
              <span title={image.errorMessage || "生成失败"}>
                <AlertCircle className="h-4 w-4 text-destructive/70" />
              </span>
            ) : (
              <MorphingInfinity className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        )}
        {/* 展示图选中态：与批量选择卡片一致的蓝底描边 + 右上角圆形对勾徽章 */}
        <span
          className={cn(
            "pointer-events-none absolute inset-0 rounded-md border-2",
            isSelected
              ? "border-blue-600 ring-2 ring-blue-600"
              : "border-transparent",
          )}
        />
        {isSelected && (
          <span className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm">
            <Check className="h-3 w-3" />
          </span>
        )}
        {image.imageUrl && (
          <button
            type="button"
            aria-label="放大查看"
            className="absolute left-1 top-1 hidden rounded-sm bg-black/45 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              openViewerAt(image)
            }}
          >
            <Maximize2 className="h-3 w-3" />
          </button>
        )}
        {selectingImageId === image.id && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/40">
            <MorphingInfinity className="h-5 w-5 text-white" />
          </span>
        )}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1 pb-0.5 pt-4 text-[9px] leading-tight text-white/85">
          {isGenerating ? "生成中" : isFailed ? "生成失败" : thumbnailLabel(image)}
        </span>
      </div>
    )
  }

  return createPortal(
    <>
      <div
        ref={panelRef}
        className="fixed left-0 top-0 z-40 overflow-hidden rounded-xl border border-border bg-background/95 shadow-2xl backdrop-blur-sm"
        style={{
          transform: `translate3d(${Math.round(pos.x)}px, ${Math.round(pos.y)}px, 0)`,
          width: panelWidth,
        }}
      >
        {/* 头部：拖动柄 + 卡片导航 + 收起/关闭 */}
        <div
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={handleHeaderPointerMove}
          onPointerUp={endHeaderDrag}
          onPointerCancel={endHeaderDrag}
          className="flex h-10 cursor-grab touch-none select-none items-center gap-1.5 border-b bg-muted/40 px-2.5 active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
          <span className="shrink-0 text-xs font-medium">工具面板</span>
          {card ? (
            <span className="ml-1 min-w-0 truncate text-[11px] tabular-nums text-muted-foreground">
              #{card.cardIndex} · {cardIndex + 1}/{cards.length}
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label={collapsed ? "展开面板" : "收起面板"}
              className={HEADER_ICON_BUTTON_CLASS}
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? (
                <Maximize2 className="h-3.5 w-3.5" />
              ) : (
                <Minus className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              aria-label="关闭工具面板"
              className={HEADER_ICON_BUTTON_CLASS}
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {!collapsed && (
          <div className="max-h-[calc(100vh-140px)] overflow-y-auto">
            {cards.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                <Images className="h-8 w-8 opacity-30" />
                <p className="text-xs text-muted-foreground">
                  当前任务暂无卡片，先添加卡片再使用工具面板
                </p>
              </div>
            ) : !card ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                <Images className="h-8 w-8 opacity-30" />
                <p className="text-xs text-muted-foreground">
                  点击网格中的任意卡片，在此查看与编辑
                </p>
              </div>
            ) : (
              <>
                {/* 卡片图片库 */}
                <section className="border-b px-3 py-2.5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      卡片图片库
                    </span>
                  </div>

                  {/* 分段切换：生成图片 / 上传图片 */}
                  <div className="mb-2 inline-flex rounded-md border border-border bg-muted/30 p-0.5 text-[11px]">
                    <button
                      type="button"
                      className={cn(
                        "rounded-[5px] px-2.5 py-1 font-medium transition-colors",
                        tab === "generated"
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setTab("generated")}
                    >
                      生成图片 {generatedImages.length}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "rounded-[5px] px-2.5 py-1 font-medium transition-colors",
                        tab === "uploaded"
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setTab("uploaded")}
                    >
                      上传图片 {uploadedImages.length}
                    </button>
                  </div>

                  {/* 2 行 × 4 列方形缩略图：固定 8 格（不足补虚线占位），
                      生成/上传两个页签及各页高度完全一致；
                      右侧纵向上下翻页列常驻（仅 1 页时禁用），避免缩略图宽度跳动 */}
                  <div className="flex gap-1.5">
                    <div className="relative grid flex-1 grid-cols-4 gap-1.5">
                      {pageImages.map(renderThumbnail)}
                      {Array.from({
                        length: PAGE_SIZE - pageImages.length,
                      }).map((_, index) => (
                        <div
                          key={`empty-slot-${index}`}
                          className="aspect-square rounded-md border border-dashed border-border/60 bg-muted/20"
                        />
                      ))}
                      {pageImages.length === 0 && (
                        <span className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
                          暂无{tab === "generated" ? "生成" : "上传"}图片
                        </span>
                      )}
                    </div>
                    <div className="flex w-7 shrink-0 flex-col items-center justify-center gap-1 self-stretch">
                      <button
                        type="button"
                        aria-label="上一页"
                        className={HEADER_ICON_BUTTON_CLASS}
                        disabled={currentPage <= 0}
                        onClick={() => setPage(currentPage - 1)}
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {currentPage + 1}/{totalPages}
                      </span>
                      <button
                        type="button"
                        aria-label="下一页"
                        className={HEADER_ICON_BUTTON_CLASS}
                        disabled={currentPage >= totalPages - 1}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* 参考图（固定展示，不随上方切换） */}
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      参考图 {referenceImages.length}
                      {referenceLimit > 0
                        ? `/${referenceLimit}`
                        : ""}
                    </span>
                    <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
                      {referenceImages.map((url, index) => (
                        <button
                          key={url}
                          type="button"
                          aria-label={`参考图 ${index + 1}`}
                          className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border border-violet-500/50 shadow-sm transition-shadow hover:shadow-md"
                          onMouseEnter={() => showPreview(url)}
                          onMouseLeave={hidePreview}
                          onClick={() => {
                            setRefViewerIndex(index)
                            setRefViewerOpen(true)
                          }}
                        >
                          <SmartImage
                            src={toImageSrc(url, { width: 120, height: 120 })}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        </button>
                      ))}
                      {referenceImages.length === 0 && (
                        <span className="self-center text-[10px] text-muted-foreground/70">
                          暂无
                        </span>
                      )}
                    </div>
                    {referenceLimit > 0 && (
                      <button
                        type="button"
                        className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        onClick={() => {
                          setGalleryInitialMode("reference")
                          setGalleryOpen(true)
                        }}
                      >
                        管理
                      </button>
                    )}
                  </div>
                </section>

                {/* 提示词 */}
                <section className="border-b px-3 py-2.5">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      提示词
                    </span>
                    {card.translatedPrompt &&
                      card.translationSourcePrompt !== card.prompt && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400">
                          中文已修改，译文未同步
                        </span>
                      )}
                  </div>
                  <Textarea
                    value={prompt}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    onBlur={handlePromptBlur}
                    className="min-h-[88px] resize-none text-xs leading-relaxed"
                    placeholder="输入提示词，修改后自动保存..."
                    disabled={isLoading}
                  />
                </section>

                {/* 操作按钮 */}
                <section className="flex items-center gap-1.5 px-3 py-2.5">
                  <Button
                    size="sm"
                    className="h-8 flex-1 gap-1.5 rounded-md bg-primary px-3 text-[11px] text-primary-foreground shadow-sm hover:bg-primary/90"
                    onClick={() => void handleGenerateImage()}
                    disabled={isLoading}
                  >
                    {generatingImage ? (
                      <MorphingInfinity className="h-3.5 w-3.5" />
                    ) : (
                      <ImagePlus className="h-3.5 w-3.5" />
                    )}
                    {hasImage ? "重新生成图片" : "生成图片"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 rounded-md px-3 text-[11px]"
                    onClick={() => void handleDeepen()}
                    disabled={isLoading}
                  >
                    {deepening ? (
                      <MorphingInfinity className="h-3.5 w-3.5" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    细化提示词
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card/80 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
                      title="更多操作"
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      side="top"
                      align="end"
                      className="w-44"
                      positionerClassName="z-50"
                    >
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
                        disabled={isLoading}
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
                        disabled={isLoading}
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
                  <input
                    ref={uploadInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    className="hidden"
                    onChange={handleUploadReference}
                  />
                </section>
              </>
            )}
          </div>
        )}
      </div>

      {/* 悬浮全比例预览（面板旁浮动，贴边左右翻转，不拦截鼠标；
          只显示图片本身——无外框/底色，尺寸按图片比例自适应） */}
      {preview && !collapsed && (
        <div
          className="pointer-events-none fixed z-40"
          style={previewStyle}
        >
          <SmartImage
            src={toImageSrc(preview.url, { width: 640, height: 640 })}
            alt=""
            className="h-auto w-auto max-w-[min(34vw,380px)] max-h-[min(52vh,480px)] rounded-lg object-contain shadow-xl"
          />
        </div>
      )}

      {/* 复用：图片库（查看全部 / 管理参考图） */}
      {card && (
        <ImageGalleryDialog
          open={galleryOpen}
          onOpenChange={setGalleryOpen}
          cardId={card.id}
          selectedImageModel={selectedImageModel}
          initialMode={galleryInitialMode}
          onImageSelected={(image) => {
            if (!card) return
            setSelectedOverrideId(image.id)
            // 同步选中图冗余字段，卡片正面立即切换（与卡片背面行为一致）
            onCardUpdated({
              ...card,
              selectedImageId: image.id,
              selImgId: image.id,
              selImgUrl: image.imageUrl,
              selImgModelName: image.modelName,
              selImgSize: image.size,
              selImgStartedAt: image.generationStartedAt,
              selImgCompletedAt: image.generationCompletedAt,
              selImgCreatedAt: image.createdAt,
            })
          }}
          onReferenceImagesChanged={handleReferenceImagesChanged}
        />
      )}

      {/* 复用：生成/上传图大图查看器 */}
      <ImageViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        images={completedImageUrls}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        info={viewerInfo}
      />

      {/* 复用：参考图大图查看器 */}
      <ImageViewer
        open={refViewerOpen}
        onOpenChange={setRefViewerOpen}
        images={referenceImages}
        index={refViewerIndex}
        onIndexChange={setRefViewerIndex}
        info={refViewerInfo}
      />

      {/* 删除确认 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              删除卡片
            </DialogTitle>
          </DialogHeader>
          <p className="py-1 text-sm text-muted-foreground">
            确认删除卡片 #{card?.cardIndex}？该卡片的提示词与图片记录将一并移除，此操作不可撤销。
          </p>
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
              disabled={deleting}
              onClick={() => void handleDeleteCard()}
            >
              {deleting ? <MorphingInfinity className="h-4 w-4" /> : null}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>,
    document.body,
  )
}
