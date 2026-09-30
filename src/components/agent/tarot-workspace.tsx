"use client"

/**
 * 塔罗模板工作台（/agent/run/[id]，template = tarot）
 *
 * - 头部：返回 / 标题 / 状态徽章（AI 团队处理中 / 等待你的操作）；
 * - 常驻顶部：4 张信息卡（文本 / 图片 / 产出 / 积分）+ 8 张紧凑 Agent 卡
 *   （deriveClassicNodeBoard 从工作台快照推导，点击打开对应角色详情侧栏）；
 * - 五阶段 stepper + 错误重试横幅 + 当前阶段内容（全宽）；
 * - 右下角圆形悬浮球：点击查看团队历史（动态时间线）；
 * - TarotWorkspace：真实项目容器（轮询 + 动作包装）；TarotWorkspaceShell：
 *   纯展示壳，/agent/preview 预览页喂 mock 复用。
 */
import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  ArrowLeft,
  Coins,
  FileText,
  ImagePlus,
  Images,
  Loader2,
  RotateCcw,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Stepper } from "@/components/ui/stepper"
import { TAROT_ROLES, TAROT_STAGES, type TarotStageId } from "@/lib/agent/templates"
import { deriveTeamStatus } from "@/lib/agent/team-status"
import { NODE_TO_TEMPLATE_ROLE, deriveClassicNodeBoard } from "@/lib/agent/node-board"
import { AgentRoleSheet } from "./agent-role-sheet"
import { AgentCardsGrid } from "./agent-cards-grid"
import { ActivityFab } from "./activity-fab"
import { StatCard } from "./production/production-stats"
import { useWorkspaceActions } from "./workspace-actions"
import { ClarifyStage, type RunTemplateAction } from "./tarot-stage-clarify"
import { WorldStage } from "./tarot-stage-world"
import { TarotCardPlan } from "./tarot-card-plan"
import { ArtStageView } from "./production/art-stage-view"
import { ComposeStageView } from "./compose-stage-view"
import { useTemplateWorkspace, type TemplateWorkspaceData } from "./use-template-workspace"

const PENDING_ACTION_LABELS: Record<string, string> = {
  clarify_turn: "需求澄清",
  finalize_brief: "整理设计简报",
  gen_directions: "生成内容方向",
  produce_cards: "卡面生产",
  compose_preview: "AI 融合预览",
  compose_batch: "AI 融合批量",
}

const DONE_ITEM_STATUSES = ["confirmed", "approved_by_ai", "fallback"] as const

export function TarotWorkspace({ initialData }: { initialData: TemplateWorkspaceData }) {
  const router = useRouter()
  const { data, refresh, busy } = useTemplateWorkspace(initialData)
  const [acting, setActing] = useState(false)

  const runAction: RunTemplateAction = useCallback(
    async (fn, successMessage) => {
      setActing(true)
      try {
        await fn()
        if (successMessage) toast.success(successMessage)
        await refresh()
        return true
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "操作失败")
        return false
      } finally {
        setActing(false)
      }
    },
    [refresh],
  )

  return (
    <TarotWorkspaceShell
      data={data}
      locked={busy || acting}
      runAction={runAction}
      onRefresh={refresh}
      onBack={() => router.push("/agent")}
    />
  )
}

/** 纯展示壳：真实工作台与 /agent/preview 预览共用（stage 可被预览切换器覆盖） */
export function TarotWorkspaceShell({
  data,
  locked,
  runAction,
  onRefresh,
  onBack,
  stage: stageOverride,
}: {
  data: TemplateWorkspaceData
  /** busy || 用户操作中（禁用交互） */
  locked: boolean
  runAction: RunTemplateAction
  /** 数据刷新（预览页喂 noop） */
  onRefresh: () => Promise<unknown>
  onBack: () => void
  /** 预览页覆盖当前阶段；缺省取 run.stage */
  stage?: TarotStageId
}) {
  const { retryTemplateAction } = useWorkspaceActions()
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const { run, items } = data
  const stage = stageOverride ?? ((run.stage ?? "clarify") as TarotStageId)
  const stageIndex = Math.max(0, TAROT_STAGES.findIndex((item) => item.id === stage))
  const busy = locked

  const team = useMemo(
    () =>
      deriveTeamStatus({
        roles: TAROT_ROLES,
        stages: TAROT_STAGES,
        run: data.run,
        events: data.events,
        messages: data.messages,
        items: data.items,
        assets: data.assets,
      }),
    [data],
  )

  const nodeCards = useMemo(() => deriveClassicNodeBoard({ run, items }), [run, items])

  // 4 信息卡（文本 / 图片 / 产出 / 积分）
  const totalCredits = run.imageCostCredits + run.costCenticredits / 100
  const doneCount = items.filter((item) =>
    DONE_ITEM_STATUSES.includes(item.status as (typeof DONE_ITEM_STATUSES)[number]),
  ).length
  const overallPercent = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0

  return (
    <div className="flex w-full flex-col gap-4 pb-8">
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> 项目库
        </Button>
        <div className="h-5 w-px bg-border" />
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-lg">
          🌙
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{run.title ?? "塔罗牌全套设计"}</p>
          <p className="max-w-xl truncate text-xs text-muted-foreground" title={run.input.prompt}>
            {run.input.prompt}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {busy ? (
            <Badge variant="secondary" className="gap-1 bg-amber-500/15 text-amber-600 dark:text-amber-300">
              <Loader2 className="size-3 animate-spin" /> AI 团队处理中
            </Badge>
          ) : (
            <Badge variant="secondary" className="bg-amber-500/20 text-amber-700 dark:text-amber-300">
              等待你的操作
            </Badge>
          )}
          <Badge className="bg-violet-500/10 text-violet-600 dark:text-violet-300">塔罗模板</Badge>
        </div>
      </div>

      {/* 4 张信息卡 */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          icon={FileText}
          label="文本"
          value={`${run.llmCallCount} 次`}
          chipClass="bg-sky-500/15 text-sky-600 dark:text-sky-300"
        />
        <StatCard
          icon={ImagePlus}
          label="图片"
          value={`${run.imageCount} 次`}
          chipClass="bg-blue-500/15 text-blue-600 dark:text-blue-300"
        />
        <StatCard
          icon={Images}
          label="产出"
          value={`${doneCount}/${items.length} 张`}
          chipClass="bg-violet-500/15 text-violet-600 dark:text-violet-300"
          progress={{ percent: overallPercent, running: busy }}
        />
        <StatCard
          icon={Coins}
          label="积分消耗"
          value={`≈${Math.round(totalCredits * 100) / 100} 积分`}
          chipClass="bg-amber-500/15 text-amber-600 dark:text-amber-300"
        />
      </div>

      {/* 8 张紧凑 Agent 卡（点击打开对应角色详情） */}
      <AgentCardsGrid
        cards={nodeCards}
        onSelect={(nodeKey) => setSelectedRoleId(NODE_TO_TEMPLATE_ROLE[nodeKey] ?? nodeKey)}
      />

      {/* 五阶段 stepper */}
      <StageProgress stageIndex={stageIndex} />

      {/* 错误横幅（可一键重试） */}
      {run.error && !busy && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
          <AlertTriangle className="size-4 shrink-0 text-red-500" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-red-600 dark:text-red-400">
              「{PENDING_ACTION_LABELS[run.pendingAction?.kind ?? ""] ?? "上一步"}」执行失败
            </p>
            <p className="break-all text-xs text-muted-foreground">{run.error}</p>
          </div>
          {run.pendingAction && (
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => void runAction(() => retryTemplateAction(run.id), "已重新提交")}
            >
              <RotateCcw className="size-3.5" /> 重试
            </Button>
          )}
        </div>
      )}

      {/* 当前阶段内容（全宽） */}
      <main className="min-w-0">
        {stage === "clarify" && <ClarifyStage data={data} busy={locked} runAction={runAction} />}
        {stage === "world" && <WorldStage data={data} busy={locked} runAction={runAction} />}
        {stage === "prompt" && <TarotCardPlan data={data} busy={locked} onRefresh={onRefresh} />}
        {stage === "art" && <ArtStageView data={data} busy={locked} onRefresh={onRefresh} runAction={runAction} />}
        {stage === "compose" && <ComposeStageView data={data} busy={locked} onRefresh={onRefresh} />}
      </main>

      <AgentRoleSheet
        role={team.roles.find((role) => role.roleId === selectedRoleId) ?? null}
        open={selectedRoleId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedRoleId(null)
        }}
      />

      {/* 圆形悬浮球：点击查看团队历史（动态时间线） */}
      <ActivityFab data={data} />
    </div>
  )
}

function StageProgress({ stageIndex }: { stageIndex: number }) {
  const stage = TAROT_STAGES[stageIndex]!
  const percent = Math.round(((stageIndex + 1) / TAROT_STAGES.length) * 100)
  return (
    <div className="rounded-xl border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium">
          阶段 {stageIndex + 1}/{TAROT_STAGES.length} · {stage.name}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{stage.goal}</span>
        <span className="text-xs tabular-nums text-violet-600 dark:text-violet-300">{percent}%</span>
      </div>
      <Stepper
        className="mt-3.5"
        steps={TAROT_STAGES.map((item) => ({ id: item.id, label: item.name }))}
        currentIndex={stageIndex}
      />
    </div>
  )
}
