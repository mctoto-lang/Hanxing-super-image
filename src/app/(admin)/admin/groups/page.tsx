import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { listGroupsAction } from "@/server/actions/admin-groups"
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

export const dynamic = "force-dynamic"

export default async function AdminGroupsPage() {
  const ctx = await requireEnterpriseAdmin()
  const groups = await listGroupsAction()

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">权限组</h1>
          <p className="text-sm text-muted-foreground">
            {ctx.enterprise?.name} · 自定义权限组（D21：组绑定企业）
          </p>
        </div>
        <GroupCreateDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">权限组列表</CardTitle>
          <CardDescription>
            每企业至多一个默认组；组成员的 allowedModels/allowedPages 在企业已开通模块内进一步限定
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>组名</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>允许页面</TableHead>
                <TableHead className="text-right">并发上限</TableHead>
                <TableHead className="text-right">成员数</TableHead>
                <TableHead className="text-right">优先级</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
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
                  <TableCell className="text-right tabular-nums">
                    {g.maxConcurrent}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {g.memberCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {g.priority}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
