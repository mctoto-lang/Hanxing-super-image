"use client"

/**
 * 塔罗模板流程配置（唯一在用的流程配置；经典全流程配置已下线）：
 * 文案改写模型 / 评审团（1-3 个视觉模型）/ 卡面与资产生图模型 /
 * 评审阈值 / 生产参数。
 */
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Sparkles, Users } from "lucide-react"
import type { TarotTemplateConfig } from "@/lib/agent/pipelines"
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
      <Slider min={40} max={95} value={[value]} onValueChange={(v) => onChange(Array.isArray(v) ? v[0]! : v)} />
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
      <Slider min={min} max={max} value={[value]} onValueChange={(v) => onChange(Array.isArray(v) ? v[0]! : v)} />
    </div>
  )
}

export function TemplateConfigForm({
  template,
  chatModels,
  imageModels,
  patch,
}: {
  template: TarotTemplateConfig
  chatModels: ChatModelOption[]
  imageModels: ImageModelOption[]
  patch: (partial: Partial<TarotTemplateConfig>) => void
}) {
  const visionModels = chatModels.filter((c) => c.supportsVision)
  const reviewers = template.reviewerModelIds
  const cardSizes = sizeOptionsOf(template.cardImageModelId, imageModels)

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
          模板五阶段（澄清→方向→清单→生产→交付）专属参数；未设置的生图模型回退平台经典槽位
        </span>
      </div>

      {/* 文案与评审团 */}
      <div className="grid gap-3 lg:grid-cols-2">
        <SlotSelect
          label="文案改写模型"
          options={chatModels.map((c) => ({ id: c.id, label: `${c.displayName}（${c.scope}）` }))}
          value={template.copywriterChatModelId ?? ""}
          onChange={(v) => patch({ copywriterChatModelId: v || null })}
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
      <div className="grid gap-5 rounded-lg border bg-card p-3.5 sm:grid-cols-2 lg:grid-cols-4">
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
          label="生产并发"
          suffix="路"
          min={1}
          max={4}
          value={template.concurrency}
          onChange={(v) => patch({ concurrency: v })}
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
    </div>
  )
}
