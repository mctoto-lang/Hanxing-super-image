"use client"

import {
  ImagePlus,
  Images,
  LayoutGrid,
  Package,
  Settings,
  ShieldCheck,
  Building2,
  type LucideIcon,
} from "lucide-react"

/**
 * 图标名 → 组件映射（客户端侧）
 *
 * 服务端只传字符串图标名，客户端在此查表，避免函数跨 RSC 边界。
 */
export const lucideIconMap: Record<string, LucideIcon> = {
  create: ImagePlus,
  assets: Images,
  workspace: LayoutGrid,
  product: Package,
  settings: Settings,
  shield: ShieldCheck,
  building: Building2,
}

export function NavIcon({ name }: { name?: string }) {
  if (!name) return null
  const Icon = lucideIconMap[name]
  return Icon ? <Icon /> : null
}
