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

/** 套餐勋章药丸：图标 + 可选套餐名 */
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
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border font-medium whitespace-nowrap",
        size === "sm" ? "h-5 px-1.5 text-[10px]" : "h-7 px-2.5 text-xs",
        isExpired && "opacity-45 saturate-0",
        className,
      )}
      style={{
        color: c,
        backgroundColor: `${c}1f`, // 12% 透明度背景
        borderColor: `${c}59`, // 35% 透明度描边
      }}
      title={isExpired ? "套餐已过期" : undefined}
    >
      <BadgeIcon iconKey={iconKey} color={c} className={size === "sm" ? "size-3" : "size-4"} />
      {name ? <span>{name}</span> : null}
      {isExpired && name ? <span>已过期</span> : null}
    </span>
  )
}
