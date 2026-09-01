"use client"

import * as React from "react"
import { useActionState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { createMemberAction } from "@/server/actions/admin-users"

export function MemberCreateDialog() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const res = await createMemberAction({
        username: String(formData.get("username") ?? ""),
        password: String(formData.get("password") ?? ""),
        name: String(formData.get("name") ?? "") || undefined,
        email: String(formData.get("email") ?? "") || undefined,
        role: (formData.get("role") as "admin" | "member" | undefined) ?? "member",
      })
      if (res.ok) {
        toast.success("成员创建成功")
        setOpen(false)
        router.refresh()
        return null
      }
      toast.error(res.error ?? "创建失败")
      return { error: res.error }
    },
    null,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="size-4" />添加成员</Button>} />
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="username">用户名</Label>
              <Input id="username" name="username" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="name">昵称</Label>
              <Input id="name" name="name" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="password">密码</Label>
              <Input id="password" name="password" type="password" required minLength={6} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email">邮箱（可选）</Label>
              <Input id="email" name="email" type="email" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>角色</Label>
            <Select
              name="role"
              defaultValue="member"
              items={[
                { value: "member", label: "成员" },
                { value: "admin", label: "管理员" },
              ]}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">成员</SelectItem>
                <SelectItem value="admin">管理员</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {state?.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
