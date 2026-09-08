import { requireSuperAdmin } from "@/lib/auth/session"
import { listPresetModelsAction } from "@/server/actions/platform-models"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  TablePagination,
  parsePageParam,
} from "@/components/shared/table-pagination"
import {
  PresetModelFormDialog,
  PresetModelEditButton,
  PresetModelToggleActiveButton,
} from "@/components/superadmin/preset-model-form-dialog"

export const dynamic = "force-dynamic"

const FORMAT_LABEL: Record<string, string> = {
  openai: "OpenAI 标准生图",
  jimeng: "即梦",
}

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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>显示名</TableHead>
                <TableHead>接口</TableHead>
                <TableHead className="text-right">积分/张</TableHead>
                <TableHead>可见性</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.displayName}</TableCell>
                  <TableCell className="text-sm">
                    {FORMAT_LABEL[m.apiFormat] ?? m.apiFormat}
                    {m.supportsReferenceImage ? (
                      <span className="ml-1 text-xs text-muted-foreground">
                        · 参考图
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.costPerImage}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {m.visibleInCreate ? (
                        <Badge variant="outline" className="text-xs">
                          创作
                        </Badge>
                      ) : null}
                      {m.visibleInWorkspace ? (
                        <Badge variant="outline" className="text-xs">
                          批量
                        </Badge>
                      ) : null}
                      {m.visibleInProduct ? (
                        <Badge variant="outline" className="text-xs">
                          商品
                        </Badge>
                      ) : null}
                      {m.visibleInWeartry ? (
                        <Badge variant="outline" className="text-xs">
                          穿戴
                        </Badge>
                      ) : null}
                      {m.visibleInMockup ? (
                        <Badge variant="outline" className="text-xs">
                          样机
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {m.isActive ? (
                      <Badge>启用</Badge>
                    ) : (
                      <Badge variant="outline">停用</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <PresetModelEditButton model={m} />
                      <PresetModelToggleActiveButton model={m} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {models.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    暂无平台预置模型，点击右上角新建
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
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
