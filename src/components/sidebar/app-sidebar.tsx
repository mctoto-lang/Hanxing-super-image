"use client"

import * as React from "react"

import { NavMain } from "@/components/sidebar/nav-main"
import { NavUser } from "@/components/sidebar/nav-user"
import { EnterpriseBadge } from "@/components/sidebar/enterprise-badge"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"
import type { NavItem, SidebarUser } from "./types"

export interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  /** 当前用户（用于 nav-user 展示） */
  user: SidebarUser
  /** 企业标识信息 */
  enterprise: {
    name: string
    logoUrl?: string | null
    isSuperAdmin: boolean
  } | null
  /** 企业积分池余额（普通用户展示，超管/无企业不展示） */
  creditsBalance?: number | null
  /** 成员个人配额（需求 3：生图扣个人配额；超管/无企业不展示） */
  userCredits?: number | null
  /** 主导航（已按 enabledModules ∩ allowedPages 过滤；企业管理/平台管理为独立分组） */
  navMain: NavItem[]
}

/**
 * 应用侧边栏（基于 sidebar-08 改造，手册 §7.1、§5.2）
 *
 * - 顶部：企业标识（点击弹出企业菜单：访问欢迎页 / 服务可用性状态弹窗）；
 * - 主导航：图片生成/模板管理/企业管理/平台管理分组，按角色过滤；
 * - 底部：用户卡（下拉含：积分额度气泡、深色/浅色模式切换、个人设置、退出登录）。
 */
export function AppSidebar({
  user,
  enterprise,
  creditsBalance,
  userCredits,
  navMain,
  ...props
}: AppSidebarProps) {
  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader>
        <EnterpriseBadge enterprise={enterprise} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={user}
          creditsBalance={creditsBalance}
          userCredits={userCredits}
        />
      </SidebarFooter>
    </Sidebar>
  )
}
