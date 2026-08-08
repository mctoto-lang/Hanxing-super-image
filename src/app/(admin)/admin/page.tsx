import Link from "next/link"
import { Users, Shield, Coins } from "lucide-react"
import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function AdminPage() {
  const ctx = await requireEnterpriseAdmin()
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">企业管理</h1>
        <p className="text-sm text-muted-foreground">
          {ctx.enterprise?.name} · {ctx.user.enterpriseRole === "owner" ? "企业主" : "管理员"}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/admin/users">
          <Card className="cursor-pointer transition-colors hover:border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="size-4" /> 成员管理
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              增删成员、改角色、分配权限组（D19）
            </CardContent>
          </Card>
        </Link>
        <Link href="/admin/groups">
          <Card className="cursor-pointer transition-colors hover:border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Shield className="size-4" /> 权限组
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              自定义权限组（模型/页面/并发，D21）
            </CardContent>
          </Card>
        </Link>
        <Link href="/admin/credits">
          <Card className="cursor-pointer transition-colors hover:border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Coins className="size-4" /> 积分流水
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              企业积分余额与流水审计
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  )
}
