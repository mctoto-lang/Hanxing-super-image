/**
 * 侧边栏数据类型（icon 用字符串名，避免函数跨服务端/客户端边界）
 */
import type { PlanBadgeInfo } from "@/lib/plans/badge"

/** 主导航项（对应 sidebar-08 nav-main） */
export interface NavItem {
  title: string
  url: string
  icon?: string // 图标名（在客户端 lucideIconMap 内查表）
  isActive?: boolean
  items?: { title: string; url: string }[]
}

/** 二级导航项（管理入口、支持等） */
export interface NavSecondaryItem {
  title: string
  url: string
  icon?: string
}

/** nav-user 展示用用户信息 */
export interface SidebarUser {
  name: string
  username: string
  email?: string | null
  avatar?: string | null
  roleLabel: string // 角色中文（企业管理员/成员管理员/成员/超管）
  groupName?: string | null
  isSuperAdmin?: boolean
  /** 归属企业名（超管/无企业为 null） */
  enterpriseName?: string | null
  /** 企业订阅套餐摘要（超管/无企业/免费版为 null；勋章 + 订阅页签共用） */
  plan: PlanBadgeInfo | null
}
