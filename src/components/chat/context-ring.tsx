"use client"

import * as React from "react"
import { Gauge } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * 上下文已用进度环（对话版积分环）
 *
 * 弧长 = 会话 contextTokens / 模型 maxContextTokens；
 * ≥80% 黄、≥95% 红；Tooltip 显示精确值；点击 Popover 展示明细与
 * 「超出后自动省略早期消息」说明。contextTokens 每条消息后由服务端
 * 用上游 usage 精确回写，零查询渲染。
 */
export function ContextRing({
  usedTokens,
  maxTokens,
  className,
}: {
  usedTokens: number
  maxTokens: number
  className?: string
}) {
  const max = Math.max(1, maxTokens)
  const pct = Math.max(0, Math.min(1, usedTokens / max))
  const percent = Math.round(pct * 100)
  const color =
    pct >= 0.95 ? "oklch(0.65 0.2 25)" : pct >= 0.8 ? "oklch(0.8 0.15 85)" : "oklch(0.7 0.15 145)"
  const R = 6
  const C = 2 * Math.PI * R

  const fmt = (n: number) => n.toLocaleString("zh-CN")

  return (
    <Popover>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className={cn(
                      "flex h-8 items-center justify-center rounded-lg px-2 transition-colors hover:bg-accent focus:outline-none",
                      className,
                    )}
                    aria-label={`上下文已用 ${percent}%`}
                  />
                }
              />
            }
          >
            <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0" aria-hidden="true">
              <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeWidth="2" className="text-muted" />
              <circle
                cx="8"
                cy="8"
                r={R}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - pct)}
                transform="rotate(-90 8 8)"
                style={{ transition: "stroke-dashoffset 0.5s ease" }}
              />
            </svg>
          </TooltipTrigger>
          <TooltipContent side="top">
            上下文已用 {percent}%（{fmt(usedTokens)} / {fmt(maxTokens)} tokens）
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent align="end" side="top" sideOffset={6} className="w-60">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Gauge
              className={cn(
                "size-4",
                pct >= 0.95 ? "text-destructive" : pct >= 0.8 ? "text-primary" : "text-muted-foreground",
              )}
            />
            <div className="flex-1">
              <div className="text-xs text-muted-foreground">当前上下文占用</div>
              <div className="text-base font-semibold tabular-nums">
                {fmt(usedTokens)} / {fmt(maxTokens)}
              </div>
            </div>
          </div>
          <div className="border-t pt-2 text-xs text-muted-foreground">
            接近上限时，发送会自动省略最早的对话内容以腾出空间；
            开始新对话可获得完整上下文。
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
