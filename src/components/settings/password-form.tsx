"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { changePasswordAction } from "@/server/actions/settings"

export function PasswordForm() {
  const [, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const res = await changePasswordAction({
        currentPassword: String(formData.get("currentPassword") ?? ""),
        newPassword: String(formData.get("newPassword") ?? ""),
        confirmPassword: String(formData.get("confirmPassword") ?? ""),
      })
      if (res.ok) {
        toast.success("密码已更新")
        // 重置表单
        const form = document.querySelector("form[action]") as HTMLFormElement | null
        form?.reset()
      } else {
        toast.error(res.error ?? "更新失败")
      }
      return null
    },
    null,
  )

  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="currentPassword">当前密码</Label>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          required
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="newPassword">新密码</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={6}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="confirmPassword">确认新密码</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          minLength={6}
        />
      </div>
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        更新密码
      </Button>
    </form>
  )
}
