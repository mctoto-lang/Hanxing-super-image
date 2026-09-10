"use client"

import * as React from "react"
import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import {
  createModelAction,
  updateModelAction,
  toggleModelActiveAction,
} from "@/server/actions/admin-models"
import type { ModelExtraConfig, ModelSizePreset } from "@/db/schema"
import { DEFAULT_SIZE_PRESETS } from "@/lib/image-sizes"
import { ModelIconUpload } from "@/components/model-form/model-icon-upload"
import { SizePresetsEditor } from "@/components/model-form/size-presets-editor"
import { BadgeField } from "@/components/model-form/badge-field"

/** 列表项类型（与 listModelsAction 返回一致） */
export interface ModelRow {
  id: string
  enterpriseId: string | null
  name: string
  displayName: string
  apiEndpoint: string
  apiFormat: "openai" | "jimeng"
  extraConfig: ModelExtraConfig | null
  costPerImage: number
  description: string | null
  badgeText: string | null
  badgeColor: string | null
  sizePresets: ModelSizePreset[] | null
  supportsImageCount: boolean
  supportsSmartSize: boolean
  visibleInCreate: boolean
  visibleInWorkspace: boolean
  visibleInProduct: boolean
  visibleInWeartry: boolean
  visibleInMockup: boolean
  supportsReferenceImage: boolean
  maxReferenceImages: number
  referenceImageField: string | null
  maxConcurrent: number
  maxRetries: number
  apiTimeout: number
  taskTimeout: number
  isActive: boolean
  iconUrl: string | null
}

interface FormState {
  name: string
  displayName: string
  description: string
  badgeText: string
  badgeColor: string
  apiEndpoint: string
  apiKey: string
  apiFormat: "openai" | "jimeng"
  jimengResolution: "" | "1k" | "2k" | "4k"
  jimengN: number
  qualityEnabled: boolean
  quality: string
  costPerImage: number
  sizePresets: ModelSizePreset[]
  supportsImageCount: boolean
  supportsSmartSize: boolean
  visibleInCreate: boolean
  visibleInWorkspace: boolean
  visibleInProduct: boolean
  visibleInWeartry: boolean
  visibleInMockup: boolean
  supportsReferenceImage: boolean
  maxReferenceImages: number
  referenceImageField: string
  maxConcurrent: number
  maxRetries: number
  apiTimeout: number
  taskTimeout: number
  iconUrl: string
}

function emptyState(): FormState {
  return {
    name: "",
    displayName: "",
    description: "",
    badgeText: "",
    badgeColor: "",
    apiEndpoint: "",
    apiKey: "",
    apiFormat: "openai",
    jimengResolution: "",
    jimengN: 1,
    qualityEnabled: false,
    quality: "",
    costPerImage: 1,
    sizePresets: DEFAULT_SIZE_PRESETS.map((p) => ({ ...p })),
    supportsImageCount: false,
    supportsSmartSize: false,
    visibleInCreate: true,
    visibleInWorkspace: false,
    visibleInProduct: false,
    visibleInWeartry: false,
    visibleInMockup: false,
    supportsReferenceImage: false,
    maxReferenceImages: 0,
    referenceImageField: "",
    maxConcurrent: 2,
    maxRetries: 2,
    apiTimeout: 120,
    taskTimeout: 300,
    iconUrl: "",
  }
}

function fromModel(m: ModelRow): FormState {
  const ec = m.extraConfig ?? {}
  return {
    ...emptyState(),
    name: m.name,
    displayName: m.displayName,
    description: m.description ?? "",
    badgeText: m.badgeText ?? "",
    badgeColor: m.badgeColor ?? "",
    apiEndpoint: m.apiEndpoint,
    apiKey: "",
    apiFormat: m.apiFormat,
    jimengResolution: (ec.jimengResolution as "" | "1k" | "2k" | "4k") ?? "",
    jimengN: ec.jimengN ?? 1,
    qualityEnabled: Boolean(ec.quality),
    quality: (ec.quality as string) ?? "",
    costPerImage: m.costPerImage,
    sizePresets: m.sizePresets
      ? m.sizePresets.map((p) => ({ ...p }))
      : DEFAULT_SIZE_PRESETS.map((p) => ({ ...p })),
    supportsImageCount: m.supportsImageCount,
    supportsSmartSize: m.supportsSmartSize,
    visibleInCreate: m.visibleInCreate,
    visibleInWorkspace: m.visibleInWorkspace,
    visibleInProduct: m.visibleInProduct,
    visibleInWeartry: m.visibleInWeartry,
    visibleInMockup: m.visibleInMockup,
    supportsReferenceImage: m.supportsReferenceImage,
    maxReferenceImages: m.maxReferenceImages,
    referenceImageField: m.referenceImageField ?? "",
    maxConcurrent: m.maxConcurrent,
    maxRetries: m.maxRetries,
    apiTimeout: m.apiTimeout,
    taskTimeout: m.taskTimeout,
    iconUrl: m.iconUrl ?? "",
  }
}

export function ModelFormDialog({
  model,
  trigger,
}: {
  model?: ModelRow
  trigger?: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const [state, setState] = React.useState<FormState>(
    model ? fromModel(model) : emptyState(),
  )
  const router = useRouter()
  const isEdit = Boolean(model)

  // 每次打开时重置表单
  React.useEffect(() => {
    if (open) setState(model ? fromModel(model) : emptyState())
  }, [open, model])

  function up<K extends keyof FormState>(key: K, val: FormState[K]) {
    setState((s) => ({ ...s, [key]: val }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const input: Record<string, unknown> = {
      name: state.name,
      displayName: state.displayName,
      description: state.description || undefined,
      badgeText: state.badgeText || undefined,
      badgeColor: state.badgeColor || undefined,
      apiEndpoint: state.apiEndpoint,
      apiFormat: state.apiFormat,
      costPerImage: state.costPerImage,
      sizePresets: state.sizePresets,
      supportsImageCount: state.supportsImageCount,
      supportsSmartSize: state.supportsSmartSize,
      visibleInCreate: state.visibleInCreate,
      visibleInWorkspace: state.visibleInWorkspace,
      visibleInProduct: state.visibleInProduct,
      visibleInWeartry: state.visibleInWeartry,
      visibleInMockup: state.visibleInMockup,
      supportsReferenceImage: state.supportsReferenceImage,
      maxReferenceImages: state.maxReferenceImages,
      referenceImageField: state.referenceImageField,
      maxConcurrent: state.maxConcurrent,
      maxRetries: state.maxRetries,
      apiTimeout: state.apiTimeout,
      taskTimeout: state.taskTimeout,
      iconUrl: state.iconUrl || undefined,
    }
    if (state.apiFormat === "jimeng") {
      input.jimengResolution = state.jimengResolution || undefined
      input.jimengN = state.jimengN
    }
    if (state.apiFormat === "openai") {
      if (state.qualityEnabled && !state.quality.trim()) {
        toast.error("已开启质量参数，请填入具体质量值")
        return
      }
      input.quality = state.qualityEnabled ? state.quality.trim() : undefined
    }
    if (state.apiKey) input.apiKey = state.apiKey

    startTransition(async () => {
      const res = isEdit
        ? await updateModelAction(model!.id, input)
        : await createModelAction(input)
      if (res.ok) {
        toast.success(isEdit ? "模型已更新" : "模型已创建")
        setOpen(false)
        router.refresh()
      } else {
        toast.error(res.error ?? "操作失败")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          trigger ?? (
            <Button>
              <Plus className="size-4" />
              {isEdit ? "编辑" : "新建模型"}
            </Button>
          )
        }
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑模型" : "新建模型"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 基础信息 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="name">模型标识</Label>
              <Input
                id="name"
                value={state.name}
                onChange={(e) => up("name", e.target.value)}
                placeholder="如 gpt-image-1"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="displayName">显示名</Label>
              <Input
                id="displayName"
                value={state.displayName}
                onChange={(e) => up("displayName", e.target.value)}
                placeholder="如 GPT 图像生成"
                required
              />
            </div>
          </div>

          {/* 描述 */}
          <div className="grid gap-2">
            <Label htmlFor="description">模型描述（可选）</Label>
            <Textarea
              id="description"
              rows={2}
              value={state.description}
              onChange={(e) => up("description", e.target.value)}
              placeholder="展示在自由创作模型卡片名称下方，如：高质量写实风格，适合人物与场景"
              maxLength={300}
            />
          </div>

          {/* 勋章 */}
          <BadgeField
            text={state.badgeText}
            color={state.badgeColor}
            onTextChange={(v) => up("badgeText", v)}
            onColorChange={(v) => up("badgeColor", v)}
          />

          <div className="grid gap-2">
            <Label htmlFor="apiEndpoint">API 地址</Label>
            <Input
              id="apiEndpoint"
              value={state.apiEndpoint}
              onChange={(e) => up("apiEndpoint", e.target.value)}
              placeholder="https://..."
              required
            />
          </div>

          {/* 图标 + API Key */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>模型图标</Label>
              <ModelIconUpload
                value={state.iconUrl || null}
                onChange={(url) => up("iconUrl", url ?? "")}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="apiKey">API Key</Label>
              <Input
                id="apiKey"
                type="password"
                value={state.apiKey}
                onChange={(e) => up("apiKey", e.target.value)}
                placeholder={isEdit ? "留空则不修改" : "请输入 API Key"}
                required={!isEdit}
              />
            </div>
          </div>

          {/* 接口格式 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>接口格式</Label>
              <Select
                value={state.apiFormat}
                onValueChange={(v) => up("apiFormat", (v ?? "openai") as "openai" | "jimeng")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {state.apiFormat === "jimeng" ? "即梦" : "OpenAI 标准生图"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI 标准生图</SelectItem>
                  <SelectItem value="jimeng">即梦</SelectItem>
                </SelectContent>
              </Select>
              {state.apiFormat === "openai" && (
                <p className="text-xs text-muted-foreground">
                  请求 POST {"{接口地址}"}/images/generations，尺寸走 size 字段，
                  参考图以 URL 链接传入 image 字段（接口地址配到 /v1 结尾）
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="costPerImage">每张积分</Label>
              <Input
                id="costPerImage"
                type="number"
                min={0}
                value={state.costPerImage}
                onChange={(e) => up("costPerImage", Number(e.target.value))}
              />
            </div>
          </div>

          {/* 即梦特定字段 */}
          {state.apiFormat === "jimeng" && (
            <div className="grid gap-4 rounded-md border p-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>分辨率</Label>
                <Select
                  value={state.jimengResolution || "__none"}
                  onValueChange={(v) =>
                    up("jimengResolution", (v === "__none" ? "" : v) as FormState["jimengResolution"])
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {state.jimengResolution
                        ? state.jimengResolution.toUpperCase()
                        : "默认"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">默认</SelectItem>
                    <SelectItem value="1k">1K</SelectItem>
                    <SelectItem value="2k">2K</SelectItem>
                    <SelectItem value="4k">4K</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="jimengN">生成数量 N（1-8）</Label>
                <Input
                  id="jimengN"
                  type="number"
                  min={1}
                  max={8}
                  value={state.jimengN}
                  onChange={(e) => up("jimengN", Number(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  每次生成 N 张，按张计费；创作页选择为次数，总张数 = 次数 ×
                  N。N &gt; 4 时自动拆分多次即梦请求（单次上游上限 4 张）。
                </p>
              </div>
            </div>
          )}

          {state.apiFormat === "openai" && (
            <div className="space-y-3 rounded-md border p-3">
              <label className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  质量参数（quality）
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    开启后生图请求透传 quality 字段，值按上游接口文档填写；关闭则不传
                  </span>
                </span>
                <Switch
                  checked={state.qualityEnabled}
                  onCheckedChange={(v) => up("qualityEnabled", v)}
                />
              </label>
              {state.qualityEnabled && (
                <div className="grid gap-2">
                  <Label htmlFor="quality">质量值</Label>
                  <Input
                    id="quality"
                    value={state.quality}
                    onChange={(e) => up("quality", e.target.value)}
                    placeholder="如 high、medium、low、auto、hd、standard"
                    list="quality-suggestions"
                  />
                  <datalist id="quality-suggestions">
                    <option value="high" />
                    <option value="medium" />
                    <option value="low" />
                    <option value="auto" />
                    <option value="hd" />
                    <option value="standard" />
                  </datalist>
                </div>
              )}
            </div>
          )}

          {/* 尺寸预设 */}
          <div className="grid gap-2">
            <Label>尺寸预设（比例 + 实际尺寸）</Label>
            <SizePresetsEditor
              value={state.sizePresets}
              onChange={(v) => up("sizePresets", v)}
            />
          </div>

          {/* 计费/并发/超时 */}
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="maxConcurrent">最大并发</Label>
              <Input
                id="maxConcurrent"
                type="number"
                min={1}
                value={state.maxConcurrent}
                onChange={(e) => up("maxConcurrent", Number(e.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="maxRetries">最大重试</Label>
              <Input
                id="maxRetries"
                type="number"
                min={0}
                value={state.maxRetries}
                onChange={(e) => up("maxRetries", Number(e.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="apiTimeout">请求超时(秒)</Label>
              <Input
                id="apiTimeout"
                type="number"
                min={1}
                value={state.apiTimeout}
                onChange={(e) => up("apiTimeout", Number(e.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="taskTimeout">任务总超时(秒)</Label>
              <Input
                id="taskTimeout"
                type="number"
                min={0}
                value={state.taskTimeout}
                onChange={(e) => up("taskTimeout", Number(e.target.value))}
              />
            </div>
          </div>

          {/* 可见性 + 创作页能力 */}
          <div className="space-y-3 rounded-md border p-3">
            <div className="grid gap-2">
              <Label>页面可见性</Label>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={state.visibleInCreate}
                    onCheckedChange={(v) => up("visibleInCreate", v === true)}
                  />
                  创作页
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={state.visibleInWorkspace}
                    onCheckedChange={(v) => up("visibleInWorkspace", v === true)}
                  />
                  批量生图
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={state.visibleInProduct}
                    onCheckedChange={(v) => up("visibleInProduct", v === true)}
                  />
                  商品图片
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={state.visibleInWeartry}
                    onCheckedChange={(v) => up("visibleInWeartry", v === true)}
                  />
                  穿戴图片
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={state.visibleInMockup}
                    onCheckedChange={(v) => up("visibleInMockup", v === true)}
                  />
                  样机渲染
                </label>
              </div>
            </div>
            <label className="flex items-center justify-between border-t pt-3">
              <span className="text-sm font-medium">
                创作页生成数量选择（1-4）
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  开启后用户可在自由创作页选择 1-4；即梦模型下为「次数」，每次出
                  N 张（总张数 = 次数 × N）
                </span>
              </span>
              <Switch
                checked={state.supportsImageCount}
                onCheckedChange={(v) => up("supportsImageCount", v)}
              />
            </label>
            <label className="flex items-center justify-between border-t pt-3">
              <span className="text-sm font-medium">
                支持智能比例
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  开启后创作页可选「智能」，size 传 auto 由模型决定尺寸
                </span>
              </span>
              <Switch
                checked={state.supportsSmartSize}
                onCheckedChange={(v) => up("supportsSmartSize", v)}
              />
            </label>
          </div>

          {/* 参考图 */}
          <div className="space-y-3 rounded-md border p-3">
            <label className="flex items-center justify-between">
              <span className="text-sm font-medium">支持参考图</span>
              <Switch
                checked={state.supportsReferenceImage}
                onCheckedChange={(v) => up("supportsReferenceImage", v)}
              />
            </label>
            {state.supportsReferenceImage ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="maxReferenceImages">最大参考图数</Label>
                  <Input
                    id="maxReferenceImages"
                    type="number"
                    min={1}
                    max={10}
                    value={state.maxReferenceImages}
                    onChange={(e) =>
                      up("maxReferenceImages", Number(e.target.value))
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="referenceImageField">参考图 API 字段名</Label>
                  <Input
                    id="referenceImageField"
                    value={state.referenceImageField}
                    onChange={(e) => up("referenceImageField", e.target.value)}
                    placeholder="留空按格式默认：openai→image，即梦→images"
                  />
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "保存中..." : isEdit ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 表格行内的编辑触发按钮（受控打开） */
export function ModelEditButton({ model }: { model: ModelRow }) {
  return (
    <ModelFormDialog
      model={model}
      trigger={
        <Button variant="ghost" size="sm">
          <Pencil className="size-4" />
          编辑
        </Button>
      }
    />
  )
}

/** 启停按钮（仅企业私有模型可用，平台预置模型由父组件控制不渲染） */
export function ModelToggleActiveButton({ model }: { model: ModelRow }) {
  const [pending, startTransition] = React.useTransition()
  const router = useRouter()
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          const res = await toggleModelActiveAction(model.id, !model.isActive)
          if (res.ok) {
            toast.success(model.isActive ? "已停用" : "已启用")
            router.refresh()
          } else {
            toast.error(res.error ?? "操作失败")
          }
        })
      }}
    >
      {pending ? "处理中" : model.isActive ? "停用" : "启用"}
    </Button>
  )
}
