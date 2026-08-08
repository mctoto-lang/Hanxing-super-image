"use client"

import * as React from "react"
import { useFormState } from "react-dom"
import { Users } from "lucide-react"
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
import { assignGroupAction } from "@/server/actions/admin-users"

export function GroupAssignDialog({
  userId,
  username,
  currentGroupId,
  groups,
}: {
  userId: string
  username: string
  currentGroupId: string | null
  groups: { id: string; name: string }[]
}) {
  const [open, setOpen] = React.useState(false)
  const [groupId, setGroupId] = React.useState(currentGroupId ?? "")
  const router = useRouter()

  const [state, formAction, pending] = useFormState(
    async (_prev: unknown, formData: FormData) => {
      const res = await assignGroupAction({
        userId,
        groupId: String(formData.get("groupId") ?? ""),
      })
      if (res.ok) {
        toast.success("权限组已更新")
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
      <DialogTrigger render={<Button variant="ghost" size="sm"><Users className="size-3.5" /></Button>} />
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>分配权限组</DialogTitle>
          <p className="text-sm text-muted-foreground">为 {username} 分配权限组</p>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="groupId" value={groupId} />
          <Select value={groupId} onValueChange={(v) => setGroupId(v ?? "")}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择权限组" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {state?.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending || !groupId}>
              {pending ? "更新中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
