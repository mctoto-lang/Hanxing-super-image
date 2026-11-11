"use client"

import * as React from "react"
import { KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm } from "react-hook-form"
import { resetPasswordFormSchema } from "@/lib/forms/schemas"
import { resetPlatformUserPasswordAction } from "@/server/actions/platform"

/**
 * 超管重置平台用户密码弹窗。
 *
 * 可重置任何用户（含企业 owner——owner 忘密码的唯一兜底）；不能重置
 * 自己（走个人设置）。表单口径与企业管理侧 reset-password-dialog 一致
 * （resetPasswordFormSchema，confirm 一致性 refine 内联校验）。
 *
 * 会话口径：JWT 无状态、无密码版本校验，重置密码不会吊销已登录会话
 * （服务端成功返回 hint 同步提示）；如需强制下线，先停用再启用该账号。
 */
interface ResetPasswordFormValues {
  newPassword: string
  confirm: string
}

export function UserResetPasswordDialog({
  userId,
  username,
  name,
}: {
  userId: string
  username: string
  name: string | null
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<ResetPasswordFormValues>({
    resolver: standardSchemaResolver(resetPasswordFormSchema),
    defaultValues: { newPassword: "", confirm: "" },
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset({ newPassword: "", confirm: "" })
      setServerError(null)
    }
  }, [open, form])

  async function onSubmit(values: ResetPasswordFormValues) {
    setServerError(null)
    const res = await resetPlatformUserPasswordAction({
      userId,
      newPassword: values.newPassword,
    })
    if (res.ok) {
      toast.success(`已重置 ${username} 的密码`, {
        description:
          res.hint ?? "重置密码不会使已登录会话失效；如需强制下线，请先停用再启用该账号",
      })
      setOpen(false)
      router.refresh()
      return
    }
    setServerError(res.error ?? "重置失败")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`重置用户 ${username} 的密码`}
          >
            <KeyRound className="size-3.5" />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>
            {name ?? username}（@{username}）· 重置后请将新密码线下告知本人。
            重置不会使已登录会话失效；如需强制下线，请先停用再启用该账号。
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>新密码</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      minLength={6}
                      maxLength={128}
                      autoComplete="new-password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>确认新密码</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      minLength={6}
                      maxLength={128}
                      autoComplete="new-password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {serverError ? (
              <p className="text-sm text-destructive">{serverError}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "重置中..." : "重置密码"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
