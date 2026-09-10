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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">平台预置模型</h1>
          <p className="text-sm text-muted-foreground">
            超管管理全企业共享的预置模型（enterpriseId 为空）；定义每张积分扣减；
            可在企业详情「模型配置」中按企业勾选可见模型
          </p>
        </div>
        <PresetModelFormDialog />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              预置模型总数
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {total}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              启用中
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {activeCount}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              启用模型积分/张（合计）
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {totalCostCredits}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">预置模型列表</CardTitle>
          <CardDescription>
            平台预置模型对所有企业可见（除非企业勾选了限定白名单）；API Key 加密落库
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
