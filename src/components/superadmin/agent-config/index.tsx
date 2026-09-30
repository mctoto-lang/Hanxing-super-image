"use client"

/**
 * 平台 Agent 配置管理器（超管入口）：
 * PageHeader + 产品线分段 Tabs（草稿跨 Tab 保留，脏标记打点）+ 离开防护。
 * 塔罗的模板流程参数（评审团/阈值/并发等）全部暴露为表单，取代旧的
 * 保存时硬编码。
 */
import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Bot } from "lucide-react"
import { toast } from "sonner"
import { updateDirectionConfigAction } from "@/server/actions/platform-agent-config"
import { DEFAULT_TAROT_TEMPLATE_CONFIG, type DirectionConfig } from "@/lib/agent/pipelines"
import type { AgentDirection } from "@/lib/agent/graph"
import { DIRECTION_CARDS } from "@/components/agent/team"
import { cn } from "@/lib/utils"
import { DirectionConfigForm } from "./direction-config-form"
import type { ChatModelOption, ImageModelOption } from "./template-config-form"

export type { ChatModelOption, ImageModelOption }

function isDirty(draft: DirectionConfig, saved: DirectionConfig): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved)
}

export function AgentConfigManager({
  configs,
  chatModels,
  imageModels,
}: {
  configs: DirectionConfig[]
  chatModels: ChatModelOption[]
  imageModels: ImageModelOption[]
}) {
  const router = useRouter()
  const [savedConfigs, setSavedConfigs] = useState<DirectionConfig[]>(configs)
  const [drafts, setDrafts] = useState<DirectionConfig[]>(configs)
  const [activeDirection, setActiveDirection] = useState<AgentDirection>("tarot")
  const [saving, setSaving] = useState<AgentDirection | null>(null)

  const anyDirty = savedConfigs.some((saved, i) => isDirty(drafts[i]!, saved))

  // 离开防护：有未保存修改时阻止误关/刷新（Tab 内切换不丢草稿，无需拦截）
  useEffect(() => {
    if (!anyDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [anyDirty])

  const activeIndex = drafts.findIndex((d) => d.direction === activeDirection)
  const activeDraft = drafts[activeIndex]!
  const activeSaved = savedConfigs[activeIndex]!

  const patchActive = useCallback((partial: Partial<DirectionConfig>) => {
    setDrafts((prev) => prev.map((d) => (d.direction === activeDirection ? { ...d, ...partial } : d)))
  }, [activeDirection])

  const resetActive = useCallback(() => {
    setDrafts((prev) => prev.map((d) => (d.direction === activeDirection ? { ...savedConfigs.find((s) => s.direction === activeDirection)! } : d)))
  }, [activeDirection, savedConfigs])

  const save = useCallback(async (config: DirectionConfig) => {
    // 塔罗模板参数的前端预检（服务端 schema 兜底）。
    // 行不存在（全新部署）时 templateConfig 为空 → 表单已用内置默认渲染，
    // 这里同样按默认口径预检，管理员在表单勾选评审团后即可首次保存。
    if (config.direction === "tarot") {
      const template = config.templateConfig ?? DEFAULT_TAROT_TEMPLATE_CONFIG
      if (template.reviewerModelIds.length === 0) {
        toast.error("塔罗评审团至少选择 1 个支持视觉的对话模型（在「评审团模型」中勾选）")
        return
      }
    }
    setSaving(config.direction)
    try {
      const templateConfig =
        config.direction === "tarot"
          ? config.templateConfig ?? {
              ...DEFAULT_TAROT_TEMPLATE_CONFIG,
              copywriterChatModelId: config.models.copywriterChatModelId,
              reviewerModelIds: [config.models.contentReviewModelId, config.models.aestheticReviewModelId, config.models.consistencyReviewModelId]
                .filter((id): id is string => Boolean(id))
                .slice(0, 3),
              assetSizes: { ...DEFAULT_TAROT_TEMPLATE_CONFIG.assetSizes },
              reviewThresholds: { ...DEFAULT_TAROT_TEMPLATE_CONFIG.reviewThresholds },
              maxRetries: config.maxRetries,
              sampleCount: config.sampleCount,
            }
          : undefined
      await updateDirectionConfigAction({
        direction: config.direction,
        enabled: config.enabled,
        sampleEnabled: config.sampleEnabled,
        sampleCount: config.sampleCount,
        maxRetries: config.maxRetries,
        thresholds: config.thresholds,
        models: {
          ...config.models,
          copywriterThinkingLevel: config.models.copywriterThinkingLevel ?? "medium",
        },
        ...(templateConfig ? { templateConfig: { ...templateConfig, frameMode: "ai" as const } } : {}),
      })
      toast.success(`「${DIRECTION_CARDS[config.direction].countLabel}」配置已保存`)
      // 本地同步已保存快照（服务端按传入值 upsert，无需再读回）
      setSavedConfigs((prev) => prev.map((s) => (s.direction === config.direction ? config : s)))
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(null)
    }
  }, [router])

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-1">
      {/* PageHeader（对齐超管表格页 text-2xl 惯例） */}
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Bot className="size-5 text-violet-500" />
          Agent 工坊配置
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          三条产品线的模型与阈值预配置；审核类角色必须选择支持视觉的对话模型；保存后用户发起即用（用户零配置）。
        </p>
      </div>

      {/* 产品线分段 Tabs（草稿保留在各方向，脏标记打点） */}
      <div className="flex w-fit flex-wrap gap-1 rounded-lg bg-muted p-[3px]">
        {drafts.map((draft) => {
          const card = DIRECTION_CARDS[draft.direction]
          const dirty = isDirty(draft, savedConfigs.find((s) => s.direction === draft.direction)!)
          const active = draft.direction === activeDirection
          return (
            <button
              key={draft.direction}
              type="button"
              onClick={() => setActiveDirection(draft.direction)}
              className={cn(
                "relative inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{card.emoji}</span>
              {card.countLabel}
              {dirty && <span aria-hidden className="ml-0.5 size-1.5 rounded-full bg-amber-500" />}
            </button>
          )
        })}
      </div>

      <DirectionConfigForm
        key={activeDirection}
        draft={activeDraft}
        saved={activeSaved}
        chatModels={chatModels}
        imageModels={imageModels}
        saving={saving === activeDirection}
        onPatch={patchActive}
        onSave={(config) => void save(config)}
        onReset={resetActive}
      />
    </div>
  )
}
