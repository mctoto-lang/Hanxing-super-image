import { cn } from "@/lib/utils"
import { getCurrentUserContext } from "@/lib/auth/session"
import { redirect } from "next/navigation"
import { AppSidebar } from "@/components/sidebar/app-sidebar"
import { buildNavMain, buildSidebarUser } from "@/components/sidebar/sidebar-data"
import { HeaderTitle } from "@/components/sidebar/dashboard-header-title"
import { AdBanner } from "@/components/banner/ad-banner"
import { getDisplayBanner } from "@/server/actions/platform-banners"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"

/**
 * Dashboard 壳（手册 §3、§7.1）
 *
 * 服务端组件：获取当前用户上下文，构建侧边栏数据，
 * 嵌入 sidebar-08 布局。各路由组 layout 直接复用。
 *
 * 未登录跳 /login；超管可访问（用于查看平台管理）。
 *
 * contentScroll 滚动模式：
 * - "page"（默认）：整页随窗口滚动（原行为）；
 * - "inner"：外层固定视口高度不滚动（侧边栏/顶栏固定），
 *   仅右侧内容区内部上下滚动（管理页长表格场景）。
 */
export async function DashboardShell({
  children,
  contentScroll = "page",
}: {
  children: React.ReactNode
  contentScroll?: "page" | "inner"
}) {
  const ctx = await getCurrentUserContext()
  if (!ctx) redirect("/login")

  // 广告横幅：超管配置，随机轮换一条；无生效横幅时渲染为空
  const banner = await getDisplayBanner()

  const inner = contentScroll === "inner"

  return (
    <>
      {/* 广告横幅：悬浮于视口顶部（fixed 覆盖显示，不占布局空间） */}
      <AdBanner banner={banner} />
      <SidebarProvider
        className={cn(inner && "h-svh max-h-svh overflow-hidden")}
      >
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
          userCredits={
            ctx.user.isSuperAdmin || !ctx.enterprise
              ? null
              : ctx.user.creditsBalance
          }
          navMain={buildNavMain(ctx)}
        />
        <SidebarInset className={cn(inner && "min-h-0 overflow-hidden")}>
          <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <HeaderTitle className="ml-4" />
          </header>
          <div className={cn("min-h-0 flex-1 p-4", inner && "overflow-y-auto")}>
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </>
  )
}
