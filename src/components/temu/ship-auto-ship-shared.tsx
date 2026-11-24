"use client"

import { Circle, CircleCheck, CircleSlash, CircleX } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { TemuShipLogisticsOption } from "@/server/actions/temu-ship"

/** 自动发货向导阶段：预览确认 → 逐组执行 → 完成 */
export type Phase = "confirm" | "running" | "done"

export type RowStatus = "pending" | "printing" | "shipping" | "done" | "failed" | "skipped"

export interface RowState {
  status: RowStatus
  /** 失败原因（悬停状态图标查看） */
  error?: string
}

/** 库存参考（getShipInventoryRefAction 行子集）：totalQty=库存合计，cartonQty=档案装箱数；
 *  shipState=null 表示未建档（接口对未建档货号同样返回 totalQty=0 的行）；
 *  snKey=归一化货号（B049≡B49 同档案同 key，扣减累计按它合并） */
export type InvRef = Record<
  string,
  {
    totalQty: number
    cartonQty: number | null
    shipState?: "auto" | "manual" | null
    snKey?: string
  }
>

/** 组级运行参数（分组卡片上报，执行时取用） */
export interface GroupRuntime {
  /** 重量/体积回填 + 比价中 */
  loading: boolean
  error: string | null
  weightKg: string
  volume: string
  /** 官方未返回体积，按 0.01 兜底 */
  volumeFallback: boolean
  option: TemuShipLogisticsOption | null
  pickTimeMs: number | null
}

export const DEFAULT_RUNTIME: GroupRuntime = {
  loading: true,
  error: null,
  weightKg: "",
  volume: "",
  volumeFallback: false,
  option: null,
  pickTimeMs: null,
}

/** 逐行状态图标（执行阶段；圆形图标口径同备货批量申报），失败原因悬停可见 */
export function RowStatusIcon({ state }: { state: RowState | undefined }) {
  const status = state?.status ?? "pending"
  if (status === "printing" || status === "shipping") {
    return <DashRing className="size-3.5" />
  }
  if (status === "done") {
    return <CircleCheck className="size-3.5 text-emerald-500" aria-label="发货成功" />
  }
  if (status === "failed") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex cursor-default" />}>
            <CircleX className="size-3.5 text-red-500" aria-label="失败" />
          </TooltipTrigger>
          <TooltipContent className="max-w-sm break-all">{state?.error ?? "发货失败"}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  if (status === "skipped") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex cursor-default" />}>
            <CircleSlash className="size-3.5 text-muted-foreground/60" aria-label="已跳过" />
          </TooltipTrigger>
          <TooltipContent className="max-w-sm break-all">
            {state?.error ?? "已跳过：未处理（保持待装箱状态）"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  return <Circle className="size-3.5 text-muted-foreground/40" aria-label="待处理" />
}
