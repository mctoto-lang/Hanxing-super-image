"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Check, Trash2, User, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { SmartImage } from "@/components/ui/smart-image"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ReferenceImageUpload } from "@/components/product/reference-image-upload"
import {
  addWeartryFigureAction,
  deleteWeartryFigureAction,
  generateWeartryModelImageAction,
  generateWeartryTryonAction,
  getWeartryBatchStatusAction,
  listWeartryFiguresAction,
  type GenerateWeartryResult,
} from "@/server/actions/weartry"
import type {
  WeartryBatchTaskRow,
  WeartryFigureRow,
  WeartryModelRow,
  WeartrySceneRow,
} from "@/lib/weartry/types"
import {
  MODEL_AGES,
  MODEL_BODY_TYPES,
  MODEL_GENDERS,
  MODEL_RACES,
} from "@/lib/weartry/dictionaries"
import { cn, toImageSrc } from "@/lib/utils"
import { ModelRatioSelects, unitCostOf } from "./model-ratio-selects"

/** 模特形象属性下拉值类型 */
type Attrs = {
  gender?: string
  age?: string
  race?: string
  bodyType?: string
}

/** 模特形象来源页签 */
type SourceMode = "ai" | "library" | "upload"

/**
 * 模特穿戴 / AI万戴 共用表单（mode 区分文案与约束）
 *
 * 区块：① 原图（wear=商品服装 1-3 张 / accessory=配饰 1 张）② 图片模型/比例
 * ③ 场景选择（超管可配，提示词注入；仅 wear）④ 模特形象（AI 生成两步流 /
 * 模特库 / 自行上传，AI 产物与上传均自动入库）⑤ 补充要求 ⑥ 生成按钮。
 */
export function TryonForm({
  mode,
  models,
  scenes,
  creditsBalance,
  submitting,
  onSubmit,
}: {
  mode: "model" | "accessory"
  models: WeartryModelRow[]
  scenes: WeartrySceneRow[]
  creditsBalance: number
  submitting: boolean
  onSubmit: (run: () => Promise<GenerateWeartryResult>) => void
}) {
  const isWear = mode === "model"
  const imagesLabel = isWear ? "商品原图" : "穿戴配饰原图"
  const figureLabel = isWear ? "模特形象" : "人物形象"

  const [referenceImages, setReferenceImages] = useState<string[]>([])
  const [sceneKey, setSceneKey] = useState<string | null>(null)
  const [sourceMode, setSourceMode] = useState<SourceMode>("ai")
  const [attrs, setAttrs] = useState<Attrs>({
    gender: MODEL_GENDERS[0]!.value,
    age: MODEL_AGES[0]!.value,
    race: MODEL_RACES[0]!.value,
    bodyType: MODEL_BODY_TYPES[0]!.value,
  })
  const [details, setDetails] = useState("")
  /** 自行上传的模特图（上传成功即自动入库） */
  const [uploadedModelImage, setUploadedModelImage] = useState<string | null>(
    null,
  )
  /** 当前采用的形象图（AI 生成采用或模特库点选写入） */
  const [adoptedImage, setAdoptedImage] = useState<string | null>(null)
  const [additionalPrompt, setAdditionalPrompt] = useState("")
  const [modelId, setModelId] = useState<string | null>(models[0]?.id ?? null)
  const [size, setSize] = useState<string | null>(null)

  // ── 模特库（AI 生成与上传自动入库；本人维度倒序）──
  const [figures, setFigures] = useState<WeartryFigureRow[]>([])
  const refreshFigures = useCallback(async () => {
    try {
      setFigures(await listWeartryFiguresAction())
    } catch {
      // 列表加载失败不阻断表单使用
    }
  }, [])
  useEffect(() => {
    void refreshFigures()
  }, [refreshFigures])

  // ── 生成模特形象（两步流第一步；本地轮询，不占右侧批次面板）──
  const [generatingFigure, setGeneratingFigure] = useState(false)
  const [figureBatchTag, setFigureBatchTag] = useState<string | null>(null)
  const [figureTasks, setFigureTasks] = useState<WeartryBatchTaskRow[]>([])
  const figureResult = useMemo(
    () =>
      figureTasks.find((t) => t.status === "completed" && t.imageUrl) ?? null,
    [figureTasks],
  )
  /** 当前生效的模特形象：优先采用图 → 已上传图 */
  const modelImage = adoptedImage ?? uploadedModelImage

  const selectedModel = models.find((m) => m.id === modelId) ?? null
  /** 原图上限：wear ≤3 / accessory =1，且预留 1 张给模特形象（模型参考图总上限） */
  const maxImages = isWear
    ? Math.min(3, Math.max(1, (selectedModel?.maxReferenceImages ?? 4) - 1))
    : 1
  const unitCost = unitCostOf(models, modelId)

  const selectedScene = scenes.find((s) => s.key === sceneKey) ?? null

  // ── 模特形象批次轮询（完成即出预览并入模特库；失败提示退款）──
  useEffect(() => {
    if (!figureBatchTag) return
    let stop = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const tasks = await getWeartryBatchStatusAction(figureBatchTag)
        if (stop) return
        setFigureTasks(tasks)
        const allDone = tasks.every(
          (t) => t.status === "completed" || t.status === "failed",
        )
        if (allDone) {
          setGeneratingFigure(false)
          if (tasks.some((t) => t.status === "failed")) {
            toast.warning("模特形象生成失败，积分已退，可重试")
          } else {
            toast.success("模特形象已生成并加入模特库，点击「采用」继续生成穿戴图")
            // AI 产物自动入库（幂等），并刷新模特库
            const done = tasks.find(
              (t) => t.status === "completed" && t.imageUrl,
            )
            if (done?.imageUrl) {
              await addWeartryFigureAction({
                imageUrl: done.imageUrl,
                source: "ai",
              })
              await refreshFigures()
            }
          }
        }
        return allDone
      } catch {
        return false
      }
    }
    const timer = setInterval(async () => {
      const done = await tick()
      if (done) clearInterval(timer)
    }, 5000)
    void tick()
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [figureBatchTag, refreshFigures])

  const tryGenerateFigure = async () => {
    if (!modelId) return toast.error("请先选择图片模型")
    if (creditsBalance < unitCost)
      return toast.error(
        `个人配额不足，还需 ${unitCost - creditsBalance} 积分，请联系管理员分配`,
      )
    setGeneratingFigure(true)
    setFigureTasks([])
    setAdoptedImage(null)
    try {
      const res = await generateWeartryModelImageAction({
        modelId,
        size: size ?? undefined,
        attrs,
        details: details.trim() || undefined,
      })
      if (!res.ok || !res.batchTag) {
        toast.error(res.error ?? "提交失败")
        setGeneratingFigure(false)
        return
      }
      setFigureBatchTag(res.batchTag)
      toast.success(`已提交模特形象生成，扣费 ${res.totalCost ?? 0} 积分`)
    } catch {
      setGeneratingFigure(false)
    }
  }

  /** 自行上传：成功即自动入库并采用 */
  const handleUploadChange = async (imgs: string[]) => {
    const url = imgs[0] ?? null
    setUploadedModelImage(url)
    if (url) {
      setAdoptedImage(null)
      const res = await addWeartryFigureAction({ imageUrl: url, source: "upload" })
      if (res.ok) {
        await refreshFigures()
      }
    }
  }

  const removeFromLibrary = async (figure: WeartryFigureRow) => {
    const res = await deleteWeartryFigureAction(figure.id)
    if (!res.ok) {
      toast.error(res.error ?? "移除失败")
      return
    }
    // 移除的是当前采用图时同步清空
    if (adoptedImage === figure.imageUrl) setAdoptedImage(null)
    await refreshFigures()
  }

  const trySubmit = () => {
    if (referenceImages.length === 0)
      return toast.error(`请上传${imagesLabel}`)
    if (!modelImage) return toast.error(`请先确定${figureLabel}（AI 生成、模特库或上传）`)
    if (creditsBalance < unitCost)
      return toast.error(
        `个人配额不足，还需 ${unitCost - creditsBalance} 积分，请联系管理员分配`,
      )
    onSubmit(() =>
      generateWeartryTryonAction({
        mode: isWear ? "wear" : "accessory",
        modelId: modelId!,
        size: size ?? undefined,
        referenceImages,
        modelImage,
        sceneKey: isWear ? sceneKey ?? undefined : undefined,
        attrs,
        details: details.trim() || undefined,
        additionalPrompt: additionalPrompt.trim() || undefined,
      }),
    )
  }

  return (
    <>
      {/* ① 原图 */}
      <div className="space-y-2">
        <Label>
          {imagesLabel}
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {isWear ? `支持 1-${maxImages} 张` : "支持 1 张"}
          </span>
        </Label>
        <ReferenceImageUpload
          images={referenceImages}
          onChange={setReferenceImages}
          maxImages={maxImages}
        />
      </div>

      {/* ② 图片模型 / 图片比例 */}
      <ModelRatioSelects
        models={models}
        modelId={modelId}
        onModelChange={setModelId}
        size={size}
        onSizeChange={setSize}
      />

      {/* ③ 场景选择（仅模特穿戴；超管可配预置场景，选定后注入提示词） */}
      {isWear && scenes.length > 0 && (
        <div className="space-y-1.5">
          <Label>场景选择</Label>
          <Select
            value={sceneKey ?? "none"}
            onValueChange={(v) => setSceneKey(v === "none" ? null : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="不指定场景">
                {selectedScene
                  ? selectedScene.name
                  : "不指定场景"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不指定场景</SelectItem>
              {scenes.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.name}
                  {s.description ? ` · ${s.description}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedScene?.description && (
            <p className="text-xs text-muted-foreground">
              {selectedScene.description}
            </p>
          )}
        </div>
      )}

      {/* ④ 模特形象：AI 生成（两步流） / 模特库 / 自行上传 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{figureLabel}</Label>
          <div className="flex rounded-md border p-0.5 text-xs">
            {(
              [
                ["ai", "AI 生成"],
                ["library", "模特库"],
                ["upload", "自行上传"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setSourceMode(m)}
                className={cn(
                  "rounded px-2 py-1 transition-colors",
                  sourceMode === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {sourceMode === "ai" && (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["gender", "性别", MODEL_GENDERS],
                  ["age", "年龄", MODEL_AGES],
                  ["race", "人种", MODEL_RACES],
                  ["bodyType", "体型", MODEL_BODY_TYPES],
                ] as const
              ).map(([key, label, defs]) => (
                <div key={key} className="space-y-1">
                  <Label className="text-xs">{label}</Label>
                  <Select
                    value={attrs[key] ?? defs[0]!.value}
                    onValueChange={(v) => setAttrs((a) => ({ ...a, [key]: v }))}
                  >
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue>
                        {defs.find((d) => d.value === attrs[key])?.label ??
                          defs[0]!.label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {defs.map((d) => (
                        <SelectItem key={d.value} value={d.value}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">补充细节（可选）</Label>
              <Input
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="如：长发、微笑、站姿挺拔…"
                className="h-8 text-sm"
              />
            </div>

            {/* 生成结果预览 / 采用 */}
            {figureResult?.imageUrl && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-2">
                <div className="relative aspect-[3/4] w-full overflow-hidden rounded-md">
                  <SmartImage
                    src={toImageSrc(figureResult.imageUrl)}
                    alt="模特形象"
                    className="h-full w-full object-cover"
                  />
                  {adoptedImage === figureResult.imageUrl && (
                    <span className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
                      <Check className="size-3" />
                      已采用
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={adoptedImage === figureResult.imageUrl ? "outline" : "default"}
                  className="w-full"
                  disabled={adoptedImage === figureResult.imageUrl}
                  onClick={() => {
                    setAdoptedImage(figureResult.imageUrl)
                    setUploadedModelImage(null)
                    toast.success("已采用该模特形象")
                  }}
                >
                  {adoptedImage === figureResult.imageUrl
                    ? "已采用"
                    : "采用此形象"}
                </Button>
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => void tryGenerateFigure()}
              disabled={generatingFigure}
            >
              {generatingFigure ? (
                <MorphingInfinity className="mr-1 size-3.5" />
              ) : (
                <User className="mr-1 size-3.5" />
              )}
              {generatingFigure
                ? "生成中…"
                : `生成${figureLabel}（${unitCost}积分）`}
            </Button>
          </div>
        )}

        {sourceMode === "library" && (
          <div className="rounded-lg border p-3">
            {figures.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                模特库为空：AI 生成的形象与上传的图片会自动加入这里
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {figures.map((f) => {
                  const active = modelImage === f.imageUrl
                  return (
                    <div key={f.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => {
                          setAdoptedImage(f.imageUrl)
                          setUploadedModelImage(null)
                        }}
                        className={cn(
                          "relative block aspect-[3/4] w-full overflow-hidden rounded-md border transition-colors",
                          active
                            ? "border-primary ring-2 ring-primary"
                            : "border-border hover:border-primary/50",
                        )}
                      >
                        <SmartImage
                          src={toImageSrc(f.imageUrl)}
                          alt="模特形象"
                          className="h-full w-full object-cover"
                        />
                        {active && (
                          <span className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check className="size-3" />
                          </span>
                        )}
                        <span className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[10px] text-white">
                          {f.source === "ai" ? "AI 生成" : "上传"}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label="从模特库移除"
                        onClick={() => void removeFromLibrary(f)}
                        className="absolute -top-1.5 -right-1.5 hidden size-5 items-center justify-center rounded-full bg-destructive text-white group-hover:flex"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {sourceMode === "upload" && (
          <ReferenceImageUpload
            images={uploadedModelImage ? [uploadedModelImage] : []}
            onChange={(imgs) => void handleUploadChange(imgs)}
            maxImages={1}
          />
        )}
      </div>

      {/* ⑤ 补充要求 */}
      <div className="space-y-2">
        <Label>补充要求</Label>
        <Textarea
          value={additionalPrompt}
          onChange={(e) => setAdditionalPrompt(e.target.value)}
          placeholder="补充要求（可选），如：正面全身、自然站立、背景虚化…"
          rows={3}
          className="text-sm"
        />
      </div>

      {/* ⑥ 生成 */}
      <div className="border-t pt-3">
        <Button className="w-full" onClick={trySubmit} disabled={submitting}>
          {submitting ? (
            <MorphingInfinity className="mr-1 size-4" />
          ) : (
            <Wand2 className="mr-1 size-4" />
          )}
          {isWear ? "生成模特穿戴" : "生成穿戴图"}（{unitCost}积分）
        </Button>
      </div>
    </>
  )
}
