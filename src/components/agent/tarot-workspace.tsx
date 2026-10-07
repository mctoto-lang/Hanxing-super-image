"use client"

/**
 * 塔罗模板工作台（/agent/run/[id]，template = tarot）
 *
 * - 头部：返回 / 标题 / 状态徽章（AI 团队处理中 / 等待你的操作）；
 * - 阶段进度条（大进度条 + 阶段胶囊，置于 4 张信息卡上方）；
 * - 常驻顶部：4 张信息卡（文本 / 图片 / 产出 / 积分）+ 8 张紧凑 Agent 卡
 *   （deriveClassicNodeBoard 从工作台快照推导，点击打开对应角色详情侧栏）；
 * - 错误重试横幅 + 当前阶段内容（全宽）：澄清 → 初稿设计 → 终稿细化 →
 *   生图与评审 → 融合与交付（存量 run 的 world 阶段渲染旧版方向选择视图）；
 * - 右下角圆形悬浮球：点击查看团队历史（动态时间线）；
 * - TarotWorkspace：项目容器（轮询 + 动作包装）；TarotWorkspaceShell：纯展示壳。
 */
import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Coins,
  FileText,
  ImagePlus,
  Images,
  Loader2,
  PauseCircle,
  RotateCcw,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { normalizeTemplateStage } from "@/lib/agent/graph"
import { isStructuredFinalPrompt } from "@/lib/agent/cards/plan"
import { TAROT_ROLES, TAROT_STAGES } from "@/lib/agent/templates"
import { deriveTeamStatus } from "@/lib/agent/team-status"
import { templateRoleForNode, deriveClassicNodeBoard } from "@/lib/agent/node-board"
import { AgentRoleSheet } from "./agent-role-sheet"
import { AgentCardsGrid } from "./agent-cards-grid"
import { ActivityFab } from "./activity-fab"
import { StatCard } from "./production/production-stats"
import { useWorkspaceActions } from "./workspace-actions"
import { ClarifyStage, type RunTemplateAction } from "./tarot-stage-clarify"
import { WorldStage } from "./tarot-stage-world"
import { TarotCardPlan } from "./tarot-card-plan"
import { FinalStageView } from "./final-stage-view"
import { ArtStageView } from "./production/art-stage-view"
import { ComposeStageView } from "./compose-stage-view"
import { useTemplateWorkspace, type TemplateWorkspaceData } from "./use-template-workspace"

const PENDING_ACTION_LABELS: Record<string, string> = {
  clarify_turn: "需求澄清",
  finalize_brief: "整理设计简报",
  gen_style_spec: "拟定风格规范书",
  design_drafts: "撰写画面初稿",
  design_finals: "细化画面终稿",
  produce_cards: "卡面生产",
  compose_preview: "AI 融合预览",
  compose_batch: "AI 融合批量",
  asset_gen: "周边资产生成",
  // 旧动作（存量 run 过渡期）
  gen_directions: "生成内容方向",
  design_prompts: "撰写画面提示词",
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

/** 纯展示壳：由 TarotWorkspace 喂轮询数据渲染 */
export function TarotWorkspaceShell({
  data,
  locked,
  runAction,
  onRefresh,
  onBack,
}: {
  data: TemplateWorkspaceData
  /** busy || 用户操作中（禁用交互） */
  locked: boolean
  runAction: RunTemplateAction
  /** 数据刷新 */
  onRefresh: () => Promise<unknown>
  onBack: () => void
}) {
  const { retryTemplateAction } = useWorkspaceActions()
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const { run, items } = data
  // 存量 run 的旧阶段值（world/prompt）归一化到新五阶段；rawStage 保留用于
  // 旧版方向选择视图（存量 world 阶段且未选定方向时仍渲染 WorldStage）
  const rawStage = run.stage ?? "clarify"
  const stage = normalizeTemplateStage(rawStage)
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
        cardTotal: data.run.input.cardCount ?? data.items.length,
      }),
    [data],
  )

  const nodeCards = useMemo(
    () => deriveClassicNodeBoard({ run, items, cardTotal: run.input.cardCount ?? items.length }),
    [run, items],
  )

  // 4 信息卡（文本 / 图片 / 产出 / 积分）
  const totalCredits = run.imageCostCredits + run.costCenticredits / 100
  const doneCount = items.filter((item) =>
    DONE_ITEM_STATUSES.includes(item.status as (typeof DONE_ITEM_STATUSES)[number]),
  ).length
  const overallPercent = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0

  // 阶段内进度（阶段基数 + 阶段内完成度加权；替代纯 stageIndex/5 的粗粒度百分比）
  const stageProgress = useMemo(() => {
    const total = items.length || run.input.cardCount || 78
    if (stage === "draft") {
      const written = items.filter((item) => (item.visualBrief ?? "").trim().length >= 20).length
      return { count: written, total }
    }
    if (stage === "final") {
      const refined = items.filter((item) => isStructuredFinalPrompt(item.currentPrompt)).length
      return { count: refined, total }
    }
    if (stage === "art") {
      const scope = run.phase === "sample" ? items.filter((item) => item.isSample) : items
      const done = scope.filter((item) =>
        DONE_ITEM_STATUSES.includes(item.status as (typeof DONE_ITEM_STATUSES)[number]),
      ).length
      return { count: done, total: scope.length || total }
    }
    if (stage === "compose") {
      const framed = items.filter((item) => item.frameStatus === "framed").length
      return { count: framed, total }
    }
    return null
  }, [stage, items, run.phase])

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

      {/* 阶段进度条（大进度条 + 阶段胶囊；置于 4 张信息卡上方） */}
      <StageProgress
        stageIndex={stageIndex}
        stageProgress={stageProgress}
        waitingUser={run.status === "waiting_human"}
        busy={busy}
      />

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

      {/* 8 张紧凑 Agent 卡（点击打开对应角色详情；初稿/融合期按动作细分角色） */}
      <AgentCardsGrid
        cards={nodeCards}
        onSelect={(nodeKey) =>
          setSelectedRoleId(templateRoleForNode(nodeKey, run.pendingAction?.kind ?? null) ?? nodeKey)
        }
      />

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
        {/* 存量 run：world 阶段（三方向选择）继续渲染旧视图直至选定 */}
        {rawStage === "world" && <WorldStage data={data} busy={locked} runAction={runAction} />}
        {stage === "draft" && rawStage !== "world" &&
          (run.selectedDirectionId ? (
            <TarotCardPlan data={data} busy={locked} onRefresh={onRefresh} />
          ) : (
            // 初稿阶段第一步：选择《风格规范书》方向（选定后才开始撰写初稿）
            <WorldStage data={data} busy={locked} runAction={runAction} variant="style" />
          ))}
        {stage === "final" && <FinalStageView data={data} busy={locked} onRefresh={onRefresh} />}
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

/**
 * 阶段进度条（方案 C）：阶段 N/5 + 阶段内实时计数 + 大号渐变进度条 +
 * 5 个状态胶囊（已完成✓ / 进行中（脉冲点） / 等待用户⏸ / 待开始）。
 * 百分比 = (阶段序 + 阶段内完成度) / 5，替代旧的纯阶段序百分比。
 */
function StageProgress({
  stageIndex,
  stageProgress,
  waitingUser,
  busy,
}: {
  stageIndex: number
  stageProgress: { count: number; total: number } | null
  waitingUser: boolean
  busy: boolean
}) {
  const stage = TAROT_STAGES[stageIndex]!
  const stageFraction =
    stageProgress && stageProgress.total > 0
      ? Math.min(1, Math.max(0, stageProgress.count / stageProgress.total))
      : busy
        ? 0.4 // 无计数依据时按处理中给个中间值，避免进度条停滞在阶段起点
        : 0
  const percent = Math.round(((stageIndex + stageFraction) / TAROT_STAGES.length) * 100)
  const detail =
    stageProgress && stageProgress.total > 0 ? ` ${stageProgress.count}/${stageProgress.total}` : ""

  return (
    <div className="rounded-xl border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium">
          阶段 {stageIndex + 1}/{TAROT_STAGES.length} · {stage.name}
          {detail && <span className="ml-1 tabular-nums text-muted-foreground">{detail}</span>}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{stage.goal}</span>
        <span className="text-xs font-medium tabular-nums text-violet-600 dark:text-violet-300">{percent}%</span>
      </div>

      {/* 大号渐变进度条 */}
      <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500",
            busy && "animate-pulse",
          )}
          style={{ width: `${Math.max(percent, 2)}%` }}
        />
      </div>

      {/* 阶段胶囊 */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {TAROT_STAGES.map((item, index) => {
          const done = index < stageIndex
          const current = index === stageIndex
          return (
            <span
              key={item.id}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium",
                done && "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
                current &&
                  !waitingUser &&
                  "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300",
                current && waitingUser && "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
                !current && !done && "border-transparent bg-muted/60 text-muted-foreground",
              )}
            >
              {done ? (
                <Check className="size-3" />
              ) : current && waitingUser ? (
                <PauseCircle className="size-3" />
              ) : current ? (
                <span className="relative flex size-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-500 opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-violet-500" />
                </span>
              ) : (
                <span className="size-2 rounded-full border border-current opacity-50" />
              )}
              {item.name}
            </span>
          )
        })}
      </div>
    </div>
  )
}
