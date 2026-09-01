/**
 * 模型勋章配色色板（需求 4）
 *
 * 勋章为模型名称后的柔和药丸（参考图1 的 "NEW"）。
 * 后台只选一个 key（存入 model.badge_color），渲染时映射到 tailwind class。
 * 每条同时给出浅底 + 深字（含 dark 模式），保证配色协调、可读。
 */

export const MODEL_BADGE_COLORS = {
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  green:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  red: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  orange:
    "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  purple:
    "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  pink: "bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300",
  cyan: "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
} as const

export type ModelBadgeColor = keyof typeof MODEL_BADGE_COLORS

/** 色板选项（label + 自身预览色块），供后台色板选择器渲染 */
export const MODEL_BADGE_COLOR_OPTIONS: {
  key: ModelBadgeColor
  label: string
  swatch: string
}[] = [
  { key: "blue", label: "蓝", swatch: "bg-blue-500" },
  { key: "green", label: "绿", swatch: "bg-emerald-500" },
  { key: "red", label: "红", swatch: "bg-rose-500" },
  { key: "orange", label: "橙", swatch: "bg-orange-500" },
  { key: "purple", label: "紫", swatch: "bg-violet-500" },
  { key: "pink", label: "粉", swatch: "bg-pink-500" },
  { key: "cyan", label: "青", swatch: "bg-cyan-500" },
  { key: "amber", label: "琥珀", swatch: "bg-amber-500" },
]

/** 取勋章样式 class；未知/缺省回退蓝色 */
export function badgeClass(color?: string | null): string {
  if (color && color in MODEL_BADGE_COLORS) {
    return MODEL_BADGE_COLORS[color as ModelBadgeColor]
  }
  return MODEL_BADGE_COLORS.blue
}
