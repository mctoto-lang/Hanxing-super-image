import * as React from "react"
import { cn } from "@/lib/utils"
import { badgeClass } from "@/lib/model-badges"

/**
 * 模型名称后的勋章（需求 4 + 细化）
 *
 * - 圆角偏方（rounded-md，非药丸 rounded-full）。
 * - 文字带 shimmer 流光（globals.css .badge-shimmer）。
 * - 配色取自预设色板 badgeClass(color)。
 */
export function ModelBadge({
  text,
  color,
  className,
}: {
  text: string
  color?: string | null
  className?: string
}) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-px text-[10px] font-semibold leading-none badge-shimmer",
        badgeClass(color),
        className,
      )}
    >
      {text}
    </span>
  )
}
