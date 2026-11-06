"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** 生产域共享类型与小件（拆分自 production-panel） */

export type Factory = {
  id: string
  code: string
  name: string
  note: string | null
  enabled: boolean
}

/** 北京时间今日日期串（与服务端 temuDayStr 同口径，和浏览器本地时区解耦） */
export const todayStr = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })

export function ActionButton({
  title,
  icon,
  onClick,
}: {
  title: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0"
            onClick={onClick}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side="top">{title}</TooltipContent>
    </Tooltip>
  )
}
