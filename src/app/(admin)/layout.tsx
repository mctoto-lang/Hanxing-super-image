import { DashboardShell } from "@/components/sidebar/dashboard-shell"

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // 企业管理页面：侧边栏/顶栏固定，仅右侧内容区内部滚动
  return <DashboardShell contentScroll="inner">{children}</DashboardShell>
}
