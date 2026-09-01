"use client"

import * as React from "react"
import Link from "next/link"
import { Building2, ShieldCheck } from "lucide-react"

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export interface EnterpriseBadgeProps {
  enterprise: {
    name: string
    logoUrl?: string | null
    isSuperAdmin: boolean
  } | null
}

/**
 * 企业标识展示（手册 §5.2、R5）
 *
 * 用户单一归属，展示当前企业（非切换器）。
 * 点击跳转营销页（/），客户端导航不清理登录状态；
 * 营销页「登录」按钮对已登录用户直接进入工作台。
 * - 普通用户：显示企业 logo + 企业名（副标题「归属企业」）；
 * - 超管：显示「平台管理」字样（工作台导航入口在「平台管理」分组）。
 */
export function EnterpriseBadge({ enterprise }: EnterpriseBadgeProps) {
  // 超管
  if (!enterprise || enterprise.isSuperAdmin) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" render={<Link href="/" />} tooltip="营销主页">
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="size-4" />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">平台管理</span>
              <span className="truncate text-xs text-muted-foreground">
                超级管理员
              </span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  // 普通用户：展示归属企业，点击进入营销页
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" render={<Link href="/" />} tooltip="营销主页">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground">
            {enterprise.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={enterprise.logoUrl}
                alt={enterprise.name}
                className="size-8 rounded-lg object-cover"
              />
            ) : (
              <Building2 className="size-4" />
            )}
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">{enterprise.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              归属企业
            </span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
