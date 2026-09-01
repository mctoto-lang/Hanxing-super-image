import { requireUserContext } from "@/lib/auth/session"
import { roleLabel } from "@/lib/auth/permissions"
import { db } from "@/db/client"
import { users } from "@/db/schema"
import { eq } from "drizzle-orm"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ProfileForm } from "@/components/settings/profile-form"
import { AvatarForm } from "@/components/settings/avatar-form"
import { PasswordForm } from "@/components/settings/password-form"

export const dynamic = "force-dynamic"

export default async function SettingsPage() {
  const ctx = await requireUserContext()
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, ctx.user.id))
    .limit(1)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">个人设置</h1>
        <p className="text-sm text-muted-foreground">头像、个人资料与密码</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">个人资料</CardTitle>
          <CardDescription>头像、昵称、邮箱、账号信息</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <AvatarForm
            initialImage={user?.image ?? null}
            fallbackText={user?.name || user?.username || "?"}
          />
          <div className="grid gap-1 text-sm">
            <div>
              用户名（登录账号，不可改）：{" "}
              <span className="font-mono">{user?.username}</span>
            </div>
            <div>
              归属企业：{" "}
              <strong>{ctx.enterprise?.name ?? "无（超管）"}</strong>
            </div>
            <div>
              角色：
              {ctx.user.isSuperAdmin
                ? "超级管理员"
                : roleLabel(ctx.user.enterpriseRole)}
              {ctx.group?.name ? ` · 权限组：${ctx.group.name}` : ""}
            </div>
          </div>
          <ProfileForm
            initialName={user?.name ?? ""}
            initialEmail={user?.email ?? ""}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">修改密码</CardTitle>
          <CardDescription>至少 6 字符</CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordForm />
        </CardContent>
      </Card>
    </div>
  )
}
