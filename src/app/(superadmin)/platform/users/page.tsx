import { requireSuperAdmin } from "@/lib/auth/session"
import { roleLabel } from "@/lib/auth/permissions"
import {
  listAllUsersAction,
  listEnterpriseOptionsAction,
} from "@/server/actions/platform"
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
  parseQueryParam,
} from "@/components/shared/table-pagination"
import { TableEmpty } from "@/components/shared/table-empty"
import { PageHeader } from "@/components/shared/page-header"
import { formatDateTime } from "@/lib/datetime"
import { cn } from "@/lib/utils"
import { UserCreateDialog } from "@/components/superadmin/user-create-dialog"
import { UserEditDialog } from "@/components/superadmin/user-edit-dialog"
import { UserStatusDialog } from "@/components/superadmin/user-status-dialog"
import { UserResetPasswordDialog } from "@/components/superadmin/user-reset-password-dialog"
import { UserFilterBar } from "@/components/superadmin/user-filter-bar"

export const dynamic = "force-dynamic"

/** 类型/状态筛选白名单（非法值回落全部，同企业列表口径） */

export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireSuperAdmin()
  const sp = await searchParams
  const page = parsePageParam(sp)
  const q = parseQueryParam(sp, "q")
  const rawType = parseQueryParam(sp, "type")
  const type = rawType === "superadmin" || rawType === "enterprise" ? rawType : ""
  const rawStatus = parseQueryParam(sp, "status")
  const status = rawStatus === "active" || rawStatus === "disabled" ? rawStatus : ""
  const enterpriseId = parseQueryParam(sp, "enterpriseId")

  const [{ items: users, total, pageSize }, { items: enterprises }] =
    await Promise.all([
      listAllUsersAction({
        page,
        pageSize: 20,
        q,
        type: type || undefined,
        status: status || undefined,
        enterpriseId: enterpriseId || undefined,
      }),
      listEnterpriseOptionsAction(), // 建/编辑用户与筛选条的企业下拉选项（全量、不截断）
    ])

  const filtered = !!(q || type || status || enterpriseId)

  return (
    <div className="space-y-4">
      <PageHeader
        title="平台用户"
        description={`创建并管理全平台用户（D19：用户由超管创建并分配）· 共 ${total} 个用户`}
      >
        <UserCreateDialog enterprises={enterprises} />
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">用户列表</CardTitle>
          <CardDescription>全平台用户（含超管与企业用户）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <UserFilterBar
            q={q}
            type={type}
            status={status}
            enterpriseId={enterpriseId}
            enterprises={enterprises}
          />
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
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableEmpty colSpan={8} noun="用户" filtered={filtered} />
              ) : (
                users.map((u) => (
                  <TableRow key={u.id} className={u.status === "disabled" ? "opacity-60" : undefined}>
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
                      {u.enterpriseRole && !u.isSuperAdmin ? (
                        <Badge variant="secondary">
                          {roleLabel(u.enterpriseRole)}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={u.status === "active" ? "default" : "destructive"}
                      >
                        {u.status === "active" ? "正常" : "已停用"}
                      </Badge>
                    </TableCell>
                    <TableCell className={cn("text-xs text-muted-foreground")}>
                      {formatDateTime(u.lastLoginAt)}
                    </TableCell>
                    <TableCell>
                      {/* 当前登录账号不提供自助操作（编辑/停用/重置密码均须其他超管处理） */}
                      {u.id === ctx.user.id ? (
                        <span className="text-xs text-muted-foreground">当前账号</span>
                      ) : (
                        <div className="flex justify-end gap-0.5">
                          <UserEditDialog
                            user={{
                              id: u.id,
                              username: u.username,
                              name: u.name,
                              isSuperAdmin: u.isSuperAdmin,
                              enterpriseId: u.enterpriseId,
                              enterpriseRole: u.enterpriseRole ?? "member",
                            }}
                            enterprises={enterprises}
                          />
                          <UserResetPasswordDialog
                            userId={u.id}
                            username={u.username}
                            name={u.name}
                          />
                          <UserStatusDialog
                            userId={u.id}
                            username={u.username}
                            status={u.status}
                          />
                        </div>
                      )}
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
          query={{ q, type, status, enterpriseId }}
        />
      </Card>
    </div>
  )
}
