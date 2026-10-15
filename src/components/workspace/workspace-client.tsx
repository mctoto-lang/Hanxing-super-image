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
  Compass,
  Lightbulb,
  PenLine,
  ArrowUp,
  Replace,
  Languages,
  LibraryBig,
  ListTodo,
  Activity,
  Bot,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
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
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import { Spinner } from "@/components/workspace/spinner"
import { NewTaskDialog } from "@/components/workspace/new-task-dialog"
import { CardGrid } from "@/components/workspace/card-grid"
import { ToolPanel, type WorkspaceCardReviewPayload } from "@/components/workspace/tool-panel"
import { TemplateSelectDialog } from "@/components/workspace/template-select-dialog"
import { ModelSelectDialog } from "@/components/workspace/model-select-dialog"
import { SizeSelectDialog } from "@/components/workspace/size-select-dialog"
import { ExportDialog } from "@/components/workspace/export-dialog"
import { BatchConfirmDialog } from "@/components/workspace/batch-confirm-dialog"
import { GenerationConfigDialog } from "@/components/workspace/generation-config-dialog"
import { BatchReplacePromptDialog } from "@/components/workspace/batch-replace-prompt-dialog"
import { BatchImageUploadDialog } from "@/components/workspace/batch-image-upload-dialog"
import {
  WorkspaceAgentDialog,
  type WorkspaceAgentStatsInput,
  type WorkspaceAgentCardSummaryInput,
  type WorkspaceAgentItemInput,
} from "@/components/workspace/workspace-agent-dialog"
import { WorkspaceAgentProgressDialog } from "@/components/workspace/workspace-agent-progress-dialog"
import type {
  PipelineStage,
  StageStatus,
} from "@/components/ui/build-pipeline"
import { WORKSPACE_AGENT_TEMPLATES } from "@/lib/workspace/agent-templates"
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
  getWorkspaceAgentProgressAction,
  getWorkspaceAgentCardReviewAction,
  restartWorkspaceAgentCardAction,
  downloadWorkspaceAgentOracleCsvAction,
} from "@/server/actions/workspace"
import {
  WORKSPACE_AGENT_STAGES,
  type WorkspaceAgentCardStatus,
  type WorkspaceAgentStage,
  type WorkspaceAgentStageProgress,
} from "@/lib/workspace/agent-types"
import type { WorkspaceAgentProgressPayload } from "@/server/services/workspace-agent/progress"
import {
  findCountMismatch,
  getBatchGenerationLanguageSummary,
  mergeCardsWithImageSummary,
  mergeImageRows,
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

// ─── 卡片合并辅助：轮询合并已迁至 lib/workspace/helpers（mergeCardsWithImageSummary，
//     含 Agent 解锁瞬间采信服务端 prompt 的回填规则），可被单测覆盖 ───

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

// ─── 工作台 Agent（source = agent 任务的四阶段进度视图） ───

/** 严格四阶段标题（顺序对齐 WORKSPACE_AGENT_STAGES；进度弹窗/主区共用） */
const AGENT_PROGRESS_STAGE_TITLES = [
  "主题选择",
  "想象力程度",
  "落地方向",
  "提示词撰写",
] as const

/** 阶段 → 归属日志的节点 key（与服务端 dialog 日志归集同口径） */
const STAGE_LOG_NODE_KEYS: Record<WorkspaceAgentStage, string[]> = {
  clarify: ["creative_director", "style_director", "supervisor"],
  draft: ["creative_director", "supervisor"],
  art: ["style_director", "supervisor"],
  compose: ["prompt_designer", "supervisor"],
}

/** 阶段语义图标（进度弹窗站点/列表行） */
const STAGE_ICONS = {
  clarify: Lightbulb,
  draft: Sparkles,
  art: Compass,
  compose: PenLine,
} as const

/** workflow 终态（Agent 进度轮询停止条件） */
function isTerminalAgentStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

/** Agent 进度视图（弹窗入参形状；由 getWorkspaceAgentProgressAction 载荷归一） */
interface AgentProgressEvent {
  nodeKey: string | null
  status: string | null
  detail: string | null
  createdAt: string
}

interface AgentProgressView {
  workflowId: string | null
  status: string | null
  currentStage: WorkspaceAgentStage
  stages: WorkspaceAgentStageProgress[]
  /** 服务端算好的阶段展示状态（locked/active/done；缺省客户端重算） */
  stageStatuses: Partial<
    Record<WorkspaceAgentStage, "locked" | "active" | "done">
  > | null
  /** 单卡状态计数（byStatus 签名对比 → 静默补拉卡片行，驱动状态实时推进） */
  cardsByStatus: Partial<Record<WorkspaceAgentCardStatus, number>>
  /** 工作流创建时间（ISO；进度弹窗页脚） */
  createdAt: string | null
  /** 发起模板 key（进度弹窗上下文条取模板名） */
  templateKey: string | null
  /** 事件留痕（进度弹窗阶段日志源；升序由读取侧排） */
  events: AgentProgressEvent[]
  stats: WorkspaceAgentStatsInput | null
  cardSummary: WorkspaceAgentCardSummaryInput | null
  agents: WorkspaceAgentItemInput[] | null
  /** 神谕文案交付进度（oracle58；null = 非神谕任务） */
  oracleCopy: { written: number; total: number; confirmed: boolean } | null
  updatedAt: string | null
}

/** getWorkspaceAgentProgressAction 返回类型（action 契约自动对齐） */
type AgentProgressResult = Awaited<
  ReturnType<typeof getWorkspaceAgentProgressAction>
>

/**
 * 轮询载荷 → 弹窗视图（宽松归一）：
 * - 兼容 ActionResult<{ progress }> 包装与扁平载荷两种形状（服务端契约迭代期）；
 * - 弹窗数据取载荷的 dialog 兼容投影（stats/cardSummary/agents/阶段日志）；
 * - 阶段展示状态优先取服务端 stageStatuses，缺省客户端用 resolveStageStatuses
 *   按阶段进度重算；空载荷（工作流不存在/无权限）返回 null 按空态处理。
 */
function normalizeAgentProgress(
  raw: AgentProgressResult | null | undefined,
): AgentProgressView | null {
  if (!raw) return null
  // 解包：{ ok, progress } 包装 → progress；扁平载荷原样
  const wrapper = raw as { progress?: unknown }
  const payload = (
    typeof wrapper === "object" &&
    "progress" in wrapper &&
    wrapper.progress &&
    typeof wrapper.progress === "object"
      ? wrapper.progress
      : raw
  ) as unknown as WorkspaceAgentProgressPayload
  const workflow = payload.workflow
  // 优先服务端聚合推导的 currentStage（与 stageStatuses 同口径）；DB
  // workflow.currentStage 写入时机不保证同步，仅作缺省回退
  const rawStage = payload.currentStage ?? workflow?.currentStage
  const currentStage = WORKSPACE_AGENT_STAGES.includes(
    rawStage as WorkspaceAgentStage,
  )
    ? (rawStage as WorkspaceAgentStage)
    : "clarify"
  const stageList = (
    Array.isArray(payload.stages) ? payload.stages : []
  ) as WorkspaceAgentStageProgress[]
  const byStage = new Map(stageList.map((s) => [s.stage, s] as const))
  return {
    workflowId: workflow?.id ?? null,
    status: workflow?.status ?? null,
    currentStage,
    stages: WORKSPACE_AGENT_STAGES.map(
      (stage): WorkspaceAgentStageProgress =>
        byStage.get(stage) ?? {
          stage,
          total: 0,
          completed: 0,
          failed: 0,
          inFlight: 0,
        },
    ),
    stageStatuses:
      payload.stageStatuses && typeof payload.stageStatuses === "object"
        ? (payload.stageStatuses as Partial<
            Record<WorkspaceAgentStage, "locked" | "active" | "done">
          >)
        : null,
    cardsByStatus: payload.cards?.byStatus ?? {},
    createdAt: workflow?.createdAt ?? null,
    templateKey: payload.input?.templateKey ?? null,
    events: Array.isArray(payload.events)
      ? payload.events.map((ev) => ({
          nodeKey: ev.nodeKey ?? null,
          status: ev.status ?? null,
          detail: ev.detail ?? null,
          createdAt: ev.createdAt ?? "",
        }))
      : [],
    stats: payload.dialog?.stats ?? null,
    cardSummary: payload.dialog?.cardSummary ?? null,
    agents:
      payload.dialog?.agents && Array.isArray(payload.dialog.agents)
        ? payload.dialog.agents
        : null,
    oracleCopy: payload.oracleCopy ?? null,
    updatedAt: workflow?.updatedAt ?? null,
  }
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
  // 时间文本依赖浏览器时区（toLocaleString），SSR（容器时区）与客户端不一致
  // 会导致 hydration mismatch（React #441）：挂载前渲染占位，挂载后再出真实时间
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
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
              {mounted
                ? new Date(task.createdAt).toLocaleString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "··/·· ··:··"}
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
  // 初值保持确定性（与 SSR 一致），localStorage 回填放到挂载后的 effect：
  // 惰性初始化直接读 localStorage 会让客户端首渲染偏离服务端输出
  // （hydration mismatch，React #441）
  const [selectedFissionTemplate, setSelectedFissionTemplate] =
    useState<TemplateRow | null>(null)
  const [selectedDeepenTemplate, setSelectedDeepenTemplate] =
    useState<TemplateRow | null>(null)
  const [selectedRegenTemplate, setSelectedRegenTemplate] =
    useState<TemplateRow | null>(null)
  const [selectedExtractTemplate, setSelectedExtractTemplate] =
    useState<TemplateRow | null>(null)
  const [selectedTranslateTemplate, setSelectedTranslateTemplate] =
    useState<TemplateRow | null>(null)
  const [selectedImageModel, setSelectedImageModel] =
    useState<ImageModelRow | null>(initialModels[0] ?? null)
  const [selectedSize, setSelectedSize] = useState<string | null>(null)

  useEffect(() => {
    const stored = loadStoredGenerationConfig()
    if (stored.fissionTemplate) setSelectedFissionTemplate(stored.fissionTemplate)
    if (stored.refineTemplate) setSelectedDeepenTemplate(stored.refineTemplate)
    if (stored.regenTemplate) setSelectedRegenTemplate(stored.regenTemplate)
    if (stored.extractTemplate) setSelectedExtractTemplate(stored.extractTemplate)
    if (stored.translateTemplate)
      setSelectedTranslateTemplate(stored.translateTemplate)
    if (stored.imageModel) setSelectedImageModel(stored.imageModel)
    if (stored.size) setSelectedSize(stored.size)
  }, [])

  // ─── 对话框状态 ───
  const router = useRouter()
  const [showNewTask, setShowNewTask] = useState(false)
  // 移动端任务抽屉（<md 侧栏隐藏，工具栏按钮唤出）
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [showGenerationConfigDialog, setShowGenerationConfigDialog] =
    useState(false)
  const [showBatchReplacePromptDialog, setShowBatchReplacePromptDialog] =
    useState(false)
  const [showBatchImageUploadDialog, setShowBatchImageUploadDialog] =
    useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showModelDialog, setShowModelDialog] = useState(false)
  const [showSizeDialog, setShowSizeDialog] = useState(false)

  // ─── Agent 任务（source = agent）：总览 / 工作流向导弹窗 ───
  const [showAgentDialog, setShowAgentDialog] = useState(false)
  // 工作流向导（可操作四阶段）；初建任务自动打开时 startAtStyle = true 从风格确认步骤开始，
  // 其余入口（执行进度按钮等）打开时从轮询载荷恢复到 current stage
  // 独立执行进度弹窗（只读流水线视图 + 阶段日志；向导仍承担四阶段交互操作）
  const [showAgentProgressDialog, setShowAgentProgressDialog] = useState(false)
  const [agentFlowStartAtStyle, setAgentFlowStartAtStyle] = useState(false)
  const [agentProgressView, setAgentProgressView] =
    useState<AgentProgressView | null>(null)
  // 桥接：taskId → workflowId（Agent 发起响应带回；任务行 source 字段
  // 未由服务端列表返回前的兜底，让创建后立即识别 Agent 任务并开始轮询）
  const [agentWorkflowByTask, setAgentWorkflowByTask] = useState<
    Map<string, string>
  >(new Map())

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
  // Agent 进度轮询定时器（source = agent 的任务；终态自停）
  const agentProgressPollRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  )
  // 单卡状态计数签名（byStatus 变化 → 静默补拉卡片行，驱动撰写/生图/评审状态实时推进）
  const agentCardsSignatureRef = useRef("")
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
  const fetchTasksRef = useRef<
    (_page?: number, _append?: boolean, _opts?: { silent?: boolean }) => Promise<void>
  >(async () => {})
  const fetchCardsRef = useRef<(_taskId: string, _opts?: { silent?: boolean }) => Promise<void>>(
    async () => {},
  )
  const pollTaskStatusRef = useRef<(_taskId: string) => Promise<void>>(
    async () => {},
  )
  const pollCardImagesRef = useRef<() => Promise<void>>(async () => {})
  const stopCardImagesPollRef = useRef<() => void>(() => {})
  const startCardImagesPollRef = useRef<() => void>(() => {})
  const pollAgentProgressRef = useRef<(_taskId: string) => Promise<void>>(
    async () => {},
  )
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
    async (page = 1, append = false, opts?: { silent?: boolean }) => {
      // silent：不置 loading（后台刷新，避免列表/主区加载态闪动）
      if (!opts?.silent) setLoadingTasks(true)
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
        if (!opts?.silent) setLoadingTasks(false)
      }
    },
    [debouncedSearch],
  )

  const fetchCards = useCallback(async (taskId: string, opts?: { silent?: boolean }) => {
    // silent：不置全屏加载态，且以现有卡片为基线合并（保留本地编辑 + memo 身份）
    const silent = opts?.silent === true
    if (!silent) setLoadingCards(true)
    try {
      const [cardsData, imagesData] = await Promise.all([
        getTaskCardsAction(taskId, { pageSize: WORKSPACE_CARDS_PAGE_SIZE }),
        getTaskCardImagesAction(taskId),
      ])
      // 竞态保护：如果请求返回后 activeTaskId 已变化，丢弃本次结果
      if (activeTaskIdRef.current !== taskId) return
      const fetchedCards = cardsData.cards
      setCards((prev) =>
        mergeCardsWithImageSummary(fetchedCards, imagesData, silent ? prev : []),
      )
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
      if (!silent) setLoadingCards(false)
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
        // 静默刷新：避免生成收尾时全屏 Spinner 替换卡片网格（闪烁）
        void fetchTasksRef.current(1, false, { silent: true })
        // 末轮全量刷新卡片行，补齐 selImg/选中信息
        void fetchCardsRef.current(currentTaskId, { silent: true })
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

  // ─── Agent 进度轮询（source = agent 的激活任务；3s 一拍，终态自停） ───

  const stopAgentProgressPoll = useCallback(() => {
    if (agentProgressPollRef.current) {
      clearInterval(agentProgressPollRef.current)
      agentProgressPollRef.current = null
    }
  }, [])

  const pollAgentProgress = useCallback(
    async (taskId: string) => {
      try {
        const data = await getWorkspaceAgentProgressAction(taskId)
        // 竞态保护：请求返回后任务已切换则丢弃
        if (activeTaskIdRef.current !== taskId) return
        const view = normalizeAgentProgress(data)
        setAgentProgressView(view)
        // 单卡状态计数变化（撰写/生图/评审/落定推进）→ 静默补拉卡片行
        const signature = JSON.stringify(view?.cardsByStatus ?? {})
        if (signature !== agentCardsSignatureRef.current) {
          agentCardsSignatureRef.current = signature
          if (view) void fetchCardsRef.current(taskId, { silent: true })
        }
        if (view && isTerminalAgentStatus(view.status)) {
          stopAgentProgressPoll()
          // 终态后补拉任务列表与卡片（产出物落回工作台任务；静默防闪烁）
          void fetchTasksRef.current(1, false, { silent: true })
          void fetchCardsRef.current(taskId, { silent: true })
        }
      } catch {
        // 轮询失败不中断，下次间隔重试
      }
    },
    [stopAgentProgressPoll],
  )

  useEffect(() => {
    pollAgentProgressRef.current = pollAgentProgress
  }, [pollAgentProgress])

  /** 当前激活任务是否为 Agent 任务（source = agent；兼容 agentWorkflowId 冗余字段与发起桥接） */
  const isAgentTask =
    activeTask?.source === "agent" ||
    Boolean(activeTask?.agentWorkflowId) ||
    (activeTaskId != null && agentWorkflowByTask.has(activeTaskId))

  // Agent 任务激活时启动轮询；切走 / 非任务态停止并清空视图
  useEffect(() => {
    if (!activeTaskId || !isAgentTask) {
      stopAgentProgressPoll()
      setAgentProgressView(null)
      return
    }
    const taskId = activeTaskId
    setAgentProgressView(null)
    agentCardsSignatureRef.current = ""
    void pollAgentProgressRef.current(taskId)
    agentProgressPollRef.current = setInterval(
      () => void pollAgentProgressRef.current(taskId),
      3000,
    )
    return () => stopAgentProgressPoll()
  }, [activeTaskId, isAgentTask, stopAgentProgressPoll])

  /** 主区运行态文案：当前阶段标题（按 WORKSPACE_AGENT_STAGES 序位映射） */
  const agentCurrentStageTitle = agentProgressView
    ? (AGENT_PROGRESS_STAGE_TITLES[
        Math.max(0, WORKSPACE_AGENT_STAGES.indexOf(agentProgressView.currentStage))
      ] ??
      AGENT_PROGRESS_STAGE_TITLES[0])
    : null

  /** 独立进度弹窗 stages：阶段标题 × stageStatuses × 事件日志（工作流失败时当前阶段标红） */
  const agentProgressStages = useMemo<PipelineStage[] | null>(() => {
    if (!agentProgressView) return null
    const statuses = agentProgressView.stageStatuses
    const workflowFailed = agentProgressView.status === "failed"
    const eventsAsc = [...agentProgressView.events].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )
    return WORKSPACE_AGENT_STAGES.map((stage, index) => {
      const state = statuses?.[stage]
      let status: StageStatus =
        state === "done" ? "passed" : state === "active" ? "running" : "queued"
      // 阶段状态本身不产 failed：工作流失败时把运行中/当前阶段标红
      if (
        workflowFailed &&
        (status === "running" || stage === agentProgressView.currentStage)
      ) {
        status = "failed"
      }
      const nodeKeys = STAGE_LOG_NODE_KEYS[stage]
      const logs = eventsAsc
        .filter((ev) => ev.nodeKey && nodeKeys.includes(ev.nodeKey) && ev.detail)
        .slice(-20)
        .map((ev) => ({
          time: new Date(ev.createdAt).toLocaleTimeString("zh-CN", {
            hour12: false,
          }),
          message: ev.detail ?? "",
          level:
            ev.status === "error"
              ? ("error" as const)
              : ev.status === "warn"
                ? ("warning" as const)
                : ("info" as const),
        }))
      return {
        id: stage,
        name: AGENT_PROGRESS_STAGE_TITLES[index] ?? stage,
        icon: STAGE_ICONS[stage],
        status,
        logs,
      }
    })
  }, [agentProgressView])

  /** 进度弹窗上下文条：任务标题 · 卡牌模板名 · #工作流ID */
  const agentPipelineContext = useMemo(() => {
    if (!agentProgressView) return undefined
    const templateName = agentProgressView.templateKey
      ? WORKSPACE_AGENT_TEMPLATES.find(
          (t) => t.meta.key === agentProgressView.templateKey,
        )?.meta.name ?? null
      : null
    return [
      activeTask?.title ?? null,
      templateName,
      agentProgressView.workflowId
        ? `#${agentProgressView.workflowId.slice(0, 8)}`
        : null,
    ].filter((value): value is string => Boolean(value && value.trim()))
  }, [agentProgressView, activeTask?.title])

  // ─── 画面评审（按当前活动卡片查询跨轮留痕） ───
  const [cardReview, setCardReview] = useState<WorkspaceCardReviewPayload | null>(null)
  const activeAgentCard = activeCardId
    ? cards.find((card) => card.id === activeCardId) ?? null
    : null
  // Agent 单卡状态：优先取卡片行 agentStatus（评审 effect 在锁定态会清空 cardReview，
  // 后者仅作旧数据回退）；ToolPanel 据此显示撰写中/评审中并禁用操作
  const agentCardStatus = (
    activeAgentCard?.agentStatus ?? cardReview?.card?.status ?? null
  ) as WorkspaceAgentCardStatus | null
  useEffect(() => {
    if (!isAgentTask || !activeCardId || activeAgentCard?.isLocked) {
      setCardReview(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const result = await getWorkspaceAgentCardReviewAction(activeCardId)
        if (!cancelled && result.ok) {
          const rounds = result.review.rounds
          const lastRound = rounds.at(-1)
          const reviews = lastRound?.reviews ?? []
          const average = (key: "content" | "aesthetic" | "consistency") => {
            const values = reviews.map((review) => review.scores[key]).filter((value): value is number => value != null)
            return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
          }
          const verdict = lastRound?.verdict?.verdict ?? null
          const records = rounds.flatMap((round) => round.reviews.map((review) => ({
            id: `${round.roundId}:${review.reviewerId}`,
            workflowId: result.review.card.id,
            cardId: result.review.card.id,
            roundNumber: round.roundNumber,
            reviewerId: review.reviewerId,
            reviewerName: review.reviewerName,
            scores: review.scores,
            violations: review.violations,
            verdict: round.verdict?.verdict ?? null,
            reason: Object.values(review.reasons).filter(Boolean).join("；"),
            createdAt: review.createdAt,
          })))
          setCardReview({
            card: {
              status: result.review.card.status,
              qualityThreshold: result.review.card.qualityThreshold,
            },
            averageScores: { content: average("content"), aesthetic: average("aesthetic"), consistency: average("consistency") },
            weightedTotal: lastRound?.weightedTotalScore ?? null,
            verdict,
            summary: lastRound?.verdict?.detail ?? lastRound?.reviews.map((review) => Object.values(review.reasons).filter(Boolean).join("；")).filter(Boolean).join("\n") ?? null,
            records,
          })
        } else if (!cancelled) {
          setCardReview(null)
        }
      } catch {
        if (!cancelled) setCardReview(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeCardId, activeAgentCard?.isLocked, isAgentTask, cardImagesMap])

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
      if (agentProgressPollRef.current) {
        clearInterval(agentProgressPollRef.current)
        agentProgressPollRef.current = null
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
    // 切换任务关闭执行进度弹窗（含内嵌向导；均按当前激活任务取数，避免串显）
    setShowAgentProgressDialog(false)
    setAgentFlowStartAtStyle(false)
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

  const handleTaskCreated = useCallback(
    (
      taskId: string,
      _cardCount: number,
      options?: { source?: "manual" | "agent"; workflowId?: string },
    ) => {
      // Agent 任务：记录 taskId → workflowId 桥接（进度轮询按 workflowId 查询）
      if (options?.source === "agent" && options.workflowId) {
        setAgentWorkflowByTask(
          (prev) => new Map(prev).set(taskId, options.workflowId!),
        )
        // 初建任务自动打开执行进度弹窗，向导折叠区自动展开、从风格确认步骤开始
        // （随后四阶段可操作）
        setAgentFlowStartAtStyle(true)
        setShowAgentProgressDialog(true)
      } else {
        setAgentFlowStartAtStyle(false)
      }
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
    },
    [],
  )

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

  /** 设为展示图后同步图片行单选状态（服务端已单选，清除旧图 isSelected 避免双勾选） */
  const handleCardImageSelected = useCallback(
    (cardId: string, imageId: string) => {
      const rows = cardImagesMapRef.current.get(cardId)
      if (!rows?.length) return
      const nextMap = new Map(cardImagesMapRef.current)
      nextMap.set(
        cardId,
        rows.map((item) => ({ ...item, isSelected: item.id === imageId })),
      )
      cardImagesMapRef.current = nextMap
      setCardImagesMap(nextMap)
    },
    [],
  )

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

  /** 重新 Agent 生成（打回耗尽卡的新周期入口）：打开意见弹窗——可填修改
   *  意见（Agent 参考意见改写画面提示词后自动生图评审），也可留空直接按
   *  当前提示词重新评审生成 */
  const [restartAgentCardId, setRestartAgentCardId] = useState<string | null>(null)
  const [restartFeedback, setRestartFeedback] = useState("")
  const [restartingAgent, setRestartingAgent] = useState(false)

  const handleRestartAgentCard = useCallback(
    (cardId: string) => {
      setRestartFeedback("")
      setRestartAgentCardId(cardId)
    },
    [setRestartFeedback, setRestartAgentCardId],
  )

  const confirmRestartAgentCard = useCallback(async () => {
    if (!restartAgentCardId || restartingAgent) return
    const cardId = restartAgentCardId
    const feedback = restartFeedback.trim()
    setRestartingAgent(true)
    try {
      const result = await restartWorkspaceAgentCardAction(cardId, {
        feedback: feedback || undefined,
      })
      if (!result.ok) throw new Error(result.error || "重新 Agent 生成失败")
      toast.success(
        feedback
          ? "已提交：Agent 将按修改意见改写提示词并重新生图评审"
          : "已重新开启 Agent 生图与评审周期",
      )
      setRestartAgentCardId(null)
      const taskId = activeTaskIdRef.current
      if (taskId) await fetchCardsRef.current(taskId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重新 Agent 生成失败")
    } finally {
      setRestartingAgent(false)
    }
  }, [
    restartAgentCardId,
    restartingAgent,
    restartFeedback,
    setRestartAgentCardId,
    setRestartingAgent,
  ])

  /** 神谕文案 CSV 下载：action 返回 CSV 文本，前端 Blob 触发浏览器下载 */
  const handleDownloadOracleCsv = useCallback(async () => {
    const taskId = activeTaskIdRef.current
    if (!taskId) return
    try {
      const result = await downloadWorkspaceAgentOracleCsvAction(taskId)
      if (!result.ok) throw new Error(result.error || "下载神谕文案失败")
      const blob = new Blob([`\uFEFF${result.csv}`], {
        type: "text/csv;charset=utf-8",
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = result.filename
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success("神谕文案 CSV 已开始下载")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载神谕文案失败")
    }
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
    const card = cardsRef.current.find((item) => item.id === cardId)
    if (!card) return
    if (card.isLocked) {
      toast.info("该卡片正在等待 Agent 撰写提示词")
      return
    }
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
    // Agent 任务批量生图走冻结模型 + kind 尺寸管线（服务端忽略 apiId/size），
    // 且 Agent 任务视图无生成配置入口，不做所选模型/尺寸强校验
    if (!isAgentTask && (!selectedImageModel || !selectedSize)) {
      toast.error("请先选择图片模型和尺寸")
      return
    }
    const ids = [...selectedCardIds]
    setBatchGeneratingImageCardIds(new Set(ids))
    try {
      const result = await batchGenerateImageAction(ids, {
        apiId: selectedImageModel?.id,
        size: selectedSize ?? undefined,
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

  // ─── 可选卡数（排除锁定卡，与全选按钮/批量选择口径一致）───
  const selectableCardsCount = useMemo(
    () => cards.filter((card) => !card.isLocked).length,
    [cards],
  )

  // ─── 渲染 ───

  // 任务侧栏内容：桌面 aside 与移动端抽屉复用同一节点（P1-3）
  const taskSidebar = (
    <>
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
    </>
  )

  return (
    // 绝对定位贴满 header 以下的工作区（相对 SidebarInset 的 relative），
    // 避开 dashboard-shell 的 p-4 包裹层：左栏贴住导航栏与顶栏，分割线贯穿到底。
    // 不用 gap：主区需紧贴左栏 border-r，保证工具栏 border-b 与竖线在左上角相接。
    // <md：左栏隐藏，改为工具栏「任务列表」按钮唤出抽屉（P1-3）
    <div className="absolute inset-x-0 top-16 bottom-0 flex">
      <aside
        className="hidden md:flex flex-col border-r border-border bg-sidebar/20 shrink-0"
        style={{ width: SIDEBAR_WIDTH }}
      >
        {taskSidebar}
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
                {/* 移动端：<md 侧栏隐藏，从此处唤出任务抽屉 */}
                <Button
                  variant="outline"
                  size="sm"
                  className="md:hidden"
                  onClick={() => setMobileSidebarOpen(true)}
                >
                  <ListTodo className="h-4 w-4" />
                  任务列表
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="max-md:hidden"
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
              {/* 移动端任务列表唤出（<md 侧栏隐藏时显示） */}
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 rounded-md md:hidden"
                onClick={() => setMobileSidebarOpen(true)}
              >
                <ListTodo className="h-3.5 w-3.5" />
                任务
              </Button>
              {isAgentTask ? (
                /* Agent 任务：独立 Agent 总览 + 执行进度入口（不显示生成配置） */
                <>
                  <Button
                    size="sm"
                    className="h-7 text-xs gap-1 rounded-md bg-violet-600 text-white hover:bg-violet-700"
                    onClick={() => setShowAgentDialog(true)}
                  >
                    <Bot className="h-3.5 w-3.5" />
                    Agent
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1 rounded-md"
                    onClick={() => setShowAgentProgressDialog(true)}
                  >
                    <Activity className="h-3.5 w-3.5" />
                    执行进度
                  </Button>
                </>
              ) : (
                /* 普通任务：保持生成配置入口 */
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
              )}
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
                      selectedCardIds.size === selectableCardsCount
                        ? "bg-gray-400 hover:bg-gray-500"
                        : "bg-green-600 hover:bg-green-700",
                    )}
                    onClick={() => {
                      if (selectedCardIds.size === selectableCardsCount) {
                        setSelectedCardIds(new Set())
                        setFlipAllToImage(false)
                      } else {
                        const selectable = cards.filter((card) => !card.isLocked)
                        setSelectedCardIds(new Set(selectable.map((c) => c.id)))
                        setFlipAllToImage(true)
                      }
                    }}
                  >
                    <CheckSquare className="h-3.5 w-3.5" />
                    {selectedCardIds.size === selectableCardsCount
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
                              // Agent 任务批量生图走冻结模型 + kind 尺寸管线
                              // （服务端忽略 apiId/size），无生成配置入口不强校验
                              if (
                                !isAgentTask &&
                                (!selectedImageModel || !selectedSize)
                              ) {
                                toast.error("请先在生成配置中选择图片模型和尺寸")
                                return
                              }
                              const selectedCards = cards.filter((card) =>
                                selectedCardIds.has(card.id),
                              )
                              const selectedKinds = new Set(
                                selectedCards.map((card) => card.agentKind).filter(Boolean),
                              )
                              if (selectedKinds.size > 1) {
                                toast.error("Agent 批量生成不能混合牌面、牌背、牌盒和边框，请分类型选择")
                                return
                              }
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
              ) : activeTask?.status === "generating" && isAgentTask ? (
                /* Agent 任务运行态：四阶段流水线提示 + 执行进度入口 */
                <div className="flex items-center justify-center h-full">
                  <div className="text-center space-y-3">
                    <MorphingInfinity className="h-10 w-10 mx-auto text-primary" />
                    <p className="text-sm text-muted-foreground">
                      {agentCurrentStageTitle
                        ? `Agent 四阶段流水线运行中（${agentCurrentStageTitle}）...`
                        : "Agent 正在生产卡牌，请稍候..."}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowAgentProgressDialog(true)}
                    >
                      <Activity className="h-3.5 w-3.5" />
                      查看执行进度
                    </Button>
                  </div>
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
                    <p className="text-sm text-muted-foreground">
                      {isAgentTask ? "Agent 生产失败" : "裂变失败"}
                    </p>
                    {activeTask.errorMessage && (
                      <p className="text-xs text-muted-foreground max-w-sm">
                        {activeTask.errorMessage}
                      </p>
                    )}
                    {isAgentTask && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowAgentProgressDialog(true)}
                      >
                        <Activity className="h-3.5 w-3.5" />
                        查看执行进度
                      </Button>
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
                  onRestartAgent={handleRestartAgentCard}
                  batchDeepeningCardIds={batchDeepeningCardIds}
                  batchRegeneratingCardIds={batchRegeneratingCardIds}
                  batchTranslatingCardIds={batchTranslatingCardIds}
                  batchGeneratingImageCardIds={batchGeneratingImageCardIds}
                  locked={isAgentTask}
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

      {/* 移动端任务抽屉（<md 侧栏隐藏，工具栏/空态按钮唤出；P1-3） */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent
          side="left"
          className="w-[280px] gap-0 p-0 sm:max-w-[280px]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>任务列表</SheetTitle>
          </SheetHeader>
          <div className="flex h-full flex-col">{taskSidebar}</div>
        </SheetContent>
      </Sheet>

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
          onCardImageSelected={handleCardImageSelected}
          cardReview={cardReview}
          agentCardStatus={agentCardStatus}
          onRestartAgent={handleRestartAgentCard}
        />
      )}

      {/* ─── 对话框 ─── */}

      <NewTaskDialog
        open={showNewTask}
        onOpenChange={setShowNewTask}
        onCreated={handleTaskCreated}
      />

      {/* ─── Agent 总览 / 工作流向导弹窗（Agent 任务专属；数据来自进度轮询） ─── */}
      <WorkspaceAgentDialog
        open={showAgentDialog}
        onOpenChange={setShowAgentDialog}
        stats={agentProgressView?.stats ?? null}
        cardSummary={agentProgressView?.cardSummary ?? null}
        agents={agentProgressView?.agents ?? null}
        oracleCopy={agentProgressView?.oracleCopy ?? null}
        onDownloadOracleCsv={handleDownloadOracleCsv}
        onOpenProgress={() => {
          setShowAgentDialog(false)
          setShowAgentProgressDialog(true)
        }}
      />

      {/*
       * 执行进度弹窗（受控）：固定高度 3D 流水线 + 阶段日志（数据来自 Agent
       * 进度轮询视图）+ 内嵌可折叠「工作流向导」（完整交互，默认收起，创建
       * 任务时自动展开并从风格确认步骤开始；taskId 按当前激活的 Agent 任务
       * 轮询）。关闭时重开标记复位，并补拉任务列表与卡片（提示词撰写结果落
       * 回工作台卡片，生图/评审未接入不会自动推进）。
       */}
      <WorkspaceAgentProgressDialog
        open={showAgentProgressDialog}
        onOpenChange={(next) => {
          setShowAgentProgressDialog(next)
          if (!next) {
            setAgentFlowStartAtStyle(false)
            // 静默补拉：撰写结果落回卡片，不触发全屏加载态（防关闭闪烁）
            void fetchTasksRef.current(1, false, { silent: true })
            const taskId = activeTaskIdRef.current
            if (taskId) void fetchCardsRef.current(taskId, { silent: true })
          }
        }}
        stages={agentProgressStages}
        context={agentPipelineContext}
        startedAt={agentProgressView?.createdAt ?? null}
        taskId={isAgentTask ? activeTaskId : null}
        startAtStyle={agentFlowStartAtStyle}
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

      {/* 重新 Agent 生成（可带修改意见）：意见交提示词设计师参考改写画面
          提示词，留空则按当前提示词直接重新生图评审 */}
      <Dialog
        open={restartAgentCardId != null}
        onOpenChange={(open) => {
          if (!open && !restartingAgent) setRestartAgentCardId(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-violet-500" />
              重新 Agent 生成
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-sm leading-relaxed text-muted-foreground">
              将重置该卡片的打回轮数并开启新一轮生图与自动评审。可填写修改意见，Agent
              会参考意见改写画面提示词后重新生成；留空则按当前提示词直接重新评审生成。
            </p>
            <Textarea
              value={restartFeedback}
              onChange={(e) => setRestartFeedback(e.target.value)}
              maxLength={500}
              className="min-h-[96px] resize-none text-sm leading-relaxed"
              placeholder="可选：修改意见，如「主体更贴近牌义、背景简化、光影更柔和」…"
            />
            <div className="text-right text-[11px] text-muted-foreground">
              {restartFeedback.length}/500
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRestartAgentCardId(null)}
              disabled={restartingAgent}
            >
              取消
            </Button>
            <Button
              onClick={() => void confirmRestartAgentCard()}
              disabled={restartingAgent}
              className="gap-1.5"
            >
              {restartingAgent ? (
                <Spinner className="size-3.5" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {restartingAgent ? "提交中…" : "重新生成"}
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
