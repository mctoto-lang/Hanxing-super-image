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

/** WCAG 相对亮度（0~1，入参须为 normalizeBadgeColor 产出的 #RRGGBB） */
function relativeLuminance(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * channel(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * channel(parseInt(hex.slice(5, 7), 16))
  )
}

/**
 * 勋章前景色自适应：按 WCAG 对比度取黑/白中更高的一方（持平取白），
 * 颜色来自超管自由输入，浅色底配白字不可读，故实底下文字色随亮度切换。
 */
export function pickBadgeTextColor(bg: string): string {
  const l = relativeLuminance(bg)
  const whiteContrast = 1.05 / (l + 0.05)
  const blackContrast = (l + 0.05) / 0.05
  return whiteContrast >= blackContrast ? "#ffffff" : "#000000"
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
