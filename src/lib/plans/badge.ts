/**
 * 套餐勋章基础数据（服务端/客户端共用，纯数据无 React 依赖）
 *
 * iconKey 只存字符串名（与侧边栏 icon 同策略），客户端在
 * PlanBadge 组件内查 lucideIconMap 渲染，避免组件跨序列化边界。
 */

/** 预设勋章图标 key 白名单（与 plan-badge.tsx 的 BADGE_ICON_MAP 一一对应） */
export const BADGE_ICON_KEYS = [
  "crown",
  "gem",
  "medal",
  "rocket",
  "star",
  "zap",
  "leaf",
  "shield",
  "flame",
  "award",
  "trophy",
  "sparkles",
] as const

export type BadgeIconKey = (typeof BADGE_ICON_KEYS)[number]

/** 校验 iconKey 是否在预设图标库内（不在则回退 medal） */
export function normalizeBadgeIconKey(key: string | null | undefined): BadgeIconKey {
  return (BADGE_ICON_KEYS as readonly string[]).includes(key ?? "")
    ? (key as BadgeIconKey)
    : "medal"
}

/** 勋章颜色校验（#RRGGBB），不合法回退默认紫 */
export function normalizeBadgeColor(color: string | null | undefined): string {
  return /^#[0-9a-fA-F]{6}$/.test(color ?? "") ? (color as string) : "#8b5cf6"
}

/** 侧边栏/弹窗展示用的套餐摘要（从订阅 join 套餐得到） */
export interface PlanBadgeInfo {
  planId: string
  planName: string
  iconKey: string
  color: string
  creditsPerCycle: number
  cycleDays: number
  maxMembers: number | null
  startsAt: string // ISO
  expiresAt: string // ISO
  lastGrantPeriodEnd: string | null // ISO
  /** expiresAt <= now 时视为已过期（勋章置灰、停止发放） */
  isExpired: boolean
}
