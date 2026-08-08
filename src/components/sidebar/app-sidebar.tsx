"use client"

import * as React from "react"

import { NavMain } from "@/components/sidebar/nav-main"
import { NavSecondary } from "@/components/sidebar/nav-secondary"
import { NavUser } from "@/components/sidebar/nav-user"
import { EnterpriseBadge } from "@/components/sidebar/enterprise-badge"
import { EnterpriseCredits } from "@/components/sidebar/enterprise-credits"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"
import type { NavItem, NavSecondaryItem, SidebarUser } from "./types"

export interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  /** 当前用户（用于 nav-user 展示） */
  user: SidebarUser
  /** 企业标识信息 */
  enterprise: {
    name: string
    logoUrl?: string | null
    isSuperAdmin: boolean
  } | null
  /** 企业积分余额（普通用户展示，超管/无企业不展示） */
  creditsBalance?: number | null
  /** 主导航（已按 enabledModules ∩ allowedPages 过滤） */
  navMain: NavItem[]
  /** 二级导航（企业管理入口 / 平台管理入口） */
  navSecondary: NavSecondaryItem[]
}

/**
 * 应用侧边栏（基于 sidebar-08 改造，手册 §7.1、§5.2）
 *
 * - 顶部：企业标识展示（纯展示，非切换器，R5）；
 * - 主导航：创作/资产/批量生图/商品主图，按 enabledModules ∩ allowedPages 过滤；
 * - 二级导航：管理员入口（企业管理 / 平台管理）；
 * - 底部：企业积分余额 + 用户卡。
 */
export function AppSidebar({
  user,
  enterprise,
  creditsBalance,
  navMain,
  navSecondary,
  ...props
}: AppSidebarProps) {
  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader>
        <EnterpriseBadge enterprise={enterprise} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
        <NavSecondary items={navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        {creditsBalance != null ? (
          <EnterpriseCredits balance={creditsBalance} />
        ) : null}
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  )
}
