"use client"

import { useActionState } from "react"
import { useRouter } from "next/navigation"
import { cn, toImageSrc } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { loginAction } from "@/server/actions/auth"

/** 登录页右侧品牌视觉图（COS config/ 前缀，不过期；上传：scripts/upload-config-asset.ts） */
const BRAND_IMAGE_URL =
  "https://super-hanxin-image-ceshi-1317363725.cos.ap-guangzhou.myqcloud.com/config/_platform/2026/09/74dd2769-2237-4722-a909-71e19a9d9dbc.png"

/**
 * 登录表单（基于 login-04 模板改造，手册 §7.2）
 *
 * - 邮箱 → 用户名；
 * - 社交登录按钮保留样式，点击提示"暂未开放"；
 * - "Sign up" 提示"内部系统，联系管理员开通"；
 * - 右侧品牌区为 COS 品牌视觉图，容器保留渐变兜底（图片加载失败不空白）。
 */
export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const router = useRouter()
  const [state, formAction, isPending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const res = await loginAction({
        username: String(formData.get("username") ?? ""),
        password: String(formData.get("password") ?? ""),
      })
      if (res.ok) {
        toast.success("登录成功")
        router.push(res.redirectTo ?? "/create")
        router.refresh()
        return null
      }
      toast.error(res.error ?? "登录失败")
      return { error: res.error }
    },
    null,
  )

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card className="gap-0 overflow-hidden py-0">
        <CardContent className="grid p-0 md:grid-cols-2">
          <form action={formAction} className="p-6 md:p-8">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col items-center text-center">
                <h1 className="text-2xl font-bold">欢迎回来</h1>
                <p className="text-balance text-muted-foreground">
                  登录瀚星 Super Image 企业工作台
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="username">用户名</Label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  placeholder="请输入用户名"
                  autoComplete="username"
                  required
                />
              </div>
              <div className="grid gap-2">
                <div className="flex items-center">
                  <Label htmlFor="password">密码</Label>
                  <a
                    href="#"
                    className="ml-auto text-sm underline-offset-2 hover:underline"
                    title="内部系统，请联系管理员重置"
                    onClick={(e) => {
                      e.preventDefault()
                      toast.info("请联系企业管理员重置密码")
                    }}
                  >
                    忘记密码？
                  </a>
                </div>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={isPending}>
                {isPending ? "登录中..." : "登录"}
              </Button>
              {state?.error ? (
                <p role="alert" className="text-center text-sm text-destructive">
                  {state.error}
                </p>
              ) : null}
              <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
                <span className="relative z-10 bg-background px-2 text-muted-foreground">
                  或使用第三方登录
                </span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <SocialButton label="GitHub" onClick={() => toast.info("暂未开放，请联系管理员")}>
                  <svg viewBox="0 0 24 24" className="size-4" fill="currentColor">
                    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                  </svg>
                </SocialButton>
                <SocialButton label="Google" onClick={() => toast.info("暂未开放，请联系管理员")}>
                  <svg viewBox="0 0 24 24" className="size-4">
                    <path fill="#4285F4" d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
                  </svg>
                </SocialButton>
                <SocialButton label="WeChat" onClick={() => toast.info("暂未开放，请联系管理员")}>
                  <svg viewBox="0 0 24 24" className="size-4" fill="currentColor">
                    <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303z" />
                  </svg>
                </SocialButton>
              </div>
              <div className="text-center text-sm">
                没有账号？{" "}
                <a
                  href="#"
                  className="underline underline-offset-4"
                  onClick={(e) => {
                    e.preventDefault()
                    toast.info("内部系统，请联系管理员开通账号")
                  }}
                >
                  注册
                </a>
              </div>
            </div>
          </form>
          <div className="relative hidden bg-gradient-to-br from-primary/20 via-background to-background md:block">
            <img
              src={toImageSrc(BRAND_IMAGE_URL, { width: 800 })}
              alt="瀚星 Super Image 品牌视觉"
              className="absolute inset-0 h-full w-full object-cover"
              draggable={false}
            />
          </div>
        </CardContent>
      </Card>
      <div className="text-balance text-center text-xs text-muted-foreground">
        继续使用即表示您同意我们的服务条款与隐私政策。
      </div>
    </div>
  )
}

function SocialButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      aria-label={`Login with ${label}`}
      onClick={onClick}
    >
      {children}
      <span className="sr-only">Login with {label}</span>
    </Button>
  )
}
