"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { deleteBannerAction } from "@/server/actions/platform-banners"

/** 删除横幅（复用 ConfirmDialog，与全站确认弹窗口径一致） */
export function BannerDeleteButton({ id, title }: { id: string; title: string }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()

  function handleConfirm() {
    startTransition(async () => {
      const res = await deleteBannerAction({ id })
      if (!res.ok) {
        toast.error(res.error ?? "删除失败")
        return
      }
      toast.success("横幅已删除")
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
        aria-label="删除横幅"
      >
        <Trash2 className="size-3.5" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="删除横幅"
        description={`确定删除「${title}」？删除后立即从全站轮换中移除，且不可恢复。`}
        confirmText="确认删除"
        destructive
        pending={pending}
        onConfirm={handleConfirm}
      />
    </>
  )
}
