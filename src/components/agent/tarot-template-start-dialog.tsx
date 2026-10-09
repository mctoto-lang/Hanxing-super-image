"use client"

/* 参考图 URL 由受控上传接口返回，使用原生 img 兼容本地存储与 COS。 */
/* eslint-disable @next/next/no-img-element */

/**
 * 塔罗项目发起弹窗（单列分节式）：基本信息 → 内容描述 → 风格描述与参考图
 * → 卡面生图模型 → AI 团队模型 → 质量要求。内容/风格分轨输入：参考图挂在
 * 风格区（仅用于提取艺术风格样式）。AI 团队模型为可选覆盖（缺省 = 平台
 * 超管配置）：创意总监/风格策划/提示词撰写单选 + 评审团 1-3 个视觉模型多选。
 * 质量滑块一列多行（标签左 / 滑块中 / 数值右）：三维及格线 0-100 每 10 分
 * 一档 + 打回上限 0-3，初始值取管理员配置默认，可一键恢复。
 */
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Bot, ImagePlus, Loader2, MessageCircleQuestion, Palette, RotateCcw, Sparkles, Upload, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider, SliderControl, SliderRange, SliderThumb, SliderTrack } from "@/components/ui/slider"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { startTarotTemplateAction } from "@/server/actions/agent-template"
import { listAgentCardModelsAction, listAgentChatModelsAction } from "@/server/actions/agent"
import { cn } from "@/lib/utils"

/** 质量默认值兜底（管理员配置缺失时） */
const FALLBACK_DEFAULTS = { contentThreshold: 75, aestheticThreshold: 75, consistencyThreshold: 70, maxRetries: 2 }

export interface QualityConfig {
  contentThreshold: number
  aestheticThreshold: number
  consistencyThreshold: number
  maxRetries: number
}

/** 卡面生图模型选项（listAgentCardModelsAction 返回；见 server/services/agent/card-models） */
interface CardModelOption {
  id: string
  displayName: string
  costPerImage: number
  matchedPreset: { label: string; width: number; height: number }
}

/** AI 团队对话模型选项（listAgentChatModelsAction 返回；见 server/services/agent/chat-models） */
interface AgentChatModelOption {
  id: string
  displayName: string
  supportsVision: boolean
  scope: string
}

/** 单选「平台默认」哨兵（不提交覆盖，跟随超管配置） */
const DEFAULT_MODEL_SENTINEL = "__default__"

/** 评审团可选上限（与服务端 resolveAgentReviewerChoice 口径一致） */
const MAX_REVIEWERS = 3

function QualitySliderRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <Label className="w-28 shrink-0 text-xs">{label}</Label>
        {/* Base UI Slider 为复合组件：必须带 Control/Track/Range/Thumb
            子组件才渲染轨道与滑块（仅 Root 时是零高度空容器） */}
        <Slider
          className="flex-1"
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={(v) => onChange(Array.isArray(v) ? v[0]! : v)}
        >
          <SliderControl>
            <SliderTrack>
              <SliderRange />
            </SliderTrack>
            <SliderThumb />
          </SliderControl>
        </Slider>
        <span className="w-14 shrink-0 text-right text-xs font-medium tabular-nums">
          {value} {unit}
        </span>
      </div>
      {hint && <p className="pl-[7.75rem] text-[10px] leading-4 text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function TarotTemplateStartDialog({
  open,
  onOpenChange,
  qualityDefaults,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 管理员配置的质量默认值（「标准」档与滑块初始值；null 用内置兜底） */
  qualityDefaults: QualityConfig | null
}) {
  const router = useRouter()
  const standard = qualityDefaults ?? FALLBACK_DEFAULTS
  const [title, setTitle] = useState("")
  const [prompt, setPrompt] = useState("")
  const [stylePrompt, setStylePrompt] = useState("")
  const [referenceImages, setReferenceImages] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [quality, setQuality] = useState<QualityConfig>(standard)
  // 卡面生图模型候选池（打开弹窗时拉取；平台默认 = 不提交模型 id）
  const [cardModelOptions, setCardModelOptions] = useState<CardModelOption[] | null>(null)
  const [cardRatio, setCardRatio] = useState("")
  const [imageModelId, setImageModelId] = useState<string>("__default__")
  // AI 团队对话模型候选池（同批拉取；平台默认 = 不提交覆盖）
  const [chatModelOptions, setChatModelOptions] = useState<AgentChatModelOption[] | null>(null)
  const [creativeModelId, setCreativeModelId] = useState<string>(DEFAULT_MODEL_SENTINEL)
  const [styleDirectorModelId, setStyleDirectorModelId] = useState<string>(DEFAULT_MODEL_SENTINEL)
  const [writerModelId, setWriterModelId] = useState<string>(DEFAULT_MODEL_SENTINEL)
  const [reviewerIds, setReviewerIds] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setCardModelOptions(null)
    setImageModelId("__default__")
    setChatModelOptions(null)
    setCreativeModelId(DEFAULT_MODEL_SENTINEL)
    setStyleDirectorModelId(DEFAULT_MODEL_SENTINEL)
    setWriterModelId(DEFAULT_MODEL_SENTINEL)
    setReviewerIds([])
    let alive = true
    void listAgentCardModelsAction()
      .then((pool) => {
        if (!alive) return
        setCardModelOptions(pool.options)
        setCardRatio(pool.cardRatio)
      })
      .catch(() => {
        // 候选池加载失败不阻断创建：静默回退「平台默认」
        if (alive) setCardModelOptions([])
      })
    void listAgentChatModelsAction()
      .then((pool) => {
        if (alive) setChatModelOptions(pool.options)
      })
      .catch(() => {
        // 对话模型池失败：静默隐藏「AI 团队模型」区（不提交覆盖）
        if (alive) setChatModelOptions(null)
      })
    return () => {
      alive = false
    }
  }, [open])

  const addImage = async (file: File) => {
    if (referenceImages.length >= 4) return toast.error("最多上传 4 张参考图")
    if (!file.type.startsWith("image/")) return toast.error("请上传图片文件")
    const body = new FormData()
    body.append("file", file)
    try {
      const response = await fetch("/api/upload", { method: "POST", body })
      if (!response.ok) throw new Error("上传失败")
      const data = (await response.json()) as { url?: string }
      if (!data.url) throw new Error("上传接口未返回图片地址")
      setReferenceImages((current) => [...current, data.url!])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "参考图上传失败")
    }
  }

  /** 切换评审团选择（1-3 个；超过上限拦截并提示） */
  const toggleReviewer = (id: string) => {
    // 上限判断在 updater 外做：updater 必须纯函数（StrictMode 双调用/
    // 并发重放时 toast 不能跟着弹两次）
    if (!reviewerIds.includes(id) && reviewerIds.length >= MAX_REVIEWERS) {
      toast.error(`评审团最多选择 ${MAX_REVIEWERS} 个模型（已选 ${reviewerIds.length} 个）`)
      return
    }
    setReviewerIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : current.length >= MAX_REVIEWERS
          ? current
          : [...current, id],
    )
  }

  // Base UI Select 的 SelectValue 不传 children 时，闭合状态下触发器会原样
  // 显示选中值（__default__ / 模型 uuid）而非中文标签——必须显式渲染 label
  // （与 superadmin/agent-config/slot-select 同模式）
  const cardModelLabel = (id: string): string => {
    if (id === "__default__") return "平台默认（超管配置）"
    const m = cardModelOptions?.find((option) => option.id === id)
    return m ? `${m.displayName}（${m.costPerImage} 积分/张 · ${m.matchedPreset.width}x${m.matchedPreset.height}）` : "平台默认（超管配置）"
  }
  const chatModelLabel = (id: string): string => {
    if (id === DEFAULT_MODEL_SENTINEL) return "平台默认"
    const m = chatModelOptions?.find((option) => option.id === id)
    return m ? `${m.displayName}（${m.scope}）` : "平台默认"
  }

  const submit = async () => {
    if (prompt.trim().length < 5) return toast.error("请先描述主题、题材或画面内容方向")
    // AI 团队模型覆盖：任一非默认/评审团非空才提交（缺省 = 跟随平台配置）
    const hasTeamOverride =
      creativeModelId !== DEFAULT_MODEL_SENTINEL ||
      styleDirectorModelId !== DEFAULT_MODEL_SENTINEL ||
      writerModelId !== DEFAULT_MODEL_SENTINEL ||
      reviewerIds.length > 0
    setSubmitting(true)
    try {
      const result = await startTarotTemplateAction({
        title: title.trim() || undefined,
        prompt,
        stylePrompt: stylePrompt.trim() || undefined,
        referenceImages,
        quality,
        imageModelId: imageModelId === "__default__" ? null : imageModelId,
        ...(hasTeamOverride
          ? {
              teamModelOverrides: {
                ...(creativeModelId !== DEFAULT_MODEL_SENTINEL ? { styleChatModelId: creativeModelId } : {}),
                ...(styleDirectorModelId !== DEFAULT_MODEL_SENTINEL ? { structureChatModelId: styleDirectorModelId } : {}),
                ...(writerModelId !== DEFAULT_MODEL_SENTINEL ? { copywriterChatModelId: writerModelId } : {}),
                ...(reviewerIds.length > 0 ? { reviewerModelIds: reviewerIds } : {}),
              },
            }
          : {}),
      })
      toast.success("塔罗项目已创建，开始需求澄清")
      onOpenChange(false)
      router.push(`/agent/run/${result.runId}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建项目失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded-lg bg-violet-500/10 p-2 text-xl">🌙</span>
            <Badge variant="secondary">塔罗牌模板</Badge>
          </div>
          <DialogTitle className="text-2xl">先告诉 AI 团队，你想创造什么</DialogTitle>
          <DialogDescription>
            内容与风格分开描述更利于成套统一。信息不完整没关系，创意总监会在下一阶段分「内容 / 风格」两轨主动提问补齐。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* 一、基本信息 */}
          <section className="space-y-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                项目名称 <span className="font-normal text-muted-foreground">（可选）</span>
              </label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：月潮汐神殿塔罗"
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                内容描述 <span className="text-red-500">*</span>
              </label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="你想做的主题、世界观、画面主体与题材……例如：以月相与潮汐神殿为主题，围绕女性神祇与海洋生物的成长叙事。"
                className="min-h-24 resize-y"
                maxLength={2000}
              />
              <p className="text-right text-xs text-muted-foreground">{prompt.length}/2000</p>
            </div>
          </section>

          {/* 二、风格描述 + 参考图（风格轨道：参考图仅用于提取艺术风格样式） */}
          <section className="space-y-3 rounded-xl border border-violet-500/20 bg-violet-500/[0.03] p-4">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Palette className="size-4 text-violet-500" />
                <label className="text-sm font-medium">
                  艺术风格描述 <span className="font-normal text-muted-foreground">（可选）</span>
                </label>
              </div>
              <Textarea
                value={stylePrompt}
                onChange={(e) => setStylePrompt(e.target.value)}
                placeholder="媒介、画风、色调氛围……例如：水彩厚涂，深蓝与鎏金主色，戏剧性明暗对比，神秘梦幻。留空则由风格策划提案。"
                className="min-h-20 resize-y"
                maxLength={2000}
              />
              <p className="text-right text-xs text-muted-foreground">{stylePrompt.length}/2000</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">
                  风格参考图 <span className="font-normal text-muted-foreground">（可选，最多 4 张）</span>
                </label>
              </div>
              <p className="text-xs leading-4 text-muted-foreground">
                参考图仅用于提取艺术风格样式（媒介 / 笔触 / 色调 / 氛围），不用于画面内容；风格方向与一致性评审会与它对齐。
              </p>
              <div className="grid grid-cols-4 gap-2">
                {referenceImages.map((url, index) => (
                  <div key={url} className="group relative aspect-square overflow-hidden rounded-lg border bg-muted">
                    <img src={url} alt={`参考图 ${index + 1}`} className="size-full object-cover" />
                    <button
                      type="button"
                      aria-label="移除参考图"
                      className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={() => setReferenceImages((current) => current.filter((_, i) => i !== index))}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
                {referenceImages.length < 4 && (
                  <label className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-violet-400 hover:bg-violet-500/5">
                    <Upload className="size-5" />
                    <span className="text-[11px]">上传</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void addImage(file)
                        e.currentTarget.value = ""
                      }}
                    />
                  </label>
                )}
              </div>
            </div>
          </section>

          {/* 三、卡面生图模型（比例锁定为平台配置；缺省跟随平台默认） */}
          {cardModelOptions !== null && (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">卡面生图模型</label>
                {cardRatio && (
                  <Badge variant="outline" className="border-violet-500/40 text-[10px] text-violet-600 dark:text-violet-300">
                    比例锁定 {cardRatio}
                  </Badge>
                )}
              </div>
              {cardModelOptions.length > 0 ? (
                <>
                  <Select value={imageModelId} onValueChange={(v) => setImageModelId(v ?? "__default__")}>
                    <SelectTrigger className="w-full">
                      <SelectValue>{cardModelLabel(imageModelId)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">平台默认（超管配置）</SelectItem>
                      {cardModelOptions.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.displayName}（{m.costPerImage} 积分/张 · {m.matchedPreset.width}x{m.matchedPreset.height}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    所有可选模型均支持 {cardRatio} 卡面比例；边框、卡背与牌盒等套件资产沿用平台配置模型，比例与卡面保持一致。
                  </p>
                </>
              ) : (
                // 候选池为空不再静默隐藏：明示当前走向，并指出管理员开放入口
                <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  暂无可选生图模型，将使用平台默认模型。如需让用户自选模型，管理员可在「模型管理」中为模型勾选
                  Agent 工坊可见性（需模型启用中且尺寸预设含 {cardRatio || "卡面"} 比例）。
                </p>
              )}
            </section>
          )}

          {/* 四、AI 团队对话模型（可选；缺省 = 平台超管配置；池加载失败时隐藏本区） */}
          {chatModelOptions !== null && (
            <section className="space-y-3 rounded-xl border bg-muted/20 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Bot className="size-4 text-violet-500" />
                  <label className="text-sm font-medium">AI 团队模型</label>
                  <span className="text-xs text-muted-foreground">（可选，缺省跟随平台配置）</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                  onClick={() => {
                    setCreativeModelId(DEFAULT_MODEL_SENTINEL)
                    setStyleDirectorModelId(DEFAULT_MODEL_SENTINEL)
                    setWriterModelId(DEFAULT_MODEL_SENTINEL)
                    setReviewerIds([])
                  }}
                >
                  <RotateCcw className="size-3" />
                  恢复平台默认
                </Button>
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">创意总监（澄清 / 简报）</Label>
                  <Select value={creativeModelId} onValueChange={(v) => setCreativeModelId(v ?? DEFAULT_MODEL_SENTINEL)}>
                    <SelectTrigger className="w-full">
                      <SelectValue>{chatModelLabel(creativeModelId)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_MODEL_SENTINEL}>平台默认</SelectItem>
                      {chatModelOptions.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.displayName}（{m.scope}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">风格策划（规范书 / 示例图）</Label>
                  <Select value={styleDirectorModelId} onValueChange={(v) => setStyleDirectorModelId(v ?? DEFAULT_MODEL_SENTINEL)}>
                    <SelectTrigger className="w-full">
                      <SelectValue>{chatModelLabel(styleDirectorModelId)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_MODEL_SENTINEL}>平台默认</SelectItem>
                      {chatModelOptions.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.displayName}（{m.scope}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">提示词撰写</Label>
                  <Select value={writerModelId} onValueChange={(v) => setWriterModelId(v ?? DEFAULT_MODEL_SENTINEL)}>
                    <SelectTrigger className="w-full">
                      <SelectValue>{chatModelLabel(writerModelId)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_MODEL_SENTINEL}>平台默认</SelectItem>
                      {chatModelOptions.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.displayName}（{m.scope}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">
                    评审团（1-3 个支持视觉的模型；不选 = 平台默认）
                  </Label>
                  {reviewerIds.length > 0 && (
                    <Badge variant="outline" className="border-violet-500/40 text-[10px] text-violet-600 dark:text-violet-300">
                      已选 {reviewerIds.length}/{MAX_REVIEWERS}
                    </Badge>
                  )}
                </div>
                {chatModelOptions.some((m) => m.supportsVision) ? (
                  <div className="flex flex-wrap gap-2">
                    {chatModelOptions
                      .filter((m) => m.supportsVision)
                      .map((m) => {
                        const active = reviewerIds.includes(m.id)
                        return (
                          <button
                            key={m.id}
                            type="button"
                            aria-pressed={active}
                            onClick={() => toggleReviewer(m.id)}
                            className={cn(
                              "rounded-full border px-3 py-1.5 text-xs transition-colors",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60",
                              active
                                ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                                : "text-muted-foreground hover:border-violet-400/60 hover:bg-violet-500/[0.04]",
                            )}
                          >
                            {m.displayName}
                          </button>
                        )
                      })}
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    暂无支持视觉（多模态）的对话模型可选，评审团将使用平台默认配置。
                  </p>
                )}
              </div>
            </section>
          )}

          {/* 五、质量要求：一列多行滑块（用户在创建时自行设定，初始值 = 平台默认） */}
          <section className="space-y-3 rounded-xl border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">质量要求</span>
                <Badge variant="outline" className="border-violet-500/40 text-[10px] text-violet-600 dark:text-violet-300">由你设定</Badge>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                onClick={() => setQuality(standard)}
              >
                <RotateCcw className="size-3" />
                恢复默认
              </Button>
            </div>
            <div className="space-y-3.5 rounded-lg border bg-card p-3.5">
              <QualitySliderRow
                label="内容对齐及格线"
                value={quality.contentThreshold}
                min={0}
                max={100}
                step={10}
                unit="分"
                onChange={(v) => setQuality((q) => ({ ...q, contentThreshold: v }))}
              />
              <QualitySliderRow
                label="审美及格线"
                value={quality.aestheticThreshold}
                min={0}
                max={100}
                step={10}
                unit="分"
                onChange={(v) => setQuality((q) => ({ ...q, aestheticThreshold: v }))}
              />
              <QualitySliderRow
                label="成套一致性及格线"
                value={quality.consistencyThreshold}
                min={0}
                max={100}
                step={10}
                unit="分"
                onChange={(v) => setQuality((q) => ({ ...q, consistencyThreshold: v }))}
              />
              <QualitySliderRow
                label="打回上限"
                hint={`每张卡最多重绘 ${quality.maxRetries} 次（0 = 不打回）`}
                value={quality.maxRetries}
                min={0}
                max={3}
                step={1}
                unit="轮"
                onChange={(v) => setQuality((q) => ({ ...q, maxRetries: v }))}
              />
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground">
              及格线与打回上限由你在创建时设定（初始值取平台默认，可直接拖动调整）；评审团 AI 按三维及格线打分，打回上限越高，单张卡最多重绘轮数越多，费用相应增加。
            </p>
          </section>

          {/* 流程提示 */}
          <div className="grid gap-3 rounded-xl border bg-muted/30 p-4 sm:grid-cols-3">
            <div className="flex gap-2">
              <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-violet-500" />
              <div>
                <p className="text-xs font-medium">内容/风格双轨澄清</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">分轨提问，风格与参考图对齐</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-violet-500" />
              <div>
                <p className="text-xs font-medium">3 个风格方向</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">各附 1 张示例图再选</p>
              </div>
            </div>
            <div className="flex gap-2">
              <ImagePlus className="mt-0.5 size-4 shrink-0 text-violet-500" />
              <div>
                <p className="text-xs font-medium">完整交付</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">卡面、边框、卡背、牌盒</p>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void submit()} disabled={submitting || prompt.trim().length < 5}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            开始需求澄清
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
