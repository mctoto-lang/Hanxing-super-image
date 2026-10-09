"use client"

/**
 * 当前动作横幅（busy 时显示，挂在阶段进度条上方）：把「AI 团队现在在
 * 干什么」显著化——此前顶部只有「AI 团队处理中」徽章，对话/生图调用
 * 对用户完全无感知。
 *
 * - 主行：pendingAction → 进行中文案（与角色侧栏共用 workingTaskText，
 *   produce_cards 按 phase 区分小样/全套）；
 * - 副行：produce_cards 用卡面实时计数（sample 相位只统计小样口径），
 *   其他动作显示最新事件详情（逐批撰写进度 / 逐轮生图等已有事件）；
 * - 数据全部来自工作台 2s 轮询负载，无独立请求。
 */
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { workingTaskText } from "@/lib/agent/team-status"
import { TAROT_STAGES } from "@/lib/agent/templates"
import { normalizeTemplateStage } from "@/lib/agent/graph"
import type { TemplateWorkspaceData } from "./use-template-workspace"

/** 终态 = 已完成本轮生产（失败卡另有红色横幅呈现，不混入完成计数） */
const DONE_ITEM_STATUSES = ["confirmed", "approved_by_ai", "fallback"] as const

/** 卡面生产实时计数（与工作台阶段进度同口径：sample 相位只统计小样） */
function productionCounts(data: TemplateWorkspaceData) {
  const scope = data.run.phase === "sample" ? data.items.filter((item) => item.isSample) : data.items
  const counts = new Map<string, number>()
  for (const item of scope) counts.set(item.status, (counts.get(item.status) ?? 0) + 1)
  const done = scope.filter((item) =>
    DONE_ITEM_STATUSES.includes(item.status as (typeof DONE_ITEM_STATUSES)[number]),
  ).length
  return {
    total: scope.length,
    done,
    drafting: counts.get("drafting") ?? 0,
    generating: counts.get("generating") ?? 0,
    reviewing: counts.get("reviewing") ?? 0,
  }
}

function CountChip({ label, value, tone }: { label: string; value: number; tone: string }) {
  if (value <= 0) return null
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums", tone)}>
      {label} {value}
    </span>
  )
}

export function CurrentActionBanner({ data, busy }: { data: TemplateWorkspaceData; busy: boolean }) {
  if (!busy) return null
  const pending = data.run.pendingAction
  // 兜底文案用阶段中文名（workingTaskText 的 stageName 参数口径与角色侧栏一致；
  // 存量 run 的旧阶段值经 normalizeTemplateStage 归并后再查名）
  const stageName =
    TAROT_STAGES.find((stage) => stage.id === normalizeTemplateStage(data.run.stage))?.name ?? null
  const text = workingTaskText(pending?.kind ?? "", data.run.directions?.length ?? 0, stageName, pending?.phase)
  const isProduction = pending?.kind === "produce_cards"
  const counts = isProduction ? productionCounts(data) : null
  const latestEvent = data.events[data.events.length - 1]
  const percent = counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : null

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-violet-500/30 bg-gradient-to-r from-violet-500/[0.10] via-violet-500/[0.04] to-transparent px-4 py-3"
    >
      <Loader2 className="size-4 shrink-0 animate-spin text-violet-500" />
      <span className="text-sm font-semibold text-violet-700 dark:text-violet-200">{text}</span>
      {isProduction && counts && (
        <>
          <span className="text-xs tabular-nums text-muted-foreground">
            已完成 {counts.done}/{counts.total} 张{percent !== null ? ` · ${percent}%` : ""}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <CountChip label="撰写中" value={counts.drafting} tone="bg-sky-500/10 text-sky-600 dark:text-sky-300" />
            <CountChip label="生成中" value={counts.generating} tone="bg-blue-500/10 text-blue-600 dark:text-blue-300" />
            <CountChip label="评审中" value={counts.reviewing} tone="bg-amber-500/10 text-amber-600 dark:text-amber-300" />
          </span>
        </>
      )}
      {/* 非生产动作（或生产尚无计数时）：用最新事件补充具体进度信号 */}
      {(!isProduction || !counts || counts.total === 0) && latestEvent?.detail && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={latestEvent.detail}>
          最新动态：{latestEvent.detail}
        </span>
      )}
    </div>
  )
}
