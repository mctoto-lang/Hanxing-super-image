import { notFound } from "next/navigation"
import { requireEnterpriseContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { TarotWorkspace } from "@/components/agent/tarot-workspace"
import { getTemplateWorkspaceAction } from "@/server/actions/agent-template"
import { AgentRunNotFoundError } from "@/lib/agent/errors"

export const dynamic = "force-dynamic"

/**
 * 项目详情页（/agent/run/[id]）：塔罗模板四阶段工作台。
 * 经典全流程已下线（历史数据已清空）；非塔罗项目一律 404。
 */
export default async function AgentRunBoardPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const ctx = await requireEnterpriseContext()
  if (!ctx.canAccess("agent")) {
    return <NoPermission module="AI Agent" />
  }

  let workspace: Awaited<ReturnType<typeof getTemplateWorkspaceAction>>
  try {
    workspace = await getTemplateWorkspaceAction(id)
  } catch (err) {
    // 仅业务性 404（不存在/无权/类型不符）走 notFound；其余异常（DB/基础
    // 设施故障）原样抛出交给 error 边界呈现，避免 5xx 被吞成「项目不存在」
    if (err instanceof AgentRunNotFoundError) notFound()
    throw err
  }

  // 视口锁定（与 /chat 同范式）：以 SidebarInset 为包含块贴满 header 以下，
  // 页面不再整页滚动，工作台内容在内部滚动（p-4 保持与其他页一致的外边距）
  return (
    <div className="absolute inset-x-0 top-16 bottom-0 p-4">
      <div className="h-full overflow-y-auto">
        <TarotWorkspace initialData={workspace} />
      </div>
    </div>
  )
}
