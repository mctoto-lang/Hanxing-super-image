"use client"

/**
 * 方向卡片展示元数据（入口页模板卡）。
 * 经典全流程的团队编制（TEAM_AGENTS/TEAM_GROUPS）已随流程移除；
 * 塔罗模板的角色编制见 @/lib/agent/templates 的 TAROT_ROLES。
 */
import type { AgentDirection } from "@/lib/agent/graph"

/** 方向卡片展示用元数据（入口页） */
export const DIRECTION_CARDS: Record<
  AgentDirection,
  {
    emoji: string
    gradient: string
    countLabel: string
    /** 模板方形卡封面深色渐变（入口页模板卡） */
    coverClass: string
  }
> = {
  tarot: {
    emoji: "🌙",
    gradient: "from-violet-500/15 to-indigo-500/10",
    countLabel: "78 张 · 22 大阿卡纳 + 56 小阿卡纳",
    coverClass: "bg-gradient-to-br from-indigo-950 via-violet-900 to-fuchsia-900",
  },
  oracle: {
    emoji: "✨",
    gradient: "from-cyan-500/15 to-blue-500/10",
    countLabel: "24 / 36 / 44 / 64 张可选",
    coverClass: "bg-gradient-to-br from-cyan-950 via-sky-900 to-blue-900",
  },
  poker: {
    emoji: "♠",
    gradient: "from-rose-500/15 to-red-500/10",
    countLabel: "54 张 · 四花色 + 大小王",
    coverClass: "bg-gradient-to-br from-rose-950 via-red-900 to-orange-950",
  },
}
