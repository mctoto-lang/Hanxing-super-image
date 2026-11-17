"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { NAV_DEFAULT_TITLES } from "@/lib/modules"

/**
 * 顶部 header 当前页面标题（手册 §7.1）
 *
 * 按 pathname 最长前缀匹配路由→标题。未命中则不渲染（header 保持原样）。
 * 在 SidebarTrigger 与分隔线之后展示，作为全局页面定位。
 *
 * TEMU 域两处（/temu、/templates/temu）跟随企业自定义导航名：由
 * dashboard-shell（服务端）resolveNavTitle 解析后经 temuTitle 传入，
 * 口径与 sidebar-data 的 t("temu") 一致（测试企业即「数据中心」）；
 * 其余键（video/selection 等）暂不接入，维持静态标题。
 */

/** 路由前缀（按长度降序优先）→ 标题 */
const ROUTE_TITLES: { prefix: string; title: string }[] = [
  // 业务模块（dashboard）
  { prefix: "/create", title: "自由创作" },
  { prefix: "/chat", title: "AI 对话" },
  { prefix: "/weartry", title: "穿戴图片" },
  { prefix: "/assets", title: "资产管理" },
  { prefix: "/workspace", title: "批量生图" },
  { prefix: "/product", title: "商品图片" },
  { prefix: "/mockup", title: "样机渲染" },
  // 库存管理
  { prefix: "/inventory/production", title: "生产规划" },
  { prefix: "/inventory/stock", title: "库存数据" },
  { prefix: "/inventory", title: "库存管理" },
  // 视频生成（占位）
  { prefix: "/video/create", title: "视频创作" },
  { prefix: "/video/replicate", title: "视频复刻" },
  { prefix: "/video/commerce", title: "带货视频" },
  { prefix: "/video/batch", title: "批量生成" },
  { prefix: "/video/works", title: "我的作品" },
  { prefix: "/video", title: "视频生成" },
  // 选品工具（占位）
  { prefix: "/selection/discover", title: "选品发现" },
  { prefix: "/selection/market", title: "市场分析" },
  { prefix: "/selection/competitor", title: "竞品监控" },
  { prefix: "/selection/reviews", title: "评论洞察" },
  { prefix: "/selection/tasks", title: "数据任务" },
  { prefix: "/selection/mine", title: "我的选品" },
  { prefix: "/selection", title: "选品工具" },
  // 店铺管理（标题在 matchTitle 内由 temuTitle 动态替换，静态值仅为缺省口径）
  { prefix: "/temu", title: "TEMU" },
  // 模板管理（同上，显示 `${temuTitle}刊登模板`）
  { prefix: "/templates/temu", title: "TEMU刊登模板" },
  { prefix: "/templates", title: "生图提示词模板" },
  // 企业管理（admin）
  { prefix: "/admin", title: "企业管理" },
  { prefix: "/admin/stats", title: "数据看板" },
  { prefix: "/admin/users", title: "成员管理" },
  { prefix: "/admin/models", title: "生图模型" },
  { prefix: "/admin/chat-models", title: "对话模型" },
  { prefix: "/admin/groups", title: "权限组" },
  { prefix: "/admin/credits", title: "积分流水" },
  { prefix: "/admin/logs", title: "操作日志" },
  // 平台管理（superadmin）
  { prefix: "/platform", title: "数据看板" },
  { prefix: "/platform/enterprises", title: "企业管理" },
  { prefix: "/platform/plans", title: "订阅套餐" },
  { prefix: "/platform/users", title: "平台用户" },
  { prefix: "/platform/models", title: "生图模型" },
  { prefix: "/platform/chat-models", title: "对话模型" },
  { prefix: "/platform/product-config", title: "商品图片配置" },
  // 旧路由已并入商品图片配置中心，保留映射避免重定向前标题回退
  { prefix: "/platform/product-directions", title: "商品图片配置" },
  { prefix: "/platform/size-specs", title: "商品图片配置" },
  { prefix: "/platform/weartry-config", title: "穿戴图片管理" },
  { prefix: "/platform/mockup-config", title: "样机提示词" },
  { prefix: "/platform/banners", title: "广告横幅" },
  { prefix: "/platform/system", title: "系统设置" },
]

/** 导出供单测断言（sidebar-nav-overrides.test.ts） */
export function matchTitle(pathname: string, temuTitle: string): string | null {
  // 精确或前缀（prefix + "/"）匹配，避免 /a 误命中 /admin 等
  let best: { prefix: string; title: string } | null = null
  for (const r of ROUTE_TITLES) {
    if (pathname === r.prefix || pathname.startsWith(r.prefix + "/")) {
      if (!best || r.prefix.length > best.prefix.length) best = r
    }
  }
  if (!best) return null
  // TEMU 域两处替换为传入的企业自定义导航名（表内静态标题仅为缺省口径）
  if (best.prefix === "/templates/temu") return `${temuTitle}刊登模板`
  if (best.prefix === "/temu") return temuTitle
  return best.title
}

export function HeaderTitle({
  className,
  temuTitle = NAV_DEFAULT_TITLES.temu,
}: {
  className?: string
  /** TEMU 域页头标题（企业自定义导航名；缺省回落默认「TEMU」） */
  temuTitle?: string
}) {
  const pathname = usePathname()
  const title = matchTitle(pathname, temuTitle)
  if (!title) return null
  return (
    <h1 className={cn("text-sm font-medium text-foreground truncate", className)}>
      {title}
    </h1>
  )
}
