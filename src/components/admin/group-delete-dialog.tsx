"use client"

import * as React from "react"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { deleteGroupAction } from "@/server/actions/admin-groups"

/**
 * 权限组删除弹窗（接线既有 deleteGroupAction，此前无 UI 入口）。
 *
 * 后端校验：默认组不可删、组内有成员不可删。有成员时删除按钮
 * 禁用并提示先在组成员弹窗里整组转移。
 */
export function GroupDeleteDialog({
  group,
}: {
  group: { id: string; name: string; memberCount: number }
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const router = useRouter()
  const hasMembers = group.memberCount > 0

  function handleConfirm() {
    startTransition(async () => {
      const res = await deleteGroupAction(group.id)
      if (!res.ok) {
        toast.error(res.error ?? "删除失败")
        return
      }
      toast.success(`已删除权限组 ${group.name}`)
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
        aria-label={`删除权限组 ${group.name}`}
        disabled={hasMembers}
        title={hasMembers ? "组内仍有成员，请先在成员数入口整组转移" : undefined}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="删除权限组"
        description={`确认删除权限组「${group.name}」？该组的页面/模型白名单与并发配置将一并移除，此操作不可撤销。`}
        confirmText="确认删除"
        destructive
        pending={pending}
        onConfirm={handleConfirm}
      />
    </>
  )
}
