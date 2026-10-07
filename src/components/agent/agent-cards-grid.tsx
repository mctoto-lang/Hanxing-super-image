"use client"

/**
 * 经典 8 节点 Agent 团队列表（紧凑状态行 · xl 一行 4 列）
 *
 * 之前确认过的样式口径：
 * - grok 正方形头像（32px，节点专属身体色，表情随状态切换）；
 * - 状态语义色：绿=已完成 / 黄=进行中（呼吸）·等你确认 / 灰=空闲 / 红=失败，
 *   圆点、圆环进度弧色、行高亮与汇总 chips 全套一致；
 * - 无边框状态行：头像 + 名称/职责（或失败·打回警示）+ 圆环进度（Tooltip
 *   具体数字）+ 状态点与标签；点击行打开对应角色详情侧栏；
 * - 数据由 deriveClassicNodeBoard 从模板工作台快照推导（见 lib/agent/node-board）。
 */
import { useMemo } from "react"
import { CircleAlert } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { ClassicNodeKey, NodeBoardStatus, NodeCardInfo } from "@/lib/agent/node-board"
import { GrokAgentAvatar } from "./grok-agent-avatar"

/** 节点编制：名称 / 职责 / grok 身体色 */
const NODE_AGENTS: Record<ClassicNodeKey, { title: string; duty: string; grokColor: `#${string}` }> = {
  style: { title: "创意总监", duty: "主持需求澄清：只追问风格/内容/主题", grokColor: "#8b5cf6" },
  structure: { title: "风格策划师", duty: "拟定唯一《风格规范书》与画面风格总述", grokColor: "#6366f1" },
  copywriter: { title: "终稿细化师", duty: "初稿→结构化终稿；打回时从初稿重细化", grokColor: "#d946ef" },
  imagegen: { title: "画师生图", duty: "按终稿与参考图逐张出图", grokColor: "#0ea5e9" },
  review_content: { title: "内容审核员", duty: "核对画面与终稿对齐（Ace-10 清点花色数量）", grokColor: "#10b981" },
  review_aesthetic: { title: "审美评审", duty: "构图/色彩/细节 0-100 打分，宁严勿宽", grokColor: "#f43f5e" },
  review_consistency: { title: "一致性审核员", duty: "对照规范书与基准图核对成套一致性", grokColor: "#06b6d4" },
  supervisor: { title: "总控裁决", duty: "三审裁决：放行/打回/兜底选优", grokColor: "#f59e0b" },
}

/** 状态 → 圆点/圆环色（绿完成 / 黄进行·等确认 / 灰空闲 / 红失败） */
const STATE_DOT: Record<NodeBoardStatus, string> = {
  idle: "bg-zinc-400",
  running: "bg-amber-500 motion-safe:animate-pulse",
  waiting: "bg-amber-500",
  done: "bg-emerald-500",
  failed: "bg-red-500",
}
const STATE_RING: Record<NodeBoardStatus, string> = {
  idle: "text-zinc-400",
  running: "text-amber-500",
  waiting: "text-amber-500",
  done: "text-emerald-500",
  failed: "text-red-500",
}
const STATE_LABEL: Record<NodeBoardStatus, string> = {
  idle: "待命",
  running: "工作中",
  waiting: "等你确认",
  done: "已完成",
  failed: "失败",
}
/** 状态 → grok 表情（waiting 用睡眠脸，同角色面板等待态） */
const STATE_AVATAR: Record<NodeBoardStatus, string> = {
  idle: "idle",
  running: "running",
  waiting: "skipped",
  done: "done",
  failed: "failed",
}

/** 圆环进度（弧长 = processed/total；Tooltip 显示具体数字） */
function ProgressRing({
  processed,
  total,
  status,
}: {
  processed: number
  total: number
  status: NodeBoardStatus
}) {
  const pct = total > 0 ? Math.max(0, Math.min(1, processed / total)) : 0
  const R = 7
  const C = 2 * Math.PI * R
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="flex size-[18px] shrink-0 items-center justify-center"
              aria-label={`任务进度 ${processed}/${total}`}
            />
          }
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r={R} fill="none" stroke="currentColor" strokeWidth="2" className="text-muted" />
            <circle
              cx="9"
              cy="9"
              r={R}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - pct)}
              transform="rotate(-90 9 9)"
              className={cn(STATE_RING[status], "transition-[stroke-dashoffset] duration-500")}
            />
          </svg>
        </TooltipTrigger>
        <TooltipContent side="top">
          任务进度 {processed}/{total}
          {total > 0 ? ` · ${Math.round(pct * 100)}%` : ""}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** 单个节点状态行（整行为按钮，键盘可达） */
function AgentRow({
  card,
  onSelect,
}: {
  card: NodeCardInfo
  onSelect?: (nodeKey: ClassicNodeKey) => void
}) {
  const agent = NODE_AGENTS[card.nodeKey]
  const processed = Math.min(card.processed, card.total)
  const hasWarning = card.failedCount > 0 || card.retryCount > 0
  return (
    <button
      type="button"
      aria-label={`查看${agent.title}的工作详情：${STATE_LABEL[card.status]}`}
      title={card.lastError ?? agent.duty}
      onClick={() => onSelect?.(card.nodeKey)}
      className={cn(
        "group rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60",
        "hover:bg-muted/60",
        card.status === "running" && "bg-amber-500/[0.07] hover:bg-amber-500/10",
        card.status === "failed" && "bg-red-500/[0.06] hover:bg-red-500/10",
      )}
    >
      <div className="flex items-center gap-2.5">
        <GrokAgentAvatar
          status={STATE_AVATAR[card.status]}
          color={agent.grokColor}
          size={32}
          className="rounded-md"
        />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-[13px] font-medium leading-tight">
            {agent.title}
            {card.status === "failed" && <CircleAlert className="size-3 shrink-0 text-red-500" />}
          </p>
          <p
            className={cn(
              "mt-0.5 line-clamp-1 text-[10px] leading-tight",
              hasWarning ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
            )}
          >
            {hasWarning
              ? [
                  card.failedCount > 0 ? `失败 ${card.failedCount}` : null,
                  card.retryCount > 0 ? `打回 ${card.retryCount}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : agent.duty}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {card.total > 0 && (
            <ProgressRing processed={processed} total={card.total} status={card.status} />
          )}
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span aria-hidden className={cn("size-1.5 rounded-full", STATE_DOT[card.status])} />
            {STATE_LABEL[card.status]}
          </span>
        </div>
      </div>
    </button>
  )
}

export function AgentCardsGrid({
  cards,
  onSelect,
  className,
}: {
  cards: NodeCardInfo[]
  onSelect: (nodeKey: ClassicNodeKey) => void
  className?: string
}) {
  const summary = useMemo(() => {
    const counts = { done: 0, running: 0, waiting: 0, idle: 0, failed: 0 }
    for (const card of cards) {
      counts[card.status] += 1
    }
    return counts
  }, [cards])

  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5">
        <span className="text-sm font-medium">AI 团队</span>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
            完成 {summary.done}
          </span>
          <span className="flex items-center gap-1">
            <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
            工作中 {summary.running}
          </span>
          {summary.waiting > 0 && (
            <span className="flex items-center gap-1">
              <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
              等确认 {summary.waiting}
            </span>
          )}
          <span className="flex items-center gap-1">
            <span aria-hidden className="size-1.5 rounded-full bg-zinc-400" />
            待命 {summary.idle}
          </span>
          {summary.failed > 0 && (
            <span className="flex items-center gap-1 text-red-500">
              <span aria-hidden className="size-1.5 rounded-full bg-red-500" />
              失败 {summary.failed}
            </span>
          )}
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">点击成员查看工作详情</span>
      </header>
      {/* 一行 4 列紧凑排布（移动 1 列 / md 2 列） */}
      <div className="grid grid-cols-1 gap-0.5 p-1.5 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <AgentRow key={card.nodeKey} card={card} onSelect={onSelect} />
        ))}
      </div>
    </section>
  )
}
