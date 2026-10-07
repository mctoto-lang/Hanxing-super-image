"use client"

/**
 * 塔罗模板流程配置（唯一在用的流程配置；经典全流程配置已下线）：
 * 文案改写模型 / 评审团（1-3 个视觉模型）/ 卡面与资产生图模型 /
 * 评审阈值 / 生产参数。
 */
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Slider, SliderControl, SliderRange, SliderThumb, SliderTrack } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { FileText, RotateCcw, Sparkles, Users } from "lucide-react"
import {
  DEFAULT_ART_RULES,
  DEFAULT_REVIEWER_PROMPT,
  ROLE_PROMPTS,
  type TarotTemplateConfig,
  type TemplateRolePromptKey,
} from "@/lib/agent/pipelines"
import { SlotSelect } from "./slot-select"

export type ChatModelOption = { id: string; displayName: string; supportsVision: boolean; scope: string }
export type ImageModelOption = {
  id: string
  displayName: string
  costPerImage: number
  sizePresets: { label: string; width: number; height: number; enabled?: boolean }[]
  scope: string
}

/** 跟随平台生图模型的哨兵值（对应 null = 未单独设置时回退经典 models 槽位） */
export const INHERIT_SENTINEL = "__inherit__"

/**
 * 可选对话槽位「未设置」哨兵值（对应 null = 运行时回退：风格策划回退
 * 创意总监、初稿/终稿撰写回退经典文案模型）。创意总监为硬依赖（保存
 * 预检拦截），不加哨兵——否则选了哨兵也存不进去，徒增困惑。
 */
const UNSET_SENTINEL = "__unset__"

function sizeOptionsOf(modelId: string | null, imageModels: ImageModelOption[]) {
  return (imageModels.find((m) => m.id === modelId)?.sizePresets ?? [])
    .filter((s) => s.enabled !== false)
    .map((s) => ({ id: `${s.width}x${s.height}`, label: `${s.label}（${s.width}×${s.height}）` }))
}

function ThresholdSlider({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs">
        {label}及格线：<span className="tabular-nums">{value}</span>
      </Label>
      {/* Base UI Slider 复合组件：须带 Control/Track/Range/Thumb 子组件 */}
      <Slider min={40} max={95} value={[value]} onValueChange={(v) => onChange(Array.isArray(v) ? v[0]! : v)}>
        <SliderControl>
          <SliderTrack>
            <SliderRange />
          </SliderTrack>
          <SliderThumb />
        </SliderControl>
      </Slider>
    </div>
  )
}

function ParamSlider({
  label,
  suffix,
  min,
  max,
  value,
  onChange,
}: {
  label: string
  suffix: string
  min: number
  max: number
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs">
        {label}：<span className="tabular-nums">{value}</span> {suffix}
      </Label>
      <Slider min={min} max={max} value={[value]} onValueChange={(v) => onChange(Array.isArray(v) ? v[0]! : v)}>
        <SliderControl>
          <SliderTrack>
            <SliderRange />
          </SliderTrack>
          <SliderThumb />
        </SliderControl>
      </Slider>
    </div>
  )
}

/** 阶段对话模型槽位（存在 models jsonb；此前无配置入口，只能沿用旧落库值） */
export interface ChatModelSlots {
  /** 创意总监：需求澄清 / 简报整理 */
  styleChatModelId: string | null
  /** 世界观策划：内容方向生成 */
  structureChatModelId: string | null
}

/**
 * 提示词覆盖编辑器：未配置时展示内置默认（与运行时回退一致），
 * 编辑即存自定义；「恢复默认」清除自定义回到内置值（内置文案升级可继续生效）。
 */
function PromptOverrideTextarea({
  label,
  value,
  defaultValue,
  rows = 6,
  hint,
  onChange,
}: {
  label: string
  value: string | undefined
  defaultValue: string
  rows?: number
  hint?: string
  onChange: (v: string | undefined) => void
}) {
  const customized = !!value?.trim() && value.trim() !== defaultValue.trim()
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-xs">{label}</Label>
        <Badge
          variant="secondary"
          className={
            customized
              ? "bg-violet-500/15 text-violet-600 dark:text-violet-300"
              : undefined
          }
        >
          {customized ? "自定义" : "内置默认"}
        </Badge>
        {customized && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 gap-1 px-2 text-[11px]"
            onClick={() => onChange(undefined)}
          >
            <RotateCcw className="size-3" />
            恢复默认
          </Button>
        )}
      </div>
      <Textarea
        value={value ?? defaultValue}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="text-xs leading-relaxed"
      />
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function TemplateConfigForm({
  template,
  chatModels,
  imageModels,
  chatModelSlots,
  patch,
  patchModels,
}: {
  template: TarotTemplateConfig
  chatModels: ChatModelOption[]
  imageModels: ImageModelOption[]
  chatModelSlots: ChatModelSlots
  patch: (partial: Partial<TarotTemplateConfig>) => void
  patchModels: (partial: Partial<ChatModelSlots>) => void
}) {
  const visionModels = chatModels.filter((c) => c.supportsVision)
  const reviewers = template.reviewerModelIds
  const cardSizes = sizeOptionsOf(template.cardImageModelId, imageModels)
  // 阶段对话模型可选项：支持读图的优先标注（澄清首条消息可能带参考图）
  const stageChatOptions = chatModels.map((c) => ({
    id: c.id,
    label: `${c.displayName}（${c.scope}${c.supportsVision ? " · 支持读图" : ""}）`,
  }))

  const toggleReviewer = (id: string, checked: boolean) => {
    const next = checked
      ? [...reviewers, id].slice(0, 3)
      : reviewers.filter((r) => r !== id)
    patch({ reviewerModelIds: next })
  }

  const cardImageOptions = [
    { id: INHERIT_SENTINEL, label: "跟随平台生图模型" },
    ...imageModels.map((i) => ({ id: i.id, label: `${i.displayName}（${i.costPerImage} 积分/张）` })),
  ]

  return (
    <div className="space-y-4 rounded-xl border border-violet-500/25 bg-violet-500/[0.03] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-violet-500" />
        <p className="text-sm font-medium">塔罗模板流程</p>
        <Badge variant="secondary" className="bg-violet-500/15 text-violet-600 dark:text-violet-300">
          卡框：AI 融合
        </Badge>
        <span className="text-xs text-muted-foreground">
          模板五阶段（澄清→初稿→终稿→生图评审→交付）专属参数；未设置的生图模型回退平台经典槽位
        </span>
      </div>

      {/* 阶段对话模型与评审团 */}
      <div className="grid gap-3 lg:grid-cols-2">
        <SlotSelect
          label="创意总监模型（需求澄清 / 简报）"
          options={stageChatOptions}
          value={chatModelSlots.styleChatModelId ?? ""}
          onChange={(v) => patchModels({ styleChatModelId: v || null })}
        />
        <SlotSelect
          label="风格策划模型（风格规范书）"
          // 哨兵项允许清回 null（运行时回退创意总监模型，template-steps ?? 链）；
          // 此前一旦选中无法清空，只能换模型不能「不设」
          options={[
            { id: UNSET_SENTINEL, label: "未设置（回退创意总监）" },
            ...stageChatOptions,
          ]}
          value={chatModelSlots.structureChatModelId ?? UNSET_SENTINEL}
          onChange={(v) =>
            patchModels({
              structureChatModelId: v === UNSET_SENTINEL ? null : v,
            })
          }
        />
        <SlotSelect
          label="初稿/终稿撰写模型"
          // 同上：哨兵项允许清回 null（运行时回退经典 models.copywriterChatModelId）
          options={[
            { id: UNSET_SENTINEL, label: "未设置（回退经典文案模型）" },
            ...chatModels.map((c) => ({
              id: c.id,
              label: `${c.displayName}（${c.scope}）`,
            })),
          ]}
          value={template.copywriterChatModelId ?? UNSET_SENTINEL}
          onChange={(v) =>
            patch({
              copywriterChatModelId: v === UNSET_SENTINEL ? null : v,
            })
          }
        />
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="flex items-center gap-1 text-xs">
              <Users className="size-3.5" />
              评审团模型（选 1-3 个，须支持视觉）
            </Label>
            <span
              className={`text-[11px] tabular-nums ${reviewers.length === 0 ? "text-red-500" : "text-muted-foreground"}`}
            >
              已选 {reviewers.length}/3
            </span>
          </div>
          {visionModels.length === 0 ? (
            <p className="rounded-md border border-dashed p-1.5 text-[11px] text-muted-foreground">
              暂无开启多模态（图片输入）的对话模型；评审团必须至少 1 个，否则卡面生产无法开始
            </p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {visionModels.map((model) => {
                const checked = reviewers.includes(model.id)
                const disabled = !checked && reviewers.length >= 3
                return (
                  <label
                    key={model.id}
                    className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                      checked ? "border-violet-500/40 bg-violet-500/10" : disabled ? "opacity-50" : "hover:bg-muted/50"
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={disabled}
                      onCheckedChange={(v) => toggleReviewer(model.id, v === true)}
                    />
                    <span className="min-w-0 truncate">{model.displayName}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{model.scope}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* 生图模型 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <SlotSelect
          label="卡面生图模型"
          options={cardImageOptions}
          value={template.cardImageModelId ?? INHERIT_SENTINEL}
          onChange={(v) => {
            if (v === INHERIT_SENTINEL) {
              // 切回“跟随平台”：清掉针对具体模型选择的残留尺寸——模板值
              // 优先级高于平台 imageSize，残留会造成模型/尺寸错配且不可见
              patch({
                cardImageModelId: null,
                ...(template.assetSizes.card !== "" ? { assetSizes: { ...template.assetSizes, card: "" } } : {}),
              })
              return
            }
            // 以【新选中模型】的尺寸预设判断当前尺寸是否仍可用
            // （此前基于旧模型的列表判断，条件几乎恒不成立、重置永不触发）
            const nextSizes = sizeOptionsOf(v, imageModels)
            patch({
              cardImageModelId: v,
              ...(!nextSizes.some((s) => s.id === template.assetSizes.card)
                ? { assetSizes: { ...template.assetSizes, card: nextSizes[0]?.id ?? "" } }
                : {}),
            })
          }}
        />
        {cardSizes.length > 0 && (
          <SlotSelect
            label="卡面尺寸"
            options={cardSizes}
            value={template.assetSizes.card}
            onChange={(v) => patch({ assetSizes: { ...template.assetSizes, card: v } })}
          />
        )}
        <SlotSelect
          label="AI 融合模型"
          options={cardImageOptions}
          value={template.aiFrameModelId ?? INHERIT_SENTINEL}
          onChange={(v) => patch({ aiFrameModelId: v === INHERIT_SENTINEL ? null : v })}
        />
        <SlotSelect
          label="套件资产生图模型"
          hint="边框/卡背/牌盒四面由该模型自动生成，生图比例延用上方卡面尺寸"
          options={cardImageOptions}
          value={template.assetImageModelId ?? INHERIT_SENTINEL}
          onChange={(v) => patch({ assetImageModelId: v === INHERIT_SENTINEL ? null : v })}
        />
      </div>

      {/* 阈值与参数 */}
      <div className="grid gap-5 rounded-lg border bg-card p-3.5 sm:grid-cols-3">
        <ThresholdSlider
          label="内容对齐"
          value={template.reviewThresholds.content}
          onChange={(v) => patch({ reviewThresholds: { ...template.reviewThresholds, content: v } })}
        />
        <ThresholdSlider
          label="审美"
          value={template.reviewThresholds.aesthetic}
          onChange={(v) => patch({ reviewThresholds: { ...template.reviewThresholds, aesthetic: v } })}
        />
        <ThresholdSlider
          label="成套一致性"
          value={template.reviewThresholds.consistency}
          onChange={(v) => patch({ reviewThresholds: { ...template.reviewThresholds, consistency: v } })}
        />
      </div>
      <div className="grid gap-5 rounded-lg border bg-card p-3.5 sm:grid-cols-3">
        <ParamSlider
          label="打回上限"
          suffix="轮"
          min={0}
          max={3}
          value={template.maxRetries}
          onChange={(v) => patch({ maxRetries: v })}
        />
        <ParamSlider
          label="小样张数"
          suffix="张"
          min={1}
          max={12}
          value={template.sampleCount}
          onChange={(v) => patch({ sampleCount: v })}
        />
        <ParamSlider
          label="澄清追问上限"
          suffix="轮"
          min={1}
          max={8}
          value={template.clarifyMaxRounds}
          onChange={(v) => patch({ clarifyMaxRounds: v })}
        />
      </div>

      {/* 角色提示词与画面规则（空 = 内置默认；生效于初稿/终稿撰写、打回重细化与评审团） */}
      <div className="grid gap-4 rounded-lg border bg-card p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <FileText className="size-3.5 text-violet-500" />
          <p className="text-xs font-medium">角色提示词与画面规则</p>
          <span className="text-[11px] text-muted-foreground">
            留空即用内置默认；改动后新项目的初稿/终稿撰写与评审立即按新文案执行
          </span>
        </div>
        <PromptOverrideTextarea
          label="画面规则（整套卡面的硬性创作要求）"
          value={template.artRules}
          defaultValue={DEFAULT_ART_RULES}
          rows={8}
          hint="随角色提示词一并注入「初稿设计师 / 终稿细化师」：约束每张卡的主体占比、构图、风格统一与视觉冲击力，保证生图效果。"
          onChange={(v) => patch({ artRules: v?.trim() ? v : undefined })}
        />
        <div className="grid gap-4 lg:grid-cols-3">
          <PromptOverrideTextarea
            label="初稿设计师（初稿设计阶段）"
            value={template.rolePrompts?.prompt_designer}
            defaultValue={ROLE_PROMPTS.copywriter}
            rows={7}
            hint="逐张撰写 78 张简洁画面初稿（40-80 字）；用户可在初稿页查看与修改。"
            onChange={(v) => patchRolePrompt(template, patch, "prompt_designer", v)}
          />
          <PromptOverrideTextarea
            label="终稿细化师（终稿细化阶段 + 打回重细化）"
            value={template.rolePrompts?.final_refiner}
            defaultValue={ROLE_PROMPTS.finalRefiner}
            rows={7}
            hint="把初稿细化为「[1]画面风格 + [2]画面内容」结构终稿；评审打回时以初稿为基准重新细化。"
            onChange={(v) => patchRolePrompt(template, patch, "final_refiner", v)}
          />
          <PromptOverrideTextarea
            label="评审团（内容对齐 / 审美 / 一致性三维同审）"
            value={template.rolePrompts?.reviewer}
            defaultValue={DEFAULT_REVIEWER_PROMPT}
            rows={7}
            hint="每个评审模型对候选卡面三维打分；Ace-10 花色数量不符、主体占比过低、风格跳出成套体系的画面应被打回。"
            onChange={(v) => patchRolePrompt(template, patch, "reviewer", v)}
          />
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        生产并发不再在此配置：实际并发自动跟随全局用户并发限制（企业并发上限与权限组并发上限的较小值，随后台调整实时生效）。
      </p>
    </div>
  )
}

/** 更新单个角色提示词覆盖（空值剔除该键 = 回退内置默认） */
function patchRolePrompt(
  template: TarotTemplateConfig,
  patch: (partial: Partial<TarotTemplateConfig>) => void,
  key: TemplateRolePromptKey,
  value: string | undefined,
): void {
  const next: Partial<Record<TemplateRolePromptKey, string>> = { ...template.rolePrompts }
  if (value?.trim()) next[key] = value
  else delete next[key]
  patch({ rolePrompts: next })
}
