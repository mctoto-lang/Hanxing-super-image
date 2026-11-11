"use client"

import * as React from "react"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { removeMemberAction } from "@/server/actions/admin-users"

/**
 * 删除成员（复用 ConfirmDialog，与 member-status 同一套确认口径）。
 *
 * 删除为硬删除：该成员的历史生图任务等数据随账号一并级联删除
 * （仅积分流水、登录日志置空保留），账号无法登录；
 * 文案引导「仅需暂停时先禁用」。
 */
export function RemoveMemberDialog({
  userId,
  username,
}: {
  userId: string
  username: string
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const router = useRouter()

  function handleConfirm() {
    startTransition(async () => {
      const res = await removeMemberAction(userId)
      if (!res.ok) {
        toast.error(res.error ?? "删除失败")
        return
      }
      toast.success(`已删除成员 ${username}`)
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        aria-label={`删除成员 ${username}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="删除成员"
        description={`确认删除成员 ${username}？该成员的历史生图任务、收藏等数据将随账号一并永久删除（仅积分流水、登录日志保留），账号将无法登录。此操作不可撤销。如仅需暂停使用，建议先「禁用」保留账号。`}
        confirmText="确认删除"
        destructive
        pending={pending}
        onConfirm={handleConfirm}
      />
    </>
  )
}
