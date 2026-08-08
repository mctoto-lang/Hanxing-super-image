import { getCurrentUserContext } from "@/lib/auth/session"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

/**
 * 统一创作页（M3 完整实现）
 *
 * M1 阶段：占位，仅展示当前用户上下文，用于验证多租户地基打通。
 */
export default async function CreatePage() {
  const ctx = await getCurrentUserContext()
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">创作</h1>
        <p className="text-sm text-muted-foreground">
          统一 AI 创作页（M3 阶段实现完整的 Pulse 光效对话框与生图流程）
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">当前用户上下文（M1 验收）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            用户：<strong>{ctx?.user.name || ctx?.user.username}</strong>（@
            {ctx?.user.username}）
          </div>
          <div>
            角色：
            <Badge variant="secondary">
              {ctx?.user.isSuperAdmin ? "超管" : ctx?.user.enterpriseRole}
            </Badge>
            {ctx?.group?.name ? (
              <Badge variant="outline" className="ml-2">
                {ctx.group.name}
              </Badge>
            ) : null}
          </div>
          <div>
            归属企业：
            <strong>{ctx?.enterprise?.name ?? "无（超管）"}</strong>
            {ctx?.enterprise ? (
              <span className="ml-2 text-muted-foreground">
                积分余额 {ctx.enterprise.creditsBalance.toLocaleString("zh-CN")}
              </span>
            ) : null}
          </div>
          <div>
            可访问模块：
            {ctx?.accessibleModules.map((m) => (
              <Badge key={m} variant="outline" className="ml-1">
                {m}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
