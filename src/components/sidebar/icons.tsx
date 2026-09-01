"use client"

import {
  Image as ImageIcon,
  ImagePlus,
  Images,
  LayoutGrid,
  LibraryBig,
  MessageSquareText,
  Package,
  Box,
  Settings,
  ShieldCheck,
  Shirt,
  Building2,
  type LucideIcon,
} from "lucide-react"

/**
 * 图标名 → 组件映射（客户端侧）
 *
 * 服务端只传字符串图标名，客户端在此查表，避免函数跨 RSC 边界。
 */
export const lucideIconMap: Record<string, LucideIcon> = {
  image: ImageIcon,
  create: ImagePlus,
  chat: MessageSquareText,
  assets: Images,
  workspace: LayoutGrid,
  product: Package,
  weartry: Shirt,
  mockup: Box,
  settings: Settings,
  shield: ShieldCheck,
  building: Building2,
  library: LibraryBig,
}

export function NavIcon({ name }: { name?: string }) {
  if (!name) return null
  const Icon = lucideIconMap[name]
  return Icon ? <Icon /> : null
}
