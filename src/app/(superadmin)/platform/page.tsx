import { requireSuperAdmin } from "@/lib/auth/session"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * 平台管理总览（M2 完整实现：企业/用户/系统设置）
 */
export default async function PlatformPage() {
  const ctx = await requireSuperAdmin()
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">平台管理</h1>
        <p className="text-sm text-muted-foreground">
          超级管理员 · {ctx.user.username}
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">平台管理控制台</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          M2 阶段实现：企业管理（创建/配置/充值）、平台用户、系统设置。
        </CardContent>
      </Card>
    </div>
  )
}
