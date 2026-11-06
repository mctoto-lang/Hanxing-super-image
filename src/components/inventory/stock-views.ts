import type { LucideIcon } from "lucide-react"
import { ArrowLeftRight, Boxes, ChartColumn, PackagePlus } from "lucide-react"

/** 库存数据页二级视图常量（纯数据模块，server/client 共用；
 *  不能放 "use client" 文件里——server 侧拿到的是引用代理，无法 .includes） */

export interface StockViewItem {
  value: "overview" | "movement" | "analysis" | "replenish"
  label: string
  icon: LucideIcon
}

export const STOCK_VIEWS: readonly StockViewItem[] = [
  { value: "overview", label: "库存总览", icon: Boxes },
  { value: "movement", label: "库存出入", icon: ArrowLeftRight },
  { value: "analysis", label: "库存分析", icon: ChartColumn },
  { value: "replenish", label: "补货建议", icon: PackagePlus },
]

export type StockView = (typeof STOCK_VIEWS)[number]["value"]

export const STOCK_VIEW_VALUES: readonly StockView[] = STOCK_VIEWS.map((v) => v.value)
