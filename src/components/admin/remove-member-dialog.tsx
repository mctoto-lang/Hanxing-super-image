"use client"

import * as React from "react"
import { useActionState } from "react"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { removeMemberAction } from "@/server/actions/admin-users"

export function RemoveMemberDialog({
  userId,
  username,
}: {
  userId: string
  username: string
}) {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()

  const [, formAction, pending] = useActionState(
    async (_prev: unknown) => {
      const res = await removeMemberAction(userId)
      if (res.ok) {
        toast.success(`已删除成员 ${username}`)
        setOpen(false)
        router.refresh()
        return null
      }
      toast.error(res.error ?? "删除失败")
      return { error: res.error }
    },
    null,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive" aria-label={`删除成员 ${username}`}><Trash2 className="size-3.5" /></Button>} />
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>删除成员</DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          确认删除成员 <strong>{username}</strong>？该成员的历史任务数据会保留在
          企业内（审计一致性），但账号将无法登录。此操作不可撤销。
        </p>
        <form action={formAction}>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
