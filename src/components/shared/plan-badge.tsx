"use client"

import {
  Award,
  Crown,
  Flame,
  Gem,
  Leaf,
  Medal,
  Rocket,
  Shield,
  Sparkles,
  Star,
  Trophy,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  normalizeBadgeColor,
  normalizeBadgeIconKey,
  pickBadgeTextColor,
  type BadgeIconKey,
} from "@/lib/plans/badge"

/**
 * 套餐勋章组件（iconKey 字符串 → lucide 图标查表，服务端只传字符串）
 *
 * 颜色为超管自选 hex，用 inline style 着色（Tailwind 无法编译动态色值）；
 * isExpired 时置灰（到期停止发放的视觉语义）。
 */

export const BADGE_ICON_MAP: Record<BadgeIconKey, LucideIcon> = {
  crown: Crown,
  gem: Gem,
  medal: Medal,
  rocket: Rocket,
  star: Star,
  zap: Zap,
  leaf: Leaf,
  shield: Shield,
  flame: Flame,
  award: Award,
  trophy: Trophy,
  sparkles: Sparkles,
}

/** 纯图标勋章（图标网格选择器 / 列表预览用） */
export function BadgeIcon({
  iconKey,
  color,
  className,
}: {
  iconKey: string | null | undefined
  color: string | null | undefined
  className?: string
}) {
  const Icon = BADGE_ICON_MAP[normalizeBadgeIconKey(iconKey)]
  return (
    <Icon
      className={cn("size-3.5", className)}
      style={{ color: normalizeBadgeColor(color) }}
    />
  )
}

/** 套餐勋章徽章（实底、方角 rounded-[4px]，与 TEMU 徽章口径一致）：图标 + 可选套餐名；文字色按底色亮度自适应黑/白 */
export function PlanBadge({
  iconKey,
  color,
  name,
  isExpired = false,
  size = "sm",
  className,
}: {
  iconKey: string | null | undefined
  color: string | null | undefined
  /** 套餐名（不传则只渲染图标） */
  name?: string | null
  isExpired?: boolean
  size?: "sm" | "md"
  className?: string
}) {
  const c = normalizeBadgeColor(color)
  const fg = pickBadgeTextColor(c) // 浅色底黑字 / 深色底白字，避免浅色底白字不可读
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-[4px] border font-medium whitespace-nowrap",
        size === "sm" ? "h-5 px-1.5 text-[10px]" : "h-7 px-2.5 text-xs",
        isExpired && "opacity-45 saturate-0",
        className,
      )}
      style={{
        color: fg,
        backgroundColor: c, // 品牌色纯实底
        borderColor: c, // 描边同色无痕
      }}
      title={isExpired ? "套餐已过期" : undefined}
    >
      <BadgeIcon iconKey={iconKey} color={fg} className={size === "sm" ? "size-3" : "size-4"} />
      {name ? <span>{name}</span> : null}
      {isExpired && name ? <span>已过期</span> : null}
    </span>
  )
}
