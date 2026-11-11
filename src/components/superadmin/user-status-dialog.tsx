"use client"

import * as React from "react"
import { Ban, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { setPlatformUserStatusAction } from "@/server/actions/platform"

/**
 * 平台用户停用/启用弹窗（超管）。
 *
 * 禁用后：无法登录、在途会话周期复核时即时降权、历史数据保留；重新
 * 启用即恢复。最后一个可用 owner 的停用由服务端拒绝（文案兜底）。
 */
export function UserStatusDialog({
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
      const res = await setPlatformUserStatusAction({
        userId,
        status: disabling ? "disabled" : "active",
      })
      if (!res.ok) {
        toast.error(res.error ?? "操作失败")
        return
      }
      toast.success(disabling ? `已停用 ${username}` : `已启用 ${username}`)
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      {disabling ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          aria-label={`停用用户 ${username}`}
          onClick={() => setOpen(true)}
        >
          <Ban className="size-3.5" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`启用用户 ${username}`}
          onClick={() => setOpen(true)}
        >
          <CheckCircle2 className="size-3.5" />
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={disabling ? "停用用户" : "启用用户"}
        description={
          disabling
            ? `确认停用 ${username}？停用后该用户无法登录、业务操作即时失效，历史数据保留；重新启用即可恢复。`
            : `确认启用 ${username}？启用后该用户可立即登录使用。`
        }
        confirmText={disabling ? "确认停用" : "确认启用"}
        destructive={disabling}
        pending={pending}
        onConfirm={handleConfirm}
      />
    </>
  )
}
