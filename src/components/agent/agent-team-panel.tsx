"use client"

/**
 * 角色团队面板（模板工作台 · 团队视角）
 *
 * 顶部一句编制概览（本项目使用 N 个角色 Agent · 已参与 M 个），下面是
 * 角色卡片网格：每张卡展示头像（Grok Agent 表情随状态切换）、姓名、职责、
 * 状态徽标、当前任务一句话、产出指标芯片与最新产出摘录；正在工作的卡片
 * 高亮描边。卡片本身是按钮（键盘可达），点击经 onSelectRole(roleId) 打开
 * 角色详情侧边栏。
 *
 * variant：grid = 主区双列（移动端单列）；rail = 右栏单列窄卡。
 * 数据来自 deriveTeamStatus（@/lib/agent/team-status，纯函数）。
 */
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Loader2,
  MessagesSquare,
  UserRoundCheck,
  UsersRound,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type { RoleRuntimeState, RoleStatus, TeamStatus } from "@/lib/agent/team-status"
import { GrokAgentAvatar } from "./grok-agent-avatar"

/** 状态 → 徽标样式 / 图标 / 头像表情（角色详情侧边栏复用同一映射） */
export const ROLE_STATE_META: Record<
  RoleRuntimeState,
  { label: string; badge: string; icon: LucideIcon; avatarStatus: string; ring: string }
> = {
  idle: {
    label: "待命",
    badge: "bg-zinc-500/15 text-zinc-500",
    icon: CircleDashed,
    avatarStatus: "idle",
    ring: "",
  },
  working: {
    label: "工作中",
    badge: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
    icon: Loader2,
    avatarStatus: "running",
    ring: "border-violet-500/50 ring-1 ring-violet-500/60",
  },
  waiting_user: {
    label: "等待你确认",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    icon: UserRoundCheck,
    avatarStatus: "skipped",
    ring: "border-amber-500/40 ring-1 ring-amber-500/50",
  },
  done: {
    label: "已完成",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
    icon: CircleCheck,
    avatarStatus: "done",
    ring: "",
  },
  error: {
    label: "出错",
    badge: "bg-red-500/15 text-red-600 dark:text-red-300",
    icon: CircleAlert,
    avatarStatus: "failed",
    ring: "border-red-500/40 ring-1 ring-red-500/50",
  },
}

/** 单张角色卡（整卡为按钮，键盘可达） */
function RoleCard({
  role,
  onSelect,
}: {
  role: RoleStatus
  onSelect?: (roleId: string) => void
}) {
  const meta = ROLE_STATE_META[role.state]
  const StateIcon = meta.icon
  return (
    <button
      type="button"
      aria-label={`查看${role.name}的工作详情`}
      onClick={() => onSelect?.(role.roleId)}
      className={cn(
        "flex w-full flex-col gap-2.5 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60",
        meta.ring,
      )}
    >
      {/* 头像 + 姓名/职责 + 状态徽标 */}
      <div className="flex items-center gap-2.5">
        <GrokAgentAvatar status={meta.avatarStatus} size={34} className="rounded-lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{role.name}</p>
          <p className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">{role.duty}</p>
        </div>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
            meta.badge,
          )}
        >
          <StateIcon className={cn("size-3", role.state === "working" && "animate-spin")} />
          {meta.label}
        </span>
      </div>

      {/* 当前任务一句话 */}
      <p
        className={cn(
          "text-xs leading-5",
          role.state === "working" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {role.currentTask}
      </p>

      {/* 产出指标芯片 */}
      {role.outputs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {role.outputs.map((output) => (
            <span
              key={output.label}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {output.label} <span className="font-medium text-foreground">{output.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* 最新产出摘录 */}
      {role.latestOutput && (
        <div className="flex items-start gap-1.5 rounded-lg bg-muted/50 p-2 text-[11px] leading-4 text-muted-foreground">
          <MessagesSquare className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-2">{role.latestOutput}</span>
        </div>
      )}
    </button>
  )
}

export function AgentTeamPanel({
  team,
  stageName,
  onSelectRole,
  variant = "grid",
  className,
}: {
  team: TeamStatus
  /** 当前阶段名（标题右侧附注，可选） */
  stageName?: string
  /** 点击角色卡 → 打开该角色详情 */
  onSelectRole?: (roleId: string) => void
  /** grid = 主区双列网格；rail = 右栏单列窄卡 */
  variant?: "grid" | "rail"
  className?: string
}) {
  return (
    <section aria-label="项目角色团队" className={cn("flex flex-col gap-3", className)}>
      <header className="flex items-center gap-2">
        <UsersRound className="size-4 shrink-0 text-violet-500" />
        <h2 className="truncate text-sm font-medium">
          本项目使用 {team.usedCount} 个角色 Agent · 已参与 {team.participatedCount} 个
        </h2>
        {stageName && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{stageName}</span>
        )}
      </header>
      <div
        className={cn(
          "grid gap-2.5",
          variant === "rail" ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2",
        )}
      >
        {team.roles.map((role) => (
          <RoleCard key={role.roleId} role={role} onSelect={onSelectRole} />
        ))}
      </div>
    </section>
  )
}
