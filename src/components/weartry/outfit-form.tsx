"use client"

import { useMemo, useRef, useState } from "react"
import { PenLine, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { ReferenceImageUpload } from "@/components/product/reference-image-upload"
import {
  DirectionPicker,
  countSelectedImages,
  initSelections,
} from "@/components/product-v2/direction-picker"
import {
  aiAssistOutfitAction,
  generateWeartryOutfitAction,
  type GenerateWeartryResult,
} from "@/server/actions/weartry"
import type { WeartryAiBriefResult, WeartryModelRow } from "@/lib/weartry/types"
import type { ProductDirectionRow } from "@/lib/product/types"
import { ModelRatioSelects, unitCostOf } from "./model-ratio-selects"

/**
 * 服装组图表单（精简流：勾选方向卡片 + 数量 → 直接生成）
 *
 * 区块：① 服装原图 ② 图片模型/比例 ③ 生成类型（超管可配方向池）
 * ④ 服装信息 & 要求（AI 帮写）⑤ 生成按钮。
 */
export function OutfitForm({
  models,
  directions,
  creditsBalance,
  submitting,
  onSubmit,
}: {
  models: WeartryModelRow[]
  directions: ProductDirectionRow[]
  creditsBalance: number
  submitting: boolean
  onSubmit: (run: () => Promise<GenerateWeartryResult>) => void
}) {
  const [referenceImages, setReferenceImages] = useState<string[]>([])
  const [modelId, setModelId] = useState<string | null>(models[0]?.id ?? null)
  const [size, setSize] = useState<string | null>(null)
  /** 服装信息合并文本块（编号格式，AI 帮写生成；服务端解析为模板变量） */
  const [productBrief, setProductBrief] = useState("")
  const [selections, setSelections] = useState(() => initSelections(directions))

  // ── AI 帮写 ──
  const [aiWriting, setAiWriting] = useState(false)
  const [aiOverwriteOpen, setAiOverwriteOpen] = useState(false)
  const pendingAiResult = useRef<WeartryAiBriefResult | null>(null)

  const selectedModel = models.find((m) => m.id === modelId) ?? null
  const maxImages = Math.max(1, selectedModel?.maxReferenceImages ?? 3)
  const visibleDirections = useMemo(
    () => directions.filter((d) => !d.isHidden),
    [directions],
  )
  const totalImages = useMemo(
    () => countSelectedImages(selections),
    [selections],
  )
  const unitCost = unitCostOf(models, modelId)
  const totalCost = unitCost * totalImages

  const runAiWrite = async () => {
    if (referenceImages.length === 0 && !productBrief.trim()) {
      toast.error("请先上传服装原图或填写说明")
      return
    }
    setAiWriting(true)
    try {
      const res = await aiAssistOutfitAction({
        referenceImages,
        userNotes: productBrief.trim() || undefined,
      })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? "AI 帮写失败")
        return
      }
      if (productBrief.trim()) {
        pendingAiResult.current = res.data
        setAiOverwriteOpen(true)
        return
      }
      setProductBrief(res.data.brief)
      if (res.degraded) {
        toast.info("已生成（AI 降级为纯文本模式）")
      }
    } finally {
      setAiWriting(false)
    }
  }

  const trySubmit = () => {
    if (referenceImages.length === 0) return toast.error("请上传服装原图")
    if (totalImages === 0) return toast.error("请至少选择 1 个生成类型")
    if (creditsBalance < totalCost)
      return toast.error(
        `个人配额不足，还需 ${totalCost - creditsBalance} 积分，请联系管理员分配`,
      )
    onSubmit(() =>
      generateWeartryOutfitAction({
        modelId: modelId!,
        referenceImages,
        size: size ?? undefined,
        sellingPoints: productBrief.trim() || undefined,
        directions: Object.entries(selections)
          .filter(([, s]) => s.selected)
          .map(([key, s]) => ({ key, count: s.count })),
      }),
    )
  }

  return (
    <>
      {/* ① 服装原图 */}
      <div className="space-y-2">
        <Label>
          服装原图
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {`支持 1-${maxImages} 张（依模型上限），多角度效果更佳`}
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

      {/* ③ 服装信息 & 要求（AI 帮写） */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>服装信息 & 要求</Label>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void runAiWrite()}
            disabled={aiWriting}
          >
            {aiWriting ? (
              <PenLine className="mr-1 size-3 animate-pen-write text-primary" />
            ) : (
              <PenLine className="mr-1 size-3 text-primary" />
            )}
            AI 帮写
          </Button>
        </div>
        <Textarea
          value={productBrief}
          onChange={(e) => setProductBrief(e.target.value)}
          placeholder={"选填，例如:风格方向、商品卖点、使用场景、展示细节等"}
          rows={8}
          className="text-sm"
        />
      </div>

      {/* ④ 生成类型（方向卡片，超管可配；一行一列） */}
      {visibleDirections.length > 0 ? (
        <div className="space-y-2">
          <Label>生成类型</Label>
          <DirectionPicker
            directions={visibleDirections}
            selections={selections}
            onSelectionsChange={setSelections}
            columns={1}
          />
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          方向池为空，请联系管理员在「穿戴图片管理-图片方向」配置
        </div>
      )}

      {/* ⑤ 生成 */}
      <div className="border-t pt-3">
        <Button className="w-full" onClick={trySubmit} disabled={submitting}>
          {submitting ? (
            <MorphingInfinity className="mr-1 size-4" />
          ) : (
            <Wand2 className="mr-1 size-4" />
          )}
          生成服装组图（{totalCost}积分）
        </Button>
      </div>

      {/* 覆盖确认（AI 帮写） */}
      <Dialog open={aiOverwriteOpen} onOpenChange={setAiOverwriteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>覆盖现有内容？</DialogTitle>
          <DialogDescription>
            AI 帮写结果将覆盖当前已填写的服装信息。
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAiOverwriteOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (pendingAiResult.current)
                  setProductBrief(pendingAiResult.current.brief)
                setAiOverwriteOpen(false)
              }}
            >
              覆盖
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
