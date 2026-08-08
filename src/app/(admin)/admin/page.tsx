import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * 企业管理总览（M2 完整实现：成员/权限组/积分/日志）
 */
export default async function AdminPage() {
  const ctx = await requireEnterpriseAdmin()
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">企业管理</h1>
        <p className="text-sm text-muted-foreground">
          {ctx.enterprise?.name} · {ctx.user.enterpriseRole}
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">企业管理控制台</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          M2 阶段实现：成员管理、权限组、积分流水、操作日志。
        </CardContent>
      </Card>
    </div>
  )
}
