import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { getMemberUsageStatsAction } from "@/server/actions/admin-stats"
import { MemberStatsPanel } from "@/components/admin/member-stats-panel"

export const dynamic = "force-dynamic"

/**
 * 企业管理 · 数据看板：成员 / 积分消耗统计面板
 * （KPI、近 30 天趋势、模块占比、成员排行）。
 */
export default async function AdminStatsPage() {
  await requireEnterpriseAdmin()
  const stats = await getMemberUsageStatsAction()
  return <MemberStatsPanel data={stats} />
}
