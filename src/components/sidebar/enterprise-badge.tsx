"use client"

import * as React from "react"
import Link from "next/link"
import {
  Activity,
  Building2,
  ChevronsUpDown,
  Home,
  ShieldCheck,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { ServiceStatusDialog } from "./service-status"

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
 * 点击弹出企业菜单：访问欢迎页（营销页 /，客户端导航不清理登录状态）、
 * 服务可用性（服务状态检测弹窗；超管无企业上下文不展示）。
 * - 普通用户：显示企业 logo + 企业名（副标题「归属企业」）；
 * - 超管：显示「平台管理」字样（工作台导航入口在「平台管理」分组）。
 */
export function EnterpriseBadge({ enterprise }: EnterpriseBadgeProps) {
  const { isMobile } = useSidebar()
  const [statusOpen, setStatusOpen] = React.useState(false)
  // 超管无企业上下文：菜单仅保留访问欢迎页（状态接口需企业级配置）
  const isSuperAdmin = !enterprise || enterprise.isSuperAdmin

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  tooltip="企业菜单"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                />
              }
            >
              <div
                className={
                  isSuperAdmin
                    ? "flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
                    : "flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground"
                }
              >
                {isSuperAdmin ? (
                  <ShieldCheck className="size-4" />
                ) : enterprise.logoUrl ? (
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
                <span className="truncate font-semibold">
                  {isSuperAdmin ? "平台管理" : enterprise.name}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {isSuperAdmin ? "超级管理员" : "归属企业"}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={isMobile ? "bottom" : "right"}
              align="start"
              sideOffset={4}
              className="w-40 rounded-lg"
            >
              <DropdownMenuItem render={<Link href="/" />}>
                <Home />
                访问欢迎页
              </DropdownMenuItem>
              {!isSuperAdmin && (
                <DropdownMenuItem onClick={() => setStatusOpen(true)}>
                  <Activity />
                  服务可用性
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      {!isSuperAdmin && (
        <ServiceStatusDialog open={statusOpen} onOpenChange={setStatusOpen} />
      )}
    </>
  )
}
