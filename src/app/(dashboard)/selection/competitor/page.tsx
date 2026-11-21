import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import { MonitorClient } from "@/components/selection/monitor-client"
import { listSelectionMonitorsAction } from "@/server/actions/selection-monitor"

export const dynamic = "force-dynamic"

/**
 * 竞品监控（0106 开放）：数据池卡片「加入竞品监控」→ 周期重抓（价格/销量/
 * 评论数趋势）+ 评论追踪（评论洞察页联动 AI 分析）。计费走发起人积分。
 */
export default async function SelectionCompetitorPage() {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("selection")) return <NoPermission module="选品工具" />

  const res = await listSelectionMonitorsAction()
  const monitors = res.ok ? res.items : []

  return (
    <div className="space-y-4">
      <PageHeader
        title="竞品监控"
        description="监控目标按设定周期自动重抓（费用按普通任务从发起人积分扣除，积分不足自动暂停）；支持评论的平台会同步抓取评论并生成 AI 分析（见评论洞察）。"
      />
      <MonitorClient initialMonitors={monitors} />
    </div>
  )
}
