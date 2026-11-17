import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { listGroupsAction, listAllGroupsAction } from "@/server/actions/admin-groups"
import { listAllModelsAction } from "@/server/actions/admin-models"
import {
  listAllAdminChatModelsAction,
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
  BASE_MODULE_OPTIONS,
  MODULE_LABELS,
  TEMU_TAB_OPTIONS,
} from "@/lib/modules"
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
import { GroupMembersDialog } from "@/components/admin/group-members-dialog"
import { GroupDeleteDialog } from "@/components/admin/group-delete-dialog"
import {
  TablePagination,
  parsePageParam,
} from "@/components/shared/table-pagination"
import { TableEmpty } from "@/components/shared/table-empty"

export const dynamic = "force-dynamic"

export default async function AdminGroupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireEnterpriseAdmin()
  const page = parsePageParam(await searchParams)
  const [{ items: groups, total, pageSize }, allGroups, imageModels, chatModels] =
    await Promise.all([
      listGroupsAction({ page, pageSize: 20 }),
      // 组成员弹窗「全部转移至」下拉需要全量组（跨页场景，>50 组时按 total 翻页拉全量）
      listAllGroupsAction(),
      // 模型勾选器数据源（企业可见生图/对话模型全量）——分页 action 的白名单
      // 过滤在内存完成、分页只是切片，listAll 变体一次取全，避免按页重复全表查询
      listAllModelsAction(),
      listAllAdminChatModelsAction(),
    ])

  // 模块勾选项按企业已开通模块过滤（超管对企业关闭的模块不露出）
  const enabledModules = ctx.enterprise?.enabledModules ?? []
  const baseOptions = BASE_MODULE_OPTIONS.filter((o) =>
    enabledModules.includes(o.value),
  )
  const temuEnabled = enabledModules.includes("temu")
  const temuOptions = TEMU_TAB_OPTIONS.filter((o) =>
    enabledModules.includes(o.value),
  )

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
  const visibleImageIds = new Set(imageOptions.map((m) => m.id))
  const visibleChatIds = new Set(chatOptions.map((m) => m.id))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <GroupCreateDialog
          imageModels={imageOptions}
          chatModels={chatOptions}
          baseOptions={baseOptions}
          temuOptions={temuOptions}
          temuEnabled={temuEnabled}
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
                <TableHead>并发上限</TableHead>
                <TableHead>成员数</TableHead>
                <TableHead>优先级</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.length === 0 ? (
                <TableEmpty colSpan={9} noun="权限组" />
              ) : null}
              {groups.map((g) => {
                const allowedModels = g.allowedModels as string[]
                const allowedChatModels = g.allowedChatModels as string[]
                // 允许页面/模型计数只按企业已开通范围展示（关闭模块/模型不露出）
                const pageKeys = g.allowedPages.filter((p) =>
                  enabledModules.includes(p),
                )
                const visibleModelCount = allowedModels.filter((id) =>
                  visibleImageIds.has(id),
                ).length
                const visibleChatCount = allowedChatModels.filter((id) =>
                  visibleChatIds.has(id),
                ).length
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
                      ) : pageKeys.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        pageKeys.map((p) => (
                          <Badge key={p} variant="outline" className="text-xs">
                            {MODULE_LABELS[p] ?? p}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {allowedModels.length === 0 ? (
                      <span className="text-xs text-muted-foreground">全部</span>
                    ) : visibleModelCount === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <span className="text-xs">已选 {visibleModelCount}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {allowedChatModels.length === 0 ? (
                      <span className="text-xs text-muted-foreground">全部</span>
                    ) : visibleChatCount === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <span className="text-xs">已选 {visibleChatCount}</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {g.maxConcurrent}
                  </TableCell>
                  <TableCell>
                    <GroupMembersDialog
                      group={{ id: g.id, name: g.name, memberCount: g.memberCount }}
                      groups={allGroups.map((x) => ({
                        id: x.id,
                        name: x.name,
                        isDefault: x.isDefault,
                      }))}
                    />
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {g.priority}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
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
                        baseOptions={baseOptions}
                        temuOptions={temuOptions}
                        temuEnabled={temuEnabled}
                      />
                      {!g.isDefault ? (
                        <GroupDeleteDialog
                          group={{ id: g.id, name: g.name, memberCount: g.memberCount }}
                        />
                      ) : null}
                    </div>
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
