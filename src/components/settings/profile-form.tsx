"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { updateProfileAction } from "@/server/actions/settings"

export function ProfileForm({
  initialName,
  initialEmail,
}: {
  initialName: string
  initialEmail: string
}) {
  const [, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const res = await updateProfileAction({
        name: String(formData.get("name") ?? "") || undefined,
        email: String(formData.get("email") ?? "") || undefined,
      })
      if (res.ok) toast.success("资料已更新")
      else toast.error(res.error ?? "更新失败")
      return null
    },
    null,
  )

  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="name">昵称</Label>
        <Input id="name" name="name" defaultValue={initialName} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="email">邮箱</Label>
        <Input id="email" name="email" type="email" defaultValue={initialEmail} />
      </div>
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        保存
      </Button>
    </form>
  )
}
