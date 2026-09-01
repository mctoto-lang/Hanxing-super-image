"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

/**
 * 顶部 header 当前页面标题（手册 §7.1）
 *
 * 按 pathname 最长前缀匹配路由→标题。未命中则不渲染（header 保持原样）。
 * 在 SidebarTrigger 与分隔线之后展示，作为全局页面定位。
 */

/** 路由前缀（按长度降序优先）→ 标题 */
const ROUTE_TITLES: { prefix: string; title: string }[] = [
  // 业务模块（dashboard）
  { prefix: "/create", title: "自由创作" },
  { prefix: "/assets", title: "资产管理" },
  { prefix: "/workspace", title: "批量生图" },
  { prefix: "/product", title: "商品图片" },
  { prefix: "/mockup", title: "样机渲染" },
  { prefix: "/settings", title: "个人设置" },
  // 模板管理
  { prefix: "/templates", title: "提示词模板" },
  // 企业管理（admin）
  { prefix: "/admin", title: "企业管理" },
  { prefix: "/admin/users", title: "成员管理" },
  { prefix: "/admin/models", title: "模型配置" },
  { prefix: "/admin/chat-models", title: "对话模型" },
  { prefix: "/admin/groups", title: "权限组" },
  { prefix: "/admin/credits", title: "积分流水" },
  { prefix: "/admin/logs", title: "操作日志" },
  // 平台管理（superadmin）
  { prefix: "/platform", title: "数据看板" },
  { prefix: "/platform/enterprises", title: "企业管理" },
  { prefix: "/platform/users", title: "平台用户" },
  { prefix: "/platform/models", title: "预置模型" },
  { prefix: "/platform/chat-models", title: "对话模型" },
  { prefix: "/platform/product-config", title: "商品图片配置" },
  { prefix: "/platform/system", title: "系统设置" },
]

function matchTitle(pathname: string): string | null {
  // 精确或前缀（prefix + "/"）匹配，避免 /a 误命中 /admin 等
  let best: { prefix: string; title: string } | null = null
  for (const r of ROUTE_TITLES) {
    if (pathname === r.prefix || pathname.startsWith(r.prefix + "/")) {
      if (!best || r.prefix.length > best.prefix.length) best = r
    }
  }
  return best?.title ?? null
}

export function HeaderTitle({ className }: { className?: string }) {
  const pathname = usePathname()
  const title = matchTitle(pathname)
  if (!title) return null
  return (
    <h1 className={cn("text-sm font-medium text-foreground truncate", className)}>
      {title}
    </h1>
  )
}
