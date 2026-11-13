"use client"

import * as React from "react"
import { Ban, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { setMemberStatusAction } from "@/server/actions/admin-users"

/**
 * 成员禁用/启用弹窗（企业管理员）。
 *
 * 禁用后：无法登录、在途会话周期复核时即时降权、历史数据保留；
 * 重新启用即恢复。owner 不可由此入口操作（由超管处理）。
 */
export function MemberStatusDialog({
  userId,
  username,
  status,
}: {
  userId: string
  username: string
  status: "active" | "disabled"
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const router = useRouter()
  const disabling = status === "active"

  function handleConfirm() {
    startTransition(async () => {
      const res = await setMemberStatusAction({
        userId,
        status: disabling ? "disabled" : "active",
      })
      if (!res.ok) {
        toast.error(res.error ?? "操作失败")
        return
      }
      toast.success(disabling ? `已禁用 ${username}` : `已启用 ${username}`)
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      {disabling ? (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          onClick={() => setOpen(true)}
        >
          <Ban className="size-3.5" />
          禁用
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <CheckCircle2 className="size-3.5" />
          启用
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={disabling ? "禁用成员" : "启用成员"}
        description={
          disabling
            ? `确认禁用 ${username}？禁用后该成员无法登录、业务操作即时失效，历史数据保留；重新启用即可恢复。`
            : `确认启用 ${username}？启用后该成员可立即登录使用。`
        }
        confirmText={disabling ? "确认禁用" : "确认启用"}
        destructive={disabling}
        pending={pending}
        onConfirm={handleConfirm}
      />
    </>
  )
}
