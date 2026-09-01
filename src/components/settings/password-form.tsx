"use client"

import { useActionState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { toast } from "sonner"
import { changePasswordAction } from "@/server/actions/settings"

export function PasswordForm() {
  // 指向本表单的引用：设置页同时渲染 ProfileForm 等多个表单，
  // document.querySelector("form[action]") 可能选中其它表单
  const formRef = useRef<HTMLFormElement>(null)
  const [, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const res = await changePasswordAction({
        currentPassword: String(formData.get("currentPassword") ?? ""),
        newPassword: String(formData.get("newPassword") ?? ""),
        confirmPassword: String(formData.get("confirmPassword") ?? ""),
      })
      if (res.ok) {
        toast.success("密码已更新")
        formRef.current?.reset()
      } else {
        toast.error(res.error ?? "更新失败")
      }
      return null
    },
    null,
  )

  return (
    <form ref={formRef} action={formAction} className="grid gap-4">
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
        {pending ? <MorphingInfinity className="size-4" /> : null}
        更新密码
      </Button>
    </form>
  )
}
