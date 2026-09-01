"use client"

import * as React from "react"
import { Coins, UserCircle2 } from "lucide-react"
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
 * 积分进度环（自由创作页 §6）
 *
 * - 圆形进度环（约 16px，与工具栏模型图标 size-4 视觉等大）：弧长=个人剩余积分占比
 *   （余额/参考满额 500），余额越多弧越满；低于阈值颜色变红。DB 无总额字段，500 为 UI 参考满额。
 * - 触发区不再常驻显示余额数字（移入下方 Popover），仅保留圆环 + Tooltip 悬停提示。
 * - 三档颜色（独立于百分比，按余额阈值）：>=200 绿、50-199 黄、<50 红。
 * - 整体高度对齐工具栏（h-8）。
 * - 悬停 → Tooltip 显示「积分余额」；点击 → 弹出 Popover 显示「我的配额」+「企业积分池」。
 */
export function CreditsRing({
  userBalance,
  enterpriseBalance,
  className,
}: {
  userBalance: number
  enterpriseBalance: number
  className?: string
}) {
  // 视觉满额参考线（DB 无总额字段，此处为 UI 占位分母）
  const FULL = 500
  const pct = Math.max(0, Math.min(1, userBalance / FULL))
  const color = getRingColor(userBalance)
  // 圆环几何（16×16 viewBox，半径 6、描边 2）
  const R = 6
  const C = 2 * Math.PI * R

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
                    aria-label={`积分余额 ${userBalance}`}
                  />
                }
              />
            }
          >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            className="shrink-0"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r={R}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-muted"
            />
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
          积分余额 {userBalance.toLocaleString("zh-CN")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <PopoverContent align="end" side="top" sideOffset={6} className="w-52">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <UserCircle2
              className={cn(
                "size-4",
                userBalance < 50 ? "text-destructive" : "text-primary",
              )}
            />
            <div className="flex-1">
              <div className="text-xs text-muted-foreground">我的配额</div>
              <div
                className={cn(
                  "text-base font-semibold tabular-nums",
                  userBalance < 50 && "text-destructive",
                )}
              >
                {userBalance.toLocaleString("zh-CN")}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 border-t pt-2">
            <Coins className="size-4 text-muted-foreground" />
            <div className="flex-1">
              <div className="text-xs text-muted-foreground">企业积分池</div>
              <div className="text-sm font-medium tabular-nums text-muted-foreground">
                {enterpriseBalance.toLocaleString("zh-CN")}
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 三档颜色阈值（绿/黄/红） */
function getRingColor(balance: number): string {
  if (balance >= 200) return "oklch(0.7 0.15 145)" // 绿
  if (balance >= 50) return "oklch(0.8 0.15 85)" // 黄
  return "oklch(0.65 0.2 25)" // 红
}
