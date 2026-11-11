import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { roleLabel } from "@/lib/auth/permissions"
import { listMembersAction } from "@/server/actions/admin-users"
import { listAllGroupsAction as listAllGroups } from "@/server/actions/admin-groups"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
import { formatDateTime } from "@/lib/datetime"
import { MemberCreateDialog } from "@/components/admin/member-create-dialog"
import { MemberSearchInput } from "@/components/admin/member-search-input"
import { MemberEditDialog } from "@/components/admin/member-edit-dialog"
import { RemoveMemberDialog } from "@/components/admin/remove-member-dialog"
import { AllocateCreditsDialog } from "@/components/admin/allocate-credits-dialog"
import { CreditsAdjustDialog } from "@/components/admin/credits-adjust-dialog"
import { MemberStatusDialog } from "@/components/admin/member-status-dialog"
import { ResetPasswordDialog } from "@/components/admin/reset-password-dialog"

export const dynamic = "force-dynamic"

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireEnterpriseAdmin()
  const sp = await searchParams
  const page = parsePageParam(sp)
  const q = parseQueryParam(sp, "q")

  const [{ items: members, total, pageSize }, groups] = await Promise.all([
    listMembersAction({ page, pageSize: 20, q }),
    listAllGroups(), // 权限组下拉全量取（分组本身有分页页面；>50 组时翻页拉全量）
  ])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <MemberSearchInput defaultValue={q} />
        <MemberCreateDialog
          groups={groups.map((g) => ({
            id: g.id,
            name: g.name,
            isDefault: g.isDefault,
          }))}
        />
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成员</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>权限组</TableHead>
                <TableHead>个人配额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近登录</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 ? (
                <TableEmpty colSpan={7} noun="成员" filtered={!!q} />
              ) : (
                members.map((m) => {
                  const initials = (m.name || m.username).slice(0, 1).toUpperCase()
                  return (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <Avatar className="size-8">
                            <AvatarImage
                              src={m.image ?? undefined}
                              alt={m.name ?? m.username}
                            />
                            <AvatarFallback className="text-xs">
                              {initials}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="font-mono text-sm">{m.username}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {m.name}
                            </div>
                          </div>
                        </div>
                      </TableCell>
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
                          {roleLabel(m.enterpriseRole)}
                        </Badge>
                      </TableCell>
                    <TableCell>{m.groupName ?? "—"}</TableCell>
                    <TableCell className="tabular-nums font-medium">
                      {m.creditsBalance.toLocaleString("zh-CN")}
                    </TableCell>
                      <TableCell>
                        <Badge
                          variant={m.status === "active" ? "default" : "destructive"}
                        >
                          {m.status === "active" ? "正常" : "禁用"}
                        </Badge>
                      </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(m.lastLoginAt)}
                    </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <MemberEditDialog
                            member={{
                              id: m.id,
                              username: m.username,
                              name: m.name,
                              email: m.email,
                              image: m.image,
                              enterpriseRole: m.enterpriseRole,
                              groupId: m.groupId,
                            }}
                            groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                          />
                          {m.id !== ctx.user.id && m.enterpriseRole !== "owner" ? (
                            <ResetPasswordDialog
                              userId={m.id}
                              username={m.username}
                              name={m.name}
                            />
                          ) : null}
                          <AllocateCreditsDialog
                            targetUserId={m.id}
                            targetUsername={m.username}
                            targetName={m.name}
                            currentBalance={m.creditsBalance}
                            enterpriseBalance={
                              ctx.enterprise?.creditsBalance ?? 0
                            }
                          />
                          <CreditsAdjustDialog
                            targetUserId={m.id}
                            targetUsername={m.username}
                            targetName={m.name}
                            currentBalance={m.creditsBalance}
                          />
                          {m.enterpriseRole !== "owner" ? (
                            <MemberStatusDialog
                              userId={m.id}
                              username={m.username}
                              status={m.status}
                            />
                          ) : null}
                          {m.enterpriseRole !== "owner" ? (
                            <RemoveMemberDialog
                              userId={m.id}
                              username={m.username}
                            />
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/users"
          query={{ q }}
        />
      </Card>
    </div>
  )
}
