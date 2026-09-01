/**
 * 广告横幅图标白名单（管理端表单与展示端共用）
 *
 * 只传字符串名（存 DB），展示端客户端组件按名查 lucide 图标，
 * 与侧边栏 icon 的处理方式一致（避免跨边界传组件）。
 */
export const BANNER_ICON_NAMES = [
  "megaphone",
  "ticket-percent",
  "sparkles",
  "gift",
  "zap",
  "flame",
  "party-popper",
  "rocket",
] as const

export type BannerIconName = (typeof BANNER_ICON_NAMES)[number]

export const BANNER_ICON_OPTIONS: { value: BannerIconName; label: string }[] = [
  { value: "megaphone", label: "喇叭" },
  { value: "ticket-percent", label: "优惠券" },
  { value: "sparkles", label: "闪光" },
  { value: "gift", label: "礼物" },
  { value: "zap", label: "闪电" },
  { value: "flame", label: "火焰" },
  { value: "party-popper", label: "庆祝" },
  { value: "rocket", label: "火箭" },
]

/** CTA 按钮默认文案 */
export const BANNER_LINK_LABEL_DEFAULT = "立即查看"
