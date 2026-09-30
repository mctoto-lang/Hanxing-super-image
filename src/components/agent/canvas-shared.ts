"use client"

/**
 * Agent 卡牌工坊共享常量：运行/卡牌状态 → 徽章样式与中文
 * （看板、列表、回放弹窗共用；经典节点级状态样式已随流程移除）
 */
import type { AgentDirection } from "@/lib/agent/graph"

/** run / item 状态 → 徽章样式与中文 */
export const RUN_STATUS_META: Record<string, { label: string; badge: string }> = {
  queued: { label: "排队中", badge: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300" },
  running: { label: "运行中", badge: "bg-amber-500/15 text-amber-600 dark:text-amber-300" },
  paused: { label: "已暂停", badge: "bg-amber-500/15 text-amber-600 dark:text-amber-300" },
  waiting_style: {
    label: "待确认风格",
    badge: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  },
  waiting_human: {
    label: "待人工确认",
    badge: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  },
  completed: { label: "已完成", badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" },
  failed: { label: "失败", badge: "bg-red-500/15 text-red-600 dark:text-red-300" },
  cancelled: { label: "已取消", badge: "bg-zinc-500/15 text-zinc-500" },
}

/** ring = 描边；bg = 角标实底背景（Tailwind 按源码字面量生成类，禁止运行时拼接） */
export const ITEM_STATUS_META: Record<string, { label: string; badge: string; ring: string; bg: string }> = {
  pending: { label: "排队", badge: "bg-zinc-500/15 text-zinc-500", ring: "ring-zinc-400", bg: "bg-zinc-400" },
  drafting: { label: "起草中", badge: "bg-violet-500/15 text-violet-600 dark:text-violet-300", ring: "ring-violet-400", bg: "bg-violet-400" },
  generating: { label: "生图中", badge: "bg-blue-500/15 text-blue-600 dark:text-blue-300", ring: "ring-blue-400", bg: "bg-blue-400" },
  reviewing: { label: "审核中", badge: "bg-orange-500/15 text-orange-600 dark:text-orange-300", ring: "ring-orange-400", bg: "bg-orange-400" },
  waiting_human: { label: "待确认", badge: "bg-amber-500/20 text-amber-700 dark:text-amber-300", ring: "ring-amber-400", bg: "bg-amber-400" },
  approved_by_ai: { label: "AI 通过", badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300", ring: "ring-emerald-400", bg: "bg-emerald-400" },
  fallback: { label: "兜底选优", badge: "bg-amber-500/15 text-amber-600 dark:text-amber-300", ring: "ring-amber-400", bg: "bg-amber-400" },
  confirmed: { label: "已确认", badge: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300", ring: "ring-emerald-500", bg: "bg-emerald-500" },
  failed: { label: "失败", badge: "bg-red-500/15 text-red-600 dark:text-red-300", ring: "ring-red-400", bg: "bg-red-400" },
  cancelled: { label: "已取消", badge: "bg-zinc-500/15 text-zinc-500", ring: "ring-zinc-400", bg: "bg-zinc-400" },
}

/** 方向展示 */
export const DIRECTION_META: Record<AgentDirection, { name: string; icon: string }> = {
  tarot: { name: "塔罗牌", icon: "🌙" },
  oracle: { name: "神谕卡", icon: "✨" },
  poker: { name: "扑克牌", icon: "♠" },
}

export function directionName(direction: string | null | undefined): string {
  return DIRECTION_META[direction as AgentDirection]?.name ?? "卡牌工坊"
}
