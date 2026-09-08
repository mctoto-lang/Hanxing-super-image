"use client"

import * as React from "react"
import {
  ChevronsUpDown,
  LogOut,
  Moon,
  Settings,
  Smile,
  Sun,
  Zap,
} from "lucide-react"
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { PlanBadge } from "@/components/shared/plan-badge"
import { AccountDialog } from "@/components/account/account-dialog"
import {
  readGrokBallEnabled,
  writeGrokBallEnabled,
} from "@/components/grok-ball/grok-ball-prefs"
import { emitGrokBallEnabled } from "@/lib/grok-ball-bus"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { logoutAction } from "@/server/actions/auth"
import type { SidebarUser } from "./types"

/**
 * 用户卡（基于 sidebar-08 nav-user 改造，手册 §7.1）
 *
 * 显示：头像 + 昵称 + 企业订阅套餐勋章 + 企业角色（owner/admin/member）+ 权限组名；
 * 下拉菜单（自上而下）：
 *   - 表情圆球开关（localStorage 偏好 + 事件总线，右侧显示已开启/已关闭）
 *   - 积分额度（企业用户；右侧闪电 + 个人积分余额，点击直达账户弹窗订阅方案页）
 *   - 深色/浅色模式切换（当前模式名 + 对应日/月图标，点击切换）
 *   - 账户管理（打开账户弹窗：个人主页 / 企业订阅 / 积分额度）、退出登录（调 logoutAction）
 *
 * 企业管理/平台管理入口已迁入主导航分组（sidebar-data.ts）；
 * 服务可用性入口在企业菜单（enterprise-badge）。
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
  const [accountOpen, setAccountOpen] = React.useState(false)
  // 账户弹窗初始页签：账户管理 → 个人主页；积分额度 → 订阅方案
  const [accountTab, setAccountTab] = React.useState<"profile" | "subscription">(
    "profile",
  )
  // 表情圆球开关（localStorage 偏好，挂载后读取避免 SSR 不一致）
  const [grokBallOn, setGrokBallOn] = React.useState(true)

  React.useEffect(() => {
    setGrokBallOn(readGrokBallEnabled())
  }, [])

  function handleToggleGrokBall() {
    const next = !grokBallOn
    setGrokBallOn(next)
    writeGrokBallEnabled(next)
    emitGrokBallEnabled(next)
  }

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
              <span className="flex items-center gap-1">
                <span className="truncate font-semibold">{user.name}</span>
                {user.plan ? (
                  <PlanBadge
                    iconKey={user.plan.iconKey}
                    color={user.plan.color}
                    isExpired={user.plan.isExpired}
                    size="sm"
                    className="max-w-14"
                  />
                ) : null}
              </span>
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
                  <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                    <span className="flex items-center gap-1">
                      <span className="truncate font-semibold">{user.name}</span>
                      {user.plan ? (
                        <PlanBadge
                          iconKey={user.plan.iconKey}
                          color={user.plan.color}
                          name={user.plan.planName}
                          isExpired={user.plan.isExpired}
                          size="sm"
                        />
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {user.roleLabel}
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={handleToggleGrokBall}>
                <Smile />
                表情圆球
                <span className="ml-auto text-xs text-muted-foreground">
                  {grokBallOn ? "已开启" : "已关闭"}
                </span>
              </DropdownMenuItem>
              {showCredits && (
                <DropdownMenuItem
                  onClick={() => {
                    setAccountTab("subscription")
                    setAccountOpen(true)
                  }}
                >
                  <Zap />
                  积分额度
                  <span
                    className={cn(
                      "ml-auto flex items-center gap-1 text-xs font-medium tabular-nums",
                      userLow ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    <Zap
                      className={cn(
                        "size-3.5",
                        userLow ? "text-destructive" : "text-primary",
                      )}
                    />
                    {(userCredits ?? 0).toLocaleString("zh-CN")}
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleToggleTheme}>
                <span className="relative inline-flex size-4 shrink-0 items-center justify-center [&_svg]:absolute">
                  <Sun className="size-4 rotate-0 scale-100 transition-transform duration-500 ease-in-out dark:-rotate-90 dark:scale-0" />
                  <Moon className="size-4 rotate-90 scale-0 transition-transform duration-500 ease-in-out dark:rotate-0 dark:scale-100" />
                </span>
                <span className="dark:hidden">浅色模式</span>
                <span className="hidden dark:inline">深色模式</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setAccountTab("profile")
                  setAccountOpen(true)
                }}
              >
                <Settings />
                账户管理
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleLogout} disabled={pending}>
                <LogOut />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
      {/* 账户管理弹窗：个人主页 / 企业订阅（套餐勋章）/ 积分额度（饼图 + 流水） */}
      <AccountDialog
        user={user}
        creditsBalance={creditsBalance}
        userCredits={userCredits}
        initialTab={accountTab}
        open={accountOpen}
        onOpenChange={setAccountOpen}
      />
    </SidebarMenu>
  )
}
