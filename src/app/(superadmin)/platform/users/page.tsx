import { requireSuperAdmin } from "@/lib/auth/session"
import { listAllUsersAction, listEnterprisesAction } from "@/server/actions/platform"
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
import { UserCreateDialog } from "@/components/superadmin/user-create-dialog"

export const dynamic = "force-dynamic"

export default async function PlatformUsersPage() {
  await requireSuperAdmin()
  const [users, enterprises] = await Promise.all([
    listAllUsersAction(),
    listEnterprisesAction(),
  ])

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">平台用户</h1>
          <p className="text-sm text-muted-foreground">
            创建用户并分配企业（D19：用户由超管创建并分配）
          </p>
        </div>
        <UserCreateDialog enterprises={enterprises} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">用户列表</CardTitle>
          <CardDescription>共 {users.length} 个用户</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户名</TableHead>
                <TableHead>昵称</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>归属企业</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近登录</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-mono">{u.username}</TableCell>
                  <TableCell>{u.name}</TableCell>
                  <TableCell>
                    {u.isSuperAdmin ? (
                      <Badge>超管</Badge>
                    ) : (
                      <Badge variant="outline">企业用户</Badge>
                    )}
                  </TableCell>
                  <TableCell>{u.enterpriseName ?? "—"}</TableCell>
                  <TableCell>
                    {u.enterpriseRole ? (
                      <Badge variant="secondary">
                        {u.enterpriseRole === "owner"
                          ? "企业主"
                          : u.enterpriseRole === "admin"
                            ? "管理员"
                            : "成员"}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={u.status === "active" ? "default" : "destructive"}
                    >
                      {u.status === "active" ? "正常" : "禁用"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {u.lastLoginAt
                      ? new Date(u.lastLoginAt).toLocaleString("zh-CN")
                      : "—"}
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
