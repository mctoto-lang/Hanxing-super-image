import { DashboardShell } from "@/components/sidebar/dashboard-shell"

/**
 * 资产管理独立壳：侧边栏 / 顶栏 / 筛选工具栏固定，
 * 仅瀑布流内容区内部滚动（区别于 (dashboard) 组的整页滚动）。
 */
export default function AssetsFixedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardShell contentScroll="inner">{children}</DashboardShell>
}
