"use client"

import * as React from "react"
import { ChevronDown, ChevronRight, Warehouse } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * 收货仓分组卡（自动创建发货 / 自动发货弹窗共用）：组头 = 收货仓名 + 统计 + 可选的
 * 组级设置区（自动发货：重量/体积/物流/取货时间），点击组头折叠/展开组内明细。
 */

/** 组内明细表头单元格 */
export const GROUP_TH =
  "bg-muted/50 px-2.5 py-1.5 text-left font-medium whitespace-nowrap text-muted-foreground"
/** 组内明细表体单元格 */
export const GROUP_TD = "px-2.5 py-1.5 align-middle"

export function WarehouseGroupCard({
  name,
  meta,
  badge,
  alert,
  header,
  defaultOpen = true,
  children,
}: {
  /** 收货仓名 */
  name: string
  /** 组头统计文案（如「7 单 · 420 件 · 15 包」） */
  meta?: React.ReactNode
  /** 组头状态徽标（如「物流待处理」） */
  badge?: React.ReactNode
  /** 需要用户处理的组：琥珀色边框 */
  alert?: boolean
  /** 组头下方的组级设置/状态区 */
  header?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <section
      className={cn(
        "overflow-hidden rounded-md border",
        alert && "border-amber-400 dark:border-amber-500/50",
      )}
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Warehouse className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">收货仓 · {name}</span>
        {badge}
        {meta && (
          <span className="ml-auto whitespace-nowrap text-muted-foreground tabular-nums">
            {meta}
          </span>
        )}
      </button>
      {header && <div className="space-y-2 border-t px-3 py-2.5">{header}</div>}
      {open && children}
    </section>
  )
}
