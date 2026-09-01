"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

const SECTIONS = [
  { title: "上架平台", url: "/platform/product-config/platforms" },
  { title: "语言", url: "/platform/product-config/languages" },
  { title: "提示词模板", url: "/platform/product-config/prompts" },
  { title: "图片方向", url: "/platform/product-config/directions" },
  { title: "尺寸规范", url: "/platform/product-config/size-specs" },
  { title: "AI 对话模型", url: "/platform/product-config/ai-model" },
]

/** 商品主图配置中心子导航（平台管理 → 商品主图配置 内部） */
export function ProductConfigNav() {
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
