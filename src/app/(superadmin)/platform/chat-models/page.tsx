import { requireSuperAdmin } from "@/lib/auth/session"
import { listPresetChatModelsAction } from "@/server/actions/platform-chat-models"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  TablePagination,
  parsePageParam,
} from "@/components/shared/table-pagination"
import { PageHeader } from "@/components/shared/page-header"
import { StatCard } from "@/components/shared/stat-card"
import { ChatModelFormDialog } from "@/components/superadmin/chat-model-form-dialog"
import { PresetChatModelsTable } from "@/components/superadmin/preset-chat-models-table"

export const dynamic = "force-dynamic"

/**
 * 平台预置对话模型（OpenAI 兼容 LLM）
 *
 * 供提示词模板关联使用（裂变/细化/重生成/提取/翻译）；
 * 全部启用中的平台预置对话模型对所有企业可见。
 */
export default async function PlatformChatModelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireSuperAdmin()
  const page = parsePageParam(await searchParams)
  const { items: chatModels, total, activeCount, pageSize } =
    await listPresetChatModelsAction({ page, pageSize: 20 })

  return (
    <div className="space-y-4">
      <PageHeader
        title="平台预置对话模型"
        description="超管管理全企业共享的对话模型（OpenAI 兼容格式，enterpriseId 为空）；用于提示词模板的裂变/细化/重生成/提取/翻译；API Key 加密落库"
      >
        <ChatModelFormDialog />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="预置对话模型总数">
          {total.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard label="启用中">
          {activeCount.toLocaleString("zh-CN")}
        </StatCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">预置对话模型列表</CardTitle>
          <CardDescription>
            启用中的平台预置对话模型对所有企业可见；企业也可在「企业管理 →
            对话模型」中自建私有对话模型
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PresetChatModelsTable chatModels={chatModels} />
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/platform/chat-models"
        />
      </Card>
    </div>
  )
}
