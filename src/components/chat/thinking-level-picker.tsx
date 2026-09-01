"use client"

import * as React from "react"
import { Brain, ChevronDown, Check, Zap, ZapOff } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { THINKING_LEVEL_LABELS, type ThinkingLevel } from "@/components/chat/types"

/**
 * 思考强度选择器（关闭 / 低 / 中 / 高）
 *
 * 仅 supportsThinking 模型渲染（由父组件控制）；档位随会话持久化。
 * 各家格式的参数映射在服务端适配层完成（reasoning_effort /
 * thinking.budget_tokens / thinkingBudget）。
 */
export function ThinkingLevelPicker({
  value,
  onChange,
}: {
  value: ThinkingLevel
  onChange: (level: ThinkingLevel) => void
}) {
  const [open, setOpen] = React.useState(false)
  const options = ["off", "low", "medium", "high"] as const

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none"
          />
        }
      >
        {value === "off" ? (
          <ZapOff className="size-3.5 shrink-0" />
        ) : (
          <Brain className="size-3.5 shrink-0 text-primary" />
        )}
        <span>思考·{THINKING_LEVEL_LABELS[value]}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-1.5">
        <p className="px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">
          思考强度越高回答越深入，消耗越多
        </p>
        <div className="space-y-0.5">
          {options.map((level) => {
            const active = level === value
            return (
              <button
                key={level}
                type="button"
                onClick={() => {
                  onChange(level)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                  active ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                {level === "off" ? (
                  <ZapOff className="size-4 text-muted-foreground" />
                ) : (
                  <Zap
                    className={cn(
                      "size-4",
                      level === "high" && "text-primary",
                      level === "medium" && "text-primary/80",
                    )}
                  />
                )}
                <span className="flex-1">{THINKING_LEVEL_LABELS[level]}</span>
                {active && <Check className="size-4 text-primary" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
