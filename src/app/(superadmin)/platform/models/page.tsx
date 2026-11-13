import { requireSuperAdmin } from "@/lib/auth/session"
import { listPresetModelsAction } from "@/server/actions/platform-models"
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
import { PresetModelFormDialog } from "@/components/superadmin/preset-model-form-dialog"
import { PresetModelsTable } from "@/components/superadmin/preset-models-table"

export const dynamic = "force-dynamic"

export default async function PlatformModelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireSuperAdmin()
  const page = parsePageParam(await searchParams)
  const { items: models, total, activeCount, pageSize } =
    await listPresetModelsAction({ page, pageSize: 20 })
  const totalCostCredits = models
    .filter((m) => m.isActive)
    .reduce((sum, m) => sum + m.costPerImage, 0)

  return (
    <div className="space-y-4">
      <PageHeader
        title="平台生图模型"
        description="超管管理全企业共享的生图模型（enterpriseId 为空）；定义每张积分扣减；可在企业详情「模型配置」中按企业勾选可见模型"
      >
        <PresetModelFormDialog />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="生图模型总数">
          {total.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard label="启用中">
          {activeCount.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard label="启用模型积分/张（合计）">
          {totalCostCredits.toLocaleString("zh-CN")}
        </StatCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">生图模型列表</CardTitle>
          <CardDescription>
            平台生图模型对所有企业可见（除非企业勾选了限定白名单）；API Key 加密落库
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PresetModelsTable models={models} />
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/platform/models"
        />
      </Card>
    </div>
  )
}
