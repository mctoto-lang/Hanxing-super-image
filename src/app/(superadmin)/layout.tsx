import { DashboardShell } from "@/components/sidebar/dashboard-shell"

export default function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardShell>{children}</DashboardShell>
}
