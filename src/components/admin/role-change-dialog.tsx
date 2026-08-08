"use client"

import * as React from "react"
import { useFormState } from "react-dom"
import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { changeRoleAction } from "@/server/actions/admin-users"
import type { EnterpriseRole } from "@/db/schema"

export function RoleChangeDialog({
  userId,
  currentRole,
}: {
  userId: string
  currentRole: EnterpriseRole
}) {
  const [open, setOpen] = React.useState(false)
  const [role, setRole] = React.useState<EnterpriseRole>(currentRole)
  const router = useRouter()

  const [state, formAction, pending] = useFormState(
    async (_prev: unknown, formData: FormData) => {
      const res = await changeRoleAction({
        userId,
        role: (formData.get("role") as EnterpriseRole) ?? "member",
      })
      if (res.ok) {
        toast.success("角色已更新")
        setOpen(false)
        router.refresh()
        return null
      }
      toast.error(res.error ?? "更新失败")
      return { error: res.error }
    },
    null,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm"><Pencil className="size-3.5" /></Button>} />
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>修改角色</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="role" value={role} />
          <Select
            value={role}
            onValueChange={(v) => setRole((v ?? "member") as EnterpriseRole)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">成员</SelectItem>
              <SelectItem value="admin">管理员</SelectItem>
            </SelectContent>
          </Select>
          {state?.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "更新中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
