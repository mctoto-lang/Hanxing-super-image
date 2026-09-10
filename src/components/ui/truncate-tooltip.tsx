"use client"

import * as React from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * 截断文本 + 悬停/聚焦完整提示
 *
 * 文本被截断（横向 truncate 或纵向 line-clamp-N 溢出）时悬停或键盘聚焦
 * 弹出 Tooltip 显示完整内容；未截断时不弹出（避免短文本弹冗余提示）。
 * open 受控：触发时实测元素溢出再放行打开。
 */
export function TruncateTooltip({
  text,
  className,
}: {
  text: string
  /** 作用于文本元素（须含 truncate / line-clamp-N 等截断类） */
  className?: string
}) {
  const ref = React.useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = React.useState(false)

  const isTruncated = () => {
    const el = ref.current
    if (!el) return false
    return (
      el.scrollWidth > el.clientWidth + 1 ||
      el.scrollHeight > el.clientHeight + 1
    )
  }

  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={(next) => setOpen(next && isTruncated())}>
        {/* tabIndex 使 p 可聚焦——键盘用户 Tab 到截断文本也能看到全文 */}
        <TooltipTrigger
          render={<p ref={ref} tabIndex={0} className={className} />}
        >
          {text}
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="whitespace-pre-wrap break-words text-left">{text}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
