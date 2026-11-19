"use client"

import { RectangleHorizontal, RectangleVertical, Square } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * 比例示意图标（预设图标样式的三种预置渲染，管理员可按预设行选择、不可上传）：
 * - outline：描边比例框（默认；按宽高比缩放的空心矩形，即上线以来的样式）
 * - solid：实底比例块（按宽高比缩放的实心矩形，选中态更醒目）
 * - shape：方向形状图标（等大 lucide 图标，横=RectangleHorizontal、竖=
 *   RectangleVertical、方=Square；比例信息由文字承载，排列最整齐）
 *
 * 管理端预设编辑器与用户端比例选择器（size-picker-popover）共用，
 * 保证两端所见一致。
 */
export type SizePresetIconStyle = "outline" | "solid" | "shape"

export function RatioIcon({
  size,
  icon = "outline",
  boxSize = 14,
  className,
}: {
  size: { width: number; height: number }
  icon?: SizePresetIconStyle
  /** 图标占位框边长（px）；shape 样式即 lucide size */
  boxSize?: number
  className?: string
}) {
  if (icon === "shape") {
    const Icon =
      size.width > size.height
        ? RectangleHorizontal
        : size.width < size.height
          ? RectangleVertical
          : Square
    return (
      <Icon
        size={boxSize}
        strokeWidth={2}
        className={cn("shrink-0", className)}
        aria-hidden
      />
    )
  }
  const max = boxSize
  const ratio =
    size.height > 0 ? size.width / size.height : Number.NaN
  let w: number, h: number
  if (!Number.isFinite(ratio) || ratio >= 1) {
    w = max
    h = Number.isFinite(ratio) ? Math.max(4, Math.round(max / ratio)) : max
  } else {
    h = max
    w = Math.max(4, Math.round(max * ratio))
  }
  return (
    <span
      className={cn("inline-flex items-center justify-center", className)}
      style={{ width: max, height: max }}
      aria-hidden
    >
      <span
        className={cn(
          "block rounded-[2px]",
          icon === "solid" ? "bg-current" : "border border-current opacity-80",
        )}
        style={{ width: w, height: h }}
      />
    </span>
  )
}

/** 图标样式循环顺序（编辑器点击预览切换用） */
const ICON_CYCLE: SizePresetIconStyle[] = ["outline", "solid", "shape"]

export function nextIconStyle(icon: SizePresetIconStyle | undefined): SizePresetIconStyle {
  const idx = ICON_CYCLE.indexOf(icon ?? "outline")
  return ICON_CYCLE[(idx + 1) % ICON_CYCLE.length]!
}
