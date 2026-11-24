import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import { KpiStrip } from "@/components/selection/kpi-strip"
import { MonitorClient } from "@/components/selection/monitor-client"
import type { MonitorListItem } from "@/lib/selection/monitor-types"
import { isSelectionPlatform, isMonitorablePlatform } from "@/lib/selection/platforms"
import { listSelectionMonitorsAction } from "@/server/actions/selection-monitor"

export const dynamic = "force-dynamic"

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/**
 * 竞品监控：数据池卡片「加入竞品监控」或本页「添加监控」（粘贴链接）→ 周期重抓
 * （价格 / BSR / 互动数等趋势，带相对上次的涨跌）+ 评论追踪（评论洞察页联动 AI
 * 分析）。计费走发起人积分；状态 / 平台 / 搜索筛选全部 URL 驱动。
 */
export default async function SelectionCompetitorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("selection")) return <NoPermission module="选品工具" />

  const sp = await searchParams
  const statusRaw = first(sp.status)
  const status = statusRaw === "active" || statusRaw === "paused" ? statusRaw : "all"
  const platformRaw = first(sp.platform)
  const platform =
    isSelectionPlatform(platformRaw) && isMonitorablePlatform(platformRaw) ? platformRaw : ""

  const res = await listSelectionMonitorsAction({ status: status === "all" ? undefined : status, platform, q: first(sp.q) })
  if (!res.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="竞品监控" description="监控目标列表。" />
        <p className="text-sm text-destructive">{res.error}</p>
      </div>
    )
  }

  // action 已把 last_* 列映射成卡片用的快照形状
  const monitors: MonitorListItem[] = res.items
  // 与服务端同口径：发起人或企业管理员可管理（改周期/开关/暂停/删除）别人的监控
  const canManageAll = ctx.user.enterpriseRole === "owner" || ctx.user.enterpriseRole === "admin"

  return (
    <div className="space-y-4">
      <PageHeader
        title="竞品监控"
        description="监控目标按设定周期自动重抓并追踪评论（费用按普通任务从发起人积分扣除，积分不足自动暂停）；指标带相对上次抓取的涨跌，评论与 AI 洞察见「评论洞察」。"
      />

      {monitors.length > 0 || res.counts.total > 0 ? (
        <KpiStrip
          items={[
            { key: "total", label: "监控目标", value: res.counts.total },
            { key: "active", label: "监控中", value: res.counts.active },
            { key: "paused", label: "已暂停", value: res.counts.paused },
            // 企业口径的服务端计数：此前用筛选后的 res.items 计算，切平台/搜索后
            // 该卡跳动且列表 limit 200 截断时失真，与旁边三张全量卡口径不一致
            { key: "tracking", label: "评论追踪中", value: res.counts.trackingReviews },
          ]}
        />
      ) : null}

      <MonitorClient
        initialMonitors={monitors}
        filter={{ status, platform, q: first(sp.q) }}
        counts={res.counts}
        currentUserId={res.currentUserId}
        canManageAll={canManageAll}
      />
    </div>
  )
}
