import { getCurrentUserContext } from "@/lib/auth/session"
import { redirect } from "next/navigation"
import { AppSidebar } from "@/components/sidebar/app-sidebar"
import { buildNavMain, buildNavSecondary, buildSidebarUser } from "@/components/sidebar/sidebar-data"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"

/**
 * Dashboard 壳（手册 §3、§7.1）
 *
 * 服务端组件：获取当前用户上下文，构建侧边栏数据，
 * 嵌入 sidebar-08 布局。各路由组 layout 直接复用。
 *
 * 未登录跳 /login；超管可访问（用于查看平台管理）。
 */
export async function DashboardShell({ children }: { children: React.ReactNode }) {
  const ctx = await getCurrentUserContext()
  if (!ctx) redirect("/login")

  return (
    <SidebarProvider>
      <AppSidebar
        user={buildSidebarUser(ctx)}
        enterprise={
          ctx.enterprise
            ? {
                name: ctx.enterprise.name,
                logoUrl: ctx.enterprise.logoUrl,
                isSuperAdmin: ctx.user.isSuperAdmin,
              }
            : { name: "", isSuperAdmin: ctx.user.isSuperAdmin }
        }
        creditsBalance={ctx.enterprise?.creditsBalance ?? null}
        navMain={buildNavMain(ctx)}
        navSecondary={buildNavSecondary(ctx)}
      />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
        </header>
        <div className="flex-1 p-4">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
