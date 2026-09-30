"use client"

/**
 * 团队动态悬浮窗（塔罗项目页 · 固定右下角悬浮球 + 浮动面板）：
 * - 悬浮球常驻：Activity 图标 + 最新事件状态色点；面板收起期间来了新事件
 *   （对比最新事件 id）色点 ping 提醒；
 * - 点击展开 360px 浮动时间线面板（模板事件为升序，最新在末尾倒序展示），
 *   事件行 = 时间 + 角色名（TAROT_ROLES 按 nodeKey 查）+ 详情；
 * - 移动端面板宽度收敛到视口内。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { Activity, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { TAROT_ROLES } from "@/lib/agent/templates"
import type { TemplateWorkspaceData } from "./use-template-workspace"

/** 事件状态 → 色点 */
function statusDotClass(status: string): string {
  if (status === "error") return "bg-red-500"
  if (status === "warn") return "bg-amber-500"
  return "bg-emerald-500"
}

function roleNameOf(nodeKey: string | null): string | null {
  if (!nodeKey) return null
  return TAROT_ROLES.find((role) => role.id === nodeKey)?.name ?? nodeKey
}

function formatTime(value: Date | string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false })
}

export function ActivityFab({ data }: { data: TemplateWorkspaceData }) {
  const [open, setOpen] = useState(false)
  const [hasNew, setHasNew] = useState(false)
  // 事件升序，最新在末尾
  const latest = data.events.length > 0 ? data.events[data.events.length - 1] : null
  const seenIdRef = useRef<string | null>(latest?.id ?? null)

  // 面板收起时出现新事件 → ping 提醒；打开面板即视为已读
  useEffect(() => {
    if (open) {
      seenIdRef.current = latest?.id ?? null
      setHasNew(false)
      return
    }
    if (latest && latest.id !== seenIdRef.current) setHasNew(true)
  }, [open, latest])

  // 倒序展示（最新在上）
  const rows = useMemo(() => [...data.events].reverse(), [data.events])

  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-2">
      {/* 浮动面板 */}
      {open && (
        <section
          aria-label="团队动态"
          className="flex h-[min(480px,60vh)] w-[min(360px,calc(100vw-3rem))] flex-col overflow-hidden rounded-xl border bg-card shadow-xl"
        >
          <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
            <Activity className="size-4 shrink-0 text-violet-500" />
            <span className="text-sm font-medium">团队动态</span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {data.events.length} 条
            </span>
            <button
              type="button"
              aria-label="收起团队动态"
              onClick={() => setOpen(false)}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
            >
              <ChevronDown className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {rows.length === 0 && (
              <p className="py-8 text-center text-xs text-muted-foreground">暂无事件</p>
            )}
            {rows.map((event) => {
              const roleName = roleNameOf(event.nodeKey)
              return (
                <div
                  key={event.id}
                  className="flex items-start gap-2 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-muted/50"
                >
                  <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", statusDotClass(event.status))} />
                  <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime(event.createdAt)}</span>
                  <span className="min-w-0 break-words">
                    {roleName ? <span className="font-medium">{roleName}：</span> : null}
                    {event.detail}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 悬浮球 */}
      <button
        type="button"
        aria-label={open ? "收起团队动态" : "展开团队动态"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative flex size-12 items-center justify-center rounded-full border bg-card text-violet-600 shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 dark:text-violet-300",
          open && "border-violet-500/40",
        )}
      >
        <Activity className={cn("size-5", open && "text-violet-500")} />
        <span aria-hidden className="absolute -right-0.5 -top-0.5 size-3">
          {!open && hasNew && (
            <span
              className={cn(
                "absolute inset-0 rounded-full motion-safe:animate-ping",
                latest ? statusDotClass(latest.status) : "bg-muted-foreground/40",
              )}
            />
          )}
          <span
            className={cn(
              "relative block size-3 rounded-full border-2 border-background",
              latest ? statusDotClass(latest.status) : "bg-muted-foreground/40",
            )}
          />
        </span>
      </button>
    </div>
  )
}
