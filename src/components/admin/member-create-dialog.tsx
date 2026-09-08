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

export function MemberCreateDialog({
  groups,
}: {
  groups: Array<{ id: string; name: string; isDefault: boolean }>
}) {
  const [open, setOpen] = React.useState(false)
  const [role, setRole] = React.useState<"member" | "admin">("member")
  const [groupId, setGroupId] = React.useState("")
  const router = useRouter()

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const res = await createMemberAction({
        username: String(formData.get("username") ?? ""),
        password: String(formData.get("password") ?? ""),
        name: String(formData.get("name") ?? "") || undefined,
        email: String(formData.get("email") ?? "") || undefined,
        role: (formData.get("role") as "admin" | "member" | undefined) ?? "member",
        // 未选择时走后端默认逻辑：自动进入企业默认权限组
        groupId: groupId || undefined,
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
              value={role}
              onValueChange={(v) => setRole((v ?? "member") as "member" | "admin")}
              items={[
                { value: "member", label: "成员" },
                { value: "admin", label: "成员管理员" },
              ]}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {role === "admin" ? "成员管理员" : "成员"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">成员</SelectItem>
                <SelectItem value="admin">成员管理员</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>权限组</Label>
            <Select
              value={groupId || "__default__"}
              onValueChange={(v) => setGroupId(v && v !== "__default__" ? v : "")}
              items={[
                { value: "__default__", label: "默认权限组（自动分配）" },
                ...groups.map((g) => ({
                  value: g.id,
                  label: g.isDefault ? `${g.name}（默认）` : g.name,
                })),
              ]}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {groupId
                    ? (groups.find((g) => g.id === groupId)?.name ?? "选择权限组")
                    : "默认权限组（自动分配）"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">默认权限组（自动分配）</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.isDefault ? `${g.name}（默认）` : g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {state?.error ? (
            <p role="alert" className="text-sm text-destructive">{state.error}</p>
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
