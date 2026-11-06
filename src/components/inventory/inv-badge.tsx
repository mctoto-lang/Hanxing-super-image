import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * 库存域徽章：描边（outline）+ 浅底 + 状态圆点口径，
 * 圆角力度与 TEMU 页面徽章统一为方角 rounded-[4px]。
 *
 * labels.ts 的 *_BADGE 记录提供配色串、*_DOT 记录提供圆点色；
 * 状态类徽章（库存六态/生产/发货状态）传 dot，类型类（流水类型）不传。
 */

export function InvBadge({
  className,
  dot,
  children,
}: {
  className?: string
  /** 圆点色类（如 "bg-emerald-500"）；不传则无圆点 */
  dot?: string
  children: React.ReactNode
}) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 rounded-[4px]", className)}>
      {dot ? <span className={cn("size-1.5 shrink-0 rounded-full", dot)} /> : null}
      {children}
    </Badge>
  )
}
