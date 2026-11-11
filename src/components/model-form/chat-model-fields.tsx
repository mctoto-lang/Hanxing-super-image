"use client"

import * as React from "react"
import { z } from "zod"
import { useForm, type UseFormReturn } from "react-hook-form"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
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
import { ModelIconUpload } from "@/components/model-form/model-icon-upload"
import { BadgeField } from "@/components/model-form/badge-field"
import {
  CHAT_ACTIVE_THINKING_LEVELS,
  CHAT_FORMAT_ENDPOINT_EXAMPLES,
  CLAUDE_THINKING_BUDGETS,
  GEMINI_THINKING_BUDGETS,
  OPENAI_REASONING_EFFORTS,
  formatPricePerMillion,
  type ActiveThinkingLevel,
} from "@/lib/ai/chat/chat-model-config"
import { THINKING_LEVEL_LABELS } from "@/components/chat/types"

/**
 * 对话模型表单字段（超管平台预置 / 企业私有 共用，RHF 统一设计语言）。
 *
 * 接口格式四选：openai / claude / gemini / grok（端点提示随格式切换）；
 * temperature / maxTokens 留空 = 使用默认值（工作台内部 AI 用）；
 * 最大上下文 / 单次最大输出 / 百万 token 厘级价格 / 思考强度为
 * /chat 交互对话专用配置。价格界面输入「积分」（两位小数），存厘（×100 整数）。
 *
 * 用法：弹窗内 `const form = useChatModelForm()` →
 * `<Form {...form}><form onSubmit={form.handleSubmit(...)}>`；
 * 编辑回填 defaultValues 用 chatModelFormFromRow，提交组装用 buildChatModelInput。
 */

export const CHAT_FORMAT_LABELS: Record<string, string> = {
  openai: "OpenAI 兼容",
  claude: "Claude（Anthropic）",
  gemini: "Gemini（Google）",
  grok: "Grok（xAI）",
}

const FORMAT_ENDPOINT_HINTS: Record<string, string> = {
  openai: "自动拼接 /v1/chat/completions；已含 /v1 或完整路径时按原样调用",
  claude: "自动拼接 /v1/messages；需 x-api-key + anthropic-version（适配器处理）",
  gemini: "自动拼接 /v1beta/models/{模型}:streamGenerateContent",
  grok: "OpenAI 兼容，默认 https://api.x.ai/v1，自动拼接 /chat/completions",
}

const OVERRIDE_HINTS: Record<string, string> = {
  openai: "填 reasoning_effort（如 low / medium / high，网关自定义值如 xhigh 也可）",
  claude: "填 thinking.budget_tokens（须小于单次最大输出 tokens）",
  gemini: "填 thinkingBudget（tokens 数，-1 = 动态思考）",
  grok: "填 reasoning_effort（如 low / medium / high，网关自定义值如 xhigh 也可）",
}

/** 思考档位覆盖的表单态（输入框字符串，留空 = 内置默认） */
export interface ThinkingOverrideFormValue {
  effort: string
  budgetTokens: string
}

export type ThinkingOverridesFormState = Record<
  ActiveThinkingLevel,
  ThinkingOverrideFormValue
>

function emptyThinkingOverrides(): ThinkingOverridesFormState {
  return CHAT_ACTIVE_THINKING_LEVELS.reduce(
    (acc, level) => {
      acc[level] = { effort: "", budgetTokens: "" }
      return acc
    },
    {} as ThinkingOverridesFormState,
  )
}

export interface ChatModelFormState {
  name: string
  displayName: string
  description: string
  badgeText: string
  badgeColor: string
  apiEndpoint: string
  apiKey: string
  formatType: string
  iconUrl: string
  temperature: string
  maxTokens: string
  maxContextTokens: string
  maxOutputTokens: string
  inputPrice: string // 积分/百万（两位小数字符串），提交转厘
  outputPrice: string
  supportsThinking: boolean
  supportsVision: boolean
  thinkingOverrides: ThinkingOverridesFormState
  maxConcurrent: number
  maxRetries: number
  apiTimeout: number
  taskTimeout: number
}

/** 数值字符串的区间校验（空值跳过，交由提交组装兜底） */
function numStringRange(
  label: string,
  min: number,
  max: number,
): (v: string) => true | string {
  return (v: string) => {
    if (v.trim() === "") return true
    const n = Number(v)
    return Number.isFinite(n) && n >= min && n <= max ? true : `${label}须在 ${min} - ${max} 之间`
  }
}

/** 客户端 zod 镜像（服务端 chatModelConfigSchema 仍是权威；apiKey 必填性由弹窗按 isEdit setError） */
const chatModelFormSchema = z.object({
  name: z.string().min(1, "请输入模型标识").max(100, "模型标识最多 100 字符"),
  displayName: z.string().min(1, "请输入显示名").max(200, "显示名最多 200 字符"),
  description: z.string().max(300, "描述最多 300 字"),
  badgeText: z.string().max(30, "勋章文字最多 30 字"),
  badgeColor: z.string().max(30),
  apiEndpoint: z.string().min(1, "请输入 API 地址").max(500, "API 地址最多 500 字符"),
  apiKey: z.string(),
  formatType: z.string(),
  iconUrl: z.string().max(500, "图标地址最多 500 字符"),
  temperature: z.string().refine(numStringRange("Temperature", 0, 2)),
  maxTokens: z.string().refine(numStringRange("Max Tokens", 0, 1_000_000)),
  maxContextTokens: z
    .string()
    .refine((v) => v.trim() !== "", "请输入最大上下文")
    .refine(numStringRange("最大上下文", 1024, 2_000_000)),
  maxOutputTokens: z
    .string()
    .refine((v) => v.trim() !== "", "请输入单次最大输出")
    .refine(numStringRange("单次最大输出", 256, 1_000_000)),
  inputPrice: z.string().refine(numStringRange("输入价格", 0, 10_000)),
  outputPrice: z.string().refine(numStringRange("输出价格", 0, 10_000)),
  supportsThinking: z.boolean(),
  supportsVision: z.boolean(),
  // 思考档位覆盖为可选高级字段，客户端不做逐项校验（服务端 re-validate）；
  // 用 z.custom 保持精确的 Record 类型（z.record 会退化为 Record<string, any>）
  thinkingOverrides: z.custom<ThinkingOverridesFormState>(
    (v) => typeof v === "object" && v !== null,
  ),
  maxConcurrent: z
    .number({ message: "请输入最大并发" })
    .int("最大并发必须为整数")
    .min(1, "最大并发至少 1")
    .max(9999, "最大并发不能超过 9999"),
  maxRetries: z
    .number({ message: "请输入最大重试" })
    .int()
    .min(0, "最大重试不能为负"),
  apiTimeout: z.number({ message: "请输入请求超时" }).int().min(1, "请求超时至少 1 秒"),
  taskTimeout: z.number({ message: "请输入任务总超时" }).int().min(0, "任务总超时不能为负"),
})

/** 对话模型表单 hook（统一设计语言入口） */
export function useChatModelForm(): UseFormReturn<ChatModelFormState> {
  return useForm<ChatModelFormState>({
    resolver: standardSchemaResolver(chatModelFormSchema),
    defaultValues: emptyChatModelState(),
  })
}

export function emptyChatModelState(): ChatModelFormState {
  return {
    name: "",
    displayName: "",
    description: "",
    badgeText: "",
    badgeColor: "",
    apiEndpoint: "",
    apiKey: "",
    formatType: "openai",
    iconUrl: "",
    temperature: "",
    maxTokens: "",
    maxContextTokens: "32768",
    maxOutputTokens: "4096",
    inputPrice: "",
    outputPrice: "",
    supportsThinking: false,
    supportsVision: false,
    thinkingOverrides: emptyThinkingOverrides(),
    maxConcurrent: 5,
    maxRetries: 3,
    apiTimeout: 120,
    taskTimeout: 300,
  }
}

export function chatModelFormFromRow(m: {
  name: string
  displayName: string
  description: string | null
  badgeText: string | null
  badgeColor: string | null
  iconUrl: string | null
  apiEndpoint: string
  formatType?: string | null
  extraConfig:
    | ({
        temperature?: number
        maxTokens?: number
        thinkingOverrides?: NonNullable<
          import("@/lib/ai/chat/chat-model-config").ChatThinkingOverrides
        >
      })
    | null
  maxContextTokens?: number | null
  maxOutputTokens?: number | null
  inputPriceCenticredits?: number | null
  outputPriceCenticredits?: number | null
  supportsThinking?: boolean | null
  supportsVision?: boolean | null
  maxConcurrent: number
  maxRetries: number
  apiTimeout: number
  taskTimeout: number
}): ChatModelFormState {
  return {
    ...emptyChatModelState(),
    name: m.name,
    displayName: m.displayName,
    description: m.description ?? "",
    badgeText: m.badgeText ?? "",
    badgeColor: m.badgeColor ?? "",
    apiEndpoint: m.apiEndpoint,
    apiKey: "", // 编辑时留空 = 不修改
    formatType: m.formatType ?? "openai",
    iconUrl: m.iconUrl ?? "",
    temperature:
      m.extraConfig?.temperature !== undefined
        ? String(m.extraConfig.temperature)
        : "",
    maxTokens:
      m.extraConfig?.maxTokens !== undefined
        ? String(m.extraConfig.maxTokens)
        : "",
    maxContextTokens: m.maxContextTokens ? String(m.maxContextTokens) : "32768",
    maxOutputTokens: m.maxOutputTokens ? String(m.maxOutputTokens) : "4096",
    inputPrice:
      m.inputPriceCenticredits != null && m.inputPriceCenticredits > 0
        ? formatPricePerMillion(m.inputPriceCenticredits)
        : "",
    outputPrice:
      m.outputPriceCenticredits != null && m.outputPriceCenticredits > 0
        ? formatPricePerMillion(m.outputPriceCenticredits)
        : "",
    supportsThinking: m.supportsThinking ?? false,
    supportsVision: m.supportsVision ?? false,
    thinkingOverrides: (() => {
      const overrides = emptyThinkingOverrides()
      const stored = m.extraConfig?.thinkingOverrides
      if (stored) {
        for (const level of CHAT_ACTIVE_THINKING_LEVELS) {
          const o = stored[level]
          if (!o) continue
          overrides[level] = {
            effort: o.effort ?? "",
            budgetTokens:
              o.budgetTokens !== undefined ? String(o.budgetTokens) : "",
          }
        }
      }
      return overrides
    })(),
    maxConcurrent: m.maxConcurrent,
    maxRetries: m.maxRetries,
    apiTimeout: m.apiTimeout,
    taskTimeout: m.taskTimeout,
  }
}

/** 积分（两位小数字符串）→ 厘（整数）；空/非法 → 0（免费） */
function priceToCenticredits(value: string): number {
  const trimmed = value.trim()
  if (!trimmed) return 0
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.max(0, Math.round(n * 100))
}

/** 组装提交给 server action 的扁平字段 */
export function buildChatModelInput(
  state: ChatModelFormState,
): Record<string, unknown> {
  const temperature = Number(state.temperature)
  const maxTokens = Number(state.maxTokens)
  const maxContextTokens = Number(state.maxContextTokens)
  const maxOutputTokens = Number(state.maxOutputTokens)
  const thinkingOverrides: Record<
    string,
    { effort?: string; budgetTokens?: number }
  > = {}
  for (const level of CHAT_ACTIVE_THINKING_LEVELS) {
    const form = state.thinkingOverrides[level]
    if (!form) continue
    const entry: { effort?: string; budgetTokens?: number } = {}
    if (form.effort.trim()) entry.effort = form.effort.trim()
    const budget = Number(form.budgetTokens)
    if (form.budgetTokens.trim() !== "" && Number.isFinite(budget)) {
      entry.budgetTokens = Math.floor(budget)
    }
    if (entry.effort !== undefined || entry.budgetTokens !== undefined) {
      thinkingOverrides[level] = entry
    }
  }
  return {
    name: state.name,
    displayName: state.displayName,
    apiEndpoint: state.apiEndpoint,
    formatType: state.formatType,
    description: state.description || undefined,
    badgeText: state.badgeText || undefined,
    badgeColor: state.badgeColor || undefined,
    iconUrl: state.iconUrl || undefined,
    temperature:
      state.temperature.trim() !== "" && Number.isFinite(temperature)
        ? temperature
        : undefined,
    maxTokens:
      state.maxTokens.trim() !== "" && Number.isFinite(maxTokens) && maxTokens > 0
        ? Math.floor(maxTokens)
        : undefined,
    maxContextTokens:
      Number.isFinite(maxContextTokens) && maxContextTokens >= 1024
        ? Math.floor(maxContextTokens)
        : 32768,
    maxOutputTokens:
      Number.isFinite(maxOutputTokens) && maxOutputTokens >= 256
        ? Math.floor(maxOutputTokens)
        : 4096,
    inputPriceCenticredits: priceToCenticredits(state.inputPrice),
    outputPriceCenticredits: priceToCenticredits(state.outputPrice),
    supportsThinking: state.supportsThinking,
    supportsVision: state.supportsVision,
    ...(Object.keys(thinkingOverrides).length > 0 ? { thinkingOverrides } : {}),
    maxConcurrent: state.maxConcurrent,
    maxRetries: state.maxRetries,
    apiTimeout: state.apiTimeout,
    taskTimeout: state.taskTimeout,
    ...(state.apiKey ? { apiKey: state.apiKey } : {}),
  }
}

export function ChatModelFields({
  form,
  isEdit,
}: {
  form: UseFormReturn<ChatModelFormState>
  isEdit: boolean
}) {
  const formatType = form.watch("formatType")
  const supportsThinking = form.watch("supportsThinking")
  const badgeColor = form.watch("badgeColor")
  const overrides = form.watch("thinkingOverrides")

  const upOverride = (
    level: ActiveThinkingLevel,
    field: "effort" | "budgetTokens",
    val: string,
  ) => {
    form.setValue("thinkingOverrides", {
      ...overrides,
      [level]: { ...overrides[level], [field]: val },
    })
  }

  const intField = (field: {
    onChange: (v: number) => void
    value: number
  }) => ({
    ...field,
    value: field.value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      field.onChange(
        e.target.value === "" ? ("" as unknown as number) : Number(e.target.value),
      ),
  })

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>模型标识</FormLabel>
              <FormControl>
                <Input {...field} placeholder="如 gpt-4o、claude-sonnet-4、gemini-2.5-flash" />
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
                <Input {...field} placeholder="如 GPT-4o" />
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
                placeholder="展示在对话模型选择处，如：综合能力强，适合日常问答"
                maxLength={300}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="badgeText"
        render={({ field }) => (
          <FormItem>
            <BadgeField
              text={field.value}
              color={badgeColor}
              onTextChange={field.onChange}
              onColorChange={(v) => form.setValue("badgeColor", v)}
            />
            <FormMessage />
          </FormItem>
        )}
      />

      {/* 接口格式 + API 地址 */}
      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="formatType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>接口格式</FormLabel>
              <Select
                value={field.value}
                onValueChange={(v) => field.onChange(v ?? "openai")}
                items={Object.entries(CHAT_FORMAT_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {CHAT_FORMAT_LABELS[field.value] ?? field.value}
                    </SelectValue>
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {Object.entries(CHAT_FORMAT_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                <Input
                  {...field}
                  placeholder={
                    CHAT_FORMAT_ENDPOINT_EXAMPLES[
                      formatType as "openai"
                    ] ?? "https://api.example.com/v1"
                  }
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                {FORMAT_ENDPOINT_HINTS[formatType] ?? FORMAT_ENDPOINT_HINTS.openai}
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

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

      {/* 能力与计费（/chat 交互对话专用） */}
      <div className="grid gap-4 rounded-md border p-3 grid-cols-1 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="maxContextTokens"
          render={({ field }) => (
            <FormItem>
              <FormLabel>最大上下文（tokens）</FormLabel>
              <FormControl>
                <Input type="number" min={1024} max={2000000} {...field} placeholder="32768" />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                上下文进度环分母，超限自动省略早期消息
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="maxOutputTokens"
          render={({ field }) => (
            <FormItem>
              <FormLabel>单次最大输出（tokens）</FormLabel>
              <FormControl>
                <Input type="number" min={256} max={1000000} {...field} placeholder="4096" />
              </FormControl>
              <p className="text-xs text-muted-foreground">单条回复的 max_tokens 上限</p>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="inputPrice"
          render={({ field }) => (
            <FormItem>
              <FormLabel>百万输入 token 价格（积分）</FormLabel>
              <FormControl>
                <Input type="number" min={0} step={0.01} {...field} placeholder="0（免费）" />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                精确到 0.01 积分；留空或 0 = 免费
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="outputPrice"
          render={({ field }) => (
            <FormItem>
              <FormLabel>百万输出 token 价格（积分）</FormLabel>
              <FormControl>
                <Input type="number" min={0} step={0.01} {...field} placeholder="0（免费）" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="supportsThinking"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <FormLabel>支持思考强度</FormLabel>
                  <p className="text-xs text-muted-foreground">
                    开启后用户可滑动选择 关闭 / 低 / 中 / 高 / 加强 / 最大 / 极限 思考强度
                  </p>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </div>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="supportsVision"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <FormLabel>支持多模态（图片输入）</FormLabel>
                  <p className="text-xs text-muted-foreground">
                    开启后用户可在对话输入框点击 @ 上传图片（需模型本身支持图片理解）
                  </p>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </div>
            </FormItem>
          )}
        />

        {/* 思考档位参数覆盖（管理员自定义高档位参数，先测试再投产） */}
        {supportsThinking ? (
          <div className="grid gap-3 border-t pt-3 sm:col-span-2">
            <div>
              <FormLabel>思考档位参数覆盖（可选）</FormLabel>
              <p className="text-xs text-muted-foreground">
                {OVERRIDE_HINTS[formatType] ?? OVERRIDE_HINTS.openai}
                ；留空档位使用内置默认值。建议覆盖后先在对话页测试再投入生产。
              </p>
            </div>
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
              {CHAT_ACTIVE_THINKING_LEVELS.map((level) => {
                const row = overrides[level]
                const isTokenFormat = formatType === "claude" || formatType === "gemini"
                const id = `cm-thinking-${level}`
                return (
                  <div key={level} className="grid gap-1.5">
                    <FormLabel htmlFor={id} className="text-xs">
                      {THINKING_LEVEL_LABELS[level]}
                    </FormLabel>
                    {isTokenFormat ? (
                      <Input
                        id={id}
                        type="number"
                        min={-1}
                        value={row?.budgetTokens ?? ""}
                        onChange={(e) =>
                          upOverride(level, "budgetTokens", e.target.value)
                        }
                        placeholder={String(
                          formatType === "gemini"
                            ? GEMINI_THINKING_BUDGETS[level]
                            : CLAUDE_THINKING_BUDGETS[level],
                        )}
                      />
                    ) : (
                      <Input
                        id={id}
                        value={row?.effort ?? ""}
                        onChange={(e) => upOverride(level, "effort", e.target.value)}
                        placeholder={OPENAI_REASONING_EFFORTS[level]}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>

      {/* 生成参数（留空 = 默认；工作台内部 AI 消费） */}
      <div className="grid gap-4 rounded-md border p-3 grid-cols-1 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="temperature"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Temperature（0-2，留空 = 0.8）</FormLabel>
              <FormControl>
                <Input type="number" min={0} max={2} step={0.1} {...field} placeholder="0.8" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="maxTokens"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Max Tokens（留空 = 不限制）</FormLabel>
              <FormControl>
                <Input type="number" min={0} {...field} placeholder="不限制" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
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
                  {...intField(field)}
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
                <Input type="number" min={0} {...intField(field)} />
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
                <Input type="number" min={1} {...intField(field)} />
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
                <Input type="number" min={0} {...intField(field)} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </>
  )
}
