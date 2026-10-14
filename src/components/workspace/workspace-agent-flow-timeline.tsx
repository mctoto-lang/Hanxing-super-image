"use client"

/**
 * 工作台 · Agent 工作流向导时间线（内嵌于「智能体执行进度」弹窗的折叠区）
 *
 * 由原独立向导弹窗抽出：五步纵向时间线（历史步骤可点击展开查看、始终只读，
 * 仅当前步骤可操作）：
 * - 风格确认：顶部「生成配置」区在方向定稿前可改生图模型与四类尺寸（修改
 *   只影响之后新生成的方向示例图）；有参考图时自动入队 AI 风格分析，分析
 *   结果在用户未手写描述时作为风格草稿回填，确认后生成 3 个候选主题；
 * - 主题选择：3 选 1（选定后锁定，历史只读）；
 * - 想象力程度：高/中/低 → bold / balanced / conservative，选定后锁定并自动
 *   入队生成 3 个创作方向；
 * - 落地方向：3 选 1 + 示例图（固定 2:3 容器 object-contain 完整展示，按
 *   pending/generating/completed/failed 渲染），选定后 styleDoc 定稿、配置冻结；
 * - 提示词撰写：展示撰写进度（已完成/总张数），可入队撰写/按反馈重写。
 *
 * 约束：
 * - 挂载即按 taskId 轮询（3s 一拍），卸载/切任务即停止并重置本地状态；
 * - 服务端队列运行中（queued/processing > 0 或 workflow queued/running）时
 *   全部操作禁用，仅轮询进度；
 * - 主题/想象力/方向一经选定，前后端均拒绝改选（时间线仅可回看）；
 * - 提示词完成后进入卡片阶段的生图/评审循环（由卡片网格与工具面板承接）；
 * - 折叠区收起即卸载本组件，重展开由「执行进度」重新打开时，从轮询载荷
 *   恢复到 current stage。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ImageIcon,
  ImageOff,
  Loader2,
  Lock,
  Palette,
  RefreshCw,
  Settings2,
  Sparkles,
} from "lucide-react"
import { cn, toImageSrc } from "@/lib/utils"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { parseImageSize, resolveSizePresets } from "@/lib/image-sizes"
import { resolveCompatibleTemplateSizes } from "@/lib/workspace/agent-templates"
import type { WorkspaceAgentTemplateSizes } from "@/lib/workspace/agent-types"
import { SmartImage } from "@/components/ui/smart-image"
import {
  PLAN_STEP_STATUS_CIRCLE_CLASS,
  type PlanStepStatus,
} from "@/components/ui/agent-planning"
import {
  chooseWorkspaceAgentImaginationAction,
  confirmWorkspaceAgentStyleAction,
  generateWorkspaceAgentDirectionsAction,
  generateWorkspaceAgentPromptsAction,
  generateWorkspaceAgentThemesAction,
  listWorkspaceAgentModelsAction,
  requestWorkspaceAgentReferenceStyleAnalysisAction,
  updateWorkspaceAgentImageConfigAction,
  getWorkspaceAgentProgressAction,
  selectWorkspaceAgentDirectionAction,
  selectWorkspaceAgentThemeAction,
} from "@/server/actions/workspace"
import type {
  WorkspaceAgentProgressDirection,
  WorkspaceAgentProgressPayload,
} from "@/server/services/workspace-agent/progress"

// ─── 步骤编制 ───

const STEP_STYLE = 0
const STEP_THEME = 1
const STEP_IMAGINATION = 2
const STEP_DIRECTION = 3
const STEP_PROMPT = 4
const STEP_COUNT = 5
/** viewStep 收起哨兵：全部步骤收起（轮询不自动展开，点步骤头再展开） */
const STEP_COLLAPSED = -1

const SIZE_KIND_LABELS: Array<{ kind: keyof WorkspaceAgentTemplateSizes; label: string }> = [
  { kind: "card", label: "卡面" },
  { kind: "back", label: "牌背" },
  { kind: "border", label: "边框" },
  { kind: "box", label: "牌盒" },
]

/** 步骤标题（四阶段严格用：主题选择 / 想象力程度 / 落地方向 / 提示词撰写） */
const STEP_TITLES: Record<number, string> = {
  [STEP_STYLE]: "风格确认",
  [STEP_THEME]: "主题选择",
  [STEP_IMAGINATION]: "想象力程度",
  [STEP_DIRECTION]: "落地方向",
  [STEP_PROMPT]: "提示词撰写",
}

/** workflow 状态 → 中文标签 */
const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_human: "等待确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

/** 想象力档位（UI 高/中/低 → 服务端 bold / balanced / conservative；措辞对齐 run.ts） */
const IMAGINATION_OPTIONS = [
  {
    level: "bold",
    label: "高",
    name: "大胆演绎",
    desc: "重构经典意象，鼓励强烈的个人风格与超现实组合，视觉冲击优先",
  },
  {
    level: "balanced",
    label: "中",
    name: "均衡演绎",
    desc: "在主题框架内适度发挥，允许新颖但可读的意象组合",
  },
  {
    level: "conservative",
    label: "低",
    name: "保守演绎",
    desc: "恪守经典牌义与用户给定描述，意象直白克制，画面稳定可预期",
  },
] as const

type ImaginationLevel = (typeof IMAGINATION_OPTIONS)[number]["level"]

function imaginationLabelOf(level: string | null | undefined): string {
  const found = IMAGINATION_OPTIONS.find((o) => o.level === level)
  return found ? `${found.label}（${found.name}）` : level ?? "—"
}

/** 终态判断（轮询停止由调用方负责；此处仅用于禁用操作） */
function isTerminalStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

/**
 * 从轮询载荷恢复当前步骤（刷新后重开 / 主动作推进后跟随服务端状态）：
 * 方向定稿（styleDoc/selectedDirectionId）→ 提示词撰写；有创作方向候选或
 * 已选想象力 → 落地方向；已选主题 → 想象力程度；否则 → 主题选择。
 * 风格确认步骤不参与推导（发起即确认，仅初建自动打开时从该步开始）。
 */
function deriveActiveStep(payload: WorkspaceAgentProgressPayload): number {
  // 风格未确认（发起未随表单确认的遗留/边缘工作流）→ 停在风格确认步骤
  if (!payload.input.styleConfirmedAt) return STEP_STYLE
  if (payload.selectedDirectionId || payload.workflow.styleDoc) {
    return STEP_PROMPT
  }
  const hasDirectionCandidates = payload.directions.some(
    (d) => d.round === "direction" && d.status === "candidate",
  )
  if (hasDirectionCandidates || payload.input.imaginationLevel) {
    return STEP_DIRECTION
  }
  if (payload.selectedThemeId) return STEP_IMAGINATION
  return STEP_THEME
}

/** 候选卡片摘要行（历史阶段只读摘要用） */
function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function asTemplateSizes(
  value: Record<string, string> | null | undefined,
): WorkspaceAgentTemplateSizes | null {
  if (!value?.card || !value.back || !value.border || !value.box) return null
  return {
    card: value.card,
    back: value.back,
    border: value.border,
    box: value.box,
  }
}

interface Props {
  /** 挂靠的工作台任务 id（按此轮询进度；非 Agent 任务传 null） */
  taskId: string | null
  /** 初建任务自动展开时置 true：从风格确认步骤开始 */
  startAtStyle?: boolean
}

export function WorkspaceAgentFlowTimeline({
  taskId,
  startAtStyle = false,
}: Props) {
  const [payload, setPayload] = useState<WorkspaceAgentProgressPayload | null>(
    null,
  )
  const [loadError, setLoadError] = useState<string | null>(null)
  /** null = 未初始化（等待首轮载荷决定） */
  const [viewStep, setViewStep] = useState<number | null>(null)
  const [acting, setActing] = useState(false)
  // 风格草稿（null = 未改动，回显 input.stylePrompt）
  const [styleDraft, setStyleDraft] = useState<string | null>(null)
  const [themeFeedback, setThemeFeedback] = useState("")
  const [directionFeedback, setDirectionFeedback] = useState("")
  const [promptFeedback, setPromptFeedback] = useState("")
  const [imageModels, setImageModels] = useState<Array<{
    id: string
    displayName?: string | null
    name?: string | null
    sizes?: string[] | null
    sizePresets?: import("@/db/schema").ModelSizePreset[] | null
  }>>([])
  const [selectedImageModelId, setSelectedImageModelId] = useState("")
  const [selectedSizes, setSelectedSizes] = useState<WorkspaceAgentTemplateSizes | null>(null)
  const [configSaving, setConfigSaving] = useState(false)
  const [analysisRequested, setAnalysisRequested] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const viewingHistoryRef = useRef(false)
  const taskIdRef = useRef<string | null>(taskId)
  const initialStepRef = useRef<number | null>(null)

  useEffect(() => {
    taskIdRef.current = taskId
  }, [taskId])

  /** 轮询载荷落地：更新数据 + 恢复/跟随步骤（风格步骤需显式确认，不自动跳过） */
  const applyPayload = useCallback(
    (next: WorkspaceAgentProgressPayload) => {
      setPayload(next)
      setSelectedImageModelId((prev) => prev || next.input.imageModelId || "")
      setSelectedSizes((prev) => prev ?? asTemplateSizes(next.input.sizes))
      const derived = deriveActiveStep(next)
      setViewStep((prev) => {
        if (prev == null) return initialStepRef.current ?? derived
        // 用户手动收起全部步骤：保持收起，轮询不自动展开。
        if (prev === STEP_COLLAPSED) return prev
        // 用户正在查看历史步骤时，轮询不能把视图强行跳回当前步骤。
        if (viewingHistoryRef.current) return prev
        if (prev === STEP_STYLE) return prev
        return Math.max(prev, derived)
      })
    },
    [],
  )

  // ─── 轮询（挂载/切任务启动，3s 一拍；卸载/清空 taskId 停止并重置） ───
  useEffect(() => {
    if (!taskId) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      setPayload(null)
      setLoadError(null)
      return
    }
    let cancelled = false
    setPayload(null)
    setLoadError(null)
    setViewStep(null)
    setStyleDraft(null)
    setThemeFeedback("")
    setDirectionFeedback("")
    setPromptFeedback("")
    setImageModels([])
    setSelectedImageModelId("")
    setSelectedSizes(null)
    setConfigSaving(false)
    setAnalysisRequested(false)
    viewingHistoryRef.current = false
    initialStepRef.current = startAtStyle ? STEP_STYLE : null

    const tick = async () => {
      const currentTaskId = taskIdRef.current
      if (!currentTaskId) return
      try {
        const res = await getWorkspaceAgentProgressAction(currentTaskId)
        if (cancelled || taskIdRef.current !== currentTaskId) return
        if (!res.ok || !res.progress) {
          setLoadError(res.ok ? "工作流不存在" : res.error)
          return
        }
        setLoadError(null)
        applyPayload(res.progress)
      } catch {
        // 轮询失败不中断，下次间隔重试
      }
    }
    void tick()
    pollRef.current = setInterval(() => void tick(), 3000)
    return () => {
      cancelled = true
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [taskId, startAtStyle, applyPayload])

  // 挂载时加载生图模型候选；只读展示也复用同一候选池。
  useEffect(() => {
    let cancelled = false
    void listWorkspaceAgentModelsAction()
      .then((result) => {
        if (!cancelled) setImageModels(result.imageModels ?? [])
      })
      .catch(() => {
        if (!cancelled) setImageModels([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 有参考图时，自动请求一次风格分析；服务端 action 幂等。
  useEffect(() => {
    if (!payload?.workflow.id || !payload.input.referenceImages.length) return
    if (payload.input.styleConfirmedAt) return
    if (payload.input.referenceStyleAnalysisStatus || analysisRequested) return
    setAnalysisRequested(true)
    void requestWorkspaceAgentReferenceStyleAnalysisAction(payload.workflow.id).catch(() => {
      setAnalysisRequested(false)
    })
  }, [payload, analysisRequested])

  // 卸载兜底清理
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [])

  const workflowId = payload?.workflow.id ?? null

  /** 统一动作执行：busy 守卫 + 错误 toast + 成功后立即刷新进度 */
  const runAction = useCallback(
    async (
      label: string,
      fn: () => Promise<{ ok: boolean; error: string | null }>,
      onSuccess?: () => void,
    ) => {
      if (acting || !workflowId) return
      setActing(true)
      try {
        const res = await fn()
        if (!res.ok) {
          toast.error(res.error || `${label}失败`)
          return
        }
        toast.success(`${label}成功`)
        onSuccess?.()
        // 立即拉一拍进度（3s 轮询兜底）
        try {
          const currentTaskId = taskIdRef.current
          if (currentTaskId) {
            const refreshed = await getWorkspaceAgentProgressAction(currentTaskId)
            if (refreshed.ok && refreshed.progress) applyPayload(refreshed.progress)
          }
        } catch {
          // 刷新失败交由轮询兜底
        }
      } finally {
        setActing(false)
      }
    },
    [acting, workflowId, applyPayload],
  )

  // ─── 派生状态 ───

  const workflow = payload?.workflow ?? null
  const input = payload?.input ?? null
  const terminal = isTerminalStatus(workflow?.status)
  /** 服务端队列运行中（queued/processing 任务或 workflow 排队/运行）：全部操作禁用 */
  const busy = useMemo(() => {
    if (!payload) return false
    return (
      payload.jobs.queued + payload.jobs.processing > 0 ||
      payload.workflow.status === "queued" ||
      payload.workflow.status === "running"
    )
  }, [payload])

  const themeRows = useMemo(
    () => (payload?.directions ?? []).filter((d) => d.round === "theme" && d.status !== "rejected"),
    [payload],
  )
  const directionRows = useMemo(
    () => (payload?.directions ?? []).filter((d) => d.round === "direction" && d.status !== "rejected"),
    [payload],
  )
  const selectedTheme = useMemo(
    () =>
      (payload?.directions ?? []).find(
        (d) => d.id === payload?.selectedThemeId,
      ) ?? null,
    [payload],
  )
  const selectedDirection = useMemo(
    () =>
      (payload?.directions ?? []).find(
        (d) => d.id === payload?.selectedDirectionId,
      ) ?? null,
    [payload],
  )
  const themesProduced = (payload?.directions ?? []).length > 0
  const cardsTotal = payload?.cards.total ?? 0
  const promptsWritten = payload?.cards.promptsWritten ?? 0
  const promptsAllDone = cardsTotal > 0 && promptsWritten >= cardsTotal

  // 风格步骤可编辑性：主题已产出 / 队列执行中 / 终态 → 只读
  const styleEditable =
    !!input && !themesProduced && !busy && !terminal && workflowId != null

  const derivedStep = payload ? deriveActiveStep(payload) : STEP_STYLE
  const currentStep = viewStep ?? derivedStep
  const stylePromptValue =
    styleDraft ?? input?.stylePrompt ?? input?.referenceStyleAnalysis ?? ""
  const imageModel = imageModels.find((model) => model.id === (selectedImageModelId || input?.imageModelId)) ?? null
  const templateKey = input?.templateKey === "poker58" || input?.templateKey === "oracle58" ? input.templateKey : "tarot81"
  const currentSizes = selectedSizes ?? asTemplateSizes(input?.sizes)
  const sizeOptions = imageModel?.sizePresets?.length
    ? resolveSizePresets(imageModel.sizePresets).map((preset) => preset.value)
    : imageModel?.sizes?.length
      ? imageModel.sizes
      : []
  const imageConfigEditable =
    !!input && !payload?.selectedDirectionId && !workflow?.styleDoc && !busy && !terminal

  const ensureSizeConfig = (modelId: string, sizes: WorkspaceAgentTemplateSizes | null) => {
    const model = imageModels.find((candidate) => candidate.id === modelId)
    const enabled = model?.sizePresets?.length
      ? resolveSizePresets(model.sizePresets).map((preset) => preset.value)
      : model?.sizes ?? []
    if (!sizes || enabled.length === 0) return sizes
    return resolveCompatibleTemplateSizes({ templateKey, current: sizes, enabledSizes: enabled })
  }

  // ─── 步骤动作 ───

  /** 风格确认：主题尚未产出时的唯一入队口——草稿有改动先落库，随后（重新）入队
   *  生成 3 主题；主题已产出（重开向导）时仅推进视图不重复入队 */
  const handleSaveImageConfig = async () => {
    if (!workflowId || !selectedImageModelId || !selectedSizes || !imageConfigEditable) return
    setConfigSaving(true)
    try {
      const result = await updateWorkspaceAgentImageConfigAction(workflowId, {
        imageModelId: selectedImageModelId,
        sizes: selectedSizes,
      })
      if (!result.ok) {
        toast.error(result.error || "模型与尺寸保存失败")
        return
      }
      toast.success("模型与尺寸已保存，后续新生成方向将使用新配置")
      const currentTaskId = taskIdRef.current
      if (currentTaskId) {
        const refreshed = await getWorkspaceAgentProgressAction(currentTaskId)
        if (refreshed.ok && refreshed.progress) applyPayload(refreshed.progress)
      }
    } finally {
      setConfigSaving(false)
    }
  }

  /** 风格确认（统一走 runAction 忙等守卫：acting 期间按钮禁用 + 成功后立即
   *  刷新进度，双击不会并发触发两次 confirm + 生成主题链） */
  const handleConfirmStyle = () => {
    if (!workflowId) return
    const original = input?.stylePrompt ?? ""
    const confirmedValue = styleDraft ?? input?.stylePrompt ?? input?.referenceStyleAnalysis ?? ""
    const changed = confirmedValue !== original
    void runAction(
      "确认风格",
      async () => {
        if (changed || !input?.styleConfirmedAt) {
          const res = await confirmWorkspaceAgentStyleAction(workflowId, {
            stylePrompt: confirmedValue,
          })
          if (!res.ok) return res
        }
        if (!themesProduced && !busy) {
          // 创建不再预排队主题任务：确认风格即触发生成 3 主题；
          // busy（已有任务在跑，如重复点击）时仅推进视图
          const res = await generateWorkspaceAgentThemesAction(workflowId, {})
          if (!res.ok) return res
        }
        return { ok: true, error: null }
      },
      () => setViewStep(STEP_THEME),
    )
  }

  const handleSelectTheme = (directionId: string) => {
    void runAction("选择主题", () =>
      selectWorkspaceAgentThemeAction(workflowId!, directionId),
    )
  }

  const handleRegenThemes = () => {
    void runAction("生成主题", () =>
      generateWorkspaceAgentThemesAction(workflowId!, {
        feedback: themeFeedback.trim() || undefined,
      }),
    )
  }

  const handleChooseImagination = (level: ImaginationLevel) => {
    void runAction("想象力档位选择", () =>
      chooseWorkspaceAgentImaginationAction(workflowId!, level),
    )
  }

  const handleRegenDirections = () => {
    void runAction("生成创作方向", () =>
      generateWorkspaceAgentDirectionsAction(workflowId!, {
        feedback: directionFeedback.trim() || undefined,
      }),
    )
  }

  const handleSelectDirection = (directionId: string) => {
    void runAction("选择方向", () =>
      selectWorkspaceAgentDirectionAction(workflowId!, directionId),
    )
  }

  const handleGeneratePrompts = () => {
    void runAction("提示词撰写", () =>
      generateWorkspaceAgentPromptsAction(workflowId!, {
        feedback: promptFeedback.trim() || undefined,
      }),
    )
  }

  // ─── 渲染片段 ───

  /** 方向/主题候选卡片 */
  const renderDirectionCard = (
    d: WorkspaceAgentProgressDirection,
    kind: "theme" | "direction",
    readOnly = false,
  ) => {
    const isTheme = kind === "theme"
    const selectable = !readOnly && !busy && !acting && !terminal
    return (
      <div
        key={d.id}
        className={cn(
          "flex flex-col rounded-lg border bg-card p-3 text-left transition-colors",
          selectable
            ? "border-border hover:border-violet-400 hover:bg-violet-50/40 dark:hover:bg-violet-950/20"
            : "border-border/70 opacity-80",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {d.name}
            </div>
            {d.concept && (
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {d.concept}
              </div>
            )}
          </div>
        </div>

        {isTheme ? (
          <>
            {d.worldview && (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                <span className="font-medium text-foreground/80">世界观：</span>
                {d.worldview}
              </p>
            )}
            {d.palette && (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                <span className="font-medium text-foreground/80">色彩：</span>
                {d.palette}
              </p>
            )}
          </>
        ) : (
          <>
            {d.visualLanguage && (
              <p className="mt-2 rounded-md bg-muted/60 px-2 py-1.5 text-xs leading-5 text-muted-foreground">
                <span className="font-medium text-foreground/80">
                  固定风格提示词：
                </span>
                {d.visualLanguage}
              </p>
            )}
            {d.sampleCards.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  示例卡文案（文字小样，非图片）
                </div>
                {d.sampleCards.map((s, i) => (
                  <p
                    key={`${d.id}-sample-${i}`}
                    className="text-xs leading-5 text-muted-foreground"
                  >
                    <span className="text-foreground/80">{s.name || "示例"}：</span>
                    {s.scene}
                  </p>
                ))}
              </div>
            )}
            {/* 示例图：按 preview 状态渲染（生成中 spinner / 失败原因 / 实际图片）；
                容器比例跟随当前卡面尺寸，object-contain 保证完整显示不裁切 */}
            {(() => {
              const { width: cardW, height: cardH } = parseImageSize(currentSizes?.card)
              const aspect = cardW > 0 && cardH > 0 ? `${cardW} / ${cardH}` : "2 / 3"
              return (
            <div className="mt-2 w-full overflow-hidden rounded-md border bg-muted/30" style={{ aspectRatio: aspect }}>
              {d.exampleImageStatus === "completed" && d.exampleImageUrl ? (
                <SmartImage
                  src={toImageSrc(d.exampleImageUrl)}
                  alt={`${d.name} 示例图`}
                  className="h-full w-full object-contain"
                  loading="lazy"
                />
              ) : d.exampleImageStatus === "failed" ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                  <ImageOff className="h-4 w-4 opacity-60" />
                  <span className="text-center text-[11px]">示例图生成失败（不影响方向选择）</span>
                </div>
              ) : d.exampleImageStatus === "pending" || d.exampleImageStatus === "generating" ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin opacity-70" />
                  <span className="text-[11px]">示例图生成中…</span>
                </div>
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                  <ImageOff className="h-4 w-4 opacity-60" />
                  <span className="text-[11px]">暂无示例图</span>
                </div>
              )}
            </div>
            )
            })()}
          </>
        )}

        <div className="mt-3 flex-1" />
        {!readOnly && (
          <Button
            size="sm"
            className="h-7 w-full text-xs"
            disabled={!selectable}
            onClick={() =>
              isTheme ? handleSelectTheme(d.id) : handleSelectDirection(d.id)
            }
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            {isTheme ? "选定此主题" : "选定此方向"}
          </Button>
        )}
      </div>
    )
  }

  /** 反馈输入 + 重新生成按钮（主题 / 方向阶段共用） */
  const renderFeedbackRow = (
    value: string,
    onChange: (v: string) => void,
    onRegen: () => void,
    regenLabel: string,
    placeholder: string,
  ) => (
    <div className="mt-3 space-y-1.5">
      <Textarea
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={500}
        disabled={busy || acting || terminal}
        className="text-xs"
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          反馈可选（{value.length}/500）
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={busy || acting || terminal}
          onClick={onRegen}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {regenLabel}
        </Button>
      </div>
    </div>
  )

  /** 单个时间线步骤（模板样式：状态圆点 + 贯穿连接线 + grid-rows 展开动画）：
   *  历史步骤可展开查看但始终只读，当前步骤才显示操作控件，锁定步骤禁点。 */
  const renderStep = (step: number) => {
    const title = STEP_TITLES[step]!
    const isLast = step === STEP_COUNT - 1
    const isCurrentStage = step === derivedStep
    const isExpanded = step === currentStep
    const isDone = step < derivedStep
    const isLocked = step > derivedStep
    const readOnly = !isCurrentStage
    // 模板四态映射：已完成 success / 当前 active（失败标 error）/ 未到 pending
    const planStatus: PlanStepStatus = isDone
      ? "success"
      : isCurrentStage
        ? workflow?.error
          ? "error"
          : "active"
        : "pending"

    // 历史阶段只读摘要
    let summary: string | null = null
    if (step === STEP_STYLE) {
      summary = input
        ? input.stylePrompt
          ? truncateText(input.stylePrompt, 60)
          : "未附加风格描述"
        : null
    } else if (step === STEP_THEME) {
      summary = selectedTheme ? `已选主题：${selectedTheme.name}` : null
    } else if (step === STEP_IMAGINATION) {
      summary = input?.imaginationLevel
        ? `已选档位：${imaginationLabelOf(input.imaginationLevel)}`
        : null
    } else if (step === STEP_DIRECTION) {
      summary = selectedDirection ? `已选方向：${selectedDirection.name}` : null
    } else if (step === STEP_PROMPT) {
      summary =
        cardsTotal > 0
          ? `撰写进度：${promptsWritten}/${cardsTotal}`
          : null
    }

    return (
      <div
        key={step}
        className={cn(
          "relative flex animate-in fade-in fill-mode-both gap-4 slide-in-from-top-4 duration-500",
          planStatus === "pending" && "opacity-60 grayscale",
        )}
        style={{ animationDelay: `${step * 80}ms` }}
      >
        {/* 时间线连接线 */}
        {!isLast && (
          <div className="absolute bottom-[-10px] left-[11px] top-7 z-0 w-[2px] bg-border/60" />
        )}

        {/* 图标列：状态圆点（模板配色；ring-card 抠出连接线） */}
        <div className="relative z-10 mt-0.5 h-6 w-6 flex-none">
          <div
            className={cn(
              "flex h-full w-full items-center justify-center rounded-full ring-4 ring-card transition-colors duration-300",
              PLAN_STEP_STATUS_CIRCLE_CLASS[planStatus],
            )}
          >
            {planStatus === "success" ? (
              <Check className="h-3.5 w-3.5" />
            ) : planStatus === "error" ? (
              <CircleAlert className="h-3.5 w-3.5" />
            ) : planStatus === "active" ? (
              busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <span className="text-[11px] font-semibold">{step + 1}</span>
              )
            ) : (
              <Lock className="h-3 w-3" />
            )}
          </div>
        </div>

        {/* 内容列 */}
        <div className="min-w-0 flex-1 pb-6">
          {/* 步骤头：标题 + 摘要 + busy/展开箭头 */}
          <button
            type="button"
            disabled={isLocked}
            onClick={() => {
              // 再次点击已展开的步骤头 → 收起全部（不随轮询自动展开）
              if (isExpanded) {
                viewingHistoryRef.current = false
                setViewStep(STEP_COLLAPSED)
                return
              }
              if (isDone || isCurrentStage) {
                viewingHistoryRef.current = isDone
                setViewStep(step)
              }
            }}
            className={cn(
              "group -mx-2 flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left transition-colors",
              isLocked
                ? "cursor-not-allowed"
                : "cursor-pointer hover:bg-secondary/50",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "shrink-0 text-sm tracking-tight transition-colors duration-200",
                  planStatus === "active" && "font-semibold text-foreground",
                  planStatus === "error" &&
                    "font-semibold text-rose-600 dark:text-rose-400",
                  (planStatus === "success" || planStatus === "pending") &&
                    "font-medium text-foreground/80 group-hover:text-foreground",
                )}
              >
                {title}
              </span>
              {isDone && summary && (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {summary}
                </span>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-3">
              {isCurrentStage && busy && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
              )}
              {!isLocked && (
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-muted-foreground/40 transition-transform group-hover:text-muted-foreground",
                    isExpanded && "rotate-180",
                  )}
                />
              )}
            </div>
          </button>

        {/* 展开体（grid-rows 过渡；min-h-0 + overflow-hidden 必须在 grid 子项上，
            0fr 行高才能真正塌到 0；收起 invisible 移出焦点序） */}
        {!isLocked && (
          <div
            className={cn(
              "grid transition-all duration-400 ease-in-out",
              isExpanded
                ? "mt-2 grid-rows-[1fr] opacity-100 visible"
                : "grid-rows-[0fr] opacity-0 invisible",
            )}
          >
          <div className="min-h-0 space-y-3 overflow-hidden pb-2 pt-1">
            {/* ── 风格确认 ── */}
            {step === STEP_STYLE && input && (
              <>
                <div className="rounded-xl border bg-card p-3 shadow-sm">
                  <div className="mb-2 flex items-center gap-2">
                    <Settings2 className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-semibold">生成配置</span>
                    {imageConfigEditable ? (
                      <span className="ml-auto text-[11px] text-blue-600 dark:text-blue-300">方向定稿前可修改</span>
                    ) : (
                      <span className="ml-auto text-[11px] text-muted-foreground">已锁定</span>
                    )}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                    <Select
                      value={selectedImageModelId || input.imageModelId || ""}
                      onValueChange={(value) => {
                        const next = value ?? ""
                        setSelectedImageModelId(next)
                        const compatible = ensureSizeConfig(next, currentSizes)
                        if (compatible) setSelectedSizes(compatible)
                      }}
                      disabled={!imageConfigEditable || configSaving || imageModels.length === 0}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择生图模型">
                          {imageModel?.displayName || imageModel?.name || imageModel?.id || "选择生图模型"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {imageModels.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.displayName || model.name || model.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <ImageIcon className="h-3.5 w-3.5" />
                      示例图只使用卡面尺寸
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {SIZE_KIND_LABELS.map(({ kind, label }) => (
                      <div key={kind} className="space-y-1">
                        <div className="text-[11px] text-muted-foreground">{label}尺寸</div>
                        <Select
                          value={currentSizes?.[kind] ?? ""}
                          onValueChange={(value) => {
                            if (!value || !currentSizes) return
                            setSelectedSizes({ ...currentSizes, [kind]: value })
                          }}
                          disabled={!imageConfigEditable || configSaving || sizeOptions.length === 0}
                        >
                          <SelectTrigger className="w-full text-xs">
                            <SelectValue placeholder="选择尺寸">{currentSizes?.[kind] || "未设置"}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {sizeOptions.map((size) => (
                              <SelectItem key={size} value={size}>{size}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                  {imageConfigEditable && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3 h-8 w-full gap-1 text-xs"
                      disabled={configSaving || !selectedImageModelId || !selectedSizes}
                      onClick={() => void handleSaveImageConfig()}
                    >
                      {configSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      保存模型与尺寸
                    </Button>
                  )}
                  <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                    修改只影响之后重新生成的方向示例图；已有示例图不会自动重做。
                  </p>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  参考图仅用于提取画面风格（不进入后续生图）。在此确认或微调风格描述；点击确认后将开始生成
                  3 个候选主题。主题产出后风格锁定，不可回退。
                </p>
                {input.referenceImages.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[11px] font-medium text-muted-foreground">
                      风格参考图（只读，共 {input.referenceImages.length} 张）
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {input.referenceImages.map((url, i) => (
                        <div key={`${url}-${i}`} className="aspect-square overflow-hidden rounded-lg border bg-muted/30">
                          <SmartImage
                            src={toImageSrc(url)}
                            alt={`参考图 ${i + 1}`}
                            className="h-full w-full object-contain"
                            loading="lazy"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {input.referenceImages.length > 0 && (
                  <div className={cn(
                    "rounded-lg border px-3 py-2 text-xs leading-5",
                    input.referenceStyleAnalysisStatus === "failed"
                      ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300"
                      : input.referenceStyleAnalysisStatus === "completed"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300"
                        : "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300",
                  )}>
                    <div className="flex items-center gap-1.5 font-medium">
                      {input.referenceStyleAnalysisStatus === "completed" ? <CircleCheck className="h-3.5 w-3.5" /> : input.referenceStyleAnalysisStatus === "failed" ? <CircleAlert className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {input.referenceStyleAnalysisStatus === "completed" ? "AI 已提取参考图风格" : input.referenceStyleAnalysisStatus === "failed" ? "参考图风格分析失败，可手动填写" : "正在分析参考图风格…"}
                    </div>
                    {input.referenceStyleAnalysis && <p className="mt-1 text-foreground/80">{input.referenceStyleAnalysis}</p>}
                    {input.referenceStyleAnalysisError && <p className="mt-1">{input.referenceStyleAnalysisError}</p>}
                  </div>
                )}
                <div className="space-y-1.5">
                  <Textarea
                    placeholder="艺术风格描述（可选；与参考图共同构成风格输入）..."
                    value={stylePromptValue}
                    onChange={(e) => setStyleDraft(e.target.value)}
                    rows={3}
                    maxLength={500}
                    disabled={!styleEditable}
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">
                      {stylePromptValue.length}/500
                      {!styleEditable && themesProduced && "（主题已产出，风格输入已锁定）"}
                    </span>
                  </div>
                </div>
                {themesProduced && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                    主题已产出，风格描述不再可改；如需调整请到「主题选择」阶段使用「重新生成主题」并附反馈。
                  </p>
                )}
                {!readOnly && (
                  <Button
                    size="sm"
                    className="h-8 w-full gap-1 text-xs"
                    disabled={acting || !styleEditable}
                    onClick={handleConfirmStyle}
                  >
                    <Check className="h-3.5 w-3.5" />
                    确认风格，生成 3 个候选主题
                  </Button>
                )}
              </>
            )}

            {/* ── 主题选择 ── */}
            {step === STEP_THEME && (
              <>
                {themeRows.length > 0 ? (
                  <>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {readOnly ? "已生成的主题候选（历史步骤，仅供查看）" : "从 3 个候选主题中选定 1 个，选定后进入想象力程度选择。"}
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {themeRows.map((d) =>
                        renderDirectionCard(d, "theme", readOnly || d.status !== "candidate"),
                      )}
                    </div>
                    {!readOnly && !payload?.selectedThemeId && renderFeedbackRow(
                      themeFeedback,
                      setThemeFeedback,
                      handleRegenThemes,
                      "重新生成主题",
                      "对主题候选的调整意见（可选，如：更暗黑一些 / 融入东方元素）...",
                    )}
                  </>
                ) : busy ? (
                  <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
                    正在生成 3 个候选主题，请稍候...
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {workflow?.error
                        ? `主题生成失败：${truncateText(workflow.error, 80)}`
                        : "尚未生成候选主题。"}
                    </p>
                    <Button
                      size="sm"
                      className="h-8 gap-1 text-xs"
                      disabled={acting || terminal || !input?.styleConfirmedAt}
                      onClick={handleRegenThemes}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      生成 3 个候选主题
                    </Button>
                  </div>
                )}
              </>
            )}

            {/* ── 想象力程度 ── */}
            {step === STEP_IMAGINATION && (
              <>
                {selectedTheme && (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs leading-5">
                    <span className="font-medium">已选主题：</span>
                    {selectedTheme.name}
                    {selectedTheme.concept ? ` — ${selectedTheme.concept}` : ""}
                  </div>
                )}
                {input?.imaginationLevel ? (
                  <p className="text-sm text-muted-foreground">
                    想象力档位已选定：
                    <span className="font-medium text-foreground">
                      {imaginationLabelOf(input.imaginationLevel)}
                    </span>
                    （只读）
                  </p>
                ) : readOnly ? (
                  <p className="text-sm text-muted-foreground">尚未选择想象力档位。</p>
                ) : !input?.imageModelId ? (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                    尚未选择生图模型：请展开「风格确认」步骤的生成配置区，选择生图模型与四类尺寸后再选档位。
                  </p>
                ) : (
                  <>
                    <p className="text-xs leading-5 text-muted-foreground">
                      选择想象力档位（高 / 中 / 低）。确认后服务端将自动开始生成
                      3 个创作方向。
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {IMAGINATION_OPTIONS.map((opt) => (
                        <button
                          key={opt.level}
                          type="button"
                          disabled={busy || acting || terminal}
                          onClick={() => handleChooseImagination(opt.level)}
                          className={cn(
                            "flex flex-col rounded-lg border p-3 text-left transition-colors",
                            busy || acting || terminal
                              ? "cursor-not-allowed border-border/70 opacity-60"
                              : "border-border hover:border-violet-400 hover:bg-violet-50/40 dark:hover:bg-violet-950/20",
                          )}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-100 text-[11px] font-bold text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                              {opt.label}
                            </span>
                            <span className="text-sm font-medium">{opt.name}</span>
                          </div>
                          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                            {opt.desc}
                          </p>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {/* ── 落地方向 ── */}
            {step === STEP_DIRECTION && (
              <>
                <p className="text-xs leading-5 text-muted-foreground">
                  每个方向附带 1 张示例图（按选定方向提示词 + 卡面尺寸生成），生成完成后自动展示在此；示例图仅作参考，不计入卡片网格。
                </p>
                {directionRows.length > 0 ? (
                  <>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {directionRows.map((d) =>
                        renderDirectionCard(d, "direction", readOnly || d.status !== "candidate"),
                      )}
                    </div>
                    {!readOnly && !payload?.selectedDirectionId && renderFeedbackRow(
                      directionFeedback,
                      setDirectionFeedback,
                      handleRegenDirections,
                      "重新生成方向",
                      "对创作方向的调整意见（可选，如：色彩再克制些 / 场景更日常）...",
                    )}
                  </>
                ) : busy ? (
                  <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
                    正在按
                    {imaginationLabelOf(input?.imaginationLevel)}
                    档位生成 3 个创作方向，请稍候...
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {workflow?.error
                        ? `创作方向生成失败：${truncateText(workflow.error, 80)}`
                        : "尚未生成创作方向。"}
                    </p>
                    <Button
                      size="sm"
                      className="h-8 gap-1 text-xs"
                      disabled={acting || terminal || !input?.imaginationLevel}
                      onClick={handleRegenDirections}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      生成 3 个创作方向
                    </Button>
                  </div>
                )}
              </>
            )}

            {/* ── 提示词撰写 ── */}
            {step === STEP_PROMPT && (
              <>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      撰写进度（已完成 / 总张数）
                    </span>
                    <span className="font-medium tabular-nums">
                      {promptsWritten} / {cardsTotal || "—"}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-violet-600 transition-all"
                      style={{
                        width: `${
                          cardsTotal > 0
                            ? Math.min(100, Math.round((promptsWritten / cardsTotal) * 100))
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  {busy && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
                      提示词撰写中，正在轮询进度...
                    </div>
                  )}
                  {!busy && promptsAllDone && (
                    <p className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs leading-5 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300">
                      全套 {cardsTotal} 张提示词已撰写完成，卡片已解锁等待后续操作。请收起此折叠区并在工作台卡片中查看 / 编辑提示词。
                    </p>
                  )}
                  {!busy && !promptsAllDone && cardsTotal > 0 && (
                    <p className="text-xs leading-5 text-muted-foreground">
                      已撰写 {promptsWritten} 张，剩余 {cardsTotal - promptsWritten}{" "}
                      张待撰写；可再次入队补齐 / 按反馈重写。
                      {(payload?.cards.byStatus.failed ?? 0) > 0 &&
                        `（失败 ${payload?.cards.byStatus.failed} 张，重新入队可重试）`}
                    </p>
                  )}
                  {cardsTotal === 0 && (
                    <p className="text-xs leading-5 text-muted-foreground">
                      卡片骨架尚未就绪，稍候自动同步。
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Textarea
                    placeholder="撰写反馈（可选，重新撰写时生效，如：文案更简练 / 意象更统一）..."
                    value={promptFeedback}
                    onChange={(e) => setPromptFeedback(e.target.value)}
                    rows={2}
                    maxLength={500}
                    disabled={busy || acting || terminal}
                    className="text-xs"
                  />
                  <Button
                    size="sm"
                    className="h-8 w-full gap-1 text-xs"
                    disabled={busy || acting || terminal || !selectedDirection}
                    onClick={handleGeneratePrompts}
                  >
                    <Palette className="h-3.5 w-3.5" />
                    {promptsWritten > 0
                      ? promptsAllDone
                        ? "按反馈重新撰写全套提示词"
                        : "继续撰写剩余提示词"
                      : "开始撰写全套提示词"}
                  </Button>
                </div>
              </>
            )}
          </div>
          </div>
        )}

        {/* 锁定提示行 */}
        {isLocked && (
          <div className="px-2 pt-1 text-xs text-muted-foreground">
            {step === STEP_THEME && "需先确认风格"}
            {step === STEP_IMAGINATION && "需先选定主题"}
            {step === STEP_DIRECTION && "需先选定想象力档位"}
            {step === STEP_PROMPT && "需先选定创作方向（风格规范书定稿）"}
          </div>
        )}
        </div>
      </div>
    )
  }

  const statusLabel = workflow
    ? (STATUS_LABELS[workflow.status] ?? workflow.status)
    : null

  return (
    <div>
      {/* 状态条（原向导弹窗头部描述 + workflow 状态徽标；mb-4 与步骤时间线分隔，
          步骤间不加间距以保证模板连接线连续） */}
      <div className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {statusLabel && (
          <span className="shrink-0 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-300">
            {statusLabel}
          </span>
        )}
        {busy ? (
          <>
            <Loader2 className="size-3.5 shrink-0 animate-spin text-violet-500" />
            服务端任务执行中，操作已暂时禁用，正在轮询进度...
          </>
        ) : loadError ? (
          <span className="truncate">进度加载失败：{loadError}</span>
        ) : (
          <span className="truncate">风格确认 → 主题选择 → 想象力程度 → 落地方向 → 提示词撰写；历史阶段只读。</span>
        )}
      </div>

      {taskId == null ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          当前任务没有关联的 Agent 工作流。
        </div>
      ) : payload == null && !loadError ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
          正在加载工作流进度...
        </div>
      ) : payload == null && loadError ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {loadError}
        </div>
      ) : (
        payload != null && Array.from({ length: STEP_COUNT }, (_, i) => renderStep(i))
      )}
    </div>
  )
}
