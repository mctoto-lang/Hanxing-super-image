import Link from "next/link"
import { Users, Shield, Coins, Cpu, ScrollText, MessageSquare, BarChart3 } from "lucide-react"
import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function AdminPage() {
  await requireEnterpriseAdmin()
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/admin/stats">
          <Card className="cursor-pointer transition-colors hover:border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="size-4" /> 数据看板
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              成员消耗趋势、模块占比与排行
            </CardContent>
          </Card>
        </Link>
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
        <Link href="/admin/models">
          <Card className="cursor-pointer transition-colors hover:border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="size-4" /> 生图模型
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              模型 CRUD、API Key 加密、可见性/计费
            </CardContent>
          </Card>
        </Link>
        <Link href="/admin/chat-models">
          <Card className="cursor-pointer transition-colors hover:border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquare className="size-4" /> 对话模型
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              OpenAI 兼容对话模型 CRUD（提示词模板用）
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
        <Link href="/admin/logs">
          <Card className="cursor-pointer transition-colors hover:border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ScrollText className="size-4" /> 操作日志
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              生图任务日志与登录审计
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  )
}
