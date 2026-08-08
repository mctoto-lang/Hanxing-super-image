import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { listMembersAction } from "@/server/actions/admin-users"
import { listGroupsAction as listGroups } from "@/server/actions/admin-groups"
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
import { MemberCreateDialog } from "@/components/admin/member-create-dialog"
import { RoleChangeDialog } from "@/components/admin/role-change-dialog"
import { GroupAssignDialog } from "@/components/admin/group-assign-dialog"
import { RemoveMemberDialog } from "@/components/admin/remove-member-dialog"

export const dynamic = "force-dynamic"

export default async function AdminUsersPage() {
  const ctx = await requireEnterpriseAdmin()
  const [members, groups] = await Promise.all([listMembersAction(), listGroups()])

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">成员管理</h1>
          <p className="text-sm text-muted-foreground">
            {ctx.enterprise?.name} · 共 {members.length} 名成员
          </p>
        </div>
        <MemberCreateDialog />
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户名</TableHead>
                <TableHead>昵称</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>权限组</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近登录</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono">{m.username}</TableCell>
                  <TableCell>{m.name}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        m.enterpriseRole === "owner"
                          ? "default"
                          : m.enterpriseRole === "admin"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {m.enterpriseRole === "owner"
                        ? "企业主"
                        : m.enterpriseRole === "admin"
                          ? "管理员"
                          : "成员"}
                    </Badge>
                  </TableCell>
                  <TableCell>{m.groupName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={m.status === "active" ? "default" : "destructive"}
                    >
                      {m.status === "active" ? "正常" : "禁用"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {m.lastLoginAt
                      ? new Date(m.lastLoginAt).toLocaleString("zh-CN")
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {m.enterpriseRole !== "owner" ? (
                      <div className="flex justify-end gap-1">
                        <RoleChangeDialog
                          userId={m.id}
                          currentRole={m.enterpriseRole}
                        />
                        <GroupAssignDialog
                          userId={m.id}
                          username={m.username}
                          currentGroupId={m.groupId}
                          groups={groups}
                        />
                        <RemoveMemberDialog
                          userId={m.id}
                          username={m.username}
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">企业主</span>
                    )}
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
