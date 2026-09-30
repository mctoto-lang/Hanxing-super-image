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
    <AgentHome
      directions={directions}
      initialRuns={runsResult.runs}
      initialCursor={runsResult.nextCursor}
    />
  )
}
