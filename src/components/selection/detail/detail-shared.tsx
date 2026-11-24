"use client"

import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/** 详情弹窗分区标题 */
export function Section({
  title,
  icon,
  children,
  className,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("space-y-2", className)}>
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        {icon}
        {title}
      </h4>
      {children}
    </section>
  )
}

/** 指标格 */
export function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  )
}

/** 键值对列表（规格属性等）；超出 limit 折叠，点击展开 */
export function Kv({
  items,
  limit = 12,
}: {
  items: Array<[string, string]>
  limit?: number
}) {
  const [expanded, setExpanded] = React.useState(false)
  const shown = expanded ? items : items.slice(0, limit)
  if (items.length === 0) return null
  return (
    <div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {shown.map(([k, v]) => (
          <React.Fragment key={k + v}>
            <Tooltip>
              <TooltipTrigger render={<dt className="max-w-32 truncate text-muted-foreground" />}>
                {k}
              </TooltipTrigger>
              <TooltipContent>{k}</TooltipContent>
            </Tooltip>
            <dd className="min-w-0 break-words">{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      {items.length > limit ? (
        <button
          type="button"
          className="mt-1 text-[11px] text-primary hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : `展开全部 ${items.length} 项`}
        </button>
      ) : null}
    </div>
  )
}

/** 标签行 */
export function Chips({ items, max }: { items: string[]; max?: number }) {
  const list = max ? items.slice(0, max) : items
  if (list.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((t, i) => (
        <span key={t + i} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {t}
        </span>
      ))}
      {max && items.length > max ? (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          +{items.length - max}
        </span>
      ) : null}
    </div>
  )
}
