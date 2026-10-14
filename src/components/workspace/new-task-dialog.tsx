"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/workspace/spinner"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import {
  Bot,
  Edit3,
  FileText,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react"
import {
  createWorkspaceAgentTaskAction,
  createWorkspaceTaskAction,
  listTemplatesAction,
  listWorkspaceAgentModelsAction,
} from "@/server/actions/workspace"
import type { CreateWorkspaceAgentTaskInput } from "@/server/actions/workspace/agent"
import { getReferenceImageLimit } from "@/lib/workspace/helpers"
import { uploadReferenceImages } from "@/lib/workspace/upload"
import { resolveSizePresets } from "@/lib/image-sizes"
import type { ModelSizePreset } from "@/db/schema"
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_REVIEW_THRESHOLD,
  DEFAULT_TEMPLATE_SIZES,
  MAX_RETRIES_MAX,
  MAX_RETRIES_MIN,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  WORKSPACE_AGENT_TEMPLATES,
  getWorkspaceAgentTemplate,
} from "@/lib/workspace/agent-templates"
import type {
  WorkspaceAgentTemplateKey,
  WorkspaceAgentTemplateSizes,
} from "@/lib/workspace/agent-types"
import type { TemplateRow } from "@/lib/workspace/types"

type CreateMode = "agent" | "extract" | "custom"
type CreateStep = "choose" | "form"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** options.source = agent 时附带 workflowId，供主界面立即启动 Agent 进度轮询 */
  onCreated: (
    taskId: string,
    cardCount: number,
    options?: { source?: "manual" | "agent"; workflowId?: string },
  ) => void
}

interface ReferenceFile {
  file: File
  preview: string
}

/** Agent 发起入参：以服务端 action 契约类型为准（模板 key + WorkspaceAgentInput 对齐字段 + 四类尺寸） */
export type { CreateWorkspaceAgentTaskInput }

/**
 * 主/评审对话模型选项（listWorkspaceAgentLaunchOptionsAction().chatModels /
 * reviewerModels 行；对齐服务端 AgentChatModelOption：id/displayName/
 * supportsVision/scope）。主控与评审候选均为支持视觉的模型。
 */
interface AgentChatModelOption {
  id: string
  displayName?: string
  name?: string
  /** 是否支持视觉（缺省视为支持） */
  supportsVision?: boolean
}

/**
 * 生图模型选项（listWorkspaceAgentModelsAction().imageModels 行；
 * 对齐服务端 WorkspaceAgentImageModelOption 的精简形状，兼容完整 ImageModelRow：
 * sizes = 启用尺寸预设 "WxH" 字符串；sizePresets = 结构化预设（有则优先展示比例标签）。
 */
interface AgentImageModelOption {
  id: string
  name?: string
  displayName?: string | null
  sizes?: string[] | null
  sizePresets?: ModelSizePreset[] | null
  supportsReferenceImage?: boolean | null
  maxReferenceImages?: number | null
}

/** "WxH" → 比例标签（如 1024x1536 → 2:3；无法解析回退原值） */
function ratioLabelOf(value: string): string {
  const match = /^(\d+)x(\d+)$/.exec(value.trim())
  if (!match) return value
  const width = Number(match[1])
  const height = Number(match[2])
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(width, height) || 1
  return `${width / divisor}:${height / divisor}`
}

/** 模板默认尺寸选项（四类默认值去重保序） */
function templateDefaultSizeOptions(
  key: WorkspaceAgentTemplateKey,
): Array<{ value: string; label: string }> {
  const defaults = DEFAULT_TEMPLATE_SIZES[key]
  const values = [defaults.card, defaults.back, defaults.border, defaults.box]
  return [...new Set(values)].map((value) => ({
    value,
    label: ratioLabelOf(value),
  }))
}

const modeMeta: Record<
  CreateMode,
  {
    label: string
    description: string
    /** 正方形选择卡的精简描述（两行内） */
    shortDescription: string
    icon: LucideIcon
    /** 图标软底方块配色 */
    iconWrapClass: string
    /** 选择卡 hover 边框/阴影配色 */
    cardHoverClass: string
  }
> = {
  agent: {
    label: "Agent",
    description:
      "选择成套卡牌模板，AI 智能体四阶段流水线产出一整套可直接印制的设计稿。",
    shortDescription: "选卡牌模板，AI 团队四阶段流水线产出一整套设计稿",
    icon: Bot,
    iconWrapClass:
      "bg-blue-100 text-blue-600 dark:bg-blue-950/50 dark:text-blue-300",
    cardHoverClass:
      "hover:border-blue-400 hover:shadow-blue-500/10 dark:hover:border-blue-700",
  },
  extract: {
    label: "提取裂变",
    description: "输入已写好的长提示词，AI 提取拆分为编号画面描述。",
    shortDescription: "粘贴长提示词，AI 拆分为编号画面描述",
    icon: FileText,
    iconWrapClass:
      "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300",
    cardHoverClass:
      "hover:border-emerald-400 hover:shadow-emerald-500/10 dark:hover:border-emerald-700",
  },
  custom: {
    label: "自定义创建",
    description:
      "每行一条提示词，按行创建对应数量的卡片，并可上传默认参考图片。",
    shortDescription: "逐行输入提示词，按行创建对应卡片",
    icon: Edit3,
    iconWrapClass:
      "bg-violet-100 text-violet-600 dark:bg-violet-950/50 dark:text-violet-300",
    cardHoverClass:
      "hover:border-violet-400 hover:shadow-violet-500/10 dark:hover:border-violet-700",
  },
}

const modeBadgeClass: Record<CreateMode, string> = {
  agent:
    "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-300",
  extract:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300",
  custom:
    "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/20 dark:text-violet-300",
}

/** 四类尺寸选择项（卡面/牌背/边框/牌盒） */
const SIZE_KIND_LABELS: Array<{
  kind: keyof WorkspaceAgentTemplateSizes
  label: string
}> = [
  { kind: "card", label: "卡面尺寸" },
  { kind: "back", label: "牌背尺寸" },
  { kind: "border", label: "边框尺寸" },
  { kind: "box", label: "牌盒尺寸" },
]

/** Agent 参考图上限硬顶（WorkspaceAgentInput 契约：风格参考图 ≤ 4） */
const AGENT_REFERENCE_IMAGE_CAP = 4
/** 评审模型数量上限（契约：1-3 个支持视觉的对话模型） */
const AGENT_REVIEWER_MAX = 3

export function NewTaskDialog({ open, onOpenChange, onCreated }: Props) {
  const [step, setStep] = useState<CreateStep>("choose")
  const [mode, setMode] = useState<CreateMode>("agent")
  const [title, setTitle] = useState("")
  const [theme, setTheme] = useState("")
  const [longText, setLongText] = useState("")
  const [customPrompts, setCustomPrompts] = useState("")
  const [cardCount, setCardCount] = useState(4)
  const [extractTemplateId, setExtractTemplateId] = useState("")
  const [extractTemplates, setExtractTemplates] = useState<TemplateRow[]>([])
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [referenceFiles, setReferenceFiles] = useState<ReferenceFile[]>([])
  const [submitting, setSubmitting] = useState(false)

  // ─── Agent 表单状态 ───
  const [agentTemplateKey, setAgentTemplateKey] =
    useState<WorkspaceAgentTemplateKey>("tarot81")
  const [agentStyle, setAgentStyle] = useState("")
  const [agentChatModels, setAgentChatModels] = useState<
    AgentChatModelOption[]
  >([])
  const [agentReviewerModels, setAgentReviewerModels] = useState<
    AgentChatModelOption[]
  >([])
  const [agentImageModels, setAgentImageModels] = useState<
    AgentImageModelOption[]
  >([])
  const [chatModelId, setChatModelId] = useState("")
  const [reviewerChatModelIds, setReviewerChatModelIds] = useState<string[]>([])
  const [agentImageModelId, setAgentImageModelId] = useState("")
  const [agentSizes, setAgentSizes] = useState<WorkspaceAgentTemplateSizes>(
    DEFAULT_TEMPLATE_SIZES.tarot81,
  )
  const [scoreThreshold, setScoreThreshold] = useState(DEFAULT_REVIEW_THRESHOLD)
  const [maxRetries, setMaxRetries] = useState(DEFAULT_MAX_RETRIES)
  const [agentReferenceFiles, setAgentReferenceFiles] = useState<
    ReferenceFile[]
  >([])

  // 此对话框未关联图片模型，无模型时参考图上限默认 5（普通模式）
  const referenceLimit = getReferenceImageLimit(null) || 5

  // Agent 生图模型选中项（"" = 平台默认配置）
  const selectedAgentImageModel =
    agentImageModels.find((m) => m.id === agentImageModelId) ?? null
  // Agent 参考图上限按所选生图模型（不支持参考图 = 0 → 隐藏上传）；
  // 模型未携带上限字段时回退契约硬顶 4
  const agentReferenceLimit = !selectedAgentImageModel
    ? AGENT_REFERENCE_IMAGE_CAP
    : selectedAgentImageModel.supportsReferenceImage === false
      ? 0
      : selectedAgentImageModel.maxReferenceImages == null
        ? AGENT_REFERENCE_IMAGE_CAP
        : Math.min(
            AGENT_REFERENCE_IMAGE_CAP,
            getReferenceImageLimit(selectedAgentImageModel),
          )
  // 四类尺寸可选项：结构化预设（带比例标签）优先，其次启用 "WxH" 字符串，
  // 最后回退所选模板默认尺寸
  const agentSizeOptions = useMemo(() => {
    if (
      selectedAgentImageModel?.sizePresets &&
      selectedAgentImageModel.sizePresets.length > 0
    ) {
      return resolveSizePresets(selectedAgentImageModel.sizePresets).map(
        (s) => ({ value: s.value, label: s.label }),
      )
    }
    if (
      selectedAgentImageModel?.sizes &&
      selectedAgentImageModel.sizes.length > 0
    ) {
      return selectedAgentImageModel.sizes.map((value) => ({
        value,
        label: ratioLabelOf(value),
      }))
    }
    return templateDefaultSizeOptions(agentTemplateKey)
  }, [selectedAgentImageModel, agentTemplateKey])
  // 评审模型候选：服务端 reviewerModels（视觉过滤；缺省回退 chatModels）
  const reviewerCandidates = (
    agentReviewerModels.length > 0 ? agentReviewerModels : agentChatModels
  ).filter((m) => m.supportsVision !== false)

  // 切换生图模型导致参考图上限收缩（或不再支持参考图）时，裁掉超限文件
  useEffect(() => {
    setAgentReferenceFiles((prev) => {
      if (prev.length <= agentReferenceLimit) return prev
      const keep = prev.slice(0, Math.max(0, agentReferenceLimit))
      prev.slice(Math.max(0, agentReferenceLimit)).forEach((f) => {
        URL.revokeObjectURL(f.preview)
      })
      return keep
    })
  }, [agentReferenceLimit])

  // 同步最新文件列表到 ref，供卸载时清理 object URL
  const filesRef = useRef(referenceFiles)
  const agentFilesRef = useRef(agentReferenceFiles)
  useEffect(() => {
    filesRef.current = referenceFiles
  })
  useEffect(() => {
    agentFilesRef.current = agentReferenceFiles
  })
  useEffect(() => {
    return () => {
      filesRef.current.forEach((f) => URL.revokeObjectURL(f.preview))
      agentFilesRef.current.forEach((f) => URL.revokeObjectURL(f.preview))
    }
  }, [])

  // 打开时加载模板与 Agent 模型选项（带竞态清理；Agent 选项失败不阻塞普通模式）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingOptions(true)
    Promise.all([
      listTemplatesAction({ type: "extract" }),
      listWorkspaceAgentModelsAction().catch(() => null),
    ])
      .then(([extract, agentModels]) => {
        if (cancelled) return
        setExtractTemplates(extract)
        if (agentModels) {
          setAgentChatModels(agentModels.chatModels ?? [])
          setAgentReviewerModels(agentModels.chatModels ?? [])
          setAgentImageModels(agentModels.imageModels ?? [])
        }
      })
      .catch(() => {
        if (!cancelled) toast.error("获取模板列表失败")
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const resetForm = () => {
    setStep("choose")
    setMode("agent")
    setTitle("")
    setTheme("")
    setLongText("")
    setCustomPrompts("")
    setCardCount(4)
    setExtractTemplateId("")
    setAgentTemplateKey("tarot81")
    setAgentStyle("")
    setChatModelId("")
    setReviewerChatModelIds([])
    setAgentImageModelId("")
    setAgentSizes(DEFAULT_TEMPLATE_SIZES.tarot81)
    setScoreThreshold(DEFAULT_REVIEW_THRESHOLD)
    setMaxRetries(DEFAULT_MAX_RETRIES)
    referenceFiles.forEach((f) => URL.revokeObjectURL(f.preview))
    setReferenceFiles([])
    agentReferenceFiles.forEach((f) => URL.revokeObjectURL(f.preview))
    setAgentReferenceFiles([])
  }

  const handleClose = () => {
    resetForm()
    onOpenChange(false)
  }

  const handleModeSelect = (nextMode: CreateMode) => {
    setMode(nextMode)
    setStep("form")
  }

  const handleAddFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    const remaining = Math.max(0, referenceLimit - referenceFiles.length)
    const incoming = Array.from(fileList)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, remaining)
      .map((file) => ({
        file,
        preview: URL.createObjectURL(file),
      }))
    if (incoming.length === 0) {
      toast.error(`最多支持 ${referenceLimit} 张参考图`)
      return
    }
    setReferenceFiles((prev) => [...prev, ...incoming])
  }

  const handleAddAgentFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    const remaining = Math.max(
      0,
      agentReferenceLimit - agentReferenceFiles.length,
    )
    const incoming = Array.from(fileList)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, remaining)
      .map((file) => ({
        file,
        preview: URL.createObjectURL(file),
      }))
    if (incoming.length === 0) {
      toast.error(`当前模型最多支持 ${agentReferenceLimit} 张参考图`)
      return
    }
    setAgentReferenceFiles((prev) => [...prev, ...incoming])
  }

  const handleRemoveFile = (index: number) => {
    setReferenceFiles((prev) => {
      const target = prev[index]
      if (target) URL.revokeObjectURL(target.preview)
      return prev.filter((_, i) => i !== index)
    })
  }

  const handleRemoveAgentFile = (index: number) => {
    setAgentReferenceFiles((prev) => {
      const target = prev[index]
      if (target) URL.revokeObjectURL(target.preview)
      return prev.filter((_, i) => i !== index)
    })
  }

  /** 评审模型多选（0-3 个；0 = 平台默认配置） */
  const toggleReviewer = (id: string) => {
    setReviewerChatModelIds((prev) => {
      if (prev.includes(id)) return prev.filter((v) => v !== id)
      if (prev.length >= AGENT_REVIEWER_MAX) {
        toast.error(`评审模型最多选择 ${AGENT_REVIEWER_MAX} 个`)
        return prev
      }
      return [...prev, id]
    })
  }

  const handleAgentTemplateChange = (key: WorkspaceAgentTemplateKey) => {
    setAgentTemplateKey(key)
    // 模板切换 → 四类尺寸回退该模板默认值
    setAgentSizes(DEFAULT_TEMPLATE_SIZES[key])
  }

  const parseCustomPrompts = (text: string): string[] =>
    text
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean)

  /** Agent 模式校验（返回错误文案；通过返回 null） */
  const validateAgentForm = (): string | null => {
    if (!theme.trim()) return "请输入主题提示词"
    if (!getWorkspaceAgentTemplate(agentTemplateKey)) return "请选择卡牌模板"
    if (reviewerChatModelIds.length > AGENT_REVIEWER_MAX) {
      return `评审模型最多选择 ${AGENT_REVIEWER_MAX} 个`
    }
    if (agentReferenceFiles.length > agentReferenceLimit) {
      return `当前模型最多支持 ${agentReferenceLimit} 张参考图`
    }
    return null
  }

  /** Agent 模式提交：上传参考图 → createWorkspaceAgentTaskAction */
  const submitAgent = async () => {
    const template = getWorkspaceAgentTemplate(agentTemplateKey)
    if (!template) throw new Error("模板不存在")

    let referenceImages: string[] = []
    if (agentReferenceFiles.length > 0) {
      const uploaded = await uploadReferenceImages(
        agentReferenceFiles.map((f) => f.file),
      )
      if (uploaded.length !== agentReferenceFiles.length) {
        toast.error("部分参考图片上传失败")
      }
      referenceImages = uploaded.map((u) => u.url)
    }

    const input: CreateWorkspaceAgentTaskInput = {
      templateKey: agentTemplateKey,
      prompt: theme.trim(),
      stylePrompt: agentStyle.trim() || undefined,
      title: title.trim() || undefined,
      referenceImages,
      quality: {
        contentThreshold: scoreThreshold,
        aestheticThreshold: scoreThreshold,
        consistencyThreshold: scoreThreshold,
        maxRetries,
      },
      imageModelId: agentImageModelId || null,
      imageSize: agentSizes.card || null,
      chatModelId: chatModelId || null,
      ...(reviewerChatModelIds.length
        ? { reviewerChatModelIds }
        : {}),
      sizes: agentSizes,
    }

    const res = await createWorkspaceAgentTaskAction(input)
    // 返回字段在 taskId / workspaceTaskId 间迭代（服务端契约收敛期），双读兜底
    const createdTaskId =
      (res as { taskId?: string }).taskId ??
      (res as { workspaceTaskId?: string }).workspaceTaskId
    if (!res.ok || !createdTaskId) {
      throw new Error(res.error || "创建失败")
    }

    const count = res.cardCount ?? template.meta.cardCount
    toast.success("Agent 任务已创建，四阶段流水线已启动")
    onCreated(createdTaskId, count, {
      source: "agent",
      workflowId: res.workflowId,
    })
    resetForm()
    onOpenChange(false)
  }

  /** 提取裂变 / 自定义模式提交：走既有 createWorkspaceTaskAction */
  const submitNormal = async () => {
    let referenceImages: string[] = []
    if (mode === "custom" && referenceFiles.length > 0) {
      const uploaded = await uploadReferenceImages(
        referenceFiles.map((f) => f.file),
      )
      if (uploaded.length !== referenceFiles.length) {
        toast.error("部分参考图片上传失败")
      }
      referenceImages = uploaded.map((u) => u.url)
    }

    const input: Parameters<typeof createWorkspaceTaskAction>[0] = {
      // 此分支仅处理 extract / custom（agent 走 createWorkspaceAgentTaskAction）
      mode: mode === "extract" ? "extract" : "custom",
      title: title.trim() || undefined,
    }
    let expectedCount = cardCount

    if (mode === "extract") {
      // 长提示词走 longText（服务端上限 10000；theme 上限 500 不够整段粘贴）
      input.longText = longText.trim()
      input.cardCount = cardCount
      input.templateId = extractTemplateId
    } else {
      const prompts = parseCustomPrompts(customPrompts)
      input.prompts = prompts
      expectedCount = prompts.length
      if (referenceImages.length) input.referenceImages = referenceImages
    }

    const res = await createWorkspaceTaskAction(input)
    if (!res.ok || !res.taskId) {
      throw new Error(res.error || "创建失败")
    }

    const count = res.cardCount ?? expectedCount
    toast.success(
      mode === "extract"
        ? "任务已创建，正在提取裂变..."
        : `任务已创建，共 ${count} 张卡片`,
    )
    onCreated(res.taskId, count)
    resetForm()
    onOpenChange(false)
  }

  const handleSubmit = async () => {
    if (mode === "agent") {
      const validationError = validateAgentForm()
      if (validationError) {
        toast.error(validationError)
        return
      }
    } else if (mode === "extract") {
      if (!longText.trim()) {
        toast.error("请输入长提示词")
        return
      }
      if (!extractTemplateId) {
        toast.error("请选择提取提示词模板")
        return
      }
    } else {
      const prompts = parseCustomPrompts(customPrompts)
      if (prompts.length === 0) {
        toast.error("请至少输入一条提示词")
        return
      }
      if (referenceFiles.length > referenceLimit) {
        toast.error(`最多支持 ${referenceLimit} 张参考图`)
        return
      }
    }

    setSubmitting(true)
    try {
      if (mode === "agent") {
        await submitAgent()
      } else {
        await submitNormal()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败")
    } finally {
      setSubmitting(false)
    }
  }

  const chatModelName = (m: AgentChatModelOption) =>
    m.displayName || m.name || m.id

  const imageModelName = (m: AgentImageModelOption) =>
    m.displayName || m.name || m.id

  const templateMetas = WORKSPACE_AGENT_TEMPLATES.map((t) => t.meta)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent
        className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-3xl"
        showCloseButton={!submitting}
      >
        <DialogHeader>
          <DialogTitle>
            {step === "choose" ? "选择新建任务方式" : "新建批量生图任务"}
          </DialogTitle>
        </DialogHeader>

        {step === "choose" ? (
          /* 长方形容器：内部一行 3 列正方形选择卡（Agent / 提取裂变 / 自定义） */
          <div className="rounded-2xl border bg-muted/20 p-3 sm:p-4">
            <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
              {(["agent", "extract", "custom"] as CreateMode[]).map((m) => {
                const meta = modeMeta[m]
                const Icon = meta.icon
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => handleModeSelect(m)}
                    className={cn(
                      "flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border border-border bg-card p-2 text-center shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:gap-2.5 sm:p-4",
                      meta.cardHoverClass,
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-10 shrink-0 items-center justify-center rounded-xl sm:size-12",
                        meta.iconWrapClass,
                      )}
                    >
                      <Icon className="size-5 sm:size-6" />
                    </span>
                    <span className="text-xs font-medium sm:text-sm">
                      {meta.label}
                    </span>
                    <span className="line-clamp-2 text-[10px] leading-4 text-muted-foreground sm:text-xs sm:leading-4">
                      {meta.shortDescription}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-hide">
            <div
              className={cn(
                "rounded-md border px-3 py-2 text-sm",
                modeBadgeClass[mode],
              )}
            >
              当前方式：{modeMeta[mode].label}
            </div>

            <div className="space-y-1.5">
              <Label>任务标题</Label>
              <Input
                placeholder="给这批图起个名字..."
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            {mode === "agent" ? (
              <>
                {/* 卡牌模板 */}
                <div className="space-y-1.5">
                  <Label>
                    卡牌模板<span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={agentTemplateKey}
                    onValueChange={(v) =>
                      v && handleAgentTemplateChange(v as WorkspaceAgentTemplateKey)
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="选择卡牌模板">
                        {templateMetas.find((t) => t.key === agentTemplateKey)
                          ?.name ?? "选择卡牌模板"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {templateMetas.map((t) => (
                        <SelectItem key={t.key} value={t.key}>
                          {t.name}（{t.cardCount} 张）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {templateMetas.find((t) => t.key === agentTemplateKey)
                      ?.description ?? ""}
                  </p>
                </div>

                {/* 主题 + 风格 */}
                <div className="space-y-1.5">
                  <Label>
                    主题提示词<span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    placeholder="输入主题/题材/画面内容方向（不含艺术风格），Agent 将据此完成整套卡牌..."
                    value={theme}
                    onChange={(e) => setTheme(e.target.value)}
                    rows={3}
                    maxLength={500}
                  />
                  <p className="text-xs text-muted-foreground">
                    {theme.length} / 500
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label>风格提示词</Label>
                  <Textarea
                    placeholder="艺术风格描述（可选；与参考图共同构成风格输入）..."
                    value={agentStyle}
                    onChange={(e) => setAgentStyle(e.target.value)}
                    rows={2}
                    maxLength={500}
                  />
                </div>

                {loadingOptions ? (
                  <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                    <Spinner className="p-0" />
                    加载 Agent 模型...
                  </div>
                ) : (
                  <>
                    {/* 主对话模型 / 评审模型 */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>主对话模型</Label>
                        {agentChatModels.length === 0 ? (
                          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                            暂无可用主对话模型（须为支持视觉的对话模型）
                          </p>
                        ) : (
                          <Select
                            value={chatModelId}
                            onValueChange={(v) => setChatModelId(v ?? "")}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="平台默认配置">
                                {chatModelId
                                  ? chatModelName(
                                      agentChatModels.find(
                                        (m) => m.id === chatModelId,
                                      ) ?? { id: chatModelId },
                                    )
                                  : "平台默认配置"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="">平台默认配置</SelectItem>
                              {agentChatModels.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                  {chatModelName(m)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        <p className="text-[11px] leading-4 text-muted-foreground">
                          主控模型需支持视觉（参考图直接进入主对话）；未选 = 平台默认
                        </p>
                      </div>

                      <div className="space-y-1.5">
                        <Label>生图模型</Label>
                        <Select
                          value={agentImageModelId}
                          onValueChange={(v) => setAgentImageModelId(v ?? "")}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="平台默认配置">
                              {agentImageModelId
                                ? imageModelName(
                                    agentImageModels.find(
                                      (m) => m.id === agentImageModelId,
                                    ) ?? { id: agentImageModelId },
                                  )
                                : "平台默认配置"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">平台默认配置</SelectItem>
                            {agentImageModels.map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {imageModelName(m)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {/* 评审模型（0-3 个支持视觉的对话模型；0 = 平台默认回退主控） */}
                    <div className="space-y-1.5">
                      <Label>
                        评审模型
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          可选 0-{AGENT_REVIEWER_MAX} 个（不选 = 平台默认配置）
                        </span>
                      </Label>
                      {reviewerCandidates.length === 0 ? (
                        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                          暂无可用评审模型（评审模型需为支持视觉的对话模型）
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {reviewerCandidates.map((m) => {
                            const active = reviewerChatModelIds.includes(m.id)
                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => toggleReviewer(m.id)}
                                className={cn(
                                  "rounded-full border px-3 py-1 text-xs transition-colors",
                                  active
                                    ? "border-blue-400 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300"
                                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                                )}
                              >
                                {chatModelName(m)}
                              </button>
                            )
                          })}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        已选 {reviewerChatModelIds.length}/
                        {AGENT_REVIEWER_MAX}；多维评审加权聚合，未达标自动打回重画
                      </p>
                    </div>

                    {/* 四类尺寸（卡面/牌背/边框/牌盒；取所选生图模型启用预设） */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {SIZE_KIND_LABELS.map(({ kind, label }) => (
                        <div key={kind} className="space-y-1.5">
                          <Label>{label}</Label>
                          <Select
                            value={agentSizes[kind]}
                            onValueChange={(v) =>
                              v &&
                              setAgentSizes((prev) => ({
                                ...prev,
                                [kind]: v,
                              }))
                            }
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="选择尺寸">
                                {agentSizes[kind] || "选择尺寸"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {agentSizeOptions.map((s) => (
                                <SelectItem key={s.value} value={s.value}>
                                  {s.label}（{s.value}）
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      套件资产（牌背/边框/牌盒）默认延用卡面比例；切换模板自动回退该模板默认尺寸
                    </p>

                    {/* 评分阈值（step 5，默认 75）+ 打回上限（1-3，默认 2） */}
                    <div className="grid grid-cols-1 gap-4 rounded-md border px-3 py-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs">
                            评分阈值
                          </Label>
                          <span className="text-xs font-medium tabular-nums text-blue-600 dark:text-blue-300">
                            {scoreThreshold} 分
                          </span>
                        </div>
                        <input
                          type="range"
                          min={THRESHOLD_MIN}
                          max={THRESHOLD_MAX}
                          step={5}
                          value={scoreThreshold}
                          onChange={(e) =>
                            setScoreThreshold(Number(e.target.value))
                          }
                          className="w-full accent-blue-600"
                        />
                        <p className="text-[11px] leading-4 text-muted-foreground">
                          内容对齐 / 审美风格 / 成套一致三维及格线统一取该值（
                          {THRESHOLD_MIN}-{THRESHOLD_MAX}，5 分一档）
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label className="text-xs">打回上限</Label>
                        <Select
                          value={String(maxRetries)}
                          onValueChange={(v) =>
                            v && setMaxRetries(Number(v))
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="打回上限">
                              {maxRetries} 轮
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from(
                              { length: MAX_RETRIES_MAX - MAX_RETRIES_MIN + 1 },
                              (_, i) => MAX_RETRIES_MIN + i,
                            )
                              .filter((n) => n >= 1)
                              .map((n) => (
                                <SelectItem key={n} value={String(n)}>
                                  {n} 轮
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <p className="text-[11px] leading-4 text-muted-foreground">
                          单卡审核不达标自动打回重画的上限（越高费用越多）
                        </p>
                      </div>
                    </div>

                    {/* 参考图（按所选生图模型上限；仅用于提取艺术风格） */}
                    {agentReferenceLimit > 0 && (
                      <div className="space-y-2">
                        <Label>风格参考图片</Label>
                        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground hover:border-blue-400 hover:text-blue-600">
                          <Upload className="h-4 w-4" />
                          选择图片
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                              handleAddAgentFiles(e.target.files)
                              e.target.value = ""
                            }}
                          />
                        </label>
                        {agentReferenceFiles.length > 0 && (
                          <div className="grid grid-cols-4 gap-2 rounded-md border p-2 sm:grid-cols-5">
                            {agentReferenceFiles.map((item, index) => (
                              <div
                                key={`${item.file.name}-${index}`}
                                className="group relative aspect-square overflow-hidden rounded-md border bg-muted"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={item.preview}
                                  alt={item.file.name}
                                  className="h-full w-full object-cover"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleRemoveAgentFile(index)}
                                  className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                                  aria-label="移除图片"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                          参考图仅用于提取艺术风格样式（不进入生图请求）。当前最多支持{" "}
                          {agentReferenceLimit} 张。
                        </p>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : mode === "extract" ? (
              <>
                <div className="space-y-1.5">
                  <Label>
                    长提示词<span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    placeholder="粘贴一整段已经写好的多个画面描述，AI 将按编号列表拆解..."
                    value={longText}
                    onChange={(e) => setLongText(e.target.value)}
                    rows={7}
                    maxLength={10000}
                  />
                  <p className="text-xs text-muted-foreground">
                    {longText.length} / 10000
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label>
                    卡片数量<span className="text-destructive">*</span>
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={cardCount}
                    onChange={(e) => setCardCount(Number(e.target.value))}
                  />
                </div>

                {loadingOptions ? (
                  <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                    <Spinner className="p-0" />
                    加载模板...
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label>
                      提取提示词模板
                      <span className="text-destructive">*</span>
                    </Label>
                    <Select
                      value={extractTemplateId}
                      onValueChange={(v) => setExtractTemplateId(v ?? "")}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择提取模板">
                          {extractTemplateId
                            ? (extractTemplates.find(
                                (t) => t.id === extractTemplateId,
                              )?.name ?? "选择提取模板")
                            : "选择提取模板"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {extractTemplates.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>
                    提示词（每行一条）<span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    placeholder={"每行一条提示词，将按行创建对应数量的卡片\n例如：\n夏日海滩饮品特写\n冬日热咖啡温馨场景"}
                    value={customPrompts}
                    onChange={(e) => setCustomPrompts(e.target.value)}
                    rows={7}
                  />
                  <p className="text-xs text-muted-foreground">
                    共 {parseCustomPrompts(customPrompts).length} 条提示词
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>上传参考图片</Label>
                  <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground hover:border-violet-400 hover:text-violet-600">
                    <Upload className="h-4 w-4" />
                    选择图片
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        handleAddFiles(e.target.files)
                        e.target.value = ""
                      }}
                    />
                  </label>
                  {referenceFiles.length > 0 && (
                    <div className="grid grid-cols-4 gap-2 rounded-md border p-2 sm:grid-cols-5">
                      {referenceFiles.map((item, index) => (
                        <div
                          key={`${item.file.name}-${index}`}
                          className="group relative aspect-square overflow-hidden rounded-md border bg-muted"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={item.preview}
                            alt={item.file.name}
                            className="h-full w-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveFile(index)}
                            className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                            aria-label="移除图片"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    上传图片会作为本次任务的参考图片。当前最多支持{" "}
                    {referenceLimit} 张。
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {step === "form" && (
          <DialogFooter className="shrink-0">
            <Button
              variant="outline"
              onClick={() => setStep("choose")}
              disabled={submitting}
            >
              上一步
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? (
                <>
                  <MorphingInfinity className="size-4" />
                  创建中...
                </>
              ) : (
                "创建任务"
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
