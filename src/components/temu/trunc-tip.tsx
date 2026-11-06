import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { EmptyHint } from "@/components/temu/empty-hint"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * TEMU 全站统一「截断文本 + Tooltip 悬浮看全文」（2026-11-05 口径：悬停信息
 * 弃用原生 title，统一 Tooltip 组件）。空值显示感叹号占位（EmptyHint 口径）。
 * className 控制宽度/字体等（如 "max-w-24 font-mono"），自带 block truncate text-xs。
 */
export function TruncTip({
  text,
  className,
  children,
}: {
  text: string | null | undefined
  /** 附加类（宽度/字色/字体），内部恒有 block truncate text-xs */
  className?: string
  /** 覆盖默认触发器文案（如需富文本）；悬浮全文仍用 text */
  children?: ReactNode
}) {
  if (!text) return <EmptyHint />
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn("block truncate text-xs", className)}>
            {children ?? text}
          </span>
        }
      />
      <TooltipContent className="max-w-sm break-all">{text}</TooltipContent>
    </Tooltip>
  )
}
