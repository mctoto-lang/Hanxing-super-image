"use client"

import * as React from "react"
import {
  ChevronsUpDown,
  Coins,
  LogOut,
  Moon,
  Settings,
  Sun,
  UserCircle2,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { logoutAction } from "@/server/actions/auth"
import type { SidebarUser } from "./types"

/**
 * 用户卡（基于 sidebar-08 nav-user 改造，手册 §7.1）
 *
 * 显示：头像 + 昵称 + 企业角色（owner/admin/member）+ 权限组名；
 * 下拉菜单（自上而下）：
 *   - 积分额度（企业用户；点击弹出气泡卡片：个人积分 + 企业积分池）
 *   - 深色/浅色模式切换（当前模式名 + 对应日/月图标，点击切换）
 *   - 个人设置、退出登录（调 logoutAction）
 *
 * 企业管理/平台管理入口已迁入主导航分组（sidebar-data.ts）。
 */
export function NavUser({
  user,
  creditsBalance,
  userCredits,
}: {
  user: SidebarUser
  /** 企业积分池（普通企业用户展示） */
  creditsBalance?: number | null
  /** 个人配额（生图扣个人配额） */
  userCredits?: number | null
}) {
  const { isMobile } = useSidebar()
  const { resolvedTheme, setTheme } = useTheme()
  const router = useRouter()
  const [pending, setPending] = React.useState(false)

  const initials = (user.name || user.username).slice(0, 1).toUpperCase()
  const showCredits = creditsBalance != null
  const userLow = userCredits != null && userCredits < 50

  function handleToggleTheme() {
    setTheme(resolvedTheme === "dark" ? "light" : "dark")
  }

  async function handleLogout() {
    setPending(true)
    try {
      await logoutAction()
      toast.success("已退出登录")
      router.push("/login")
      router.refresh()
    } catch {
      toast.error("退出失败，请重试")
    } finally {
      setPending(false)
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              />
            }
          >
            <Avatar className="h-8 w-8 rounded-lg">
              <AvatarImage src={user.avatar ?? undefined} alt={user.name} />
              <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {user.username} · {user.roleLabel}
                {user.groupName ? ` · ${user.groupName}` : ""}
              </span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarImage src={user.avatar ?? undefined} alt={user.name} />
                    <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {user.roleLabel}
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            {showCredits && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <Popover>
                    <PopoverTrigger
                      render={
                        <button
                          type="button"
                          className={cn(
                            "group/dropdown-menu-item relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none",
                            "focus:bg-accent focus:text-accent-foreground",
                            "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                          )}
                        />
                      }
                    >
                      <Coins />
                      积分额度
                    </PopoverTrigger>
                    <PopoverContent
                      side={isMobile ? "top" : "right"}
                      align="start"
                      sideOffset={4}
                      className="w-52"
                    >
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          积分额度
                        </div>
                        <div className="flex items-center gap-2">
                          <UserCircle2
                            className={cn(
                              "size-4",
                              userLow ? "text-destructive" : "text-primary",
                            )}
                          />
                          <div className="flex-1">
                            <div className="text-xs text-muted-foreground">
                              个人积分
                            </div>
                            <div
                              className={cn(
                                "text-base font-semibold tabular-nums",
                                userLow && "text-destructive",
                              )}
                            >
                              {(userCredits ?? 0).toLocaleString("zh-CN")}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 border-t pt-2">
                          <Coins className="size-4 text-muted-foreground" />
                          <div className="flex-1">
                            <div className="text-xs text-muted-foreground">
                              企业积分池
                            </div>
                            <div className="text-sm font-medium tabular-nums text-muted-foreground">
                              {(creditsBalance ?? 0).toLocaleString("zh-CN")}
                            </div>
                          </div>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </DropdownMenuGroup>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={handleToggleTheme}>
                <span className="relative inline-flex size-4 shrink-0 items-center justify-center [&_svg]:absolute">
                  <Sun className="size-4 rotate-0 scale-100 transition-transform duration-500 ease-in-out dark:-rotate-90 dark:scale-0" />
                  <Moon className="size-4 rotate-90 scale-0 transition-transform duration-500 ease-in-out dark:rotate-0 dark:scale-100" />
                </span>
                <span className="dark:hidden">浅色模式</span>
                <span className="hidden dark:inline">深色模式</span>
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/settings" />}>
                <Settings />
                个人设置
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleLogout} disabled={pending}>
                <LogOut />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
