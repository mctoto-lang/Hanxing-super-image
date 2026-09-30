"use client"

/**
 * /agent/preview · 塔罗工作台 UI 预览（纯 Mock）。
 *
 * - 顶部琥珀色「预览模式」横幅 + 阶段/状态切换器，可自由走查五个阶段
 *   在「等待用户 / 处理中 / 失败」下的完整界面；
 * - 复用 TarotWorkspaceShell（与真实工作台同一组件，所见即真实 UI）；
 * - 通过 AgentWorkspaceActionsProvider 注入 mock actions：写操作静默
 *   no-op（按钮照常反馈），读操作喂 mock 数据，绝不触达后端。
 */
import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Eye, FlaskConical, Info } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { TAROT_STAGES, type TarotStageId } from "@/lib/agent/templates"
import {
  buildMockTarotWorkspace,
  mockAssetPrompts,
  mockDeckScores,
  mockDeliverables,
  mockItemDetail,
  type PreviewStage,
  type PreviewStatus,
} from "@/lib/agent/mocks/tarot-workspace"
import { TarotWorkspaceShell } from "../tarot-workspace"
import { AgentWorkspaceActionsProvider, type AgentWorkspaceActions } from "../workspace-actions"

const STATUS_OPTIONS: { key: PreviewStatus; label: string }[] = [
  { key: "waiting_human", label: "等待用户" },
  { key: "running", label: "处理中" },
  { key: "error", label: "失败" },
]

/** mock actions：读操作返回占位数据，写操作静默 resolve（操作反馈由界面层给出） */
function buildMockActions(stage: PreviewStage, data: ReturnType<typeof buildMockTarotWorkspace>): AgentWorkspaceActions {
  const ok = { ok: true } as const
  return {
    getTemplateWorkspace: async () => data,
    retryTemplateAction: async () => ok,
    appendTemplateMessage: async () => ok,
    requestBrief: async () => ok,
    saveTemplateBrief: async () => ok,
    regenerateDirections: async () => ok,
    selectTemplateDirection: async () => ok,
    confirmSampleBatch: async () => ({ ok: true, fullCount: data.items.length }),
    getTarotDeckScores: async () => mockDeckScores(stage),
    getTarotDeliverables: async () => mockDeliverables(data),
    requestAiFramePreview: async () => ({ ok: true, previewCount: 3, estimatedImages: 3 }),
    confirmAiFrameBatch: async () => ({ ok: true, estimatedImages: 78 }),
    retryAiFrameItem: async () => ok,
    updateTarotCardPlanItem: async () => ok,
    confirmTarotCardPlan: async () => ({ ok: true, count: data.items.length, sampleCount: 6 }),
    confirmItem: async () => ok,
    regenItem: async () => ok,
    getRunItemDetail: async (itemId: string) => mockItemDetail(itemId, data),
    getTarotAssetPrompts: async () => mockAssetPrompts(),
    saveTarotAsset: async () => data.assets[0] ?? {
      id: "preview-asset-new",
      runId: data.run.id,
      kind: "border",
      name: "border",
      url: "data:image/svg+xml,",
      meta: null,
      createdAt: new Date(),
    },
    confirmTarotAsset: async () => ok,
  }
}

export function AgentWorkspacePreview() {
  const router = useRouter()
  const [stage, setStage] = useState<PreviewStage>("clarify")
  const [status, setStatus] = useState<PreviewStatus>("waiting_human")

  const data = useMemo(() => buildMockTarotWorkspace(stage, status), [stage, status])
  const actions = useMemo(() => buildMockActions(stage, data), [stage, data])
  const locked = status === "running"

  const runAction = async (fn: () => Promise<unknown>, successMessage?: string) => {
    try {
      await fn()
      toast.info(successMessage ? `预览模式：${successMessage}` : "预览模式：操作已忽略")
      return true
    } catch {
      return false
    }
  }

  return (
    <div className="space-y-4 pb-8">
      {/* 预览模式横幅 */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/[0.07] px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15">
          <FlaskConical className="size-4 text-amber-600 dark:text-amber-400" />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="flex flex-wrap items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
            <Eye className="size-4" />
            UI 预览模式
            <Badge variant="secondary" className="bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-300">
              Mock 数据
            </Badge>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            所有图片与文案均为占位（内联 SVG + 占位中文），按钮操作不会真正执行，用于走查界面与交互。
          </p>
        </div>
      </div>

      {/* 阶段 × 状态切换器 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium text-muted-foreground">阶段</span>
          {TAROT_STAGES.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={stage === item.id}
              onClick={() => setStage(item.id)}
              className={cn(
                "rounded-full px-3 py-1 text-xs transition-colors",
                stage === item.id
                  ? "bg-violet-500 font-medium text-white"
                  : "border text-muted-foreground hover:border-violet-400 hover:text-foreground",
              )}
            >
              {index + 1}. {item.name}
            </button>
          ))}
        </div>
        <div className="h-5 w-px bg-border" />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium text-muted-foreground">状态</span>
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={status === option.key}
              onClick={() => setStatus(option.key)}
              className={cn(
                "rounded-full px-3 py-1 text-xs transition-colors",
                status === option.key
                  ? "bg-amber-500 font-medium text-white"
                  : "border text-muted-foreground hover:border-amber-400 hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground lg:flex">
          <Info className="size-3.5" />
          需求澄清阶段会自动弹出「向用户提问」弹窗；点卡面可看逐轮回放
        </p>
      </div>

      {/* 与真实工作台同壳渲染（key 切换强制重挂载，状态干净） */}
      <AgentWorkspaceActionsProvider key={`${stage}-${status}`} actions={actions}>
        <TarotWorkspaceShell
          data={data}
          locked={locked}
          runAction={runAction}
          onRefresh={async () => undefined}
          onBack={() => router.push("/agent")}
          stage={stage as TarotStageId}
        />
      </AgentWorkspaceActionsProvider>
    </div>
  )
}
