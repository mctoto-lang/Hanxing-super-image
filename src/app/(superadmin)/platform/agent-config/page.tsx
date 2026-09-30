import { requireSuperAdmin } from "@/lib/auth/session"
import {
  listAllChatModelsAction,
  listAllImageModelsAction,
  listDirectionConfigsAction,
} from "@/server/actions/platform-agent-config"
import { AgentConfigManager } from "@/components/superadmin/agent-config"

export const dynamic = "force-dynamic"

/**
 * 平台 Agent 配置（/platform/agent-config，仅超管）
 *
 * 三条产品线 × 八个角色槽位的模型与阈值预配置；用户发起时零配置。
 */
export default async function PlatformAgentConfigPage() {
  await requireSuperAdmin()
  const [configs, chatModels, imageModels] = await Promise.all([
    listDirectionConfigsAction(),
    listAllChatModelsAction(),
    listAllImageModelsAction(),
  ])
  return (
    <AgentConfigManager configs={configs} chatModels={chatModels} imageModels={imageModels} />
  )
}
