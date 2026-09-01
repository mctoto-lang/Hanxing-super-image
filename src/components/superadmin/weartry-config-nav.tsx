"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

const SECTIONS = [
  { title: "场景预设", url: "/platform/weartry-config/scenes" },
  { title: "图片方向", url: "/platform/weartry-config/directions" },
  { title: "提示词模板", url: "/platform/weartry-config/prompts" },
]

/** 穿戴图片管理配置中心子导航（与商品图片配置完全分割） */
export function WeartryConfigNav() {
  const pathname = usePathname()
  return (
    <nav className="flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
      {SECTIONS.map((s) => {
        const active =
          pathname === s.url || pathname.startsWith(s.url + "/")
        return (
          <Link
            key={s.url}
            href={s.url}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              active
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s.title}
          </Link>
        )
      })}
    </nav>
  )
}
