"use client"

import * as React from "react"
import { Ban, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { setEnterpriseStatusAction } from "@/server/actions/platform"

/**
 * 企业停用/启用弹窗（超管）。
 *
 * 停用语义（session.ts 既有实现）：成员仍可登录，但企业视为无作用域，
 * 全部业务操作返回 403；启用后即时恢复。切换需二次确认。
 */
export function EnterpriseStatusDialog({
  enterpriseId,
  enterpriseName,
  status,
  size = "sm",
}: {
  enterpriseId: string
  enterpriseName: string
  status: "active" | "suspended"
  size?: "sm" | "default"
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const router = useRouter()
  const suspending = status === "active"

  function handleConfirm() {
    startTransition(async () => {
      const res = await setEnterpriseStatusAction({
        enterpriseId,
        status: suspending ? "suspended" : "active",
      })
      if (!res.ok) {
        toast.error(res.error ?? "操作失败")
        return
      }
      toast.success(suspending ? "企业已停用" : "企业已启用")
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      {suspending ? (
        <Button
          variant="outline"
          size={size}
          className="text-destructive"
          onClick={() => setOpen(true)}
        >
          <Ban className="size-3.5" />
          停用
        </Button>
      ) : (
        <Button variant="outline" size={size} onClick={() => setOpen(true)}>
          <CheckCircle2 className="size-3.5" />
          启用
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={suspending ? "停用企业" : "启用企业"}
        description={
          suspending
            ? `确认停用「${enterpriseName}」？停用后成员仍可登录，但全部业务操作（生图/对话/TEMU 等）将被拒绝，直至重新启用。`
            : `确认启用「${enterpriseName}」？启用后成员业务操作即时恢复。`
        }
        confirmText={suspending ? "确认停用" : "确认启用"}
        destructive={suspending}
        pending={pending}
        onConfirm={handleConfirm}
      />
    </>
  )
}
