import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { listModelsAction } from "@/server/actions/admin-models"
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
  ModelFormDialog,
  ModelEditButton,
  ModelToggleActiveButton,
} from "@/components/admin/model-form-dialog"

export const dynamic = "force-dynamic"

const FORMAT_LABEL: Record<string, string> = {
  openai: "OpenAI 标准生图",
  jimeng: "即梦",
}

export default async function AdminModelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireEnterpriseAdmin()
  const page = parsePageParam(await searchParams)
  const {
    items: models,
    total,
    presetCount,
    privateCount,
    activeCount,
    pageSize,
  } = await listModelsAction({ page, pageSize: 20 })

  // 需求 2c：企业 allowCustomModels=false 时禁止自建/编辑私有模型
  const allowCustom = ctx.enterprise?.allowCustomModels ?? true

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        {allowCustom ? (
          <ModelFormDialog />
        ) : (
          <span className="rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
            平台已关闭本企业自定义模型
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              平台预置
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {presetCount}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              企业私有
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {privateCount}
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
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">模型列表</CardTitle>
          <CardDescription>
            平台预置模型（enterpriseId 为空）所有企业可见且不可修改；企业私有模型可编辑/启停
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>显示名</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>接口</TableHead>
                <TableHead className="text-right">积分/张</TableHead>
                <TableHead>可见性</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => {
                const isPreset = m.enterpriseId === null
                // 自定义模型开关关闭时，私有模型也变只读
                const readOnly = isPreset || !allowCustom
                return (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">
                      {m.displayName}
                    </TableCell>
                    <TableCell>
                      {isPreset ? (
                        <Badge variant="secondary">平台预置</Badge>
                      ) : (
                        <Badge variant="outline">企业私有</Badge>
                      )}
                    </TableCell>
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
                      {readOnly ? (
                        <span className="text-xs text-muted-foreground">
                          只读
                        </span>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <ModelEditButton model={m} />
                          <ModelToggleActiveButton model={m} />
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
              {models.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground"
                  >
                    暂无模型，点击右上角新建
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
          basePath="/admin/models"
        />
      </Card>
    </div>
  )
}
