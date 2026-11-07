import { CircleAlert } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** 空值占位：圆形感叹号 + 悬浮提示（数值为空或无数据）——TEMU 各页空值统一口径。
 *  独立模块避免 products-table ↔ trunc-tip 循环依赖（products-table 原路径再导出保持兼容）。
 *  center：图标在单元格内水平居中（口径：数值列数字保持左对齐、仅空值图标居中）。 */
export function EmptyHint({ center = false }: { center?: boolean }) {
  const hint = (
    <Tooltip>
      <TooltipTrigger className="cursor-default text-muted-foreground" aria-label="数值为空或无数据">
        <CircleAlert className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="text-xs">数值为空或无数据</TooltipContent>
    </Tooltip>
  )
  return center ? <span className="flex w-full justify-center">{hint}</span> : hint
}
