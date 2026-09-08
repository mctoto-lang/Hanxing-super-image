"use client"

import * as React from "react"
import { ChevronDown, Loader2, Settings2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { resolveSizePresets } from "@/lib/image-sizes"
import { listMockupModelsAction } from "@/server/actions/mockup"

/**
 * 样机渲染「生成配置」（AI背景/AI渲染 共用的模型 + 尺寸选择）
 *
 * 交互与批量生图页一致：工具栏按钮显示当前摘要，弹窗内两个 Combobox；
 * 选择由父级持有并持久化 localStorage（mockup:generation-config）。
 */

const STORAGE_KEY = "mockup:generation-config"

export interface MockupGenerationConfig {
  modelId: string
  imageSize: string
}

interface PickableModel {
  id: string
  name: string
  displayName: string
  costPerImage: number
  sizePresets: Array<{ label: string; width: number; height: number; enabled?: boolean }> | null
  supportsReferenceImage: boolean
  maxReferenceImages: number
}

export function loadStoredMockupGenConfig(): MockupGenerationConfig | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<MockupGenerationConfig>
    if (typeof parsed.modelId === "string" && typeof parsed.imageSize === "string") {
      return { modelId: parsed.modelId, imageSize: parsed.imageSize }
    }
  } catch {
    // ignore
  }
  return null
}

export function saveStoredMockupGenConfig(config: MockupGenerationConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // ignore
  }
}

export function MockupGenerationConfigButton({
  value,
  onApply,
}: {
  value: MockupGenerationConfig | null
  onApply: (config: MockupGenerationConfig) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [models, setModels] = React.useState<PickableModel[]>([])
  const [loading, setLoading] = React.useState(false)
  const [modelId, setModelId] = React.useState<string | null>(null)
  const [size, setSize] = React.useState<string | null>(null)

  const loadModels = React.useCallback(async () => {
    setLoading(true)
    try {
      const list = (await listMockupModelsAction()) as PickableModel[]
      setModels(list)
      return list
    } catch {
      toast.error("模型列表获取失败")
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    setModelId(value?.modelId ?? null)
    setSize(value?.imageSize ?? null)
    if (models.length === 0) void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const selectedModel = models.find((m) => m.id === modelId) ?? null
  const sizePresets = React.useMemo(
    () => resolveSizePresets(selectedModel?.sizePresets),
    [selectedModel],
  )

  const modelOptions: ComboboxOption[] = models.map((m) => ({
    value: m.id,
    label: m.displayName,
    description: m.name,
    badge: `${m.costPerImage} 积分/张`,
  }))
  const sizeOptions: ComboboxOption[] = sizePresets.map((s) => ({
    value: s.value,
    label: s.label,
    description: s.value,
  }))

  const handleSelectModel = (id: string) => {
    setModelId(id || null)
    setSize(null)
  }

  const handleApply = () => {
    if (!modelId) {
      toast.error("请选择模型")
      return
    }
    if (!size) {
      toast.error("请选择尺寸")
      return
    }
    onApply({ modelId, imageSize: size })
    saveStoredMockupGenConfig({ modelId, imageSize: size })
    toast.success("生成配置已保存")
    setOpen(false)
  }

  const summary = selectedModel
    ? `${selectedModel.displayName} · ${value?.imageSize ?? ""}`
    : value
      ? "模型已失效，点击重选"
      : ""

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        title="AI背景/AI渲染 使用的模型与尺寸"
      >
        <Settings2 className="size-4" />
        生成配置
        {summary ? (
          <span className="max-w-[160px] truncate text-xs text-muted-foreground">
            {summary}
          </span>
        ) : null}
        <ChevronDown className="size-3.5 opacity-60" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>生成配置</DialogTitle>
            <DialogDescription>
              AI背景 / AI渲染 使用的生图模型与尺寸（需在生图模型中开启「样机渲染」可见）
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>图片模型</Label>
              {loading && models.length === 0 ? (
                <div className="flex h-9 items-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" /> 加载模型…
                </div>
              ) : (
                <Combobox
                  value={modelId}
                  onChange={handleSelectModel}
                  options={modelOptions}
                  placeholder="选择图片模型"
                  searchPlaceholder="搜索模型..."
                  popoverClassName="w-80"
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label>尺寸</Label>
              <Combobox
                value={size}
                onChange={(v) => setSize(v || null)}
                options={sizeOptions}
                placeholder={selectedModel ? "选择尺寸" : "请先选择图片模型"}
                searchPlaceholder="搜索尺寸..."
                disabled={!selectedModel}
              />
            </div>
            {selectedModel ? (
              <p className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                {selectedModel.supportsReferenceImage
                  ? `${selectedModel.displayName} · ${selectedModel.costPerImage} 积分/张 · 支持参考图`
                  : `${selectedModel.displayName} 不支持参考图，无法用于 AI背景/AI渲染`}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={!modelId || !size} onClick={handleApply}>
              应用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
