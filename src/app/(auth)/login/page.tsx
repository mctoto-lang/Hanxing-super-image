import { redirect } from "next/navigation"

import { LoginForm } from "@/components/login-form"
import { getCurrentUserContext } from "@/lib/auth/session"
import { postLoginPath } from "@/lib/auth/post-login"

/**
 * 登录页
 *
 * 已有登录态的用户直接按角色进入工作台（超管 → /platform，其余 → /create），
 * 未登录才展示登录表单——营销页「登录」按钮依赖此行为实现"直接登录"。
 */
export default async function LoginPage() {
  const ctx = await getCurrentUserContext()
  if (ctx) {
    redirect(postLoginPath(ctx.user.isSuperAdmin))
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-6 md:p-10">
      <div className="w-full max-w-sm md:max-w-3xl">
        <LoginForm />
      </div>
    </div>
  )
}
