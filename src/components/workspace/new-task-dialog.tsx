"use client"

import { useEffect, useRef, useState } from "react"
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
  Edit3,
  FileText,
  Sparkles,
  Upload,
  X,
} from "lucide-react"
import {
  createWorkspaceTaskAction,
  listTemplatesAction,
} from "@/server/actions/workspace"
import { getReferenceImageLimit } from "@/lib/workspace/helpers"
import { uploadReferenceImages } from "@/lib/workspace/upload"
import type { TemplateRow } from "@/lib/workspace/types"

type CreateMode = "smart" | "extract" | "custom"
type CreateStep = "choose" | "form"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (taskId: string, cardCount: number) => void
}

interface ReferenceFile {
  file: File
  preview: string
}

const modeMeta: Record<
  CreateMode,
  { label: string; description: string; accent: string }
> = {
  smart: {
    label: "智能裂变",
    description: "输入主题提示词，AI 根据裂变模板生成多张卡片。",
    accent:
      "border-blue-300 bg-blue-50 text-blue-700 hover:border-blue-400 hover:bg-blue-100 dark:border-blue-900/70 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-950/50",
  },
  extract: {
    label: "提取裂变",
    description: "输入已写好的长提示词，AI 提取拆分为编号画面描述。",
    accent:
      "border-emerald-300 bg-emerald-50 text-emerald-700 hover:border-emerald-400 hover:bg-emerald-100 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/50",
  },
  custom: {
    label: "自定义创建",
    description:
      "每行一条提示词，按行创建对应数量的卡片，并可上传默认参考图片。",
    accent:
      "border-violet-300 bg-violet-50 text-violet-700 hover:border-violet-400 hover:bg-violet-100 dark:border-violet-900/70 dark:bg-violet-950/30 dark:text-violet-300 dark:hover:bg-violet-950/50",
  },
}

const modeBadgeClass: Record<CreateMode, string> = {
  smart:
    "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-300",
  extract:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300",
  custom:
    "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/20 dark:text-violet-300",
}

export function NewTaskDialog({ open, onOpenChange, onCreated }: Props) {
  const [step, setStep] = useState<CreateStep>("choose")
  const [mode, setMode] = useState<CreateMode>("smart")
  const [title, setTitle] = useState("")
  const [theme, setTheme] = useState("")
  const [longText, setLongText] = useState("")
  const [customPrompts, setCustomPrompts] = useState("")
  const [cardCount, setCardCount] = useState(4)
  const [fissionTemplateId, setFissionTemplateId] = useState("")
  const [extractTemplateId, setExtractTemplateId] = useState("")
  const [fissionTemplates, setFissionTemplates] = useState<TemplateRow[]>([])
  const [extractTemplates, setExtractTemplates] = useState<TemplateRow[]>([])
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [referenceFiles, setReferenceFiles] = useState<ReferenceFile[]>([])
  const [submitting, setSubmitting] = useState(false)

  // 此对话框未关联图片模型，无模型时参考图上限默认 5
  const referenceLimit = getReferenceImageLimit(null) || 5

  // 同步最新文件列表到 ref，供卸载时清理 object URL
  const filesRef = useRef(referenceFiles)
  useEffect(() => {
    filesRef.current = referenceFiles
  })
  useEffect(() => {
    return () => {
      filesRef.current.forEach((f) => URL.revokeObjectURL(f.preview))
    }
  }, [])

  // 打开时加载模板（带竞态清理）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingOptions(true)
    Promise.all([
      listTemplatesAction({ type: "fission" }),
      listTemplatesAction({ type: "extract" }),
    ])
      .then(([fission, extract]) => {
        if (cancelled) return
        setFissionTemplates(fission)
        setExtractTemplates(extract)
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
    setMode("smart")
    setTitle("")
    setTheme("")
    setLongText("")
    setCustomPrompts("")
    setCardCount(4)
    setFissionTemplateId("")
    setExtractTemplateId("")
    referenceFiles.forEach((f) => URL.revokeObjectURL(f.preview))
    setReferenceFiles([])
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

  const handleRemoveFile = (index: number) => {
    setReferenceFiles((prev) => {
      const target = prev[index]
      if (target) URL.revokeObjectURL(target.preview)
      return prev.filter((_, i) => i !== index)
    })
  }

  const parseCustomPrompts = (text: string): string[] =>
    text
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean)

  const handleSubmit = async () => {
    if (mode === "smart") {
      if (!theme.trim()) {
        toast.error("请输入主题提示词")
        return
      }
      if (!fissionTemplateId) {
        toast.error("请选择裂变模板")
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
      let referenceImages: string[] = []
      if (
        (mode === "smart" || mode === "custom") &&
        referenceFiles.length > 0
      ) {
        const uploaded = await uploadReferenceImages(
          referenceFiles.map((f) => f.file),
        )
        if (uploaded.length !== referenceFiles.length) {
          toast.error("部分参考图片上传失败")
        }
        referenceImages = uploaded.map((u) => u.url)
      }

      const input: Parameters<typeof createWorkspaceTaskAction>[0] = {
        mode,
        title: title.trim() || undefined,
      }
      let expectedCount = cardCount

      if (mode === "smart") {
        input.theme = theme.trim()
        input.cardCount = cardCount
        input.templateId = fissionTemplateId
        if (referenceImages.length) input.referenceImages = referenceImages
      } else if (mode === "extract") {
        input.theme = longText.trim()
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
        mode === "smart"
          ? "任务已创建，正在智能裂变..."
          : mode === "extract"
            ? "任务已创建，正在提取裂变..."
            : `任务已创建，共 ${count} 张卡片`,
      )
      onCreated(res.taskId, count)
      resetForm()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败")
    } finally {
      setSubmitting(false)
    }
  }

  const showReferenceImages = mode === "smart" || mode === "custom"

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent
        className={step === "choose" ? "max-w-lg" : "max-w-2xl"}
        showCloseButton={!submitting}
      >
        <DialogHeader>
          <DialogTitle>
            {step === "choose" ? "选择新建任务方式" : "新建批量生图任务"}
          </DialogTitle>
        </DialogHeader>

        {step === "choose" ? (
          <div className="grid grid-cols-1 gap-3">
            {(["smart", "custom", "extract"] as CreateMode[]).map((m) => {
              const meta = modeMeta[m]
              const Icon =
                m === "smart" ? Sparkles : m === "custom" ? Edit3 : FileText
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => handleModeSelect(m)}
                  className={cn(
                    "rounded-md border p-5 text-left transition-all",
                    meta.accent,
                  )}
                >
                  <Icon className="mb-2 h-5 w-5" />
                  <div className="font-medium">{meta.label}</div>
                  <div className="mt-1 text-xs opacity-80">
                    {meta.description}
                  </div>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1 py-2">
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

            {mode === "custom" ? (
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
            ) : (
              <div className="space-y-1.5">
                <Label>
                  {mode === "smart" ? "主题提示词" : "长提示词"}
                  <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  placeholder={
                    mode === "smart"
                      ? "输入主题，AI 将据此裂变出多条图片提示词..."
                      : "粘贴一整段已经写好的多个画面描述，AI 将按编号列表拆解..."
                  }
                  value={mode === "smart" ? theme : longText}
                  onChange={(e) =>
                    mode === "smart"
                      ? setTheme(e.target.value)
                      : setLongText(e.target.value)
                  }
                  rows={mode === "smart" ? 4 : 7}
                />
              </div>
            )}

            {mode !== "custom" && (
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
            )}

            {loadingOptions ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Spinner className="p-0" />
                加载模板...
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {mode === "smart" && (
                  <div className="space-y-1.5">
                    <Label>
                      裂变模板<span className="text-destructive">*</span>
                    </Label>
                    <Select
                      value={fissionTemplateId}
                      onValueChange={(v) => setFissionTemplateId(v ?? "")}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择裂变模板">
                          {fissionTemplateId
                            ? (fissionTemplates.find((t) => t.id === fissionTemplateId)
                                ?.name ?? "选择裂变模板")
                            : "选择裂变模板"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {fissionTemplates.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                            {t.fissionCount ? ` (${t.fissionCount}条)` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {mode === "extract" && (
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
                            ? (extractTemplates.find((t) => t.id === extractTemplateId)
                                ?.name ?? "选择提取模板")
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
              </div>
            )}

            {showReferenceImages && (
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
            )}
          </div>
        )}

        {step === "form" && (
          <DialogFooter>
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
