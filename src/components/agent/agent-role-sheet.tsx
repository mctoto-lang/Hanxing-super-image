"use client"

/**
 * 角色详情侧边栏（团队面板点击角色卡弹出）
 *
 * 三段式：① 角色信息头（Grok Agent 头像 + 姓名/职责/状态徽标）
 * ② 当前任务 + 产出指标芯片 + 最新产出摘录
 * ③ 该角色的执行时间线（zh-CN 时间 + 状态色点 + 动作中文标签，新→旧）。
 *
 * 受控 Sheet：open / onOpenChange 由父组件持有；role 为 null 时仅渲染空壳，
 * 不渲染任何内容（避免残留上一位角色的数据）。
 */
import { MessagesSquare } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import type { RoleStatus, RoleRuntimeState, TeamEventSnapshot } from "@/lib/agent/team-status"
import { ROLE_STATE_META } from "./agent-team-panel"
import { GrokAgentAvatar } from "./grok-agent-avatar"

/** 事件动作 → 中文标签（与环节详情侧边栏同一套词表） */
const ACTION_LABEL: Record<string, string> = {
  start: "开始",
  done: "完成",
  fail: "失败",
  retry: "打回",
  fallback: "兜底",
  confirm: "确认",
  regen: "重做",
}

/** zh-CN 短时间（月-日 时:分）；服务端传 ISO 字符串也能解析 */
function formatTime(t: Date | string): string {
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false })
}

/** 状态色点：错误红 / 警告琥珀 / 正常绿 */
function StatusDot({ status }: { status: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1 size-1.5 shrink-0 rounded-full",
        status === "error"
          ? "bg-red-500"
          : status === "warn"
            ? "bg-amber-500"
            : "bg-emerald-500",
      )}
    />
  )
}

/** 时间线单条：色点 + 时间 + 动作标签 + 详情 */
function EventRow({ event }: { event: TeamEventSnapshot }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <StatusDot status={event.status} />
      <span className="shrink-0 text-muted-foreground">{formatTime(event.createdAt)}</span>
      <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
        {ACTION_LABEL[event.action] ?? event.action}
      </span>
      <span className="min-w-0 break-words">{event.detail ?? "—"}</span>
    </li>
  )
}

export function AgentRoleSheet({
  role,
  open,
  onOpenChange,
}: {
  /** 目标角色状态；null = 无选中（关闭态下不渲染内容） */
  role: RoleStatus | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const meta = role ? ROLE_STATE_META[role.state as RoleRuntimeState] : null
  const StateIcon = meta?.icon
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[420px] overflow-y-auto p-0 sm:max-w-[420px]">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-base">
            <GrokAgentAvatar status={meta?.avatarStatus} size={30} className="rounded-md" />
            <span className="min-w-0 truncate">{role?.name ?? "角色详情"}</span>
            {meta && (
              <Badge variant="secondary" className={cn("ml-1 shrink-0", meta.badge)}>
                {meta.label}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="line-clamp-2">
            {role?.duty ?? "该角色的工作产出与执行时间线"}
          </SheetDescription>
        </SheetHeader>

        {role && (
          <div className="space-y-5 p-4 pb-8">
            {/* ① 当前任务 */}
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">当前任务</p>
              <p className="flex items-center gap-2 rounded-lg border p-3 text-sm">
                {StateIcon && (
                  <StateIcon
                    className={cn(
                      "size-4 shrink-0",
                      role.state === "working" && "animate-spin",
                      meta?.badge,
                    )}
                  />
                )}
                {role.currentTask}
              </p>
            </div>

            {/* ② 产出指标 + 最新产出 */}
            {role.outputs.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">产出指标</p>
                <div className="flex flex-wrap gap-1.5">
                  {role.outputs.map((output) => (
                    <span
                      key={output.label}
                      className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
                    >
                      {output.label}{" "}
                      <span className="font-medium text-foreground">{output.value}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {role.latestOutput && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">最新产出</p>
                <p className="flex items-start gap-1.5 whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
                  <MessagesSquare className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">{role.latestOutput}</span>
                </p>
              </div>
            )}

            {/* ③ 执行时间线（新→旧） */}
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                执行时间线（{role.events.length} 条，新→旧）
              </p>
              {role.events.length === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                  该角色还没有任何执行记录
                </p>
              ) : (
                <ul className="space-y-1.5 rounded-lg border p-2.5">
                  {[...role.events].reverse().map((event) => (
                    <EventRow key={event.id} event={event} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
