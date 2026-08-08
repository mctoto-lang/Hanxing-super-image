import type { UserContext } from "@/lib/auth/session"
import type { ModuleName } from "@/db/schema"
import type { NavItem, NavSecondaryItem, SidebarUser } from "./types"

/**
 * 根据当前用户上下文构建侧边栏数据（手册 §7.1、§5.1、§5.2）
 *
 * 主导航：按 enabledModules ∩ allowedPages 过滤；
 * 二级导航：超管 → 平台管理；企业管理员 → 企业管理。
 *
 * icon 只传字符串名（在客户端 lucideIconMap 内查表），
 * 避免函数从服务端组件跨边界传到客户端组件。
 */

/** 模块 → 主菜单项配置 */
const MODULE_NAV: Record<ModuleName, { title: string; url: string; icon: string }> = {
  create: { title: "创作", url: "/create", icon: "create" },
  assets: { title: "资产管理", url: "/assets", icon: "assets" },
  workspace: { title: "批量生图", url: "/workspace", icon: "workspace" },
  product: { title: "商品主图", url: "/product", icon: "product" },
  settings: { title: "个人设置", url: "/settings", icon: "settings" },
}

/** 构建主导航（按可访问模块过滤） */
export function buildNavMain(ctx: UserContext): NavItem[] {
  return ctx.accessibleModules
    .map((m) => MODULE_NAV[m])
    .filter(Boolean)
    .map(({ title, url, icon }) => ({ title, url, icon }))
}

/** 构建二级导航（管理入口） */
export function buildNavSecondary(ctx: UserContext): NavSecondaryItem[] {
  if (ctx.user.isSuperAdmin) {
    return [{ title: "平台管理", url: "/platform", icon: "shield" }]
  }
  if (
    ctx.user.enterpriseRole === "owner" ||
    ctx.user.enterpriseRole === "admin"
  ) {
    return [{ title: "企业管理", url: "/admin", icon: "building" }]
  }
  return []
}

/** 构建用户卡数据 */
export function buildSidebarUser(ctx: UserContext): SidebarUser {
  const roleLabel = ctx.user.isSuperAdmin
    ? "超管"
    : ctx.user.enterpriseRole === "owner"
      ? "企业主"
      : ctx.user.enterpriseRole === "admin"
        ? "企业管理员"
        : "成员"
  return {
    name: ctx.user.name || ctx.user.username,
    username: ctx.user.username,
    avatar: null,
    roleLabel,
    groupName: ctx.group?.name ?? null,
  }
}
