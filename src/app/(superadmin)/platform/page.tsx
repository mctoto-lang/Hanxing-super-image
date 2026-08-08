import Link from "next/link"
import { Building2, Users } from "lucide-react"
import { requireSuperAdmin } from "@/lib/auth/session"
import { listEnterprisesAction, listAllUsersAction } from "@/server/actions/platform"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function PlatformPage() {
  const ctx = await requireSuperAdmin()
  const [enterprises, users] = await Promise.all([
    listEnterprisesAction(),
    listAllUsersAction(),
  ])

  const totalCredits = enterprises.reduce(
    (sum, e) => sum + e.creditsBalance,
    0,
  )

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">平台管理</h1>
        <p className="text-sm text-muted-foreground">
          超级管理员 · {ctx.user.username}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              企业总数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{enterprises.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              用户总数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              平台积分总量
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {totalCredits.toLocaleString("zh-CN")}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/platform/enterprises">
          <Card className="cursor-pointer transition-colors hover:border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 className="size-4" /> 企业管理
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              创建企业、配置模块开关、充值积分
            </CardContent>
          </Card>
        </Link>
        <Link href="/platform/users">
          <Card className="cursor-pointer transition-colors hover:border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="size-4" /> 平台用户
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              创建用户并分配到企业、设置初始角色
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  )
}
