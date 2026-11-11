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
import { resetMemberPasswordAction } from "@/server/actions/admin-users"

/**
 * 管理员重置成员密码弹窗。
 *
 * 登录页承诺「请联系企业管理员重置密码」，此前管理端并无此能力；
 * 现补齐：可重置本企业其他非 owner 成员；不能重置自己（走个人设置）。
 * owner 需由平台超管处理（resetPlatformUserPasswordAction），
 * 口径同 setMemberStatusAction。
 *
 * 表单口径：useForm + standardSchemaResolver（resetPasswordFormSchema，
 * confirm 一致性由 refine 内联校验）；服务端兜底错误显示在 footer 上方。
 */
interface ResetPasswordFormValues {
  newPassword: string
  confirm: string
}

export function ResetPasswordDialog({
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
    const res = await resetMemberPasswordAction({
      userId,
      newPassword: values.newPassword,
    })
    if (res.ok) {
      toast.success(`已重置 ${username} 的密码`)
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
            aria-label={`重置成员 ${username} 的密码`}
          >
            <KeyRound className="size-3.5" />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>
            {name ?? username}（@{username}）· 重置后请将新密码线下告知本人
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
