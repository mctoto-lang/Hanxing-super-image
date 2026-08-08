"use client"

import * as React from "react"
import { useFormState } from "react-dom"
import { Plus } from "lucide-react"
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
import { createUserAndAssignAction } from "@/server/actions/platform"

export function UserCreateDialog({
  enterprises,
}: {
  enterprises: { id: string; name: string }[]
}) {
  const [open, setOpen] = React.useState(false)
  const [enterpriseId, setEnterpriseId] = React.useState("")
  const router = useRouter()

  const [state, formAction, pending] = useFormState(
    async (_prev: unknown, formData: FormData) => {
      const res = await createUserAndAssignAction({
        username: String(formData.get("username") ?? ""),
        password: String(formData.get("password") ?? ""),
        name: String(formData.get("name") ?? "") || undefined,
        email: String(formData.get("email") ?? "") || undefined,
        enterpriseId: String(formData.get("enterpriseId") ?? ""),
        role: (formData.get("role") as "owner" | "admin" | "member") ?? "member",
      })
      if (res.ok) {
        toast.success("用户创建成功")
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
      <DialogTrigger render={<Button><Plus className="size-4" />创建用户</Button>} />
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>创建用户并分配企业</DialogTitle>
          <DialogDescription>
            用户名全局唯一；新用户默认分配到企业默认权限组（D19）
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                name="username"
                required
                placeholder="如：zhangsan"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="name">昵称</Label>
              <Input id="name" name="name" placeholder="如：张三" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={6}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email">邮箱（可选）</Label>
              <Input id="email" name="email" type="email" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>归属企业</Label>
              <input type="hidden" name="enterpriseId" value={enterpriseId} />
              <Select
                value={enterpriseId}
                onValueChange={(v) => setEnterpriseId(v ?? "")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择企业" />
                </SelectTrigger>
                <SelectContent>
                  {enterprises.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="role">角色</Label>
              <Select name="role" defaultValue="member">
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">成员</SelectItem>
                  <SelectItem value="admin">管理员</SelectItem>
                  <SelectItem value="owner">企业主</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {state?.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending || !enterpriseId}>
              {pending ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
