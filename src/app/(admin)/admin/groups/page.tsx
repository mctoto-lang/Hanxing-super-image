import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { listGroupsAction } from "@/server/actions/admin-groups"
import { listModelsAction } from "@/server/actions/admin-models"
import {
  listAdminChatModelsAction,
} from "@/server/actions/admin-chat-models"
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
import { GroupCreateDialog } from "@/components/admin/group-create-dialog"
import { GroupEditDialog } from "@/components/admin/group-edit-dialog"
import {
  TablePagination,
  parsePageParam,
} from "@/components/shared/table-pagination"

export const dynamic = "force-dynamic"

export default async function AdminGroupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireEnterpriseAdmin()
  const page = parsePageParam(await searchParams)
  const [{ items: groups, total, pageSize }, { items: imageModels }, { items: chatModels }] =
    await Promise.all([
      listGroupsAction({ page, pageSize: 20 }),
      // 模型勾选器数据源（企业可见生图/对话模型，pageSize 上限 50）
      listModelsAction({ page: 1, pageSize: 50 }),
      listAdminChatModelsAction({ page: 1, pageSize: 50 }),
    ])

  const imageOptions = imageModels.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    isActive: m.isActive,
    isPreset: m.enterpriseId === null,
  }))
  const chatOptions = chatModels.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    isActive: m.isActive,
    isPreset: m.enterpriseId === null,
  }))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <GroupCreateDialog
          imageModels={imageOptions}
          chatModels={chatOptions}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">权限组列表</CardTitle>
          <CardDescription>
            每企业至多一个默认组；组成员的可用模型/allowedPages 在企业已开通范围内进一步限定
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>组名</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>允许页面</TableHead>
                <TableHead>生图模型</TableHead>
                <TableHead>对话模型</TableHead>
                <TableHead className="text-right">并发上限</TableHead>
                <TableHead className="text-right">成员数</TableHead>
                <TableHead className="text-right">优先级</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-8 text-center text-muted-foreground"
                  >
                    暂无权限组
                  </TableCell>
                </TableRow>
              ) : null}
              {groups.map((g) => {
                const allowedModels = g.allowedModels as string[]
                const allowedChatModels = g.allowedChatModels as string[]
                return (
                <TableRow key={g.id}>
                  <TableCell className="font-medium">
                    {g.name}
                    {g.description ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {g.description}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {g.isDefault ? (
                      <Badge>默认组</Badge>
                    ) : (
                      <Badge variant="outline">自定义</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(g.allowedPages as string[]).length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          全部模块
                        </span>
                      ) : (
                        (g.allowedPages as string[]).map((p) => (
                          <Badge key={p} variant="outline" className="text-xs">
                            {p}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {allowedModels.length === 0 ? (
                      <span className="text-xs text-muted-foreground">全部</span>
                    ) : (
                      <span className="text-xs">已选 {allowedModels.length}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {allowedChatModels.length === 0 ? (
                      <span className="text-xs text-muted-foreground">全部</span>
                    ) : (
                      <span className="text-xs">
                        已选 {allowedChatModels.length}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {g.maxConcurrent}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {g.memberCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {g.priority}
                  </TableCell>
                  <TableCell className="text-right">
                    <GroupEditDialog
                      group={{
                        id: g.id,
                        name: g.name,
                        description: g.description,
                        allowedModels,
                        allowedChatModels,
                        allowedPages: g.allowedPages as string[],
                        maxConcurrent: g.maxConcurrent,
                        priority: g.priority,
                        isDefault: g.isDefault,
                      }}
                      imageModels={imageOptions}
                      chatModels={chatOptions}
                    />
                  </TableCell>
                </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/groups"
        />
      </Card>
    </div>
  )
}
