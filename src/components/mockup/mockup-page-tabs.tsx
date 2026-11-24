"use client"

import type * as React from "react"
import { Layers, Sparkles } from "lucide-react"
import { usePathname } from "next/navigation"
import { PageTabs } from "@/components/shared/page-tabs"

/**
 * 样机渲染页内 Tab 导航（模板渲染 / 批量替换）
 *
 * 样式与商品图片页功能 Tab 一致（PageTabs sm 尺寸）；value=路由地址，
 * 切换即 Link 跳转，当前 pathname 决定高亮；宽度不够折叠为单 tab 下拉
 * （右侧工具以 children 传入，与全站口径一致地参与折叠判定）。
 * 侧边栏保持一个「样机渲染」入口。
 */
const TABS = [
  { href: "/mockup", label: "模板渲染", icon: Layers },
  { href: "/mockup/batch", label: "批量替换", icon: Sparkles },
]

export function MockupPageTabs({
  children,
  className,
}: {
  /** 右侧工具组（参与折叠判定，透传给 PageTabs） */
  children?: React.ReactNode
  /** 追加到整行（透传给 PageTabs，如 shrink-0 / 覆盖行间距） */
  className?: string
}) {
  const pathname = usePathname()
  // /mockup 需精确匹配，避免 /mockup/batch 同时高亮
  const active =
    TABS.find((t) =>
      t.href === "/mockup" ? pathname === "/mockup" : pathname.startsWith(t.href),
    )?.href ?? "/mockup"

  return (
    <PageTabs
      size="sm"
      className={className}
      tabs={TABS.map(({ href, label, icon: Icon }) => ({
        value: href,
        label,
        href,
        icon: <Icon />,
      }))}
      value={active}
    >
      {children}
    </PageTabs>
  )
}
