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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm, type Resolver } from "react-hook-form"
import {
  firstSizePresetError,
  modelFormSchema,
  type ModelFormValues,
} from "@/lib/forms/model-schemas"
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
  apiFormat: "openai" | "jimeng" | "gemini" | "grsai"
  extraConfig: ModelExtraConfig | null
  costPerImage: number
  description: string | null
  badgeText: string | null
  badgeColor: string | null
  sizePresets: ModelSizePreset[] | null
  supportsImageCount: boolean
  supportsSmartSize: boolean
  useRatioParam: boolean
  ratioParamField: string | null
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

function emptyState(): ModelFormValues {
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
    useRatioParam: false,
    ratioParamField: "",
    grsaiImageSize: "",
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

function fromModel(m: ModelRow): ModelFormValues {
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
    jimengResolution: (ec.jimengResolution as ModelFormValues["jimengResolution"]) ?? "",
    jimengN: ec.jimengN ?? 1,
    qualityEnabled: Boolean(ec.quality),
    quality: (ec.quality as string) ?? "",
    useRatioParam: m.useRatioParam,
    ratioParamField: m.ratioParamField ?? "",
    // 双读：新键优先，旧键 grsai_image_size 为存量数据
    grsaiImageSize:
      ((ec.grsaiImageSize ?? ec.grsai_image_size) as ModelFormValues["grsaiImageSize"]) ??
      "",
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

/**
 * 企业私有生图模型 新建/编辑弹窗。
 *
 * 统一设计语言（范式：recharge-dialog）：useForm + standardSchemaResolver
 * （client-safe zod 镜像 @/lib/forms/model-schemas）→ FormField 体系字段级
 * 内联校验；条件显隐由 form.watch 驱动；成功才 toast，服务端兜底错误统一
 * 显示在 footer 上方一条。
 */
export function ModelFormDialog({
  model,
  trigger,
}: {
  model?: ModelRow
  trigger?: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()
  const isEdit = Boolean(model)

  // raw: true —— 校验走 schema，但提交回调拿原始表单值（apiKey 不在 schema 的
  // 输入类型内，由 ModelFormValues 单独声明；故此处对 resolver 做类型桥接）
  const form = useForm<ModelFormValues>({
    resolver: standardSchemaResolver(modelFormSchema, undefined, {
      raw: true,
    }) as unknown as Resolver<ModelFormValues>,
    defaultValues: model ? fromModel(model) : emptyState(),
  })
  const pending = form.formState.isSubmitting

  // 条件显隐（替代原 state 条件渲染）
  const apiFormat = form.watch("apiFormat")
  const qualityEnabled = form.watch("qualityEnabled")
  const useRatioParam = form.watch("useRatioParam")
  const supportsReferenceImage = form.watch("supportsReferenceImage")
  // 勋章配色：与 badgeText 分属 BadgeField 双字段，经 form 回写/读取
  const badgeColor = form.watch("badgeColor")

  // 编辑器条目输入框无法逐条目挂 FormMessage，统一取第一条嵌套错误兜底展示
  const sizePresetError = firstSizePresetError(form.formState.errors.sizePresets)

  // 每次打开时重置表单
  React.useEffect(() => {
    if (open) {
      form.reset(model ? fromModel(model) : emptyState())
      setServerError(null)
    }
  }, [open, model, form])

  async function onSubmit(values: ModelFormValues) {
    setServerError(null)

    // apiKey 不进 schema：创建必填、编辑留空=不修改（保持原行为，错误落字段）
    if (!isEdit && !values.apiKey) {
      form.setError("apiKey", { message: "请输入 API Key" })
      return
    }

    const input: Record<string, unknown> = {
      name: values.name,
      displayName: values.displayName,
      description: values.description || undefined,
      badgeText: values.badgeText || undefined,
      badgeColor: values.badgeColor || undefined,
      apiEndpoint: values.apiEndpoint,
      apiFormat: values.apiFormat,
      costPerImage: values.costPerImage,
      sizePresets: values.sizePresets,
      supportsImageCount: values.supportsImageCount,
      supportsSmartSize: values.supportsSmartSize,
      visibleInCreate: values.visibleInCreate,
      visibleInWorkspace: values.visibleInWorkspace,
      visibleInProduct: values.visibleInProduct,
      visibleInWeartry: values.visibleInWeartry,
      visibleInMockup: values.visibleInMockup,
      supportsReferenceImage: values.supportsReferenceImage,
      maxReferenceImages: values.maxReferenceImages,
      referenceImageField: values.referenceImageField,
      maxConcurrent: values.maxConcurrent,
      maxRetries: values.maxRetries,
      apiTimeout: values.apiTimeout,
      taskTimeout: values.taskTimeout,
      iconUrl: values.iconUrl || undefined,
    }
    if (values.apiFormat === "jimeng") {
      input.jimengResolution = values.jimengResolution || undefined
      input.jimengN = values.jimengN
    }
    if (values.apiFormat === "grsai") {
      input.grsaiImageSize = values.grsaiImageSize || undefined
    }
    if (values.apiFormat === "openai" || values.apiFormat === "gemini") {
      // 开启但未填值 / 非法比例字段名已由 schema 内联拦截，这里只做透传组装
      input.quality = values.qualityEnabled ? values.quality.trim() : undefined
    }
    if (values.apiFormat === "gemini") {
      input.useRatioParam = values.useRatioParam
      input.ratioParamField = values.useRatioParam
        ? values.ratioParamField.trim() || undefined
        : undefined
    } else {
      // 比例传参仅 gemini 格式生效，其余格式提交复位值（防格式切换残留）
      input.useRatioParam = false
      input.ratioParamField = undefined
    }
    if (values.apiKey) input.apiKey = values.apiKey

    const res = isEdit
      ? await updateModelAction(model!.id, input)
      : await createModelAction(input)
    if (res.ok) {
      toast.success(isEdit ? "模型已更新" : "模型已创建")
      setOpen(false)
      router.refresh()
    } else {
      // 服务端兜底错误（业务错误）：统一条内联展示，不再 toast
      setServerError(res.error ?? "操作失败")
    }
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
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* 基础信息 */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>模型标识</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="如 gpt-image-1" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>显示名</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="如 GPT 图像生成" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* 描述 */}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>模型描述（可选）</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      {...field}
                      placeholder="展示在自由创作模型卡片名称下方，如：高质量写实风格，适合人物与场景"
                      maxLength={300}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 勋章（文字/配色双字段组件：文字走本 FormField，配色经 form 回写） */}
            <FormField
              control={form.control}
              name="badgeText"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <BadgeField
                      text={field.value}
                      color={badgeColor}
                      onTextChange={field.onChange}
                      onColorChange={(v) =>
                        form.setValue("badgeColor", v, {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="apiEndpoint"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>API 地址</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="https://..." />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 图标 + API Key */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="iconUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>模型图标</FormLabel>
                    <FormControl>
                      <ModelIconUpload
                        value={field.value || null}
                        onChange={(url) => field.onChange(url ?? "")}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="apiKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>API Key</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        {...field}
                        placeholder={isEdit ? "留空则不修改" : "请输入 API Key"}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* 接口格式 */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="apiFormat"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>接口格式</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(v) =>
                        field.onChange(
                          (v ?? "openai") as ModelFormValues["apiFormat"],
                        )
                      }
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {field.value === "jimeng"
                              ? "即梦"
                              : field.value === "gemini"
                                ? "Gemini（OpenAI 兼容中转）"
                                : field.value === "grsai"
                                  ? "Gemini (Grsai)"
                                  : "OpenAI 标准生图"}
                          </SelectValue>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="openai">OpenAI 标准生图</SelectItem>
                        <SelectItem value="jimeng">即梦</SelectItem>
                        <SelectItem value="gemini">
                          Gemini（OpenAI 兼容中转）
                        </SelectItem>
                        <SelectItem value="grsai">Gemini (Grsai)</SelectItem>
                      </SelectContent>
                    </Select>
                    {apiFormat === "openai" && (
                      <p className="text-xs text-muted-foreground">
                        请求 POST {"{接口地址}"}/images/generations，尺寸走 size 字段，
                        参考图以 URL 链接传入 image 字段（接口地址配到 /v1 结尾）
                      </p>
                    )}
                    {apiFormat === "gemini" && (
                      <p className="text-xs text-muted-foreground">
                        请求形状同 OpenAI 标准生图（POST {"{接口地址}"}/images/generations、
                        Bearer 鉴权），供 Gemini 系中转模型使用；可在下方配置生图时
                        传比例参数代替尺寸参数
                      </p>
                    )}
                    {apiFormat === "grsai" && (
                      <p className="text-xs text-muted-foreground">
                        请求 POST {"{接口地址}"}/api/generate（接口地址配到域名或 /v1
                        结尾，如 https://grsaiapi.com），比例自动取自下方启用的尺寸预设
                        （aspectRatio），清晰度档位可选；参考图传入 images 字段
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="costPerImage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>每张积分</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* 即梦特定字段 */}
            {apiFormat === "jimeng" && (
              <div className="grid gap-4 rounded-md border p-3 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="jimengResolution"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>分辨率</FormLabel>
                      <Select
                        value={field.value || "__none"}
                        onValueChange={(v) =>
                          field.onChange(
                            (v === "__none" ? "" : v) as ModelFormValues["jimengResolution"],
                          )
                        }
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue>
                              {field.value ? field.value.toUpperCase() : "默认"}
                            </SelectValue>
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none">默认</SelectItem>
                          <SelectItem value="1k">1K</SelectItem>
                          <SelectItem value="2k">2K</SelectItem>
                          <SelectItem value="4k">4K</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="jimengN"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>生成数量 N（1-8）</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          max={8}
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value),
                            )
                          }
                        />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">
                        每次生成 N 张，按张计费；创作页选择为次数，总张数 = 次数 ×
                        N。N &gt; 4 时自动拆分多次即梦请求（单次上游上限 4 张）。
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {(apiFormat === "openai" || apiFormat === "gemini") && (
              <div className="space-y-3 rounded-md border p-3">
                <FormField
                  control={form.control}
                  name="qualityEnabled"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between">
                      <FormLabel>
                        质量参数（quality）
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          开启后生图请求透传 quality 字段，值按上游接口文档填写；关闭则不传
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
                {qualityEnabled && (
                  <FormField
                    control={form.control}
                    name="quality"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>质量值</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="如 high、medium、low、auto、hd、standard"
                            list="quality-suggestions"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
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

            {/* Grsai 专属：清晰度档位（比例自动取自启用的尺寸预设） */}
            {apiFormat === "grsai" && (
              <div className="grid gap-2 rounded-md border p-3">
                <FormField
                  control={form.control}
                  name="grsaiImageSize"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>清晰度档位（imageSize）</FormLabel>
                      <Select
                        value={field.value || "__auto"}
                        onValueChange={(v) =>
                          field.onChange(
                            (v === "__auto" ? "" : v) as ModelFormValues["grsaiImageSize"],
                          )
                        }
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue>
                              {field.value
                                ? field.value
                                : "自动（按预设尺寸推导）"}
                            </SelectValue>
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__auto">
                            自动（按预设尺寸推导）
                          </SelectItem>
                          <SelectItem value="1K">1K</SelectItem>
                          <SelectItem value="2K">2K</SelectItem>
                          <SelectItem value="4K">4K</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        自动档按所选尺寸预设的总像素推导（约 ≤160 万像素 → 1K、
                        ≤600 万像素 → 2K、更大 → 4K）；生图比例无需配置，自动取自
                        下方启用的尺寸预设（如 1024x1536 → 2:3）
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {/* Gemini 专属：生图传尺寸还是传比例 */}
            {apiFormat === "gemini" && (
              <div className="space-y-3 rounded-md border p-3">
                <FormField
                  control={form.control}
                  name="useRatioParam"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between">
                      <FormLabel>
                        传比例参数（代替尺寸）
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          开启后生图请求传所选比例（由尺寸预设归约，如 1024x1024 →
                          1:1），不再传 size；关闭则与 OpenAI 格式一致传 size
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
                {useRatioParam && (
                  <FormField
                    control={form.control}
                    name="ratioParamField"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>比例字段名</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="留空默认 aspect_ratio，按中转站文档填写"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>
            )}

            {/* 尺寸预设 */}
            <FormField
              control={form.control}
              name="sizePresets"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>尺寸预设（比例 + 实际尺寸）</FormLabel>
                  <FormControl>
                    <SizePresetsEditor
                      value={field.value}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  {sizePresetError ? (
                    <p className="text-sm text-destructive">{sizePresetError}</p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 计费/并发/超时 */}
            <div className="grid gap-4 sm:grid-cols-4">
              <FormField
                control={form.control}
                name="maxConcurrent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>最大并发</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={9999}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="maxRetries"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>最大重试</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="apiTimeout"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>请求超时(秒)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="taskTimeout"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>任务总超时(秒)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* 可见性 + 创作页能力 */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="grid gap-2">
                <Label>页面可见性</Label>
                <div className="flex flex-wrap gap-4">
                  {(
                    [
                      ["visibleInCreate", "创作页"],
                      ["visibleInWorkspace", "批量生图"],
                      ["visibleInProduct", "商品图片"],
                      ["visibleInWeartry", "穿戴图片"],
                      ["visibleInMockup", "样机渲染"],
                    ] as const
                  ).map(([fieldName, label]) => (
                    <FormField
                      key={fieldName}
                      control={form.control}
                      name={fieldName}
                      render={({ field }) => (
                        <FormItem className="flex items-center gap-2">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={(v) => field.onChange(v === true)}
                            />
                          </FormControl>
                          <FormLabel className="font-normal">{label}</FormLabel>
                        </FormItem>
                      )}
                    />
                  ))}
                </div>
              </div>
              <FormField
                control={form.control}
                name="supportsImageCount"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between border-t pt-3">
                    <FormLabel>
                      创作页生成数量选择（1-4）
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        开启后用户可在自由创作页选择 1-4；即梦模型下为「次数」，每次出
                        N 张（总张数 = 次数 × N）
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="supportsSmartSize"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between border-t pt-3">
                    <FormLabel>
                      支持智能比例
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        开启后创作页可选「智能」，size 传 auto 由模型决定尺寸
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            {/* 参考图 */}
            <div className="space-y-3 rounded-md border p-3">
              <FormField
                control={form.control}
                name="supportsReferenceImage"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between">
                    <FormLabel>支持参考图</FormLabel>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              {supportsReferenceImage ? (
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="maxReferenceImages"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>最大参考图数</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={1}
                            max={10}
                            {...field}
                            value={field.value ?? ""}
                            onChange={(e) =>
                              field.onChange(
                                e.target.value === ""
                                  ? undefined
                                  : Number(e.target.value),
                              )
                            }
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {/* grsai 固定用 images 字段（适配器硬编码，见 grsai-image.ts），
                      不暴露字段名配置，避免填了 image 之类的值被静默忽略 */}
                  {apiFormat !== "grsai" && (
                    <FormField
                      control={form.control}
                      name="referenceImageField"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>参考图 API 字段名</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              placeholder="留空按格式默认：openai→image，即梦→filePaths"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                </div>
              ) : null}
            </div>

            {serverError ? (
              <p className="text-sm text-destructive">{serverError}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "保存中…" : isEdit ? "保存" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
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
