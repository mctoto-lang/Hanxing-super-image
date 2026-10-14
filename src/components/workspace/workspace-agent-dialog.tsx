"use client"

/**
 * 工作台 · AI 智能体总览弹窗（受控 Dialog）
 *
 * 结构：顶部四张统计卡（对话轮次 / 生图张数 / Token 消耗 / 调用次数，
 * 复用生产统计 StatCard）+ 卡片状态摘要条；下方智能体状态卡片网格
 * （方形彩色 GrokAgentAvatar，表情随状态切换）。
 *
 * props 全部为宽松共享类型（字段可空、可整体缺省），便于后续接入真实
 * 轮询数据：未传时统计显示「—」、智能体区显示空态，组件自身不发请求。
 */
import {
  Activity,
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Coins,
  Download,
  ImageIcon,
  Loader2,
  MessagesSquare,
  MinusCircle,
  UserRoundCheck,
  Zap,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { StatCard } from "@/components/agent/production/production-stats"
import { GrokAgentAvatar } from "@/components/agent/grok-agent-avatar"

/** 顶部消耗统计（宽松：均可空，缺省显示「—」） */
export interface WorkspaceAgentStatsInput {
  /** 对话轮次 */
  conversationCount?: number | null
  /** 生图张数 */
  imageCount?: number | null
  /** Token 累计消耗 */
  tokenUsed?: number | null
  /** 生图调用次数（usage 台账，全部状态） */
  imageCallCount?: number | null
  /** 对话调用次数（usage 台账，全部状态） */
  llmCallCount?: number | null
}

/** 卡片状态摘要（宽松：缺省按 0 展示） */
export interface WorkspaceAgentCardSummaryInput {
  total?: number | null
  completed?: number | null
  generating?: number | null
  failed?: number | null
}

/** 单个智能体状态卡片（宽松：status 接受常见别名，未识别按「待命」） */
export interface WorkspaceAgentItemInput {
  id: string
  name: string
  /** idle | running | waiting | done | failed | skipped（宽松字符串） */
  status?: string | null
  /** 职责一句话 */
  duty?: string | null
  /** Grok 身体色（#rrggbb，区分不同智能体） */
  color?: string | null
  /** 当前进行中的一句话（如「正在生成第 3/8 张」） */
  currentTask?: string | null
  /** 进度百分比 0-100（越界自动收敛） */
  progressPercent?: number | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 顶部统计；缺省全部显示「—」 */
  stats?: WorkspaceAgentStatsInput | null
  /** 卡片状态摘要；缺省隐藏该条 */
  cardSummary?: WorkspaceAgentCardSummaryInput | null
  /** 智能体列表；缺省显示空态 */
  agents?: readonly WorkspaceAgentItemInput[] | null
  /** 点击「查看执行进度」回调（配合进度弹窗使用；不传则不渲染该按钮） */
  onOpenProgress?: () => void
  /** 神谕文案交付进度（仅 oracle58 任务；null = 非神谕任务隐藏该区块） */
  oracleCopy?: { written: number; total: number; confirmed: boolean } | null
  /** 下载神谕文案 CSV（文案齐全时可用） */
  onDownloadOracleCsv?: () => void
}

/** 状态别名归一（与项目内 agent 状态用语对齐） */
const STATE_ALIASES: Record<string, string> = {
  idle: "idle",
  pending: "idle",
  queued: "idle",
  none: "idle",
  running: "running",
  working: "running",
  generating: "running",
  active: "running",
  waiting: "waiting",
  waiting_user: "waiting",
  confirm: "waiting",
  done: "done",
  completed: "done",
  success: "done",
  finished: "done",
  failed: "failed",
  fail: "failed",
  error: "failed",
  errored: "failed",
  skipped: "skipped",
}

/** 状态 → 徽标样式 / 图标 / Grok 表情（口径同 agent-team-panel） */
const AGENT_STATE_META: Record<
  string,
  {
    label: string
    badgeClass: string
    icon: LucideIcon
    spin?: boolean
    avatarStatus: string
    ring: string
  }
> = {
  idle: {
    label: "待命",
    badgeClass: "bg-zinc-500/15 text-zinc-500",
    icon: CircleDashed,
    avatarStatus: "idle",
    ring: "",
  },
  running: {
    label: "工作中",
    badgeClass: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    icon: Loader2,
    spin: true,
    avatarStatus: "running",
    ring: "border-amber-500/40 ring-1 ring-amber-500/50",
  },
  waiting: {
    label: "等你确认",
    badgeClass: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    icon: UserRoundCheck,
    avatarStatus: "skipped",
    ring: "border-amber-500/40 ring-1 ring-amber-500/50",
  },
  done: {
    label: "已完成",
    badgeClass: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
    icon: CircleCheck,
    avatarStatus: "done",
    ring: "",
  },
  failed: {
    label: "失败",
    badgeClass: "bg-red-500/15 text-red-600 dark:text-red-300",
    icon: CircleAlert,
    avatarStatus: "failed",
    ring: "border-red-500/40 ring-1 ring-red-500/50",
  },
  skipped: {
    label: "已跳过",
    badgeClass: "bg-zinc-500/15 text-zinc-500",
    icon: MinusCircle,
    avatarStatus: "skipped",
    ring: "",
  },
}

function stateMetaOf(status: string | null | undefined) {
  if (!status) return AGENT_STATE_META.idle!
  return AGENT_STATE_META[STATE_ALIASES[status.toLowerCase()] ?? "idle"]!
}

/** 数值格式化：空值「—」；大数用中文紧凑单位（如 1.2 万） */
function formatStat(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (value < 100000) return new Intl.NumberFormat("zh-CN").format(value)
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
}

/** 摘要计数：空值按 0 */
function summaryCount(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) ? Math.max(0, value) : 0
}

/** 单张智能体状态卡片（方形彩色 Grok 头像 + 状态徽标 + 进度） */
function AgentStatusCard({ agent }: { agent: WorkspaceAgentItemInput }) {
  const meta = stateMetaOf(agent.status)
  const StateIcon = meta.icon
  const percent =
    agent.progressPercent != null && Number.isFinite(agent.progressPercent)
      ? Math.round(
          Math.min(100, Math.max(0, Number(agent.progressPercent))),
        )
      : null

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-card p-3",
        meta.ring,
      )}
    >
      <div className="flex items-center gap-2.5">
        <GrokAgentAvatar
          status={meta.avatarStatus}
          color={agent.color ?? undefined}
          size={36}
          className="rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm leading-tight font-medium">
            {agent.name}
          </p>
          {agent.duty && (
            <p className="mt-0.5 line-clamp-1 text-[11px] leading-4 text-muted-foreground">
              {agent.duty}
            </p>
          )}
        </div>
        <Badge
          variant="outline"
          className={cn("shrink-0 border-transparent", meta.badgeClass)}
        >
          <StateIcon
            className={cn("size-3", meta.spin && "motion-safe:animate-spin")}
          />
          {meta.label}
        </Badge>
      </div>

      {agent.currentTask && (
        <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
          {agent.currentTask}
        </p>
      )}

      {percent != null && (
        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>任务进度</span>
            <span className="tabular-nums">{percent}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-violet-500 transition-[width] duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export function WorkspaceAgentDialog({
  open,
  onOpenChange,
  stats,
  cardSummary,
  agents,
  onOpenProgress,
  oracleCopy,
  onDownloadOracleCsv,
}: Props) {
  const s = stats ?? {}
  const summary = cardSummary ?? null
  const agentList = agents ?? []
  const summaryTotal = summaryCount(summary?.total)

  const statCards = [
    {
      icon: MessagesSquare,
      label: "对话轮次",
      value: formatStat(s.conversationCount),
      sub: "智能体累计对话",
      chipClass:
        "bg-violet-500/15 text-violet-600 dark:text-violet-300",
    },
    {
      icon: ImageIcon,
      label: "生图张数",
      value: formatStat(s.imageCount),
      sub: "累计生成图片",
      chipClass: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
    },
    {
      icon: Coins,
      label: "Token 消耗",
      value: formatStat(s.tokenUsed),
      sub: "本任务累计消耗",
      chipClass: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    },
    {
      icon: Zap,
      label: "调用次数",
      value: formatStat(
        s.imageCallCount != null || s.llmCallCount != null
          ? (s.imageCallCount ?? 0) + (s.llmCallCount ?? 0)
          : null,
      ),
      sub:
        s.imageCallCount != null || s.llmCallCount != null
          ? `生图 ${s.imageCallCount ?? 0} · 对话 ${s.llmCallCount ?? 0}`
          : "生图调用 + 对话调用",
      chipClass:
        "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
    },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-4 text-violet-500" />
            AI 智能体总览
          </DialogTitle>
          <DialogDescription>
            当前任务的智能体运行状态与资源消耗一览
          </DialogDescription>
        </DialogHeader>

        {/* 顶部统计卡（移动 1 列 / sm 2 列） */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {statCards.map((card) => (
            <StatCard
              key={card.label}
              icon={card.icon}
              label={card.label}
              value={card.value}
              sub={card.sub}
              chipClass={card.chipClass}
            />
          ))}
        </div>

        {/* 卡片状态摘要条 */}
        {summary && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-muted/40 px-3 py-2 text-xs">
            <span className="font-medium">卡片状态</span>
            <span className="text-muted-foreground">
              共 {summaryTotal} 张
            </span>
            <span className="flex items-center gap-1 text-muted-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
              完成 {summaryCount(summary.completed)}
            </span>
            <span className="flex items-center gap-1 text-muted-foreground">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full bg-amber-500",
                  summaryCount(summary.generating) > 0 && "motion-safe:animate-pulse",
                )}
              />
              生成中 {summaryCount(summary.generating)}
            </span>
            <span className="flex items-center gap-1 text-muted-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-red-500" />
              失败 {summaryCount(summary.failed)}
            </span>
          </div>
        )}

        {/* 智能体状态卡片网格 */}
        {agentList.length === 0 ? (
          <p className="rounded-xl border border-dashed py-6 text-center text-sm text-muted-foreground">
            暂无智能体运行数据
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {agentList.map((agent) => (
              <AgentStatusCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}

        {/* 神谕文案交付进度 + CSV 下载（仅 oracle58 任务） */}
        {oracleCopy && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-xs">
            <span className="font-medium">神谕文案</span>
            <span className="text-muted-foreground">
              {oracleCopy.written}/{oracleCopy.total} 组
            </span>
            {oracleCopy.confirmed ? (
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-300">
                <CircleCheck className="size-3" />
                已定稿
              </span>
            ) : (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                生成中
              </span>
            )}
            {onDownloadOracleCsv && (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto h-7 gap-1 text-xs"
                disabled={!oracleCopy.confirmed}
                onClick={onDownloadOracleCsv}
              >
                <Download className="size-3.5" />
                下载文案 CSV
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {onOpenProgress && (
            <Button onClick={onOpenProgress}>
              <Activity className="size-4" />
              查看执行进度
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
