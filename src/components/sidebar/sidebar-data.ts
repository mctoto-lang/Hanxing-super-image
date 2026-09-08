import type { UserContext } from "@/lib/auth/session"
import { roleLabel } from "@/lib/auth/permissions"
import type { ModuleName } from "@/db/schema"
import type { PlanBadgeInfo } from "@/lib/plans/badge"
import type { NavItem, SidebarUser } from "./types"

/**
 * 根据当前用户上下文构建侧边栏数据（手册 §7.1、§5.1、§5.2）
 *
 * 主导航：AI 对话（独立顶级项）、图片生成（按 enabledModules ∩ allowedPages 过滤）、
 * 模板管理（提示词模板，跟随 workspace 模块）、企业管理（owner/admin）、
 * 平台管理（仅超管，位于工作台分组内，与企业管理同构）。
 *
 * icon 只传字符串名（在客户端 lucideIconMap 内查表），
 * 避免函数从服务端组件跨边界传到客户端组件。
 */

/** 模块 → 菜单项配置 */
const MODULE_NAV: Record<ModuleName, { title: string; url: string; icon: string }> = {
  create: { title: "自由创作", url: "/create", icon: "create" },
  chat: { title: "AI 对话", url: "/chat", icon: "chat" },
  assets: { title: "资产管理", url: "/assets", icon: "assets" },
  workspace: { title: "批量生图", url: "/workspace", icon: "workspace" },
  product: { title: "商品图片", url: "/product", icon: "product" },
  weartry: { title: "穿戴图片", url: "/weartry", icon: "shirt" },
  mockup: { title: "样机渲染", url: "/mockup", icon: "mockup" },
  settings: { title: "个人设置", url: "/settings", icon: "settings" },
}

/**
 * 「图片生成」分组下子项的固定展示顺序（业务模块，不含 settings）。
 * 与 MODULE_NAMES 的顺序无关，专门控制侧边栏内子菜单呈现。
 */
const IMAGE_GEN_ORDER: Exclude<ModuleName, "settings">[] = [
  "create",
  "workspace",
  "product",
  "weartry",
  "mockup",
  "assets",
]

/**
 * 「企业管理」分组下子项（页面均在 /admin/* 下，与聚合页卡片一致）。
 */
const ADMIN_NAV: { title: string; url: string }[] = [
  { title: "数据看板", url: "/admin/stats" },
  { title: "成员管理", url: "/admin/users" },
  { title: "生图模型", url: "/admin/models" },
  { title: "对话模型", url: "/admin/chat-models" },
  { title: "权限组", url: "/admin/groups" },
  { title: "积分流水", url: "/admin/credits" },
  { title: "操作日志", url: "/admin/logs" },
]

/**
 * 「平台管理」分组下子项（仅超管可见，页面均在 /platform/* 下，
 * 与 /platform 聚合页快捷入口卡片一致）。
 */
const PLATFORM_NAV: { title: string; url: string }[] = [
  { title: "数据看板", url: "/platform" },
  { title: "企业管理", url: "/platform/enterprises" },
  { title: "订阅套餐", url: "/platform/plans" },
  { title: "平台用户", url: "/platform/users" },
  { title: "预置模型", url: "/platform/models" },
  { title: "对话模型", url: "/platform/chat-models" },
  { title: "商品图片配置", url: "/platform/product-config" },
  { title: "穿戴图片管理", url: "/platform/weartry-config" },
  { title: "样机提示词", url: "/platform/mockup-config" },
  { title: "广告横幅", url: "/platform/banners" },
  { title: "系统设置", url: "/platform/system" },
]

/**
 * 构建主导航：AI 对话 / 图片生成 / 模板管理 / 企业管理 / 平台管理。
 *
 * - AI 对话：独立顶级导航项（无子项，直链渲染），位于图片生成上方。
 * - 图片生成：按可访问业务模块过滤子项；settings 不进入主导航（仅保留
 *   在底部用户卡下拉），超管无业务模块时整组隐藏。
 * - 模板管理：提示词模板仅被批量生图消费，跟随 workspace 模块权限。
 * - 企业管理：owner/admin 专属。
 * - 平台管理：超管专属（原顶部徽章/用户卡下拉入口迁入主导航分组）。
 */
export function buildNavMain(ctx: UserContext): NavItem[] {
  const groups: NavItem[] = []
  const accessible = new Set(ctx.accessibleModules)

  // AI 对话：独立顶级导航项（无子项，直链渲染）
  if (accessible.has("chat")) {
    groups.push({
      title: MODULE_NAV.chat.title,
      url: MODULE_NAV.chat.url,
      icon: MODULE_NAV.chat.icon,
    })
  }

  const subItems = IMAGE_GEN_ORDER.filter((m) => accessible.has(m)).map((m) => ({
    title: MODULE_NAV[m].title,
    url: MODULE_NAV[m].url,
  }))
  if (subItems.length > 0) {
    // 父组点击兜底跳转到第一个可访问子项（IMAGE_GEN_ORDER 优先级）
    const parentUrl = MODULE_NAV[
      IMAGE_GEN_ORDER.find((m) => accessible.has(m)) ?? "create"
    ].url
    groups.push({
      title: "图片生成",
      url: parentUrl,
      icon: "image",
      items: subItems,
    })
  }

  if (accessible.has("workspace")) {
    groups.push({
      title: "模板管理",
      url: "/templates",
      icon: "library",
      items: [{ title: "提示词模板", url: "/templates" }],
    })
  }

  if (
    ctx.user.enterpriseRole === "owner" ||
    ctx.user.enterpriseRole === "admin"
  ) {
    groups.push({
      title: "企业管理",
      url: "/admin",
      icon: "building",
      items: ADMIN_NAV,
    })
  }

  if (ctx.user.isSuperAdmin) {
    groups.push({
      title: "平台管理",
      url: "/platform",
      icon: "shield",
      items: PLATFORM_NAV,
    })
  }

  return groups
}

/** 构建用户卡数据（角色文案统一取 roleLabel，全项目唯一来源） */
export function buildSidebarUser(
  ctx: UserContext,
  plan: PlanBadgeInfo | null = null,
): SidebarUser {
  return {
    name: ctx.user.name || ctx.user.username,
    username: ctx.user.username,
    email: ctx.user.email,
    avatar: ctx.user.image ?? null,
    roleLabel: ctx.user.isSuperAdmin ? "超管" : roleLabel(ctx.user.enterpriseRole),
    groupName: ctx.group?.name ?? null,
    isSuperAdmin: ctx.user.isSuperAdmin,
    enterpriseName: ctx.enterprise?.name ?? null,
    plan,
  }
}
