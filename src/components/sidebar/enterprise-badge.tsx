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
 * 用户单一归属，纯展示当前企业（非切换器）。
 * - 普通用户：显示企业 logo + 企业名（只读）；
 * - 超管：显示"平台管理"字样，点击进入 /platform。
 */
export function EnterpriseBadge({ enterprise }: EnterpriseBadgeProps) {
  // 超管
  if (!enterprise || enterprise.isSuperAdmin) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            render={<Link href="/platform" />}
            tooltip="平台管理"
          >
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

  // 普通用户：只读展示归属企业
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" disabled>
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
