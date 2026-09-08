"use client"

import * as React from "react"
import { Layers, Sparkles } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

/**
 * 样机渲染页内 Tab 导航（模板渲染 / 批量替换）
 *
 * 样式与商品图片页功能 Tab 一致（shadcn Tabs）；value=路由地址，
 * 切换即 router.push，当前 pathname 决定高亮。侧边栏保持一个「样机渲染」入口。
 */
const TABS = [
  { href: "/mockup", label: "模板渲染", icon: Layers },
  { href: "/mockup/batch", label: "批量替换", icon: Sparkles },
]

export function MockupPageTabs() {
  const pathname = usePathname()
  const router = useRouter()
  // /mockup 需精确匹配，避免 /mockup/batch 同时高亮
  const active =
    TABS.find((t) =>
      t.href === "/mockup" ? pathname === "/mockup" : pathname.startsWith(t.href),
    )?.href ?? "/mockup"

  return (
    <Tabs
      value={active}
      onValueChange={(v) => {
        if (v && v !== active) router.push(v)
      }}
      className="min-w-0"
    >
      <TabsList>
        {TABS.map(({ href, label, icon: Icon }) => (
          <TabsTrigger key={href} value={href} className="px-3">
            <Icon />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
