import { requireSuperAdmin } from "@/lib/auth/session"
import { roleLabel } from "@/lib/auth/permissions"
import { listAllUsersAction, listEnterprisesAction } from "@/server/actions/platform"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Search } from "lucide-react"
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
  parseQueryParam,
} from "@/components/shared/table-pagination"
import { UserCreateDialog } from "@/components/superadmin/user-create-dialog"

export const dynamic = "force-dynamic"

export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireSuperAdmin()
  const sp = await searchParams
  const page = parsePageParam(sp)
  const q = parseQueryParam(sp, "q")

  const [{ items: users, total, pageSize }, { items: enterprises }] =
    await Promise.all([
      listAllUsersAction({ page, pageSize: 20, q }),
      listEnterprisesAction({ pageSize: 50 }), // 建用户弹窗下拉全量取
    ])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">平台用户</h1>
          <p className="text-sm text-muted-foreground">
            创建用户并分配企业（D19：用户由超管创建并分配）· 共 {total} 个用户
          </p>
        </div>
        <div className="flex items-center gap-2">
          <form action="/platform/users" className="flex items-center gap-2">
            <Input
              name="q"
              defaultValue={q}
              placeholder="搜索用户名 / 昵称 / 邮箱"
              className="w-56"
            />
            <Button type="submit" variant="outline" size="sm">
              <Search className="size-3.5" />
              搜索
            </Button>
          </form>
          <UserCreateDialog enterprises={enterprises} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">用户列表</CardTitle>
          <CardDescription>全平台用户（含超管与企业用户）</CardDescription>
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
              {users.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {q ? `未找到与「${q}」匹配的用户` : "暂无用户"}
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => (
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
                          {roleLabel(u.enterpriseRole)}
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
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/platform/users"
          query={{ q }}
        />
      </Card>
    </div>
  )
}
