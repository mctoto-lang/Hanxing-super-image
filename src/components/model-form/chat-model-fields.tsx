"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ModelIconUpload } from "@/components/model-form/model-icon-upload"
import { BadgeField } from "@/components/model-form/badge-field"
import { CHAT_FORMAT_ENDPOINT_EXAMPLES, formatPricePerMillion } from "@/lib/ai/chat/chat-model-config"

/**
 * 对话模型表单字段（超管平台预置 / 企业私有 共用）
 *
 * 接口格式四选：openai / claude / gemini / grok（端点提示随格式切换）；
 * temperature / maxTokens 留空 = 使用默认值（工作台内部 AI 用）；
 * 最大上下文 / 单次最大输出 / 百万 token 厘级价格 / 思考强度为
 * /chat 交互对话专用配置。价格界面输入「积分」（两位小数），存厘（×100 整数）。
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
  maxConcurrent: number
  maxRetries: number
  apiTimeout: number
  taskTimeout: number
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
  extraConfig: { temperature?: number; maxTokens?: number } | null
  maxContextTokens?: number | null
  maxOutputTokens?: number | null
  inputPriceCenticredits?: number | null
  outputPriceCenticredits?: number | null
  supportsThinking?: boolean | null
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
        : "",    supportsThinking: m.supportsThinking ?? false,
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
    maxConcurrent: state.maxConcurrent,
    maxRetries: state.maxRetries,
    apiTimeout: state.apiTimeout,
    taskTimeout: state.taskTimeout,
    ...(state.apiKey ? { apiKey: state.apiKey } : {}),
  }
}

export function ChatModelFields({
  state,
  up,
  isEdit,
}: {
  state: ChatModelFormState
  up: <K extends keyof ChatModelFormState>(
    key: K,
    val: ChatModelFormState[K],
  ) => void
  isEdit: boolean
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="cm-name">模型标识</Label>
          <Input
            id="cm-name"
            value={state.name}
            onChange={(e) => up("name", e.target.value)}
            placeholder="如 gpt-4o、claude-sonnet-4、gemini-2.5-flash"
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cm-displayName">显示名</Label>
          <Input
            id="cm-displayName"
            value={state.displayName}
            onChange={(e) => up("displayName", e.target.value)}
            placeholder="如 GPT-4o"
            required
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="cm-description">模型描述（可选）</Label>
        <Textarea
          id="cm-description"
          rows={2}
          value={state.description}
          onChange={(e) => up("description", e.target.value)}
          placeholder="展示在对话模型选择处，如：综合能力强，适合日常问答"
          maxLength={300}
        />
      </div>

      <BadgeField
        text={state.badgeText}
        color={state.badgeColor}
        onTextChange={(v) => up("badgeText", v)}
        onColorChange={(v) => up("badgeColor", v)}
      />

      {/* 接口格式 + API 地址 */}
      <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
        <div className="grid gap-2">
          <Label>接口格式</Label>
          <Select
            value={state.formatType}
            onValueChange={(v) => up("formatType", v ?? "openai")}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CHAT_FORMAT_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cm-apiEndpoint">API 地址</Label>
          <Input
            id="cm-apiEndpoint"
            value={state.apiEndpoint}
            onChange={(e) => up("apiEndpoint", e.target.value)}
            placeholder={CHAT_FORMAT_ENDPOINT_EXAMPLES[state.formatType as "openai"] ?? "https://api.example.com/v1"}
            required
          />
          <p className="text-xs text-muted-foreground">
            {FORMAT_ENDPOINT_HINTS[state.formatType] ?? FORMAT_ENDPOINT_HINTS.openai}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label>模型图标</Label>
          <ModelIconUpload
            value={state.iconUrl || null}
            onChange={(url) => up("iconUrl", url ?? "")}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cm-apiKey">API Key</Label>
          <Input
            id="cm-apiKey"
            type="password"
            value={state.apiKey}
            onChange={(e) => up("apiKey", e.target.value)}
            placeholder={isEdit ? "留空则不修改" : "请输入 API Key"}
            required={!isEdit}
          />
        </div>
      </div>

      {/* 能力与计费（/chat 交互对话专用） */}
      <div className="grid gap-4 rounded-md border p-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="cm-maxContextTokens">最大上下文（tokens）</Label>
          <Input
            id="cm-maxContextTokens"
            type="number"
            min={1024}
            max={2000000}
            step={1024}
            value={state.maxContextTokens}
            onChange={(e) => up("maxContextTokens", e.target.value)}
            placeholder="32768"
          />
          <p className="text-xs text-muted-foreground">上下文进度环分母，超限自动省略早期消息</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cm-maxOutputTokens">单次最大输出（tokens）</Label>
          <Input
            id="cm-maxOutputTokens"
            type="number"
            min={256}
            max={200000}
            step={256}
            value={state.maxOutputTokens}
            onChange={(e) => up("maxOutputTokens", e.target.value)}
            placeholder="4096"
          />
          <p className="text-xs text-muted-foreground">单条回复的 max_tokens 上限</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cm-inputPrice">百万输入 token 价格（积分）</Label>
          <Input
            id="cm-inputPrice"
            type="number"
            min={0}
            step={0.01}
            value={state.inputPrice}
            onChange={(e) => up("inputPrice", e.target.value)}
            placeholder="0（免费）"
          />
          <p className="text-xs text-muted-foreground">
            精确到 0.01 积分；留空或 0 = 免费
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cm-outputPrice">百万输出 token 价格（积分）</Label>
          <Input
            id="cm-outputPrice"
            type="number"
            min={0}
            step={0.01}
            value={state.outputPrice}
            onChange={(e) => up("outputPrice", e.target.value)}
            placeholder="0（免费）"
          />
        </div>
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          <div>
            <Label htmlFor="cm-supportsThinking">支持思考强度</Label>
            <p className="text-xs text-muted-foreground">
              开启后用户可选择 关闭/低/中/高 四档思考强度
            </p>
          </div>
          <Switch
            id="cm-supportsThinking"
            checked={state.supportsThinking}
            onCheckedChange={(v) => up("supportsThinking", v)}
          />
        </div>
      </div>

      {/* 生成参数（留空 = 默认；工作台内部 AI 消费） */}
      <div className="grid gap-4 rounded-md border p-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="cm-temperature">Temperature（0-2，留空 = 0.8）</Label>
          <Input
            id="cm-temperature"
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={state.temperature}
            onChange={(e) => up("temperature", e.target.value)}
            placeholder="0.8"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cm-maxTokens">Max Tokens（留空 = 不限制）</Label>
          <Input
            id="cm-maxTokens"
            type="number"
            min={0}
            value={state.maxTokens}
            onChange={(e) => up("maxTokens", e.target.value)}
            placeholder="不限制"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="grid gap-2">
          <Label htmlFor="cm-maxConcurrent">最大并发</Label>
          <Input
            id="cm-maxConcurrent"
            type="number"
            min={1}
            value={state.maxConcurrent}
            onChange={(e) => up("maxConcurrent", Number(e.target.value))}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cm-maxRetries">最大重试</Label>
          <Input
            id="cm-maxRetries"
            type="number"
            min={0}
            value={state.maxRetries}
            onChange={(e) => up("maxRetries", Number(e.target.value))}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cm-apiTimeout">请求超时(秒)</Label>
          <Input
            id="cm-apiTimeout"
            type="number"
            min={1}
            value={state.apiTimeout}
            onChange={(e) => up("apiTimeout", Number(e.target.value))}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cm-taskTimeout">任务总超时(秒)</Label>
          <Input
            id="cm-taskTimeout"
            type="number"
            min={0}
            value={state.taskTimeout}
            onChange={(e) => up("taskTimeout", Number(e.target.value))}
          />
        </div>
      </div>
    </>
  )
}
