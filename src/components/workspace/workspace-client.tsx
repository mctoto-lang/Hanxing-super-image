"use client"

import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import { useRouter } from "next/navigation"
import {
  Plus,
  Search,
  CheckCircle2,
  XCircle,
  Trash2,
  ChevronDown,
  Wand2,
  ImagePlus,
  CheckSquare,
  Download,
  PanelRight,
  Square,
  Pin,
  PinOff,
  MoreVertical,
  Pencil,
  AlertCircle,
  RefreshCw,
  Sparkles,
  ArrowUp,
  Replace,
  Languages,
  LibraryBig,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn, toImageSrc } from "@/lib/utils"
import { SmartImage } from "@/components/ui/smart-image"
import { toast } from "sonner"
import { Spinner } from "@/components/workspace/spinner"
import { NewTaskDialog } from "@/components/workspace/new-task-dialog"
import { CardGrid } from "@/components/workspace/card-grid"
import { ToolPanel } from "@/components/workspace/tool-panel"
import { TemplateSelectDialog } from "@/components/workspace/template-select-dialog"
import { ModelSelectDialog } from "@/components/workspace/model-select-dialog"
import { SizeSelectDialog } from "@/components/workspace/size-select-dialog"
import { ExportDialog } from "@/components/workspace/export-dialog"
import { BatchConfirmDialog } from "@/components/workspace/batch-confirm-dialog"
import { GenerationConfigDialog } from "@/components/workspace/generation-config-dialog"
import { BatchReplacePromptDialog } from "@/components/workspace/batch-replace-prompt-dialog"
import { BatchImageUploadDialog } from "@/components/workspace/batch-image-upload-dialog"
import {
  listWorkspaceTasksAction,
  getTaskStatusAction,
  updateTaskAction,
  deleteTaskAction,
  pinTaskAction,
  unpinTaskAction,
  getTaskCardsAction,
  getTaskCardImagesAction,
  addCardAction,
  batchDeleteCardsAction,
  batchGenerateImageAction,
  batchDeepenAction,
  batchRegeneratePromptAction,
  batchTranslatePromptAction,
} from "@/server/actions/workspace"
import {
  findCountMismatch,
  getBatchGenerationLanguageSummary,
  mergeImageRows,
  sameCardDisplay,
} from "@/lib/workspace/helpers"
import type {
  WorkspaceTaskRow,
  PromptCardRow,
  CardImageRow,
  TemplateRow,
  ImageModelRow,
  TaskCardImagesPayload,
  StoredGenerationConfig,
  BatchGenerationLanguage,
} from "@/lib/workspace/types"

// ─── 常量 ───

const SIDEBAR_WIDTH = 280
const GENERATION_CONFIG_STORAGE_KEY = "workspace:generation-config"
const TASKS_PAGE_SIZE = 30
const WORKSPACE_CARDS_PAGE_SIZE = 500
// 图片全量重同步冷却：对账发现增量丢行时全量拉一次，冷却防止 bug 场景下每 tick 全量
const IMAGES_RESYNC_COOLDOWN_MS = 15_000

// ─── localStorage 生成配置 ───

function loadStoredGenerationConfig(): StoredGenerationConfig {
  const emptyConfig: StoredGenerationConfig = {
    fissionTemplate: null,
    refineTemplate: null,
    regenTemplate: null,
    extractTemplate: null,
    translateTemplate: null,
    imageModel: null,
    size: null,
  }
  if (typeof window === "undefined") return emptyConfig
  try {
    const raw = localStorage.getItem(GENERATION_CONFIG_STORAGE_KEY)
    if (!raw) return emptyConfig
    return { ...emptyConfig, ...JSON.parse(raw) }
  } catch {
    return emptyConfig
  }
}

function saveStoredGenerationConfig(config: StoredGenerationConfig) {
  if (typeof window === "undefined") return
  localStorage.setItem(GENERATION_CONFIG_STORAGE_KEY, JSON.stringify(config))
}

// ─── 卡片合并辅助（轮询时保留本地 prompt 编辑 + 身份稳定） ───

function mergeCardsWithImageSummary(
  fetchedCards: PromptCardRow[],
  payload: TaskCardImagesPayload,
  previousCards: PromptCardRow[] = [],
): PromptCardRow[] {
  const previousCardMap = new Map(previousCards.map((card) => [card.id, card]))

  // 按 card.id 去重，避免后端 JOIN 膨胀导致重复渲染
  const dedupedCards = Array.from(
    fetchedCards.reduce(
      (map, card) => map.set(card.id, card),
      new Map<string, PromptCardRow>(),
    ).values(),
  )

  return dedupedCards.map((card) => {
    const summary = payload.cards[card.id]
    const selected = summary?.selectedImage
    const previousCard = previousCardMap.get(card.id)

    let merged: PromptCardRow
    if (!selected) {
      merged = !previousCard
        ? card
        : {
            ...previousCard,
            ...card,
            // 轮询期间保留本地 prompt，避免覆盖用户正在编辑的内容
            prompt: previousCard.prompt,
            translatedPrompt: previousCard.translatedPrompt,
            translationSourcePrompt: previousCard.translationSourcePrompt,
            translationStatus: previousCard.translationStatus,
            selectedImageId: card.selectedImageId ?? previousCard.selectedImageId,
            selImgId: card.selImgId ?? previousCard.selImgId,
            selImgUrl: card.selImgUrl ?? previousCard.selImgUrl,
            selImgModelName: card.selImgModelName ?? previousCard.selImgModelName,
            selImgSize: card.selImgSize ?? previousCard.selImgSize,
            selImgStartedAt: card.selImgStartedAt ?? previousCard.selImgStartedAt,
            selImgCompletedAt:
              card.selImgCompletedAt ?? previousCard.selImgCompletedAt,
            selImgCreatedAt: card.selImgCreatedAt ?? previousCard.selImgCreatedAt,
          }
    } else {
      merged = {
        ...previousCard,
        ...card,
        prompt: previousCard ? previousCard.prompt : card.prompt,
        translatedPrompt: previousCard
          ? previousCard.translatedPrompt
          : card.translatedPrompt,
        translationSourcePrompt: previousCard
          ? previousCard.translationSourcePrompt
          : card.translationSourcePrompt,
        translationStatus: previousCard
          ? previousCard.translationStatus
          : card.translationStatus,
        selectedImageId: selected.id,
        selImgId: selected.id,
        selImgUrl: selected.imageUrl,
        selImgModelName: selected.modelName,
        selImgSize: selected.size,
        selImgStartedAt: selected.startedAt,
        selImgCompletedAt: selected.completedAt,
        selImgCreatedAt: selected.createdAt,
      }
    }
    // 渲染相关字段未变化 → 复用旧对象引用，FlipCard memo 跳过重渲染
    if (previousCard && sameCardDisplay(previousCard, merged)) {
      return previousCard
    }
    return merged
  })
}

function buildCardImagesMap(
  payload: TaskCardImagesPayload,
  fallbackMap?: Map<string, CardImageRow[]>,
): Map<string, CardImageRow[]> {
  const incremental = Boolean(payload.incremental)
  const next = new Map<string, CardImageRow[]>()
  Object.values(payload.cards).forEach((summary) => {
    next.set(
      summary.cardId,
      mergeImageRows(
        fallbackMap?.get(summary.cardId),
        summary.images || [],
        incremental,
      ),
    )
  })
  if (fallbackMap) {
    for (const [cardId, images] of fallbackMap.entries()) {
      if (!next.has(cardId)) next.set(cardId, images)
    }
  }
  return next
}

// ─── 状态配置 ───

const statusConfig = {
  generating: {
    label: "生成中",
    icon: MorphingInfinity,
    className:
      "text-amber-600 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800",
  },
  completed: {
    label: "已完成",
    icon: CheckCircle2,
    className:
      "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800",
  },
  failed: {
    label: "未完成",
    icon: XCircle,
    className:
      "text-red-600 bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800",
  },
} as const

// ─── 辅助纯函数 ───

function getRenamedTaskTitle(title: string): string | null {
  const normalizedTitle = title.trim()
  return normalizedTitle || null
}

function shouldShowTaskActions(isEditingTitle: boolean): boolean {
  return !isEditingTitle
}

// ─── 侧边栏骨架屏 ───

function TaskSidebarSkeleton() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="px-2 py-1.5">
          <div className="rounded-md border border-border/60 bg-background/70 px-3 py-3">
            <div className="flex items-start gap-3">
              <Skeleton className="h-12 w-12 rounded-md shrink-0" />
              <div className="flex-1 space-y-2.5 pt-0.5">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3 w-2/3" />
                <div className="flex items-center gap-2 pt-1">
                  <Skeleton className="h-5 w-12 rounded-full" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── 任务卡片（memo） ───

interface TaskCardProps {
  task: WorkspaceTaskRow
  isActive: boolean
  isPinned: boolean
  onClick: () => void
  onPin: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => Promise<boolean>
}

const TaskCard = memo(function TaskCard({
  task,
  isActive,
  isPinned,
  onClick,
  onPin,
  onDelete,
  onRename,
}: TaskCardProps) {
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(task.title)
  const isSavingTitleRef = useRef(false)
  const showTaskActions = shouldShowTaskActions(isEditingTitle)
  const { label, icon: Icon, className } = statusConfig[task.status]
  const thumbnailUrls = task.thumbnailUrls.length
    ? task.thumbnailUrls.slice(0, 3)
    : task.thumbnailUrl
      ? [task.thumbnailUrl]
      : []
  const hasThumbnail = thumbnailUrls.length > 0
  const stackLayers = [
    "translate-x-2 translate-y-2 rotate-0",
    "translate-x-1 translate-y-1 -rotate-6",
    "translate-x-0 translate-y-0 -rotate-12",
  ]

  // 计算细分状态：生成中优先，其次失败
  const generatingCount = task.generatingImageCount || 0
  const failedCount = task.failedImageCount || 0
  const hasGenerating = generatingCount > 0
  const hasFailed = failedCount > 0
  const subStatus = hasGenerating ? "generating" : hasFailed ? "failed" : null

  const startEditingTitle = () => {
    setTitleDraft(task.title)
    setIsEditingTitle(true)
  }

  const cancelEditingTitle = () => {
    setTitleDraft(task.title)
    setIsEditingTitle(false)
  }

  const saveTitle = async () => {
    if (!isEditingTitle || isSavingTitleRef.current) return
    const title = getRenamedTaskTitle(titleDraft)
    if (!title) {
      toast.error("任务名称不能为空")
      cancelEditingTitle()
      return
    }
    if (title === task.title) {
      cancelEditingTitle()
      return
    }

    isSavingTitleRef.current = true
    const renamed = await onRename(task.id, title)
    isSavingTitleRef.current = false
    if (renamed) setIsEditingTitle(false)
  }

  return (
    <div
      onClick={onClick}
      className={cn(
        "group relative px-3 py-2.5 rounded-md cursor-pointer transition-colors border",
        isActive
          ? "bg-primary/8 border-primary/30 text-foreground"
          : "border-transparent hover:bg-accent hover:border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {/* hover 出现的「更多」菜单：置顶/重命名/删除 */}
      {showTaskActions && (
        <DropdownMenu>
          <DropdownMenuTrigger
            onClick={(e) => e.stopPropagation()}
            className="absolute right-2 top-2 z-10 cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
            aria-label="更多操作"
            title="更多操作"
          >
            <MoreVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-32"
            positionerClassName="z-40"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuItem onClick={() => onPin(task.id)}>
              {isPinned ? (
                <PinOff className="size-4" />
              ) : (
                <Pin className="size-4" />
              )}
              {isPinned ? "取消置顶" : "置顶"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => startEditingTitle()}>
              <Pencil className="size-4" />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onDelete(task.id)}>
              <Trash2 className="size-4" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <div className="flex gap-3">
        <div className="relative h-16 w-16 shrink-0">
          {stackLayers.map((layerClass, index) => {
            const imageIndex = index - (stackLayers.length - thumbnailUrls.length)
            const layerImageUrl = imageIndex >= 0 ? thumbnailUrls[imageIndex] : undefined
            const isTopLayer = index === stackLayers.length - 1

            return (
              <div
                key={layerClass}
                className={cn(
                  "absolute left-0 top-0 flex h-14 w-14 items-center justify-center overflow-hidden rounded-md border border-border bg-muted shadow-sm",
                  layerClass,
                  !isTopLayer && "opacity-80",
                )}
              >
                {layerImageUrl ? (
                  // 远程动态图片：SmartImage 带过期占位
                  <SmartImage
                    src={toImageSrc(layerImageUrl)}
                    alt={isTopLayer ? task.title : ""}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  isTopLayer &&
                  !hasThumbnail && (
                    <div className="text-xl font-semibold leading-none text-foreground">
                      {task.cardCount}
                    </div>
                  )
                )}
              </div>
            )
          })}
        </div>

        <div className="min-w-0 flex-1 pr-1">
          {isEditingTitle ? (
            <Input
              autoFocus
              value={titleDraft}
              maxLength={200}
              className="h-6 px-1 text-sm font-medium leading-5"
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === "Enter") {
                  event.preventDefault()
                  void saveTitle()
                }
                if (event.key === "Escape") {
                  event.preventDefault()
                  cancelEditingTitle()
                }
              }}
              onBlur={() => void saveTitle()}
            />
          ) : (
            <div
              className="text-sm font-medium truncate leading-5"
              onDoubleClick={(event) => {
                event.stopPropagation()
                startEditingTitle()
              }}
            >
              {task.title}
            </div>
          )}
          <div className="mt-1 truncate text-xs leading-4 text-muted-foreground">
            {task.themePrompt || "暂无主题提示词"}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground shrink-0 mr-auto">
              {new Date(task.createdAt).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {/* 细分状态图标（只显示图标） */}
              {subStatus && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger render={<span />}>
                      <span
                        className={cn(
                          "inline-flex h-5 w-5 items-center justify-center rounded-full shrink-0",
                          subStatus === "generating"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
                            : "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
                        )}
                      >
                        {subStatus === "generating" ? (
                          <MorphingInfinity className="h-3 w-3" />
                        ) : (
                          <AlertCircle className="h-3 w-3" />
                        )}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {subStatus === "generating"
                        ? `${generatingCount} 张图片生成中`
                        : `${failedCount} 张图片生成失败`}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {/* 任务级状态标签 */}
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border font-medium shrink-0",
                  className,
                )}
              >
                <Icon className="h-2.5 w-2.5" />
                {label}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})

// ─── 主组件 ───

interface WorkspaceClientProps {
  initialTasks: WorkspaceTaskRow[]
  initialModels: ImageModelRow[]
}

type BatchConfirmState = {
  action: string
  count: number
  onConfirm: () => void
  generationLanguage?: BatchGenerationLanguage
  languageSummary?: ReturnType<typeof getBatchGenerationLanguageSummary>
} | null

export function WorkspaceClient({
  initialTasks,
  initialModels,
}: WorkspaceClientProps) {
  // ─── 任务列表状态 ───
  const [tasks, setTasks] = useState<WorkspaceTaskRow[]>(initialTasks)
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [taskPage, setTaskPage] = useState(1)
  const [hasMoreTasks, setHasMoreTasks] = useState(
    initialTasks.length >= TASKS_PAGE_SIZE,
  )

  // ─── 当前任务 ───
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [activeTask, setActiveTask] = useState<WorkspaceTaskRow | null>(null)

  // ─── 卡片状态 ───
  const [cards, setCards] = useState<PromptCardRow[]>([])
  const [cardImagesMap, setCardImagesMap] = useState<
    Map<string, CardImageRow[]>
  >(new Map())
  const [loadingCards, setLoadingCards] = useState(false)

  // ─── 批量模式 ───
  const [batchMode, setBatchMode] = useState(false)
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(
    new Set(),
  )
  const [flipAllToImage, setFlipAllToImage] = useState(false)

  // ─── 工具面板（与批量模式互斥） ───
  const [toolPanelOpen, setToolPanelOpen] = useState(false)
  const [activeCardId, setActiveCardId] = useState<string | null>(null)

  // ─── 生成配置（localStorage 持久化） ───
  const [selectedFissionTemplate, setSelectedFissionTemplate] =
    useState<TemplateRow | null>(() => loadStoredGenerationConfig().fissionTemplate)
  const [selectedDeepenTemplate, setSelectedDeepenTemplate] =
    useState<TemplateRow | null>(() => loadStoredGenerationConfig().refineTemplate)
  const [selectedRegenTemplate, setSelectedRegenTemplate] =
    useState<TemplateRow | null>(() => loadStoredGenerationConfig().regenTemplate)
  const [selectedExtractTemplate, setSelectedExtractTemplate] =
    useState<TemplateRow | null>(() => loadStoredGenerationConfig().extractTemplate)
  const [selectedTranslateTemplate, setSelectedTranslateTemplate] =
    useState<TemplateRow | null>(() => loadStoredGenerationConfig().translateTemplate)
  const [selectedImageModel, setSelectedImageModel] =
    useState<ImageModelRow | null>(
      () => loadStoredGenerationConfig().imageModel ?? initialModels[0] ?? null,
    )
  const [selectedSize, setSelectedSize] = useState<string | null>(
    () => loadStoredGenerationConfig().size,
  )

  // ─── 对话框状态 ───
  const router = useRouter()
  const [showNewTask, setShowNewTask] = useState(false)
  const [showGenerationConfigDialog, setShowGenerationConfigDialog] =
    useState(false)
  const [showBatchReplacePromptDialog, setShowBatchReplacePromptDialog] =
    useState(false)
  const [showBatchImageUploadDialog, setShowBatchImageUploadDialog] =
    useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showModelDialog, setShowModelDialog] = useState(false)
  const [showSizeDialog, setShowSizeDialog] = useState(false)

  // ─── 确认对话框 ───
  const [batchConfirm, setBatchConfirm] = useState<BatchConfirmState>(null)
  const [deleteConfirmTask, setDeleteConfirmTask] =
    useState<WorkspaceTaskRow | null>(null)

  // ─── 批量操作加载状态 ───
  const [batchDeepeningCardIds, setBatchDeepeningCardIds] = useState<
    Set<string>
  >(new Set())
  const [batchRegeneratingCardIds, setBatchRegeneratingCardIds] = useState<
    Set<string>
  >(new Set())
  const [batchTranslatingCardIds, setBatchTranslatingCardIds] = useState<
    Set<string>
  >(new Set())
  const [batchGeneratingImageCardIds, setBatchGeneratingImageCardIds] =
    useState<Set<string>>(new Set())
  // 单张生图状态
  const [generatingImageCardIds, setGeneratingImageCardIds] = useState<
    Set<string>
  >(new Set())

  // ─── UI 状态 ───
  const [showScrollToTop, setShowScrollToTop] = useState(false)

  // ─── Refs（轮询定时器 + 防竞态） ───
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cardImagesPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const translatePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 增量轮询游标（上一轮 serverTime）；null = 下次全量拉取
  const cardImagesSinceRef = useRef<string | null>(null)
  // cardImagesMap 镜像：轮询对账需要在 setState 后立即读取最新 map（不等 effect）
  const cardImagesMapRef = useRef<Map<string, CardImageRow[]>>(new Map())
  // 上次图片全量重同步时间戳（对账冷却）
  const lastImagesResyncAtRef = useRef(0)
  const taskRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const cardScrollContainerRef = useRef<HTMLDivElement | null>(null)

  // ─── Refs（避免 stale closure） ───
  const activeTaskIdRef = useRef<string | null>(null)
  const tasksRef = useRef(tasks)
  const cardsRef = useRef(cards)
  const fetchTasksRef = useRef<(_page?: number, _append?: boolean) => Promise<void>>(
    async () => {},
  )
  const fetchCardsRef = useRef<(_taskId: string) => Promise<void>>(
    async () => {},
  )
  const pollTaskStatusRef = useRef<(_taskId: string) => Promise<void>>(
    async () => {},
  )
  const pollCardImagesRef = useRef<() => Promise<void>>(async () => {})
  const stopCardImagesPollRef = useRef<() => void>(() => {})
  const startCardImagesPollRef = useRef<() => void>(() => {})
  const activeCardIdRef = useRef<string | null>(null)

  useEffect(() => {
    activeTaskIdRef.current = activeTaskId
  }, [activeTaskId])
  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])
  useEffect(() => {
    cardsRef.current = cards
  }, [cards])
  useEffect(() => {
    activeCardIdRef.current = activeCardId
  }, [activeCardId])

  // ─── 工具面板开关（与批量模式互斥：后开者关闭先开者） ───
  const toggleToolPanel = useCallback(() => {
    setToolPanelOpen((prev) => {
      const next = !prev
      if (next) {
        setBatchMode(false)
        setSelectedCardIds(new Set())
        setFlipAllToImage(false)
        // 无活动卡片时默认聚焦第一张，面板打开即有内容
        setActiveCardId((current) => current ?? cardsRef.current[0]?.id ?? null)
      }
      return next
    })
  }, [])

  // ─── 排序任务（置顶优先） ───
  const sortedTasks = useMemo(() => {
    return [...tasks].sort(
      (a, b) => Number(b.isPinned) - Number(a.isPinned),
    )
  }, [tasks])
  // 置顶组在上（无标签），「最近」标签下为其余任务（同自由创作侧栏）
  const pinnedTasks = sortedTasks.filter((t) => t.isPinned)
  const recentTasks = sortedTasks.filter((t) => !t.isPinned)

  // ─── 数据获取 ───

  const fetchTasks = useCallback(
    async (page = 1, append = false) => {
      setLoadingTasks(true)
      try {
        const data = await listWorkspaceTasksAction({
          page,
          pageSize: TASKS_PAGE_SIZE,
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
        })
        if (append) {
          setTasks((prev) => [...prev, ...(data.tasks || [])])
        } else {
          setTasks(data.tasks || [])
        }
        setHasMoreTasks((data.tasks?.length || 0) === TASKS_PAGE_SIZE)
      } catch {
        toast.error("获取任务列表失败")
      } finally {
        setLoadingTasks(false)
      }
    },
    [debouncedSearch],
  )

  const fetchCards = useCallback(async (taskId: string) => {
    setLoadingCards(true)
    try {
      const [cardsData, imagesData] = await Promise.all([
        getTaskCardsAction(taskId, { pageSize: WORKSPACE_CARDS_PAGE_SIZE }),
        getTaskCardImagesAction(taskId),
      ])
      // 竞态保护：如果请求返回后 activeTaskId 已变化，丢弃本次结果
      if (activeTaskIdRef.current !== taskId) return
      const fetchedCards = cardsData.cards
      setCards(mergeCardsWithImageSummary(fetchedCards, imagesData, []))
      const nextMap = buildCardImagesMap(imagesData)
      setCardImagesMap(nextMap)
      cardImagesMapRef.current = nextMap

      // 刷新/切任务回到进行中的批量：自动续上图片轮询（否则完成态永远不更新）
      const hasPending = Object.values(imagesData.cards).some(
        (s) => s.pendingCount > 0,
      )
      if (hasPending && !cardImagesPollRef.current && !batchPollRef.current) {
        startCardImagesPollRef.current()
      }
    } catch {
      toast.error("获取卡片列表失败")
    } finally {
      setLoadingCards(false)
    }
  }, [])

  // ─── 轮询 ───

  // 单张生图在提交动作落库前就会启动轮询，首个 tick 可能读不到 pending；
  // 只有「已观测到 pending」或超过宽限期后才允许停止，避免轮询被竞态误停
  const CARD_IMAGES_POLL_GRACE_MS = 15_000
  const cardImagesPollSawPendingRef = useRef(false)
  const cardImagesPollStartedAtRef = useRef(0)

  // cardImagesMap 镜像随 state 同步（轮询外的 setCardImagesMap：切任务清空、上传等）
  useEffect(() => {
    cardImagesMapRef.current = cardImagesMap
  }, [cardImagesMap])

  /** 对账兜底：增量丢行时全量重同步一次，返回新游标（serverTime） */
  const resyncFullImages = useCallback(
    async (taskId: string): Promise<string | undefined> => {
      const full = await getTaskCardImagesAction(taskId)
      if (activeTaskIdRef.current !== taskId) return undefined
      const fullMap = buildCardImagesMap(full)
      setCardImagesMap(fullMap)
      cardImagesMapRef.current = fullMap
      setCards((prev) => mergeCardsWithImageSummary(prev, full, prev))
      return full.serverTime
    },
    [],
  )

  const pollTaskStatus = useCallback(async (taskId: string) => {
    try {
      const data = await getTaskStatusAction(taskId)
      if (!data) return
      if (data.status === "completed" || data.status === "failed") {
        if (pollingRef.current) {
          clearInterval(pollingRef.current)
          pollingRef.current = null
        }
        await fetchTasksRef.current(1)
        if (data.status === "completed" && activeTaskIdRef.current === taskId) {
          await fetchCardsRef.current(taskId)
          setActiveTask((prev) =>
            prev
              ? {
                  ...prev,
                  status: data.status as WorkspaceTaskRow["status"],
                  cardCount: data.cardCount,
                  errorMessage: data.errorMessage,
                }
              : prev,
          )
        }
      }
    } catch (e) {
      console.error("轮询任务状态失败:", e)
    }
  }, [])

  const pollCardImages = useCallback(async () => {
    const currentTaskId = activeTaskIdRef.current
    if (!currentTaskId) return
    // 首轮（无游标）全量拉取卡片行；后续 tick 只拉图片增量，卡片合并基于现有 state
    const isFirstTick = cardImagesSinceRef.current === null
    try {
      const [cardsData, imagesData] = await Promise.all([
        isFirstTick
          ? getTaskCardsAction(currentTaskId, {
              pageSize: WORKSPACE_CARDS_PAGE_SIZE,
            })
          : Promise.resolve(null),
        getTaskCardImagesAction(
          currentTaskId,
          cardImagesSinceRef.current ?? undefined,
        ),
      ])
      // 竞态保护
      if (activeTaskIdRef.current !== currentTaskId) return
      if (imagesData.serverTime) {
        cardImagesSinceRef.current = imagesData.serverTime
      }
      const fetchedCards = cardsData?.cards
      setCards((prev) =>
        mergeCardsWithImageSummary(fetchedCards ?? prev, imagesData, prev),
      )
      const mergedMap = buildCardImagesMap(imagesData, cardImagesMapRef.current)
      setCardImagesMap(mergedMap)
      cardImagesMapRef.current = mergedMap

      // 对账兜底：服务端计数与本地不一致 = 增量丢行，冷却内做一次全量重同步
      if (
        findCountMismatch(imagesData, mergedMap).length > 0 &&
        Date.now() - lastImagesResyncAtRef.current > IMAGES_RESYNC_COOLDOWN_MS
      ) {
        lastImagesResyncAtRef.current = Date.now()
        const serverTime = await resyncFullImages(currentTaskId)
        if (serverTime) cardImagesSinceRef.current = serverTime
      }

      // 检查是否还有 pending/generating 的图片，如果没有则停止轮询
      let hasAnyPending = false
      for (const summary of Object.values(imagesData.cards)) {
        if (summary.pendingCount > 0) {
          hasAnyPending = true
          break
        }
      }
      if (hasAnyPending) {
        cardImagesPollSawPendingRef.current = true
      }
      const pastGrace =
        Date.now() - cardImagesPollStartedAtRef.current >
        CARD_IMAGES_POLL_GRACE_MS
      if (
        !hasAnyPending &&
        (cardImagesPollSawPendingRef.current || pastGrace) &&
        cardImagesPollRef.current
      ) {
        clearInterval(cardImagesPollRef.current)
        cardImagesPollRef.current = null
        setGeneratingImageCardIds(new Set())
        setBatchGeneratingImageCardIds(new Set())
        void fetchTasksRef.current(1)
        // 末轮全量刷新卡片行，补齐 selImg/选中信息
        void fetchCardsRef.current(currentTaskId)
      }

      // 清除已完成的单张生图状态
      setGeneratingImageCardIds((prev) => {
        const next = new Set(prev)
        for (const card of cardsRef.current) {
          const summary = imagesData.cards[card.id]
          if (!summary || summary.pendingCount === 0) next.delete(card.id)
        }
        if (next.size === prev.size) return prev
        return next
      })
    } catch {
      // 轮询失败不中断
    }
  }, [resyncFullImages])

  const startCardImagesPoll = useCallback(() => {
    if (cardImagesPollRef.current) {
      clearInterval(cardImagesPollRef.current)
    }
    cardImagesSinceRef.current = null
    cardImagesPollSawPendingRef.current = false
    cardImagesPollStartedAtRef.current = Date.now()
    void pollCardImagesRef.current()
    cardImagesPollRef.current = setInterval(
      () => void pollCardImagesRef.current(),
      3000,
    )
  }, [])

  const stopCardImagesPoll = useCallback(() => {
    if (cardImagesPollRef.current) {
      clearInterval(cardImagesPollRef.current)
      cardImagesPollRef.current = null
    }
  }, [])

  // ─── 更新 refs ───
  useEffect(() => {
    fetchTasksRef.current = fetchTasks
  }, [fetchTasks])
  useEffect(() => {
    fetchCardsRef.current = fetchCards
  }, [fetchCards])
  useEffect(() => {
    pollTaskStatusRef.current = pollTaskStatus
  }, [pollTaskStatus])
  useEffect(() => {
    pollCardImagesRef.current = pollCardImages
  }, [pollCardImages])
  useEffect(() => {
    stopCardImagesPollRef.current = stopCardImagesPoll
  }, [stopCardImagesPoll])
  useEffect(() => {
    startCardImagesPollRef.current = startCardImagesPoll
  }, [startCardImagesPoll])

  // ─── 搜索防抖 ───
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 400)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // ─── 搜索/过滤变化时重新获取任务（跳过初始挂载） ───
  const isInitialMountRef = useRef(true)
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false
      return
    }
    setTaskPage(1)
    void fetchTasks(1)
  }, [fetchTasks])

  // ─── 滚动检测 ───
  useEffect(() => {
    const container = cardScrollContainerRef.current
    if (!container) return

    const handleScroll = () => {
      setShowScrollToTop(container.scrollTop > 240)
    }

    handleScroll()
    container.addEventListener("scroll", handleScroll)
    return () => container.removeEventListener("scroll", handleScroll)
  }, [activeTaskId, cards.length, loadingCards])

  // ─── 切换任务：清理旧数据 + 获取新数据 + 启动/停止轮询 ───
  useEffect(() => {
    if (activeTaskId) {
      const task = tasksRef.current.find((t) => t.id === activeTaskId)
      if (task) setActiveTask(task)
      // 切换任务时停止所有旧轮询，清空旧数据，避免串显其他任务卡片
      stopCardImagesPollRef.current()
      if (batchPollRef.current) {
        clearInterval(batchPollRef.current)
        batchPollRef.current = null
      }
      if (translatePollRef.current) {
        clearInterval(translatePollRef.current)
        translatePollRef.current = null
      }
      setCards([])
      setCardImagesMap(new Map())
      void fetchCardsRef.current(activeTaskId)
      setSelectedCardIds(new Set())
      setGeneratingImageCardIds(new Set())
      setBatchDeepeningCardIds(new Set())
      setBatchRegeneratingCardIds(new Set())
      setBatchGeneratingImageCardIds(new Set())
      setBatchTranslatingCardIds(new Set())

      if (pollingRef.current) clearInterval(pollingRef.current)
      if (task?.status === "generating") {
        pollingRef.current = setInterval(
          () => void pollTaskStatusRef.current(activeTaskId),
          3000,
        )
      }
    } else {
      stopCardImagesPollRef.current()
      setGeneratingImageCardIds(new Set())
      setBatchDeepeningCardIds(new Set())
      setBatchRegeneratingCardIds(new Set())
      setBatchGeneratingImageCardIds(new Set())
      setBatchTranslatingCardIds(new Set())
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [activeTaskId])

  // ─── tasks 变化时同步 activeTask 和轮询状态 ───
  useEffect(() => {
    if (!activeTaskId) return
    const task = tasks.find((t) => t.id === activeTaskId)
    if (task) setActiveTask(task)
    if (task?.status === "generating") {
      // 无条件重建定时器，确保轮询的是当前任务
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      pollingRef.current = setInterval(
        () => void pollTaskStatusRef.current(activeTaskId),
        3000,
      )
    } else {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
  }, [tasks, activeTaskId])

  // ─── 清理所有轮询 ───
  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      if (batchPollRef.current) {
        clearInterval(batchPollRef.current)
        batchPollRef.current = null
      }
      if (cardImagesPollRef.current) {
        clearInterval(cardImagesPollRef.current)
        cardImagesPollRef.current = null
      }
      if (translatePollRef.current) {
        clearInterval(translatePollRef.current)
        translatePollRef.current = null
      }
      if (taskRefreshTimeoutRef.current) {
        clearTimeout(taskRefreshTimeoutRef.current)
        taskRefreshTimeoutRef.current = null
      }
    }
  }, [])

  // ─── 滚动到顶部 ───
  const handleScrollToTop = useCallback(() => {
    cardScrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

  // ─── 任务操作 ───

  const handleTaskSelect = useCallback((task: WorkspaceTaskRow) => {
    setBatchMode(false)
    setSelectedCardIds(new Set())
    // 切换任务同样退出工具面板（与批量模式行为一致）
    setToolPanelOpen(false)
    setActiveCardId(null)
    setActiveTaskId(task.id)
  }, [])

  const handleTaskRename = useCallback(
    async (taskId: string, title: string): Promise<boolean> => {
      try {
        const result = await updateTaskAction(taskId, { title })
        if (!result.ok) throw new Error(result.error || "重命名失败")
        setTasks((prev) =>
          prev.map((task) => (task.id === taskId ? { ...task, title } : task)),
        )
        setActiveTask((prev) =>
          prev?.id === taskId ? { ...prev, title } : prev,
        )
        toast.success("任务名称已更新")
        return true
      } catch (error) {
        toast.error((error as Error).message || "重命名失败")
        return false
      }
    },
    [],
  )

  const handleRequestDeleteTask = useCallback((taskId: string) => {
    const task = tasksRef.current.find((t) => t.id === taskId)
    if (task) setDeleteConfirmTask(task)
  }, [])

  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      try {
        const result = await deleteTaskAction(taskId)
        if (!result.ok) throw new Error(result.error || "删除失败")
        toast.success("任务已删除")
        setTasks((prev) => prev.filter((t) => t.id !== taskId))
        if (activeTaskIdRef.current === taskId) {
          setActiveTaskId(null)
          setActiveTask(null)
          setCards([])
          setCardImagesMap(new Map())
          setGeneratingImageCardIds(new Set())
          setBatchDeepeningCardIds(new Set())
          setBatchRegeneratingCardIds(new Set())
          setBatchGeneratingImageCardIds(new Set())
          setBatchTranslatingCardIds(new Set())
        }
      } catch {
        toast.error("删除任务失败")
      }
    },
    [],
  )

  const handlePinTask = useCallback(async (taskId: string) => {
    const task = tasksRef.current.find((t) => t.id === taskId)
    const isPinned = task?.isPinned ?? false
    // 乐观更新
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, isPinned: !isPinned } : t)),
    )
    try {
      const result = isPinned
        ? await unpinTaskAction(taskId)
        : await pinTaskAction(taskId)
      if (!result.ok) throw new Error(result.error || "")
    } catch {
      // 失败时回滚
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, isPinned } : t)),
      )
      toast.error(isPinned ? "取消置顶失败" : "置顶失败")
    }
  }, [])

  const handleTaskCreated = useCallback((taskId: string, _cardCount: number) => {
    void fetchTasksRef.current(1)
    setActiveTaskId(taskId)
    setCards([])
    setShowNewTask(false)
    // 清理已有轮询再启动新轮询，避免多个 interval 并行
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    pollingRef.current = setInterval(
      () => void pollTaskStatusRef.current(taskId),
      3000,
    )
  }, [])

  // ─── 卡片操作 ───

  const handleCardUpdated = useCallback((updatedCard: PromptCardRow) => {
    setCards((prev) =>
      prev.map((c) => (c.id === updatedCard.id ? updatedCard : c)),
    )
    // 卡片图片状态变化时，防抖刷新任务列表以更新细分状态
    if (taskRefreshTimeoutRef.current) clearTimeout(taskRefreshTimeoutRef.current)
    taskRefreshTimeoutRef.current = setTimeout(
      () => void fetchTasksRef.current(1),
      500,
    )
  }, [])

  /** 单张卡片删除：从列表移除并同步任务卡片数（服务端已级联删图并更新 cardCount） */
  const handleCardDeleted = useCallback((cardId: string) => {
    // 工具面板：活动卡片被删时自动切到相邻卡片（删除发生在 setCards 之前，
    // cardsRef 仍是删除前的列表，可取到邻居）
    if (activeCardIdRef.current === cardId) {
      const list = cardsRef.current
      const index = list.findIndex((c) => c.id === cardId)
      const neighbor = list[index + 1] ?? list[index - 1] ?? null
      setActiveCardId(neighbor ? neighbor.id : null)
    }
    setCards((prev) => prev.filter((c) => c.id !== cardId))
    const taskId = activeTaskIdRef.current
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, cardCount: Math.max(0, t.cardCount - 1) }
          : t,
      ),
    )
    setActiveTask((prev) =>
      prev?.id === taskId
        ? { ...prev, cardCount: Math.max(0, prev.cardCount - 1) }
        : prev,
    )
  }, [])

  /** 添加空白卡片：直接落库（提示词为空），新卡自动翻到提示词面编辑 */
  const handleAddCard = useCallback(
    async (): Promise<PromptCardRow | null> => {
      const taskId = activeTaskIdRef.current
      if (!taskId) return null
      try {
        const result = await addCardAction(taskId, { prompt: "" })
        if (!result.ok || !result.cardId) {
          toast.error(result.error || "添加卡片失败")
          return null
        }
        // 重新获取卡片列表以拿到完整的新卡片数据
        const [cardsData, imagesData] = await Promise.all([
          getTaskCardsAction(taskId, { pageSize: WORKSPACE_CARDS_PAGE_SIZE }),
          getTaskCardImagesAction(taskId),
        ])
        if (activeTaskIdRef.current !== taskId) return null
        const fetchedCards = cardsData.cards
        setCards((prev) =>
          mergeCardsWithImageSummary(fetchedCards, imagesData, prev),
        )
        setCardImagesMap((prev) => buildCardImagesMap(imagesData, prev))
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId ? { ...t, cardCount: fetchedCards.length } : t,
          ),
        )
        setActiveTask((prev) =>
          prev?.id === taskId
            ? { ...prev, cardCount: fetchedCards.length }
            : prev,
        )
        toast.success("卡片已添加")
        return fetchedCards.find((c) => c.id === result.cardId) ?? null
      } catch {
        toast.error("添加卡片失败")
        return null
      }
    },
    [],
  )

  const toggleCardSelection = useCallback((cardId: string) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }, [])

  const handleCardGeneratingImage = useCallback(
    (cardId: string, generating: boolean) => {
      setGeneratingImageCardIds((prev) => {
        const next = new Set(prev)
        if (generating) next.add(cardId)
        else next.delete(cardId)
        return next
      })
      // 有新的生图任务时，启动统一轮询；批量图片轮询运行中则由其兜底跟踪
      // （批量轮询判停条件覆盖全任务 pending），不再叠加第二个轮询器
      if (generating && !cardImagesPollRef.current && !batchPollRef.current) {
        startCardImagesPollRef.current()
      }
    },
    [],
  )

  // ─── 批量轮询（image / prompt 两种类型） ───

  const startBatchPoll = useCallback(
    (cardIds: string[], type: "image" | "prompt") => {
      if (batchPollRef.current) {
        clearInterval(batchPollRef.current)
        batchPollRef.current = null
      }
      // 互斥：image 批量轮询接管为唯一图片状态轮询器（判停条件覆盖全任务
      // pending），避免与 cardImagesPoll 双轮询叠加（读放大 + 状态互相覆盖）
      if (type === "image") {
        stopCardImagesPollRef.current?.()
        cardImagesSinceRef.current = null
      }
      // 记录原始提示词，用于 prompt 类型对比
      const originalPrompts = new Map<string, string>()
      const currentCards = cardsRef.current
      for (const card of currentCards) {
        if (cardIds.includes(card.id)) {
          originalPrompts.set(card.id, card.prompt)
        }
      }

      // 轮询上限：生图类 60 分钟（队列并发限制下大批量出图耗时较长，
      // 5 分钟到点即停会让后完成的卡片停留在旧状态直到手动刷新）；
      // 提示词类 5 分钟足够
      const MAX_POLL_COUNT = type === "image" ? 1200 : 100
      const remainingImageIds = new Set(cardIds)
      // 增量轮询游标（闭包内维护）：首轮全量，之后只拉变化行
      let since: string | undefined

      const poll = async () => {
        try {
          const currentTaskId = activeTaskIdRef.current
          if (!currentTaskId) return

          if (type === "image") {
            const activeIds = [...remainingImageIds]
            const imagesData = await getTaskCardImagesAction(currentTaskId, since)

            // 竞态保护
            if (activeTaskIdRef.current !== currentTaskId) return
            if (imagesData.serverTime) since = imagesData.serverTime
            const mergedMap = buildCardImagesMap(
              imagesData,
              cardImagesMapRef.current,
            )
            setCardImagesMap(mergedMap)
            cardImagesMapRef.current = mergedMap
            setCards((prev) =>
              mergeCardsWithImageSummary(prev, imagesData, prev),
            )

            // 对账兜底：服务端计数与本地不一致 = 增量丢行，冷却内做一次全量重同步
            if (
              findCountMismatch(imagesData, mergedMap).length > 0 &&
              Date.now() - lastImagesResyncAtRef.current >
                IMAGES_RESYNC_COOLDOWN_MS
            ) {
              lastImagesResyncAtRef.current = Date.now()
              const serverTime = await resyncFullImages(currentTaskId)
              if (serverTime) since = serverTime
            }

            // 逐卡清除已完成的批量生图状态
            for (const cardId of activeIds) {
              const summary = imagesData.cards[cardId]
              const pending = summary?.pendingCount ?? 1
              if (pending === 0) {
                setBatchGeneratingImageCardIds((prev) => {
                  const next = new Set(prev)
                  next.delete(cardId)
                  return next
                })
                remainingImageIds.delete(cardId)
              }
            }

            // 判停看全任务：批量期间其他入口（单卡生图）发起的 pending
            // 也由本轮询兜底跟踪，全部完成才停
            let hasAnyPending = false
            for (const summary of Object.values(imagesData.cards)) {
              if (summary.pendingCount > 0) {
                hasAnyPending = true
                break
              }
            }
            if (!hasAnyPending) {
              if (batchPollRef.current) {
                clearInterval(batchPollRef.current)
                batchPollRef.current = null
              }
              setGeneratingImageCardIds(new Set())
              void fetchTasksRef.current(1)
              // 末轮全量刷新卡片行，补齐 selImg/选中信息
              void fetchCardsRef.current(currentTaskId)
            }
          } else {
            // prompt 类型：逐卡片检查提示词是否变化
            const cardsData = await getTaskCardsAction(currentTaskId, {
              pageSize: WORKSPACE_CARDS_PAGE_SIZE,
            })
            if (activeTaskIdRef.current !== currentTaskId) return
            const newCards = cardsData.cards

            let hasAnyPending = false
            for (const newCard of newCards) {
              if (!cardIds.includes(newCard.id)) continue
              const original = originalPrompts.get(newCard.id)
              if (original === undefined) continue
              if (newCard.prompt !== original) {
                // 该卡片提示词已变化，清除其加载状态
                setBatchDeepeningCardIds((prev) => {
                  const next = new Set(prev)
                  next.delete(newCard.id)
                  return next
                })
                setBatchRegeneratingCardIds((prev) => {
                  const next = new Set(prev)
                  next.delete(newCard.id)
                  return next
                })
                setCards((prev) =>
                  prev.map((c) => (c.id === newCard.id ? newCard : c)),
                )
              } else {
                hasAnyPending = true
              }
            }
            if (!hasAnyPending) {
              if (batchPollRef.current) {
                clearInterval(batchPollRef.current)
                batchPollRef.current = null
              }
            }
          }
        } catch {
          // 轮询失败不中断，下次间隔重试
        }
      }

      // 立即执行一次，然后每 3 秒轮询
      void poll()
      let pollCount = 0
      batchPollRef.current = setInterval(() => {
        pollCount++
        if (pollCount >= MAX_POLL_COUNT) {
          // 兜底：达到轮询上限（生图 60 分钟 / 提示词 5 分钟）
          if (batchPollRef.current) {
            clearInterval(batchPollRef.current)
            batchPollRef.current = null
          }
          setBatchDeepeningCardIds(new Set())
          setBatchRegeneratingCardIds(new Set())
          setBatchGeneratingImageCardIds(new Set())
          setGeneratingImageCardIds(new Set())
          void fetchTasksRef.current(1)
          if (type === "image") {
            toast.warning(
              "部分图片仍在生成，已停止自动刷新，可刷新页面查看最新结果",
            )
          }
        } else {
          void poll()
        }
      }, 3000)
    },
    [resyncFullImages],
  )

  // ─── 批量操作 ───

  const handleBatchDelete = async () => {
    const ids = [...selectedCardIds]
    try {
      const result = await batchDeleteCardsAction(ids)
      if (!result.ok) throw new Error()
      const deletedIds: string[] =
        result.deletedIds.length > 0 ? result.deletedIds : ids
      const deletedCount = result.deletedCount || deletedIds.length
      toast.success(`已删除 ${deletedCount} 张卡片`)
      setCards((prev) => prev.filter((c) => !deletedIds.includes(c.id)))
      setSelectedCardIds(new Set())
      setGeneratingImageCardIds((prev) => {
        const next = new Set(prev)
        deletedIds.forEach((id) => next.delete(id))
        return next
      })
      setBatchDeepeningCardIds((prev) => {
        const next = new Set(prev)
        deletedIds.forEach((id) => next.delete(id))
        return next
      })
      setBatchRegeneratingCardIds((prev) => {
        const next = new Set(prev)
        deletedIds.forEach((id) => next.delete(id))
        return next
      })
      setBatchGeneratingImageCardIds((prev) => {
        const next = new Set(prev)
        deletedIds.forEach((id) => next.delete(id))
        return next
      })
      if (activeTaskId) {
        await fetchCardsRef.current(activeTaskId)
      }
      void fetchTasksRef.current(1)
    } catch {
      toast.error("批量删除失败")
    }
  }

  const handleBatchGenerateImage = async (
    languagePreference?: BatchGenerationLanguage,
  ) => {
    if (!selectedImageModel || !selectedSize) {
      toast.error("请先选择图片模型和尺寸")
      return
    }
    const ids = [...selectedCardIds]
    setBatchGeneratingImageCardIds(new Set(ids))
    try {
      const result = await batchGenerateImageAction(ids, {
        apiId: selectedImageModel.id,
        size: selectedSize,
        ...(languagePreference ? { languagePreference } : {}),
      })
      if (!result.ok) throw new Error("批量生图提交失败")

      const submittedCount = result.submitted
      const errors = result.errors
      const successCardIds = result.tasks.map((t) => t.cardId)

      if (submittedCount > 0 && errors.length > 0) {
        toast.warning(`已提交 ${submittedCount} 张，${errors.length} 张失败`)
      } else if (submittedCount > 0) {
        toast.success(`已提交 ${submittedCount} 张卡片的生图任务`)
      } else {
        throw new Error(errors[0]?.error || "批量生图提交失败")
      }

      setSelectedCardIds(new Set())
      setBatchMode(false)
      // 复位全部翻面指令，避免其悬置为 true 持续阻止卡片手动翻面
      setFlipAllToImage(false)
      if (successCardIds.length > 0) {
        setBatchGeneratingImageCardIds(new Set(successCardIds))
        startBatchPoll(successCardIds, "image")
      } else {
        setBatchGeneratingImageCardIds(new Set())
      }
    } catch (err) {
      toast.error((err as Error).message || "批量生图提交失败")
      setBatchGeneratingImageCardIds(new Set())
    }
  }

  const handleBatchDeepen = async () => {
    if (!selectedDeepenTemplate) {
      toast.error("请先选择细化模板")
      return
    }
    const ids = [...selectedCardIds]
    setBatchDeepeningCardIds(new Set(ids))
    try {
      const result = await batchDeepenAction(ids, {
        templateId: selectedDeepenTemplate.id,
      })
      if (!result.ok)
        throw new Error(result.errors[0]?.error || "批量细化失败")
      toast.success(
        `已提交 ${result.submitted.length || ids.length} 张卡片的细化任务`,
      )
      setSelectedCardIds(new Set())
      setBatchMode(false)
      // 启动轮询：批量细化后需要轮询卡片状态
      startBatchPoll(ids, "prompt")
    } catch (err) {
      toast.error((err as Error).message || "批量细化提交失败")
      setBatchDeepeningCardIds(new Set())
    }
  }

  const handleBatchRegeneratePrompt = async () => {
    if (!selectedRegenTemplate) {
      toast.error("请先选择重新生成模板")
      return
    }
    const ids = [...selectedCardIds]
    setBatchRegeneratingCardIds(new Set(ids))
    try {
      const result = await batchRegeneratePromptAction(ids, {
        templateId: selectedRegenTemplate.id,
      })
      if (!result.ok)
        throw new Error(result.errors[0]?.error || "批量重新生成失败")
      toast.success(
        `已提交 ${result.submitted.length || ids.length} 张卡片的重新生成任务`,
      )
      setSelectedCardIds(new Set())
      setBatchMode(false)
      startBatchPoll(ids, "prompt")
    } catch (err) {
      toast.error((err as Error).message || "批量重新生成提交失败")
      setBatchRegeneratingCardIds(new Set())
    }
  }

  const handleBatchTranslate = async () => {
    if (!selectedTranslateTemplate) {
      toast.error("请先选择提示词翻译模板")
      return
    }
    const ids = [...selectedCardIds]
    setBatchTranslatingCardIds(new Set(ids))
    try {
      const result = await batchTranslatePromptAction(ids, {
        templateId: selectedTranslateTemplate.id,
      })
      if (!result.ok) throw new Error(result.errors[0]?.error || "批量翻译失败")
      const submittedIds: string[] = result.submitted
      const skippedIds: string[] = result.skippedCardIds
      setBatchTranslatingCardIds(new Set(submittedIds))
      setCards((prev) =>
        prev.map((card) =>
          submittedIds.includes(card.id)
            ? { ...card, translationStatus: "translating" }
            : card,
        ),
      )
      toast.success(
        `已提交 ${submittedIds.length} 张翻译任务${skippedIds.length ? `，跳过 ${skippedIds.length} 张有效译文` : ""}`,
      )
      setSelectedCardIds(new Set())
      setBatchMode(false)

      // 启动翻译轮询
      if (translatePollRef.current) {
        clearInterval(translatePollRef.current)
        translatePollRef.current = null
      }
      const MAX_COUNT = 100
      let count = 0
      const poll = async () => {
        const currentTaskId = activeTaskIdRef.current
        if (!currentTaskId) return
        try {
          const cardsData = await getTaskCardsAction(currentTaskId, {
            pageSize: WORKSPACE_CARDS_PAGE_SIZE,
          })
          if (activeTaskIdRef.current !== currentTaskId) return
          const refreshed = cardsData.cards
          const pendingIds = new Set<string>()
          setCards((prev) =>
            prev.map((card) => {
              const next = refreshed.find((item) => item.id === card.id)
              if (!next) return card
              if (
                submittedIds.includes(card.id) &&
                next.translationStatus === "translating"
              )
                pendingIds.add(card.id)
              return submittedIds.includes(card.id) ? next : card
            }),
          )
          setBatchTranslatingCardIds(pendingIds)
          if (pendingIds.size === 0) {
            if (translatePollRef.current) {
              clearInterval(translatePollRef.current)
              translatePollRef.current = null
            }
          }
        } catch {
          // 轮询失败不中断
        }
      }
      void poll()
      translatePollRef.current = setInterval(() => {
        count++
        if (count >= MAX_COUNT) {
          if (translatePollRef.current) {
            clearInterval(translatePollRef.current)
            translatePollRef.current = null
          }
          setBatchTranslatingCardIds(new Set())
        } else {
          void poll()
        }
      }, 3000)
    } catch (err) {
      toast.error((err as Error).message || "批量翻译提交失败")
      setBatchTranslatingCardIds(new Set())
    }
  }

  const handleBatchReplacePromptCompleted = useCallback(
    async (cardCount: number) => {
      const taskId = activeTaskIdRef.current
      if (taskId) {
        await fetchCardsRef.current(taskId)
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId ? { ...t, cardCount } : t,
          ),
        )
        setActiveTask((prev) =>
          prev ? { ...prev, cardCount } : prev,
        )
      }
      setSelectedCardIds(new Set())
      setBatchMode(false)
      void fetchTasksRef.current(1)
    },
    [],
  )

  // ─── 生成配置摘要 ───
  const configSummary = useMemo(() => {
    if (
      !selectedDeepenTemplate &&
      !selectedExtractTemplate &&
      !selectedTranslateTemplate &&
      !selectedImageModel &&
      !selectedSize
    )
      return "未选择"
    return [
      selectedDeepenTemplate?.name,
      selectedExtractTemplate?.name,
      selectedTranslateTemplate?.name,
      selectedImageModel?.displayName || selectedImageModel?.name,
      selectedSize,
    ]
      .filter(Boolean)
      .join(" / ")
  }, [
    selectedDeepenTemplate,
    selectedExtractTemplate,
    selectedTranslateTemplate,
    selectedImageModel,
    selectedSize,
  ])

  // ─── 渲染 ───

  return (
    // 绝对定位贴满 header 以下的工作区（相对 SidebarInset 的 relative），
    // 避开 dashboard-shell 的 p-4 包裹层：左栏贴住导航栏与顶栏，分割线贯穿到底。
    // 不用 gap：主区需紧贴左栏 border-r，保证工具栏 border-b 与竖线在左上角相接
    <div className="absolute inset-x-0 top-16 bottom-0 flex">
      <aside
        className="flex flex-col border-r border-border bg-sidebar/20 shrink-0"
        style={{ width: SIDEBAR_WIDTH }}
      >
        <div className="px-3 py-2.5 space-y-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="搜索任务..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 h-8 text-xs"
            />
          </div>

          <Button
            size="sm"
            className="w-full h-8 gap-1.5 text-xs rounded-md"
            onClick={() => setShowNewTask(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            新建任务
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-1 pb-2 space-y-0.5 scrollbar-hide">
          {loadingTasks && tasks.length === 0 ? (
            <TaskSidebarSkeleton />
          ) : tasks.length === 0 ? (
            <div className="text-center text-muted-foreground text-xs py-8 px-4">
              暂无任务，点击「新建任务」开始
            </div>
          ) : (
            <>
              {pinnedTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  isActive={task.id === activeTaskId}
                  isPinned={task.isPinned}
                  onClick={() => handleTaskSelect(task)}
                  onPin={handlePinTask}
                  onDelete={handleRequestDeleteTask}
                  onRename={handleTaskRename}
                />
              ))}
              {recentTasks.length > 0 && (
                <p className="px-1 pt-1 pb-0.5 text-xs text-muted-foreground">
                  最近
                </p>
              )}
              {recentTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  isActive={task.id === activeTaskId}
                  isPinned={task.isPinned}
                  onClick={() => handleTaskSelect(task)}
                  onPin={handlePinTask}
                  onDelete={handleRequestDeleteTask}
                  onRename={handleTaskRename}
                />
              ))}
              {hasMoreTasks && (
                <button
                  onClick={() => {
                    const next = taskPage + 1
                    setTaskPage(next)
                    void fetchTasks(next, true)
                  }}
                  className="w-full text-xs text-muted-foreground hover:text-foreground py-2 flex items-center justify-center gap-1"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                  加载更多
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      <main className="relative flex-1 min-w-0 flex flex-col overflow-hidden">
        {!activeTaskId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center space-y-2">
              <ImagePlus className="h-12 w-12 mx-auto opacity-20" />
              <p className="text-sm">选择左侧任务，或新建任务开始工作</p>
              <div className="flex items-center justify-center gap-2">
                <Button size="sm" onClick={() => setShowNewTask(true)}>
                  <Plus className="h-4 w-4" />
                  新建任务
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push("/templates")}
                >
                  <LibraryBig className="h-4 w-4" />
                  模板管理
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 工具栏 */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-background/80 backdrop-blur-sm shrink-0 flex-wrap">
              <Button
                size="sm"
                className="h-7 text-xs gap-1 rounded-md bg-blue-600 text-white hover:bg-blue-700"
                onClick={() => setShowGenerationConfigDialog(true)}
              >
                生成配置
                <span className="max-w-[180px] truncate text-white/80">
                  {configSummary}
                </span>
                <ChevronDown className="h-3 w-3" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1 rounded-md"
                onClick={() => router.push("/templates")}
              >
                <LibraryBig className="h-3.5 w-3.5" />
                模板管理
              </Button>

              <div className="flex items-center gap-1 ml-auto">
                {batchMode && cards.length > 0 && (
                  <Button
                    size="sm"
                    className={cn(
                      "h-7 text-xs gap-1 rounded-md text-white",
                      selectedCardIds.size === cards.length
                        ? "bg-gray-400 hover:bg-gray-500"
                        : "bg-green-600 hover:bg-green-700",
                    )}
                    onClick={() => {
                      if (selectedCardIds.size === cards.length) {
                        setSelectedCardIds(new Set())
                        setFlipAllToImage(false)
                      } else {
                        setSelectedCardIds(new Set(cards.map((c) => c.id)))
                        setFlipAllToImage(true)
                      }
                    }}
                  >
                    <CheckSquare className="h-3.5 w-3.5" />
                    {selectedCardIds.size === cards.length
                      ? "取消全选"
                      : "全部选择"}
                  </Button>
                )}

                <Button
                  variant={toolPanelOpen ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs gap-1 rounded-md"
                  onClick={toggleToolPanel}
                >
                  <PanelRight className="h-3.5 w-3.5" />
                  {toolPanelOpen ? "工具面板已开" : "工具面板"}
                </Button>

                <Button
                  variant={batchMode ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs gap-1 rounded-md"
                  onClick={() => {
                    // 进入批量模式时关闭工具面板（互斥）
                    if (!batchMode) {
                      setToolPanelOpen(false)
                      setActiveCardId(null)
                    }
                    setBatchMode(!batchMode)
                    setSelectedCardIds(new Set())
                    setFlipAllToImage(false)
                  }}
                >
                  {batchMode ? (
                    <CheckSquare className="h-3.5 w-3.5" />
                  ) : (
                    <Square className="h-3.5 w-3.5" />
                  )}
                  {batchMode ? `已选 ${selectedCardIds.size}` : "批量选择"}
                </Button>

                {batchMode && selectedCardIds.size > 0 &&
                  (() => {
                    const selectedCards = cards.filter((c) =>
                      selectedCardIds.has(c.id),
                    )
                    const hasSelectedCardGeneratingImage = selectedCards.some(
                      (card) => {
                        const images = cardImagesMap.get(card.id) || []
                        return images.some(
                          (image) =>
                            image.status === "pending" ||
                            image.status === "generating",
                        )
                      },
                    )
                    const hasGeneratingCard =
                      selectedCards.some(
                        (c) =>
                          batchGeneratingImageCardIds.has(c.id) ||
                          generatingImageCardIds.has(c.id),
                      ) || hasSelectedCardGeneratingImage
                    if (hasGeneratingCard) {
                      return (
                        <Button
                          size="sm"
                          className="h-7 text-xs gap-1 rounded-md bg-red-600 hover:bg-red-700 text-white"
                          onClick={() =>
                            setBatchConfirm({
                              action: "批量删除",
                              count: selectedCardIds.size,
                              // onConfirm 仅在确认弹窗的点击回调中执行（绝不于渲染期调用），
                              // handler 内读取 fetchXxxRef.current 属事件期访问，安全。
                              // eslint-disable-next-line react-hooks/refs
                              onConfirm: handleBatchDelete,
                            })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          批量删除卡片
                        </Button>
                      )
                    }
                    return (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              size="sm"
                              className="h-7 text-xs gap-1 rounded-md bg-violet-600 hover:bg-violet-700 text-white"
                            />
                          }
                        >
                          <Wand2 className="h-3.5 w-3.5" />
                          批量操作
                          <ChevronDown className="h-3 w-3" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          sideOffset={6}
                          className="w-44"
                        >
                          <DropdownMenuItem
                            onClick={() => setShowBatchImageUploadDialog(true)}
                          >
                            <ImagePlus className="h-4 w-4" />
                            批量上传图片
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              if (!selectedTranslateTemplate) {
                                toast.error("请先在生成配置中选择提示词翻译模板")
                                return
                              }
                              setBatchConfirm({
                                action: "批量翻译提示词",
                                count: selectedCardIds.size,
                                // onConfirm 仅在确认弹窗点击回调中执行，非渲染期；详见上方说明。
                                // eslint-disable-next-line react-hooks/refs
                                onConfirm: handleBatchTranslate,
                              })
                            }}
                          >
                            <Languages className="h-4 w-4" />
                            批量翻译提示词
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              if (!selectedRegenTemplate) {
                                toast.error("请先在生成配置中选择重新生成模板")
                                return
                              }
                              setBatchConfirm({
                                action: "批量重新生成提示词",
                                count: selectedCardIds.size,
                                onConfirm: handleBatchRegeneratePrompt,
                              })
                            }}
                          >
                            <RefreshCw className="h-4 w-4" />
                            批量生成提示词
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              if (!selectedDeepenTemplate) {
                                toast.error("请先在生成配置中选择细化模板")
                                return
                              }
                              setBatchConfirm({
                                action: "批量细化提示词",
                                count: selectedCardIds.size,
                                onConfirm: handleBatchDeepen,
                              })
                            }}
                          >
                            <Sparkles className="h-4 w-4" />
                            批量细化提示词
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              if (!selectedExtractTemplate) {
                                toast.error("请先在生成配置中选择提取提示词模板")
                                return
                              }
                              setShowBatchReplacePromptDialog(true)
                            }}
                          >
                            <Replace className="h-4 w-4" />
                            批量替换提示词
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              if (!selectedImageModel || !selectedSize) {
                                toast.error("请先在生成配置中选择图片模型和尺寸")
                                return
                              }
                              const selectedCards = cards.filter((card) =>
                                selectedCardIds.has(card.id),
                              )
                              const languageSummary =
                                getBatchGenerationLanguageSummary(
                                  selectedCards,
                                  "zh",
                                )
                              setBatchConfirm({
                                action: "批量生成图片",
                                count: selectedCardIds.size,
                                generationLanguage:
                                  languageSummary.requiresLanguageSelection
                                    ? "zh"
                                    : undefined,
                                languageSummary,
                                // onConfirm 仅在确认弹窗点击回调中执行，非渲染期；详见上方说明。
                                // eslint-disable-next-line react-hooks/refs
                                onConfirm: () => handleBatchGenerateImage(languageSummary.requiresLanguageSelection ? "zh" : undefined),
                              })
                            }}
                          >
                            <ImagePlus className="h-4 w-4" />
                            批量生成图片
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() =>
                              setBatchConfirm({
                                action: "批量删除",
                                count: selectedCardIds.size,
                                onConfirm: handleBatchDelete,
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4" />
                            批量删除卡片
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  })()}

                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1 rounded-md"
                  onClick={() => setShowExportDialog(true)}
                >
                  <Download className="h-3.5 w-3.5" />
                  导出
                </Button>
              </div>
            </div>

            {/* 卡片网格区域 */}
            <div
              ref={cardScrollContainerRef}
              className="relative flex-1 overflow-y-auto"
            >
              {loadingCards ? (
                <div className="flex items-center justify-center h-full">
                  <Spinner />
                </div>
              ) : activeTask?.status === "generating" ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center space-y-3">
                    <MorphingInfinity className="h-10 w-10 mx-auto text-primary" />
                    <p className="text-sm text-muted-foreground">
                      正在裂变提示词，请稍候...
                    </p>
                  </div>
                </div>
              ) : activeTask?.status === "failed" ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center space-y-3">
                    <XCircle className="h-10 w-10 mx-auto text-destructive opacity-60" />
                    <p className="text-sm text-muted-foreground">裂变失败</p>
                    {activeTask.errorMessage && (
                      <p className="text-xs text-muted-foreground max-w-sm">
                        {activeTask.errorMessage}
                      </p>
                    )}
                  </div>
                </div>
              ) : cards.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center space-y-2">
                    <Wand2 className="h-10 w-10 mx-auto opacity-20" />
                    <p className="text-sm text-muted-foreground">暂无卡片</p>
                  </div>
                </div>
              ) : (
                <CardGrid
                  taskId={activeTaskId}
                  cards={cards}
                  cardImagesMap={cardImagesMap}
                  scrollContainerRef={cardScrollContainerRef}
                  batchMode={batchMode}
                  selectedCardIds={selectedCardIds}
                  flipAllToImage={flipAllToImage}
                  toolPanelMode={toolPanelOpen}
                  activeCardId={activeCardId}
                  onCardActivate={setActiveCardId}
                  selectedDeepenTemplate={selectedDeepenTemplate}
                  selectedRegenTemplate={selectedRegenTemplate}
                  selectedTranslateTemplate={selectedTranslateTemplate}
                  selectedImageModel={selectedImageModel}
                  selectedSize={selectedSize}
                  onToggleSelect={toggleCardSelection}
                  onCardUpdated={handleCardUpdated}
                  onCardDeleted={handleCardDeleted}
                  onAddCard={handleAddCard}
                  onCardGeneratingImage={handleCardGeneratingImage}
                  batchDeepeningCardIds={batchDeepeningCardIds}
                  batchRegeneratingCardIds={batchRegeneratingCardIds}
                  batchTranslatingCardIds={batchTranslatingCardIds}
                  batchGeneratingImageCardIds={batchGeneratingImageCardIds}
                />
              )}

              <button
                type="button"
                onClick={handleScrollToTop}
                className={cn(
                  "sticky ml-auto mr-5 mb-5 bottom-5 flex h-12 w-12 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-lg backdrop-blur transition-all duration-300 ease-out hover:-translate-y-0.5 hover:bg-accent",
                  showScrollToTop
                    ? "translate-y-0 opacity-100 pointer-events-auto"
                    : "translate-y-3 opacity-0 pointer-events-none",
                )}
                aria-label="回到顶部"
                title="回到顶部"
              >
                <ArrowUp className="h-5 w-5" />
              </button>
            </div>
          </>
        )}
      </main>

      {/* ─── 工具面板（浮动，与批量模式互斥） ─── */}
      {toolPanelOpen && (
        <ToolPanel
          cards={cards}
          activeCardId={activeCardId}
          onClose={() => setToolPanelOpen(false)}
          cardImages={
            activeCardId ? cardImagesMap.get(activeCardId) ?? [] : []
          }
          selectedDeepenTemplate={selectedDeepenTemplate}
          selectedRegenTemplate={selectedRegenTemplate}
          selectedTranslateTemplate={selectedTranslateTemplate}
          selectedImageModel={selectedImageModel}
          selectedSize={selectedSize}
          onCardUpdated={handleCardUpdated}
          onCardDeleted={handleCardDeleted}
          onCardGeneratingImage={handleCardGeneratingImage}
        />
      )}

      {/* ─── 对话框 ─── */}

      <NewTaskDialog
        open={showNewTask}
        onOpenChange={setShowNewTask}
        onCreated={handleTaskCreated}
      />

      <BatchImageUploadDialog
        open={showBatchImageUploadDialog}
        onOpenChange={setShowBatchImageUploadDialog}
        cardIds={Array.from(selectedCardIds)}
        onCompleted={(imagesByCard) => {
          setCardImagesMap((previous) => {
            const next = new Map(previous)
            Object.entries(imagesByCard).forEach(([cardId, images]) => {
              const existing = next.get(cardId) || []
              const merged = [
                ...images,
                ...existing.filter(
                  (image) => !images.some((item) => item.id === image.id),
                ),
              ]
              next.set(cardId, merged)
            })
            return next
          })
        }}
      />

      <TemplateSelectDialog
        open={false}
        onOpenChange={() => {}}
        type="fission"
        selected={selectedFissionTemplate}
        onSelect={() => {}}
      />

      <ModelSelectDialog
        open={showModelDialog}
        onOpenChange={setShowModelDialog}
        selected={selectedImageModel}
        onSelect={(m) => {
          setSelectedImageModel(m)
          setSelectedSize(null)
          setShowModelDialog(false)
        }}
      />

      <SizeSelectDialog
        open={showSizeDialog}
        onOpenChange={setShowSizeDialog}
        model={selectedImageModel}
        selected={selectedSize}
        onSelect={(s) => {
          setSelectedSize(s)
          setShowSizeDialog(false)
        }}
      />

      <GenerationConfigDialog
        open={showGenerationConfigDialog}
        onOpenChange={setShowGenerationConfigDialog}
        selectedFissionTemplate={selectedFissionTemplate}
        selectedRefineTemplate={selectedDeepenTemplate}
        selectedRegenTemplate={selectedRegenTemplate}
        selectedExtractTemplate={selectedExtractTemplate}
        selectedTranslateTemplate={selectedTranslateTemplate}
        selectedImageModel={selectedImageModel}
        selectedSize={selectedSize}
        onApply={(config) => {
          setSelectedFissionTemplate(config.fissionTemplate)
          setSelectedDeepenTemplate(config.refineTemplate)
          setSelectedRegenTemplate(config.regenTemplate)
          setSelectedExtractTemplate(config.extractTemplate)
          setSelectedTranslateTemplate(config.translateTemplate)
          setSelectedImageModel(config.imageModel)
          setSelectedSize(config.size)
          saveStoredGenerationConfig(config)
        }}
      />

      <BatchReplacePromptDialog
        open={showBatchReplacePromptDialog}
        onOpenChange={setShowBatchReplacePromptDialog}
        taskId={activeTaskId}
        selectedTemplate={selectedExtractTemplate}
        cards={cards}
        selectedCardIds={selectedCardIds}
        onCompleted={handleBatchReplacePromptCompleted}
      />

      <ExportDialog
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
        taskId={activeTaskId}
        taskTitle={activeTask?.title || ""}
        cards={cards}
        cardImagesMap={cardImagesMap}
        selectedCardIds={selectedCardIds}
        batchMode={batchMode}
      />

      {/* 删除任务确认 */}
      <Dialog
        open={Boolean(deleteConfirmTask)}
        onOpenChange={(open) => !open && setDeleteConfirmTask(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              确认删除历史任务
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2 text-sm">
            <p className="text-muted-foreground">
              删除后将移除该批量生图任务及其提示词卡片记录，此操作不可撤销。
            </p>
            {deleteConfirmTask && (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                <div
                  className="font-medium text-foreground truncate"
                  title={deleteConfirmTask.title}
                >
                  {deleteConfirmTask.title}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {deleteConfirmTask.cardCount} 张卡片
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmTask(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!deleteConfirmTask) return
                const taskId = deleteConfirmTask.id
                setDeleteConfirmTask(null)
                await handleDeleteTask(taskId)
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量操作确认 */}
      {batchConfirm && (
        <BatchConfirmDialog
          open={true}
          onOpenChange={(open) => !open && setBatchConfirm(null)}
          action={batchConfirm.action}
          count={batchConfirm.count}
          onConfirm={() => {
            batchConfirm.onConfirm()
            setBatchConfirm(null)
          }}
          generationLanguage={batchConfirm.generationLanguage}
          languageSummary={batchConfirm.languageSummary}
          onLanguagePreferenceChange={(language) =>
            setBatchConfirm((current) =>
              current
                ? {
                    ...current,
                    generationLanguage: language,
                    languageSummary:
                      getBatchGenerationLanguageSummary(
                        cards.filter((card) => selectedCardIds.has(card.id)),
                        language,
                      ),
                    onConfirm: () => handleBatchGenerateImage(language),
                  }
                : null,
            )
          }
        />
      )}
    </div>
  )
}
