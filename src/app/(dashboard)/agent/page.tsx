import { requireEnterpriseContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { AgentHome } from "@/components/agent/agent-home"
import { listDirectionsAction, listRunsAction } from "@/server/actions/agent"

export const dynamic = "force-dynamic"

/**
 * AI Agent 卡牌工坊首页（/agent）：模板库 + 项目历史（客户端轮询/分页）
 */
export default async function AgentPage() {
  const ctx = await requireEnterpriseContext()
  if (!ctx.canAccess("agent")) {
    return <NoPermission module="AI Agent" />
  }

  const [directions, runsResult] = await Promise.all([
    listDirectionsAction(),
    listRunsAction({ limit: 20 }),
  ])
  return (
    // 视口锁定（与 /chat 同范式）：以 SidebarInset 为包含块贴满 header 以下，
    // 页面不再整页滚动，内容在内部滚动（p-4 保持与其他页一致的外边距）
    <div className="absolute inset-x-0 top-16 bottom-0 p-4">
      <div className="h-full overflow-y-auto">
        <AgentHome
          directions={directions}
          initialRuns={runsResult.runs}
          initialCursor={runsResult.nextCursor}
        />
      </div>
    </div>
  )
}
