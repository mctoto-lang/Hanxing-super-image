import { requireEnterpriseContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { AgentWorkspacePreview } from "@/components/agent/preview/workspace-preview"

export const dynamic = "force-dynamic"

/**
 * 塔罗工作台 UI 预览页（/agent/preview）：纯 Mock 数据 + mock actions，
 * 供走查五阶段 × 三状态的完整界面；登录且具有 Agent 模块权限即可访问。
 */
export default async function AgentPreviewPage() {
  const ctx = await requireEnterpriseContext()
  if (!ctx.canAccess("agent")) {
    return <NoPermission module="AI Agent" />
  }
  return <AgentWorkspacePreview />
}
