"use client"

import * as React from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
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
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { useWatch, type UseFormReturn } from "react-hook-form"
import {
  firstSizePresetError,
  type ModelFormValues,
} from "@/lib/forms/model-schemas"
import type { ModelExtraConfig, ModelSizePreset } from "@/db/schema"
import { DEFAULT_SIZE_PRESETS } from "@/lib/image-sizes"
import { ModelIconUpload } from "@/components/model-form/model-icon-upload"
import { SizePresetsEditor } from "@/components/model-form/size-presets-editor"
import { BadgeField } from "@/components/model-form/badge-field"
import { UpstreamModelFetch } from "@/components/model-form/upstream-model-fetch"

/**
 * 生图模型表单共享字段组件 + 表单值助手（企业侧 ModelFormDialog 与超管侧
 * PresetModelFormDialog 共用，替代原先双份 ~1100 行复制维护）。
 *
 * 布局（2026-11 重设计：简洁紧凑）：基本信息 / 接口 / 尺寸与参数 / 参考图
 * 四区 + 默认折叠的「高级设置」（并发 · 超时 · 页面可见性 · 创作页能力），
 * 常用路径一屏内完成；条件显隐由 form.watch 驱动。
 */

/** 列表行类型（与两侧 list action 返回结构一致；enterpriseId 仅企业侧使用） */
export interface ImageModelFormRow {
  id: string
  enterpriseId?: string | null
  name: string
  displayName: string
  apiEndpoint: string
  apiFormat: "openai" | "chat" | "gemini" | "midjourney" | "jimeng" | "grsai"
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

/** 接口格式下拉展示名（六格式） */
export const API_FORMAT_LABELS: Record<ImageModelFormRow["apiFormat"], string> = {
  openai: "Images 协议（OpenAI 标准）",
  chat: "Chat 协议（OpenAI 兼容对话）",
  gemini: "Gemini 协议（官方原生）",
  midjourney: "Midjourney（MJ Proxy）",
  jimeng: "即梦（jimeng-free-api）",
  grsai: "Grsai（统一端点）",
}

export function emptyModelState(): ModelFormValues {
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
    sizeMode: "pixels",
    tierValue: "",
    responseFormat: "",
    ratioParamField: "",
    grsaiImageSize: "",
    mjFlags: "",
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

export function fromModelToForm(m: ImageModelFormRow): ModelFormValues {
  const ec = m.extraConfig ?? {}
  return {
    ...emptyModelState(),
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
    // 尺寸传参模式：extraConfig.sizeMode 优先；旧「Gemini 系中转」行
    // useRatioParam=true 回退视为 ratio（0102 已迁移补写，双保险）
    sizeMode:
      (ec.sizeMode as ModelFormValues["sizeMode"] | undefined) ??
      (m.useRatioParam ? "ratio" : "pixels"),
    tierValue: (ec.tierValue as ModelFormValues["tierValue"]) ?? "",
    responseFormat: (ec.responseFormat as ModelFormValues["responseFormat"]) ?? "",
    ratioParamField: m.ratioParamField ?? "",
    // 双读：新键优先，旧键 grsai_image_size 为存量数据
    grsaiImageSize:
      ((ec.grsaiImageSize ?? ec.grsai_image_size) as ModelFormValues["grsaiImageSize"]) ??
      "",
    mjFlags: (ec.mjFlags as string) ?? "",
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

/** 把表单值组装为提交给 action 的扁平 input（六格式条件字段） */
export function buildModelSubmitInput(
  values: ModelFormValues,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: values.name,
    displayName: values.displayName,
    description: values.description || undefined,
    badgeText: values.badgeText || undefined,
    badgeColor: values.badgeColor || undefined,
    apiEndpoint: values.apiEndpoint,
    apiFormat: values.apiFormat,
    costPerImage: values.costPerImage,
    // 空/纯空白 ratio 剔除为 undefined（服务端 schema 的 ratio 不收空串；
    // 键缺省即合法，落库后展示侧按宽高 gcdRatio 归约，见 lib/image-sizes.ts）
    sizePresets: values.sizePresets.map((p) =>
      p.ratio && p.ratio.trim() ? p : { ...p, ratio: undefined },
    ),
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
    // 旧「Gemini 系中转」比例开关：新配置一律 false（行为由 extraConfig.sizeMode 承载）
    useRatioParam: false,
  }
  if (values.apiFormat === "jimeng") {
    input.jimengResolution = values.jimengResolution || undefined
    input.jimengN = values.jimengN
  }
  if (values.apiFormat === "grsai") {
    input.grsaiImageSize = values.grsaiImageSize || undefined
  }
  if (values.apiFormat === "midjourney") {
    input.mjFlags = values.mjFlags.trim() || undefined
  }
  if (values.apiFormat === "openai") {
    // 开启但未填值 / 非法参数字段名已由 schema 内联拦截，这里只做透传组装
    input.quality = values.qualityEnabled ? values.quality.trim() : undefined
    input.sizeMode = values.sizeMode
    input.tierValue =
      values.sizeMode === "tier" ? values.tierValue || undefined : undefined
    input.responseFormat = values.responseFormat || undefined
    input.ratioParamField =
      values.sizeMode !== "pixels"
        ? values.ratioParamField.trim() || undefined
        : undefined
  } else {
    // 尺寸传参仅 Images 协议生效，其余格式复位（防格式切换残留）
    input.ratioParamField = undefined
  }
  if (values.apiKey) input.apiKey = values.apiKey
  return input
}

/** 数字输入受控桥（空串→undefined 触发必填校验，其余转 number） */
function numberProps(field: {
  value: number | undefined
  onChange: (v: number) => void
}) {
  return {
    value: field.value ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      field.onChange(
        e.target.value === "" ? (undefined as unknown as number) : Number(e.target.value),
      ),
  }
}

/** 分区标题（细分隔线 + 小号标签，紧凑分组） */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t pt-3 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * 生图模型表单字段（分区布局）。在 <Form {...form}> 内渲染，不含
 * Dialog 外壳与提交按钮（由两侧薄壳弹窗各自持有）。
 */
export function ImageModelFields({
  form,
  scope,
  isEdit,
  modelId,
}: {
  form: UseFormReturn<ModelFormValues>
  scope: "enterprise" | "platform"
  isEdit: boolean
  modelId?: string
}) {
  // 条件显隐（顶层 form.watch：无条件调用，React Compiler 可记忆化）
  const apiFormat = form.watch("apiFormat")
  const qualityEnabled = form.watch("qualityEnabled")
  const sizeMode = form.watch("sizeMode")
  const supportsReferenceImage = form.watch("supportsReferenceImage")
  const badgeColor = form.watch("badgeColor")
  // 拉取按钮的响应式入参（useWatch 替代内联 form.watch：后者使
  // React Compiler 跳过本组件记忆化，lint 报 Compilation Skipped）
  const apiEndpointValue = useWatch({ control: form.control, name: "apiEndpoint" })
  const apiKeyValue = useWatch({ control: form.control, name: "apiKey" })

  const sizePresetError = firstSizePresetError(form.formState.errors.sizePresets)
  // 提供模型列表拉取的格式（openai/chat→/v1/models；gemini→/v1beta/models）
  const fetchableFormat =
    apiFormat === "openai" || apiFormat === "chat" || apiFormat === "gemini"
  // 比例协议：预设宽高仅用于比例换算与展示
  const ratioOnly =
    apiFormat === "gemini" || apiFormat === "midjourney" || apiFormat === "chat"

  const [advancedOpen, setAdvancedOpen] = React.useState(false)

  return (
    <>
      {/* ── 基本信息 ── */}
      <SectionHeading>基本信息</SectionHeading>
      <div className="grid grid-cols-2 gap-3">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>模型标识</FormLabel>
              <FormControl>
                <Input {...field} placeholder="如 gpt-image-1" />
              </FormControl>
              {fetchableFormat && (
                <UpstreamModelFetch
                  scope={scope}
                  kind="image"
                  endpoint={apiEndpointValue}
                  apiKey={apiKeyValue}
                  modelId={modelId}
                  apiFormat={apiFormat}
                  onPick={(id) =>
                    form.setValue("name", id, { shouldDirty: true })
                  }
                />
              )}
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
      <div className="grid grid-cols-2 gap-3">
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
      </div>

      {/* ── 接口 ── */}
      <SectionHeading>接口</SectionHeading>
      <div className="grid grid-cols-2 gap-3">
        <FormField
          control={form.control}
          name="apiFormat"
          render={({ field }) => (
            <FormItem>
              <FormLabel>接口格式</FormLabel>
              <Select
                value={field.value}
                onValueChange={(v) =>
                  field.onChange((v ?? "openai") as ModelFormValues["apiFormat"])
                }
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue>{API_FORMAT_LABELS[field.value]}</SelectValue>
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {(Object.keys(API_FORMAT_LABELS) as Array<ImageModelFormRow["apiFormat"]>).map(
                    (f) => (
                      <SelectItem key={f} value={f}>
                        {API_FORMAT_LABELS[f]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
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
                <Input type="number" min={0} {...field} {...numberProps(field)} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {apiFormat === "openai" &&
          "无参考图 POST {接口地址}/v1/images/generations，带参考图自动走 /v1/images/edits（multipart 文件上传）；接口地址配到 /v1 结尾，Bearer 鉴权"}
        {apiFormat === "chat" &&
          "POST {接口地址}/v1/chat/completions：提示词 + 参考图多模态消息，从回复解析图片；适合各类聚合渠道，无尺寸参数"}
        {apiFormat === "gemini" &&
          "POST {接口地址}/v1beta/models/{模型标识}:generateContent：按比例生图（aspectRatio 十档，无像素尺寸控制），参考图自动取图转 base64"}
        {apiFormat === "midjourney" &&
          "POST {接口地址}/mj/submit/imagine 提交 + 轮询：一次任务固定 4 张四宫格、按任务计费；画幅 --ar 自动取自所选比例"}
        {apiFormat === "jimeng" &&
          "POST {接口地址}（jimeng-free-api 反代完整地址），Bearer 鉴权；比例 + 分辨率档位传参，参考图传入 filePaths 字段"}
        {apiFormat === "grsai" &&
          "POST {接口地址}/v1/api/generate（配到域名或 /v1 结尾）：比例自动取自尺寸预设（aspectRatio），清晰度档位可选，参考图传入 images 字段"}
      </p>
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

      {/* ── 尺寸与参数（按格式条件） ── */}
      <SectionHeading>尺寸与参数</SectionHeading>

      {/* Images 协议：尺寸传参模式 + 质量 + response_format */}
      {apiFormat === "openai" && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="sizeMode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>尺寸传参模式</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) =>
                      field.onChange((v ?? "pixels") as ModelFormValues["sizeMode"])
                    }
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {field.value === "ratio"
                            ? "比例（如 1:1）"
                            : field.value === "tier"
                              ? "清晰度档位（1K/2K/4K）"
                              : "像素（size，默认）"}
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="pixels">像素（size，默认）</SelectItem>
                      <SelectItem value="ratio">比例（如 1:1）</SelectItem>
                      <SelectItem value="tier">清晰度档位（1K/2K/4K）</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {sizeMode === "tier" && (
              <FormField
                control={form.control}
                name="tierValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>档位</FormLabel>
                    <Select
                      value={field.value || "__auto"}
                      onValueChange={(v) =>
                        field.onChange(
                          (v === "__auto" ? "" : v) as ModelFormValues["tierValue"],
                        )
                      }
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {field.value
                              ? `固定 ${field.value}`
                              : "自动（按预设像素推导）"}
                          </SelectValue>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__auto">自动（按预设像素推导）</SelectItem>
                        <SelectItem value="1K">固定 1K</SelectItem>
                        <SelectItem value="2K">固定 2K</SelectItem>
                        <SelectItem value="4K">固定 4K</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      固定档位后 size 恒传该值，用户端自定义尺寸置灰
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
          </div>
          {sizeMode !== "pixels" && (
            <FormField
              control={form.control}
              name="ratioParamField"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>尺寸/比例参数字段名</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={
                        sizeMode === "ratio"
                          ? "留空默认 aspect_ratio，按中转站文档填写"
                          : "留空默认 size，按中转站文档填写（如 image_size）"
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
          <FormField
            control={form.control}
            name="qualityEnabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between">
                <FormLabel>
                  质量参数（quality）
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    开启后透传 quality 字段，值按上游文档填写
                  </span>
                </FormLabel>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
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
          <FormField
            control={form.control}
            name="responseFormat"
            render={({ field }) => (
              <FormItem>
                <FormLabel>response_format</FormLabel>
                <Select
                  value={field.value || "__none"}
                  onValueChange={(v) =>
                    field.onChange(
                      (v === "__none" ? "" : v) as ModelFormValues["responseFormat"],
                    )
                  }
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {field.value === "url"
                          ? "url"
                          : field.value === "b64_json"
                            ? "b64_json"
                            : "不传（默认）"}
                      </SelectValue>
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none">不传（默认）</SelectItem>
                    <SelectItem value="url">url</SelectItem>
                    <SelectItem value="b64_json">b64_json</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  部分上游默认返回 b64、需显式要求才返回 URL（或反之）；两种返回均已支持解析转存
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      )}

      {/* Chat / Gemini 协议：无尺寸参数，仅说明 */}
      {apiFormat === "chat" && (
        <p className="rounded-md border p-3 text-xs text-muted-foreground">
          Chat 协议无尺寸/质量参数：请求只带提示词与参考图（多模态消息），生成尺寸由模型自行决定；下方尺寸预设仅用于前端选择与比例展示。
        </p>
      )}
      {apiFormat === "gemini" && (
        <p className="rounded-md border p-3 text-xs text-muted-foreground">
          Gemini 官方原生按比例生图：预设宽高自动归约并吸附到官方十档比例（1:1 ~ 21:9），无像素级尺寸控制；用户端自定义尺寸置灰、仅按比例选择。
        </p>
      )}

      {/* Midjourney：参数后缀 */}
      {apiFormat === "midjourney" && (
        <div className="space-y-2 rounded-md border p-3">
          <FormField
            control={form.control}
            name="mjFlags"
            render={({ field }) => (
              <FormItem>
                <FormLabel>参数后缀（追加到提示词末尾）</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="如 --v 8.2 --fast" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <p className="text-xs text-muted-foreground">
            画幅 --ar 自动取自用户所选比例（无须配置）；一次任务固定 4 张、按任务计费，「任务总超时」（高级设置）建议 ≥ 300 秒。
          </p>
        </div>
      )}

      {/* 即梦 */}
      {apiFormat === "jimeng" && (
        <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
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
                    {...numberProps(field)}
                  />
                </FormControl>
                <p className="text-xs text-muted-foreground">
                  每次生成 N 张、按张计费；创作页选择为「次数」（总张数 = 次数 × N），N &gt; 4
                  自动拆分请求（单次上游上限 4 张）
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      )}

      {/* Grsai：清晰度档位 */}
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
                        {field.value ? field.value : "自动（按预设尺寸推导）"}
                      </SelectValue>
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__auto">自动（按预设尺寸推导）</SelectItem>
                    <SelectItem value="1K">1K</SelectItem>
                    <SelectItem value="2K">2K</SelectItem>
                    <SelectItem value="4K">4K</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  自动档按所选尺寸预设总像素推导（≤160 万像素 → 1K、≤600 万 → 2K、更大 → 4K）；比例自动取自下方启用的预设
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      )}

      {/* 尺寸预设（全格式；可增删，图标样式可选） */}
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
                {...(ratioOnly
                  ? { ratioOnlyHint: "该格式按比例生图，宽高仅用于比例换算与展示" }
                  : {})}
              />
            </FormControl>
            {sizePresetError ? (
              <p className="text-sm text-destructive">{sizePresetError}</p>
            ) : null}
            <FormMessage />
          </FormItem>
        )}
      />

      {/* ── 参考图 ── */}
      <SectionHeading>参考图</SectionHeading>
      <div className="space-y-3 rounded-md border p-3">
        <FormField
          control={form.control}
          name="supportsReferenceImage"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between">
              <FormLabel>支持参考图</FormLabel>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )}
        />
        {supportsReferenceImage ? (
          <>
            <div className="grid grid-cols-2 gap-3">
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
                        {...numberProps(field)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/* 字段名仅即梦可配：其余格式参考图字段固定（openai→edits multipart
                  image、chat→image_url 消息、gemini→inlineData、grsai→images、
                  midjourney→提示词开头 URL），避免填了自定义名被静默忽略 */}
              {apiFormat === "jimeng" && (
                <FormField
                  control={form.control}
                  name="referenceImageField"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>参考图 API 字段名</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="留空默认 filePaths"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {apiFormat === "openai" && "参考图走官方 edits 接口（服务端下载后 multipart 上传，字段名固定 image）"}
              {apiFormat === "chat" && "参考图以 image_url 多模态消息发送（vision 形状）"}
              {apiFormat === "gemini" && "参考图自动取图转 base64（inlineData）"}
              {apiFormat === "midjourney" && "参考图 URL 自动拼在提示词开头（协议约定，可多张空格分隔）"}
              {apiFormat === "grsai" && "参考图传入 images 字段（固定）"}
              {apiFormat === "jimeng" && "参考图以 URL 数组传入所配置字段，反代自行拉取"}
            </p>
          </>
        ) : null}
      </div>

      {/* ── 高级设置（默认折叠） ── */}
      <div className="rounded-md border">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          {advancedOpen ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          高级设置（并发 · 超时 · 页面可见性 · 创作页能力）
        </button>
        {advancedOpen && (
          <div className="space-y-3 border-t p-3">
            <div className="grid gap-3 sm:grid-cols-4">
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
                        {...numberProps(field)}
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
                        {...numberProps(field)}
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
                        {...numberProps(field)}
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
                        {...numberProps(field)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
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
                      即梦下为「次数」（每次 N 张）；Midjourney 下为「任务数」（每任务 4 张）
                    </span>
                  </FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
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
                      开启后创作页可选「智能」，由模型决定尺寸/比例
                    </span>
                  </FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        )}
      </div>
    </>
  )
}
