"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Check, Info } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Combobox } from "@/components/ui/combobox"
import { Spinner } from "@/components/workspace/spinner"
import { toast } from "sonner"
import {
  listTemplatesAction,
  listWorkspaceModelsAction,
} from "@/server/actions/workspace"
import { resolveSizePresets } from "@/lib/image-sizes"
import type {
  ImageModelRow,
  StoredGenerationConfig,
  TemplateRow,
} from "@/lib/workspace/types"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  refreshKey?: number
  selectedFissionTemplate: TemplateRow | null
  selectedRefineTemplate: TemplateRow | null
  selectedRegenTemplate: TemplateRow | null
  selectedExtractTemplate: TemplateRow | null
  selectedTranslateTemplate: TemplateRow | null
  selectedImageModel: ImageModelRow | null
  selectedSize: string | null
  onApply: (config: StoredGenerationConfig) => void
}

export function GenerationConfigDialog({
  open,
  onOpenChange,
  refreshKey = 0,
  selectedFissionTemplate,
  selectedRefineTemplate,
  selectedRegenTemplate,
  selectedExtractTemplate,
  selectedTranslateTemplate,
  selectedImageModel,
  selectedSize,
  onApply,
}: Props) {
  const [fissionTemplates, setFissionTemplates] = useState<TemplateRow[]>([])
  const [refineTemplates, setRefineTemplates] = useState<TemplateRow[]>([])
  const [regenTemplates, setRegenTemplates] = useState<TemplateRow[]>([])
  const [extractTemplates, setExtractTemplates] = useState<TemplateRow[]>([])
  const [translateTemplates, setTranslateTemplates] = useState<TemplateRow[]>([])
  const [models, setModels] = useState<ImageModelRow[]>([])
  const [fissionTemplateId, setFissionTemplateId] = useState("")
  const [refineTemplateId, setRefineTemplateId] = useState("")
  const [regenTemplateId, setRegenTemplateId] = useState("")
  const [extractTemplateId, setExtractTemplateId] = useState("")
  const [translateTemplateId, setTranslateTemplateId] = useState("")
  const [imageModelId, setImageModelId] = useState("")
  const [size, setSize] = useState("")
  const [loading, setLoading] = useState(false)

  const selectedModel = useMemo(
    () => models.find((m) => m.id === imageModelId) || null,
    [models, imageModelId],
  )

  const sizes = useMemo(
    () => resolveSizePresets(selectedModel?.sizePresets),
    [selectedModel],
  )

  const fetchOptions = useCallback(async () => {
    setLoading(true)
    try {
      const [fission, refine, regen, extract, translate, modelsData] =
        await Promise.all([
          listTemplatesAction({ type: "fission" }),
          listTemplatesAction({ type: "deepen" }),
          listTemplatesAction({ type: "regenerate" }),
          listTemplatesAction({ type: "extract" }),
          listTemplatesAction({ type: "translate" }),
          listWorkspaceModelsAction(),
        ])
      setFissionTemplates(fission)
      setRefineTemplates(refine)
      setRegenTemplates(regen)
      setExtractTemplates(extract)
      setTranslateTemplates(translate)
      setModels(
        modelsData.map((m) => ({
          id: m.id,
          name: m.name,
          displayName: m.displayName,
          sizePresets: m.sizePresets,
          iconUrl: m.iconUrl,
          supportsReferenceImage: m.supportsReferenceImage,
          maxReferenceImages: m.maxReferenceImages,
          costPerImage: m.costPerImage,
        })),
      )
    } catch {
      toast.error("获取生成配置失败")
    } finally {
      setLoading(false)
    }
  }, [])

  // 打开或 refreshKey 变化时同步已选状态并拉取数据
  useEffect(() => {
    if (!open) return
    setFissionTemplateId(selectedFissionTemplate?.id ?? "")
    setRefineTemplateId(selectedRefineTemplate?.id ?? "")
    setRegenTemplateId(selectedRegenTemplate?.id ?? "")
    setExtractTemplateId(selectedExtractTemplate?.id ?? "")
    setTranslateTemplateId(selectedTranslateTemplate?.id ?? "")
    setImageModelId(selectedImageModel?.id ?? "")
    setSize(selectedSize ?? "")
    fetchOptions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refreshKey])

  // 切换模型时清空尺寸（保留初次打开时与初始模型匹配的尺寸）
  useEffect(() => {
    if (!open) return
    if (selectedImageModel && selectedImageModel.id === imageModelId) return
    setSize("")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageModelId])

  const handleApply = () => {
    onApply({
      fissionTemplate:
        fissionTemplates.find((t) => t.id === fissionTemplateId) || null,
      refineTemplate:
        refineTemplates.find((t) => t.id === refineTemplateId) || null,
      regenTemplate:
        regenTemplates.find((t) => t.id === regenTemplateId) || null,
      extractTemplate:
        extractTemplates.find((t) => t.id === extractTemplateId) || null,
      translateTemplate:
        translateTemplates.find((t) => t.id === translateTemplateId) || null,
      imageModel: selectedModel,
      size: size || null,
    })
    onOpenChange(false)
  }

  const modelOptions = useMemo(
    () =>
      models.map((m) => ({
        value: m.id,
        label: m.displayName || m.name,
        description: m.name,
        iconUrl: m.iconUrl,
        badge: `${m.costPerImage} 积分/张`,
      })),
    [models],
  )

  const sizeOptions = useMemo(
    () => sizes.map((s) => ({ value: s.value, label: s.label })),
    [sizes],
  )

  const templateFields: Array<{
    label: string
    placeholder: string
    value: string
    onChange: (v: string) => void
    options: TemplateRow[]
  }> = [
    {
      label: "裂变模板",
      placeholder: "选择裂变模板",
      value: fissionTemplateId,
      onChange: setFissionTemplateId,
      options: fissionTemplates,
    },
    {
      label: "细化模板",
      placeholder: "选择细化模板",
      value: refineTemplateId,
      onChange: setRefineTemplateId,
      options: refineTemplates,
    },
    {
      label: "重生成模板",
      placeholder: "选择重生成模板",
      value: regenTemplateId,
      onChange: setRegenTemplateId,
      options: regenTemplates,
    },
    {
      label: "提取提示词模板",
      placeholder: "选择提取提示词模板",
      value: extractTemplateId,
      onChange: setExtractTemplateId,
      options: extractTemplates,
    },
    {
      label: "翻译模板",
      placeholder: "选择翻译模板",
      value: translateTemplateId,
      onChange: setTranslateTemplateId,
      options: translateTemplates,
    },
  ]

  const templateToOption = (t: TemplateRow) => ({
    value: t.id,
    label: t.name,
    badge: t.chatApiName ?? null,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>生成配置</DialogTitle>
        </DialogHeader>
        {loading ? (
          <Spinner />
        ) : (
          <div className="space-y-6 py-2">
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">生图配置</h3>
                <span className="text-xs text-muted-foreground">
                  应用于卡片图片生成
                </span>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>图片模型</Label>
                  <Combobox
                    value={imageModelId || null}
                    onChange={setImageModelId}
                    options={modelOptions}
                    placeholder="选择图片模型"
                    searchPlaceholder="搜索模型..."
                    popoverClassName="w-80"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>尺寸</Label>
                  <Combobox
                    value={size || null}
                    onChange={setSize}
                    options={sizeOptions}
                    placeholder={selectedModel ? "选择尺寸" : "请先选择图片模型"}
                    searchPlaceholder="搜索尺寸..."
                    disabled={!selectedModel}
                  />
                </div>
              </div>
              {selectedModel ? (
                <p className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                  <Info className="size-3.5 shrink-0" />
                  {selectedModel.costPerImage} 积分/张
                  {selectedModel.supportsReferenceImage
                    ? ` · 支持参考图（最多 ${Math.max(1, selectedModel.maxReferenceImages ?? 1)} 张）`
                    : " · 不支持参考图"}
                </p>
              ) : null}
            </section>
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">提示词配置</h3>
                <span className="text-xs text-muted-foreground">
                  徽章为模板关联的对话模型
                </span>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {templateFields.map((field) => (
                  <div key={field.label} className="space-y-1.5">
                    <Label>{field.label}</Label>
                    <Combobox
                      value={field.value || null}
                      onChange={field.onChange}
                      options={field.options.map(templateToOption)}
                      placeholder={field.placeholder}
                      searchPlaceholder="搜索模板..."
                      emptyText="暂无模板，可在模板管理中创建"
                    />
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleApply}>
            <Check className="h-4 w-4" />
            应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
