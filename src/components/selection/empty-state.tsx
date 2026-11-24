import type * as React from "react"

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"

/**
 * 选品工具空态（各页统一）：图标 + 标题 + 说明 + 可选操作。
 * 「整个模块还没数据」与「筛选无结果」用同一组件，文案由调用方区分。
 */
export function SelectionEmpty({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: React.ReactNode
  title: string
  description?: string
  /** 引导操作（如「前往数据任务」） */
  action?: React.ReactNode
  className?: string
}) {
  return (
    <Empty className={cn("rounded-xl border py-12", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle className="text-sm font-medium">{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}
